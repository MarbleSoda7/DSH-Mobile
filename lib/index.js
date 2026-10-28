/* DSH 手机远程接管 —— Host 插件
 *
 * 目的：让手机在扫码绑定后，远程接管这台电脑上的 DSH 会话：
 *   收消息 / 发消息 / 排队 / 插话 / 切模型与思考强度 / 回答问答 / 终止本轮。
 *
 * 省流量设计（用户按流量计费）：
 *   - 客户端用游标（每会话最大 seq）做增量，重连只补缺口；
 *   - 工具调用只下发一句摘要，参数按需再取；
 *   - assistant 消息里与正文重复的 stream 字段整块丢弃；
 *   - 流式片段按时间/字数合帧，只在 focused 会话上推送；
 *   - 静态资源 ETag + 304 + gzip。
 *
 * 推送通道：SSE 优先；Cloudflare 临时隧道会缓冲 chunked 响应直到结束，
 * 所以另有长轮询 `/api/poll`（空闲挂 25s），客户端 4s 收不到 hello 就切换。
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 自己的模块图必须整条破缓存：reloadSelf() 只给 index.js 加了 `?v=<ts>`，
// 静态 `import './queue-state.js'` 会命中 Node 的模块缓存，跑的还是旧版
// （真机上出现过 `queueState.hide is not a function`）。这里把版本号透传下去。
const SELF_VERSION = new URL(import.meta.url).searchParams.get('v') || ''
let createQueueState
try {
  ;({ createQueueState } = await import(`./queue-state.js${SELF_VERSION ? `?v=${SELF_VERSION}` : ''}`))
} catch (error) {
  console.warn('[mobile-remote] versioned queue-state load failed, falling back:', error?.message || error)
  ;({ createQueueState } = await import('./queue-state.js'))
}

// 内置二维码编码器：不依赖 profile 里是否装了 `qrcode` 包。
// 早期版本靠外部包，换机器就 501「qrcode 包不可用」，配对页直接空白。
let qrCodec
try {
  qrCodec = await import(`./qr.js${SELF_VERSION ? `?v=${SELF_VERSION}` : ''}`)
} catch (error) {
  console.warn('[mobile-remote] versioned qr load failed, falling back:', error?.message || error)
  qrCodec = await import('./qr.js')
}

// `webServer` 绝对不能写进 inject：
// - 写数组 `['sessionController','webServer']`：纯 CLI 环境没有 webServer，插件直接拒绝加载；
// - 写对象 `{required:[...], optional:[...]}`：Cordis 不认这个形状，插件永远卡在
//   「pending（等待依赖）」，插件管理页显示「等待依赖」，实际什么都没跑。
// 所以只声明真正必需的 sessionController，webServer 用 ctx.get('webServer') 惰性取，
// 取不到就只跳过侧边栏按钮，7788 端口照常工作。
export const inject = ['sessionController']

/** 用来确认宿主里跑的确实是这份代码（/api/health 会回显） */
const REV = 'r2026-10-28-builtinqr56'

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
const ICON = fileURLToPath(new URL('../icon.svg', import.meta.url))

/** 每个设备最多回放这么多帧，再多就让客户端走一次分页 */
const RECENT_MAX = 1500
/** 单次重连最多回放这么多帧。手机切后台十分钟再回来，recent 里可以积上千帧：
 *  一次性推过去会让它在主线程里反复重建时间线，表现就是"切回前台页面卡死"。
 *  超过这个量就不回放，改发一帧 resync，让它按"最新一页"对齐（O(1) 而不是 O(积压)）。 */
const REPLAY_MAX_FRAMES = 120
/** 流式片段合帧窗口 */
const DELTA_FLUSH_MS = 260
const DELTA_MAX_CHARS = 1200
/** 手机没回答时，把问答交回电脑端 */
const QUESTION_FALLBACK_MS = 120_000
/** 长轮询挂起时长；delta 批次延迟这么点再回，避免每 260ms 一个请求 */
const POLL_HOLD_MS = 25_000
const POLL_AGGREGATE_MS = 1_200

const NOISE_TYPES = new Set(['step/start', 'step/end'])
// tool/ptc-dispatch* 曾经被当噪声丢掉，但电脑版正是靠它把一次 run_code 里的
// 每次嵌套工具调用（读取 / 搜索 / 查看子智能体…）拆成独立的一行。
// 手机端要"和电脑端同步"，就必须保留它们（见 trimEvent 里转成 tool/subcall）。
const NOISE_PREFIXES = ['session-log-', 'job/']

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
}

/* ------------------------------------------------------------------ utils */

const now = () => Date.now()

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const port = Number(raw.port)
  return {
    host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7788,
    publicOrigin: typeof raw.publicOrigin === 'string' ? raw.publicOrigin.replace(/\/+$/, '') : '',
    tunnelUrlFile: typeof raw.tunnelUrlFile === 'string' ? raw.tunnelUrlFile : '',
    stateDir: typeof raw.stateDir === 'string' && raw.stateDir ? raw.stateDir : '',
    maxEventChars: Number(raw.maxEventChars) > 0 ? Number(raw.maxEventChars) : 4000,
    // 同时允许绑定的手机数量。默认 1：新手机配对成功就把旧手机踢掉（换手机=换绑），
    // 避免"每扫一次码就多一个永久全权入口"，也让"别人的手机连上了"这件事立刻可见
    // （旧手机下一次请求就是 401，界面上直接显示被替换）。设成 0 表示不限数量。
    maxDevices: Number.isFinite(Number(raw.maxDevices)) && Number(raw.maxDevices) >= 0
      ? Math.floor(Number(raw.maxDevices))
      : 1,
    // 配对码有效期：默认 2 分钟（原来是 10 分钟）。
    // 配对码一旦被扫就作废，窗口越短，"链接被转发后被人抢扫"的机会越小。
    pairCodeTtlMs: Number(raw.pairCodeTtlMs) > 0 ? Number(raw.pairCodeTtlMs) : 2 * 60_000,
    // 默认开启：lib/index.js 一变就自动重载，开发期不必重启宿主。
    autoReload: raw.autoReload !== false,
    // 反向隧道由插件自己托管：宿主重启后插件会重新 apply，于是隧道自动重建。
    // 之前靠启动文件夹里的 powershell 监督进程，但它会随宿主一起被杀掉，
    // 结果"DSH 重启 → 手机打不开"，只能手动救。
    tunnel: normalizeTunnelConfig(raw.tunnel),
  }
}

function normalizeTunnelConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    enabled: raw.enabled === true,
    server: typeof raw.server === 'string' && raw.server ? raw.server : '',
    user: typeof raw.user === 'string' && raw.user ? raw.user : 'root',
    remotePort: Number(raw.remotePort) > 0 ? Number(raw.remotePort) : 7788,
    localPort: Number(raw.localPort) > 0 ? Number(raw.localPort) : 7788,
    keyPath: typeof raw.keyPath === 'string' ? raw.keyPath : '',
    sshPath: typeof raw.sshPath === 'string' && raw.sshPath
      ? raw.sshPath
      : join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
  }
}

/**
 * 隧道参数也可以放在 `<stateDir>/tunnel.json` 里。
 * 这样改隧道开关/服务器地址不需要重装 bundle（bundle 的 cordis.patch.yml
 * 是跟着包一起装进 profile 的，改它要重新 install，而宿主 HMR 有时是坏的）。
 */
function loadTunnelConfig(config, stateDir) {
  if (config.tunnel.enabled && config.tunnel.server) return config.tunnel
  try {
    const file = join(stateDir, 'tunnel.json')
    if (!existsSync(file)) return config.tunnel
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const merged = normalizeTunnelConfig({ ...saved, enabled: saved.enabled !== false })
    return merged
  } catch {
    return config.tunnel
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

function resolveStateDir(config) {
  if (config.stateDir) return config.stateDir
  return join(dshHome(), 'dsh-mobile-remote')
}

/** 隧道脚本会把当前公网地址写进 url.txt，二维码就跟着它走 */
function readTunnelUrl(config) {
  if (!config.tunnelUrlFile) return ''
  try {
    const text = readFileSync(config.tunnelUrlFile, 'utf8').split(/\r?\n/).find((line) => line.trim())
    const value = (text || '').trim().replace(/\/+$/, '')
    return /^https?:\/\/\S+$/i.test(value) ? value : ''
  } catch {
    return ''
  }
}

/**
 * 虚拟网卡（VPN / 虚拟机 / 容器）的地址段，手机连不上，扫了也没用：
 * 26.x = Radmin VPN，100.64/10 = Tailscale / CGNAT，10.8/10.211 常见于
 * OpenVPN，198.18/15 = Clash TUN，172.17-31 = Docker / WSL / VirtualBox。
 */
const VIRTUAL_NET_HINT = /^(26\.|25\.|198\.18\.|198\.19\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function isVirtualIface(name) {
  return /radmin|tailscale|zerotier|vethernet|vmware|virtualbox|vbox|hyper-v|docker|wsl|clash|tap|tun|npcap|loopback/i.test(
    String(name || ''),
  )
}

/**
 * 手机上真正能访问到的局域网 IPv4。
 * 优先 192.168 / 10 / 172.16-31 这类真实网卡，跳过虚拟网卡；都没有才退回原逻辑。
 */
function lanAddress() {
  const candidates = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (isVirtualIface(name) || VIRTUAL_NET_HINT.test(item.address)) continue
      // 私有网段优先，其余（169.254 链路本地等）排在后面
      const score = /^192\.168\./.test(item.address)
        ? 0
        : /^10\./.test(item.address)
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(item.address)
            ? 2
            : 3
      candidates.push({ address: item.address, score })
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.score - b.score)
    return candidates[0].address
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

/**
 * 所有可选的局域网地址（含虚拟网卡的），给 /admin 页面做「都不对就手动选」用。
 */
function lanAddresses() {
  const seen = new Set()
  const out = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal || seen.has(item.address)) continue
      seen.add(item.address)
      out.push({
        address: item.address,
        iface: name,
        virtual: isVirtualIface(name) || VIRTUAL_NET_HINT.test(item.address),
      })
    }
  }
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual))
  return out
}

const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex')

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

const isLoopbackAddress = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || '').split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function isNoise(type) {
  if (NOISE_TYPES.has(type)) return true
  const text = String(type || '')
  return NOISE_PREFIXES.some((prefix) => text.startsWith(prefix) || text.includes(prefix))
}

/**
 * 宿主会以 user 角色注入环境快照（source.kind = runtime-context / time-context）。
 * 电脑版不展示它们，手机端也不必：既影响阅读又白耗流量，直接整条丢弃。
 */
const INJECTED_CONTEXT_KINDS = new Set(['runtime-context', 'time-context', 'environment-context'])

function isInjectedContext(event) {
  const data = (event && event.data) || {}
  const message = data.message || data
  const kind = message && message.source && message.source.kind
  return typeof kind === 'string' && INJECTED_CONTEXT_KINDS.has(kind)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function clipText(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (!max || text.length <= max) return text
  return `${text.slice(0, max)}…[已截断 ${text.length - max} 字]`
}

function countLines(value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  return value.split(/\r?\n/).length
}

/** 手机上一行一个工具调用：动词 · 目标 +N -M */
const TOOL_VERBS = {
  pwsh: '运行命令',
  bash: '运行命令',
  shell: '运行命令',
  run_code: '运行命令',
  read: '读取',
  write: '写入',
  edit: '编辑',
  grep: '搜索',
  glob: '查找文件',
  list: '浏览目录',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  fetch: '抓取网页',
  compress: '压缩上下文',
  decompress: '展开上下文',
  record_experience: '记录经验',
  search_experience: '检索经验',
  todo_write: '更新清单',
  present: '产出文件',
  plugin_manager: '插件管理',
  subagent: '派子代理',
  subagent_fork: '派子代理',
  workflow: '编排工作流',
  ask_user_question: '向用户提问',
  schedule_create: '创建定时任务',
  automation_create: '创建自动化',
  cordis_inspect_list: '查看宿主能力',
  cordis_inspect_query: '查询宿主能力',
  skill: '加载技能',
  acp_status: '查看上下文用量',
  acp_cache: '查看缓存',
  list_agents: '查看队友',
  send_message: '发消息给队友',
  wait_agent: '等待队友',
  interrupt_agent: '打断队友',
  job_output: '读取后台任务',
  job_kill: '结束后台任务',
  list_temporary_solutions: '查看临时方案',
  report_error_solution: '记录报错方案',
  search_learned_errors: '检索历史报错',
  dsh_code_review: '代码审查',
  automation_update: '更新自动化',
  automation_delete: '删除自动化',
  schedule_create: '创建定时任务',
  schedule_list: '查看定时任务',
  schedule_delete: '删除定时任务',
  terminal_open: '打开终端',
  terminal_send: '终端输入',
  terminal_read: '读取终端',
  terminal_close: '关闭终端',
  sidebar_open: '侧栏打开',
  read_image: '查看图片',
  read_page: '读取网页',
  x_search: '搜索 X',
  web_search_alias: '联网搜索',
  workspace: '工作区操作',
  todo: '更新清单',
  goal: '目标操作',
  create_goal: '创建目标',
  update_goal: '更新目标',
  edit_file: '编辑',
  read_file: '读取',
  write_file: '写入',
  list_dir: '浏览目录',
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function summarizeToolCall(name, rawArguments) {
  // 电脑版这里是一个动作词（运行命令 / 读取 / 编辑…），绝不用"工具调用"这种占位字样；
  // 认不出来的工具就直接用工具名，也比"工具调用"有信息量。
  const verb = TOOL_VERBS[name] || String(name || '工具')
  let args = {}
  if (typeof rawArguments === 'string' && rawArguments) {
    try {
      args = JSON.parse(rawArguments)
    } catch {
      args = {}
    }
  } else if (rawArguments && typeof rawArguments === 'object') {
    args = rawArguments
  }

  const pick = (...keys) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  let target = pick(
    'description', 'file_path', 'path', 'pattern', 'query', 'command', 'url',
    'prompt', 'expert', 'name', 'action', 'tool', 'title', 'text',
  )
  // compress 的参数只有一个 content 数组：显示段数，别把键名 "content" 当目标。
  if (!target && name === 'compress' && Array.isArray(args.content)) {
    target = `${args.content.length} 段上下文`
  }
  if (!target) {
    // 不能把参数键名（如 content / ranges）当目标显示，那对用户毫无信息量。
    const keys = Object.keys(args)
    const head = keys.length ? args[keys[0]] : null
    if (Array.isArray(head)) target = `${keys[0]} · ${head.length} 项`
    else if (typeof head === 'string' && head.trim()) target = clipText(head.replace(/\s+/g, ' ').trim(), 80)
    else if (typeof head === 'number' || typeof head === 'boolean') target = `${keys[0]} · ${head}`
    else if (head && typeof head === 'object') target = keys[0]
  }
  if (!target) target = `${name}`

  let extra = ''
  if (name === 'edit' || name === 'write') {
    const body = pick('new_string', 'content')
    const plus = countLines(body)
    const minus = name === 'edit' ? countLines(pick('old_string')) : 0
    const size = formatBytes(Buffer.byteLength(body, 'utf8'))
    const parts = []
    if (size) parts.push(size)
    if (plus) parts.push(`+${plus}`)
    if (minus) parts.push(`-${minus}`)
    extra = parts.join(' ')
  } else if (name === 'pwsh' || name === 'bash' || name === 'shell' || name === 'run_code') {
    // 电脑版显示的是命令的 description（一句人话），没有描述才退化成命令本身。
    const desc = pick('description')
    const command = pick('command')
    target = desc || (command ? clipText(command.replace(/\s+/g, ' '), 80) : name)
  }

  return {
    kind: name || 'tool',
    verb,
    target: clipText(String(target).replace(/\s+/g, ' '), 120),
    extra,
  }
}

function trimBlocks(blocks, maxChars) {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length <= maxChars) return block
      // 不要把截断痕迹写进正文（否则用户复制出来会带一句"已截断"）。
      // 只给元信息，由手机端在气泡下方画"展开全文"按钮，点了再按需拉完整内容。
      return { ...block, text: text.slice(0, maxChars), truncated: { shown: maxChars, total: text.length } }
    }
    return block
  })
}

/** 单条事件的完整内容（用户点"展开全文"时才调用，所以不做任何截断） */
function fullEvent(event) {
  const data = event?.data
  if (data && typeof data === 'object' && data.stream) {
    // stream 与正文完全重复，且体积最大，即使要全文也没必要带回去
    const { stream, ...rest } = data
    return { ...event, data: rest }
  }
  return event
}

/** 手机上用不到的重字段在这里剥掉，直接省流量 */
function trimEvent(event, maxChars) {
  const type = event?.type
  const data = event?.data
  if (!data || typeof data !== 'object') return event

  if (type === 'assistant/message') {
    // stream 与正文重复，而且体积最大，整块丢掉
    const { stream, ...rest } = data
    const message = rest.message
    if (message && Array.isArray(message.content)) {
      return { ...event, data: { ...rest, message: { ...message, content: trimBlocks(message.content, maxChars) } } }
    }
    return { ...event, data: rest }
  }

  if (type === 'user/message') {
    // 注意：user/message 的 data 是**扁平**的（content/role/id 直接在 data 上），
    // 只有 assistant/message 才把消息放在 data.message 里。
    // 这里就地裁剪 content，不额外包一层 message —— 省流量，也不改变宿主原结构。
    const message = data.message || data
    if (message && Array.isArray(message.content)) {
      return { ...event, data: { ...data, content: trimBlocks(message.content, maxChars) } }
    }
    return event
  }

  if (type === 'tool/call') {
    const summary = summarizeToolCall(data.name, data.arguments)
    const args = typeof data.arguments === 'string' ? clipText(data.arguments, 600) : data.arguments
    return { ...event, type: 'tool/call', data: { ...data, arguments: args, summary } }
  }

  if (type === 'tool/result') {
    const message = data.message
    if (message && Array.isArray(message.content)) {
      return { ...event, data: { ...data, message: { ...message, content: trimBlocks(message.content, maxChars) } } }
    }
    return event
  }

  if (type === 'tool/ptc-dispatch-start') {
    // 一次 run_code 里的嵌套子调用开始：电脑版显示成独立的一行（读取 / 搜索 / 查看子智能体…）。
    // 手机端用同一个 tool/subcall 类型承载，客户端按 subCallId 去重后原地更新。
    const summary = summarizeToolCall(data.name, data.arguments)
    return { ...event, data: { subCallId: data.subCallId, parentCallId: data.parentCallId, name: data.name, summary } }
  }

  if (type === 'tool/ptc-dispatch') {
    const summary = summarizeToolCall(data.name, data.arguments)
    const message = { content: Array.isArray(data.content) ? trimBlocks(data.content, maxChars) : [] }
    return {
      ...event,
      data: {
        subCallId: data.subCallId,
        parentCallId: data.parentCallId,
        name: data.name,
        summary,
        isError: data.isError === true,
        message,
      },
    }
  }

  return event
}

function sniffMediaType(buffer) {
  if (!buffer || buffer.length < 4) return 'application/octet-stream'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf'
  return 'application/octet-stream'
}

function messageTextOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/* 一条消息里带几张图片。
 *
 * 纯图片消息（用户直接贴图、不写字）没有正文，早年 `messageTextOf` 返回空串就把
 * 整条消息当"空消息"丢掉了 —— 手机端表现是「排队/插话发图片，界面上什么都没有」，
 * 用户以为没发出去。图片数也决定排队行能不能显示 🖼 徽标、能不能编辑
 * （宿主 `updateQueue` 的 edit 只收 TextBlock[]，一编辑图片就永久丢）。
 */
function messageImageCountOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter((block) => block?.type === 'image' || block?.type === 'attachment').length
}

/* ------------------------------------------------------------------ store */

function createStore(stateDir) {
  const devicesFile = join(stateDir, 'devices.json')
  const usageFile = join(stateDir, 'usage.json')

  const readJson = (file, fallback) => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : fallback
    } catch {
      return fallback
    }
  }

  const state = readJson(devicesFile, { version: 1, devices: [] })
  if (!Array.isArray(state.devices)) state.devices = []
  const usage = readJson(usageFile, { bytesOut: 0, requests: 0, since: now() })

  let dirty = false
  let usageDirty = false

  const flush = () => {
    try {
      mkdirSync(stateDir, { recursive: true })
      if (dirty) {
        writeFileSync(devicesFile, JSON.stringify(state, null, 2), 'utf8')
        dirty = false
      }
      if (usageDirty) {
        writeFileSync(usageFile, JSON.stringify(usage, null, 2), 'utf8')
        usageDirty = false
      }
    } catch {}
  }

  const timer = setInterval(flush, 15_000)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    flush,
    list() {
      return state.devices.map((row) => ({ ...row }))
    },
    add(name, meta = {}) {
      const key = randomBytes(32).toString('hex')
      const device = {
        id: randomBytes(8).toString('hex'),
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : '手机',
        keyHash: hashKey(key),
        createdAt: now(),
        lastSeenAt: now(),
        revoked: false,
        // 配对台账：谁、什么时候、用什么设备绑上来的。
        // 注意 ip 通常是 127.0.0.1 —— 流量经 SSH 反向隧道进来，宿主看到的是隧道出口，
        // 拿不到手机的真实地址（要真实 IP 得在 VPS 上加一层反代写 X-Forwarded-For）。
        ua: typeof meta.ua === 'string' ? meta.ua.slice(0, 200) : '',
        ip: typeof meta.ip === 'string' ? meta.ip : '',
      }
      state.devices.push(device)
      dirty = true
      flush()
      return { device, token: `${device.id}.${key}` }
    },
    /** 换绑：保留 keepId，其余未撤销的设备全部杀掉。返回被撤销的 id 列表。 */
    revokeOthers(keepId) {
      const killed = []
      for (const device of state.devices) {
        if (device.id === keepId || device.revoked === true) continue
        device.revoked = true
        device.revokedAt = now()
        killed.push(device.id)
      }
      if (killed.length > 0) {
        dirty = true
        flush()
      }
      return killed
    },
    /** 超出 maxDevices 时，把最老的活跃设备撤掉（从旧到新）。 */
    trim(limit) {
      if (!(limit > 0)) return []
      const active = state.devices
        .filter((row) => row.revoked !== true)
        .sort((a, b) => (a.lastSeenAt || a.createdAt || 0) - (b.lastSeenAt || b.createdAt || 0))
      const over = active.length - limit
      if (over <= 0) return []
      const killed = []
      for (let i = 0; i < over; i += 1) {
        active[i].revoked = true
        active[i].revokedAt = now()
        killed.push(active[i].id)
      }
      dirty = true
      flush()
      return killed
    },
    verify(token) {
      if (typeof token !== 'string') return null
      const cut = token.indexOf('.')
      if (cut <= 0) return null
      const id = token.slice(0, cut)
      const key = token.slice(cut + 1)
      const device = state.devices.find((row) => row.id === id)
      if (!device || device.revoked === true) return null
      if (!safeEqualHex(device.keyHash, hashKey(key))) return null
      device.lastSeenAt = now()
      dirty = true
      return device
    },
    revoke(id) {
      const device = state.devices.find((row) => row.id === id)
      if (!device) return false
      device.revoked = true
      dirty = true
      flush()
      return true
    },
    activeCount() {
      return state.devices.filter((row) => row.revoked !== true).length
    },
    countOut(bytes) {
      if (bytes > 0) {
        usage.bytesOut += bytes
        usage.requests += 1
        usageDirty = true
      }
    },
    usage() {
      return { bytesOut: usage.bytesOut, requests: usage.requests, since: usage.since }
    },
  }
}

/* ------------------------------------------------------------------ plugin */

// 已经生效的那一份实例。重新 import 本模块后，新实例会先把旧实例关掉，
// 保证同一个 7788 端口只被一个实例监听。
let ACTIVE = null

export function apply(ctx, rawConfig) {
  if (ACTIVE) {
    try {
      ACTIVE.shutdown()
    } catch {}
    ACTIVE = null
  }
  const config = normalizeConfig(rawConfig)
  const stateDir = resolveStateDir(config)
  const store = createStore(stateDir)

  const log = (...args) => {
    try {
      console.log('[mobile-remote]', ...args)
    } catch {}
  }

  /* 启动时把超额的历史设备收掉。
   * 只在配对那一刻 trim 是不够的：老版本没有 maxDevices 限制，devices.json 里可能躺着
   * 十几个仍然有效的 token，任何一个都还能读会话。这里按"最近用过"保留 N 台，其余撤销。 */
  try {
    const trimmed = store.trim(config.maxDevices)
    if (trimmed.length > 0) log('trimmed stale devices', trimmed.length, 'keep', config.maxDevices)
  } catch {}

  const controller = () => {
    const value = ctx.sessionController || (typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined)
    if (!value) throw Object.assign(new Error('sessionController 服务尚未就绪'), { status: 503 })
    return value
  }

  const pairCodes = new Map()
  const clients = new Set()
  const focusByDevice = new Map()
  const pollWaiters = new Set()
  const recent = []
  const pendingQuestions = new Map()
  const deltaBuf = new Map()
  const seqSeen = new Map()
  // 队列的唯一模型（见 lib/queue-state.js）：spliced + inbox 身份事件都从这里过一遍，
  // next-step（插话）的消息只记 id、不进手机上的「排队」框。
  const queueState = createQueueState({ textOf: messageTextOf, imageCountOf: messageImageCountOf })
  const disposers = []
  let closed = false

  /* --------------------------------------------------------- 传输层 */

  function focusSet(device) {
    let set = focusByDevice.get(device.id)
    if (!set) {
      set = new Set()
      focusByDevice.set(device.id, set)
    }
    return set
  }

  function isFocused(sessionId) {
    for (const set of focusByDevice.values()) if (set.has(sessionId)) return true
    return false
  }

  function pushFrame(client, type, payload) {
    if (client.kind === 'poll') {
      client.queue.push({ type, payload })
      return
    }
    try {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {}
  }

  function broadcast(type, payload, options = {}) {
    const { sessionId, focusedOnly = false } = options
    for (const client of clients) {
      if (focusedOnly && sessionId && !client.focused.has(sessionId)) continue
      pushFrame(client, type, payload)
    }
    settlePollers()
  }

  /** 立刻踢掉某台设备的全部连接：先推一帧说明原因，再把连接关掉。
   *  客户端收到 kicked 就会清 token 回配对页，并提示"已被别的设备替换"。
   *  不做这步的话，被换绑的旧手机要等到下一次 HTTP 请求才收到 401，
   *  在那之前它还挂在一条 SSE 上，继续实时看着会话。 */
  function kickDevice(deviceId, reason) {
    let kicked = 0
    for (const client of [...clients]) {
      if (!client.device || client.device.id !== deviceId) continue
      kicked += 1
      pushFrame(client, 'kicked', { reason })
      if (client.kind === 'poll') {
        finishPoll(client)
        continue
      }
      try { client.res.end() } catch {}
      clients.delete(client)
    }
    focusByDevice.delete(deviceId)
    return kicked
  }

  function remember(sessionId, seq, event, frameType = 'event') {
    seqSeen.set(sessionId, seq)
    recent.push({ sessionId, seq, event, frameType })
    while (recent.length > RECENT_MAX) recent.shift()
  }

  function replayTo(client, cursor) {
    if (!cursor || typeof cursor !== 'object') return
    const pending = []
    for (const item of recent) {
      const seen = cursor[item.sessionId]
      // 只有"老设备续传"才回放：游标里根本没有这个会话 = 新设备/新会话，
      // 历史消息交给 openChat 时按需拉取，避免首次连接就把上千条事件灌到手机上。
      if (typeof seen !== 'number') continue
      if (item.seq <= seen) continue
      pending.push(item)
      if (pending.length > REPLAY_MAX_FRAMES) break
    }
    if (pending.length > REPLAY_MAX_FRAMES) {
      // 积压太多（手机切后台很久）：不回放逐帧，改成一句"以最新为准"。
      // 客户端收到 resync 只做一次对齐渲染，而不是几百次 reflow。
      // 必须带服务端 cursor：客户端认下它才不会下次又判定积压（否则无限打转）。
      pushFrame(client, 'resync', { cursor: cursorSnapshot(), at: now() })
      return
    }
    for (const item of pending) pushFrame(client, item.frameType || 'event', item.event)
  }

  function cursorSnapshot() {
    return Object.fromEntries(seqSeen)
  }

  function parseCursor(url) {
    const raw = url.searchParams.get('c')
    if (!raw) return null
    try {
      const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      const value = JSON.parse(text)
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  function finishPoll(waiter, abandoned) {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    if (waiter.aggregateTimer) clearTimeout(waiter.aggregateTimer)
    pollWaiters.delete(waiter)
    clients.delete(waiter)
    if (abandoned) return
    sendJson(waiter.req, waiter.res, 200, {
      ok: true,
      frames: waiter.queue,
      // 队列快照必须在**响应发出这一刻**重算，不能用建立连接时算好的那份：
      // 长轮询最长挂 25 秒，那份快照可能是 25 秒前的，会把用户刚编辑好的文本
      // 又覆盖回旧值（用户报的"看起来没修改，其实已经改好了"）。
      queueSync: queueSyncFrames(waiter.focused),
      // 会话运行状态：长轮询没有 hello 帧，靠它把"运行中"同步给列表
      status: Object.fromEntries(lastStatus),
      // 会话集合/归档集合的版本号（客户端据此决定要不要重新拉 /api/state）
      sessionsRev,
      cursor: cursorSnapshot(),
      serverTime: now(),
    })
  }

  /** 有新帧就放行长轮询；只有 delta 时稍等一下，把连续片段攒成一批 */
  function settlePollers() {
    for (const waiter of [...pollWaiters]) {
      if (!waiter.queue.length) continue
      const onlyDelta = waiter.queue.every((frame) => frame.type === 'delta')
      if (onlyDelta) {
        if (waiter.aggregateTimer) continue
        waiter.aggregateTimer = setTimeout(() => finishPoll(waiter), POLL_AGGREGATE_MS)
        if (typeof waiter.aggregateTimer.unref === 'function') waiter.aggregateTimer.unref()
        continue
      }
      finishPoll(waiter)
    }
  }

  /* --------------------------------------------------------- HTTP 工具 */

  function sendJson(req, res, status, value) {
    if (res.writableEnded) return
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    const gzip = body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    if (gzip) {
      const packed = gzipSync(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': packed.length,
        'cache-control': 'no-store',
      })
      res.end(packed)
      return
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sendError(req, res, status, message) {
    sendJson(req, res, status, { ok: false, error: message })
  }

  const staticCache = new Map()

  function sendFile(req, res, name, type) {
    const file = join(WEB_DIR, name)
    let info
    try {
      info = statSync(file)
    } catch {
      sendError(req, res, 404, '前端资源缺失')
      return
    }
    const version = `${info.mtimeMs}:${info.size}`
    let cached = staticCache.get(file)
    if (!cached || cached.version !== version) {
      let data = readFileSync(file)
      // 外壳引用带 rev：绕过 Service Worker / 浏览器缓存里的旧 app.js。
      // 手机上"代码改了但行为没变"最常见的原因就是拿到了缓存里的旧外壳。
      if (name === 'index.html') {
        const text = data.toString('utf8')
          .replace('/style.css"', `/style.css?v=${REV}"`)
          .replace('/app.js"', `/app.js?v=${REV}"`)
        data = Buffer.from(text, 'utf8')
      }
      cached = {
        version,
        data,
        etag: `"${createHash('sha1').update(data).digest('base64url').slice(0, 16)}"`,
      }
      staticCache.set(file, cached)
    }
    if (String(req.headers['if-none-match'] || '') === cached.etag) {
      res.writeHead(304, { etag: cached.etag })
      res.end()
      return
    }
    const isText = type.startsWith('text/') || type.includes('json') || type.includes('javascript')
    const useGzip = isText && cached.data.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    const body = useGzip ? gzipSync(cached.data) : cached.data
    const headers = {
      'content-type': type,
      'content-length': body.length,
      etag: cached.etag,
      'cache-control': 'no-cache',
    }
    if (useGzip) headers['content-encoding'] = 'gzip'
    res.writeHead(200, headers)
    res.end(body)
  }

  function isLoopbackRequest(req) {
    return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(req.headers.host)
  }

  /* --------------------------------------------------------- 认证 */

  function authenticate(req, url) {
    const header = String(req.headers.authorization || '')
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const key = url?.searchParams.get('k') || ''
    if (bearer) return store.verify(bearer)
    if (key) return store.verify(key)
    return null
  }

  /* 外壳（index.html）的访问闸门。
   * 目标：别人扫到这个 IP:端口 直接访问根路径时，连"这里有一台 DSH 的配对页"都看不到。
   * 放行条件只有两个：URL 带着配对码（扫码进来的第一程），或者浏览器里有已配对设备的 cookie。
   * 自己人正常访问时走 cookie；cookie 丢了就重新扫码（配对码只在本机生成，不会漏）。 */
  const DEVICE_COOKIE = 'mr_dev'

  function parseCookies(req) {
    const out = {}
    for (const part of String(req.headers.cookie || '').split(';')) {
      const cut = part.indexOf('=')
      if (cut <= 0) continue
      const name = part.slice(0, cut).trim()
      if (!name) continue
      try {
        out[name] = decodeURIComponent(part.slice(cut + 1).trim())
      } catch {
        out[name] = part.slice(cut + 1).trim()
      }
    }
    return out
  }

  function shellAllowed(req, url) {
    if (url && url.searchParams.get('t')) return true
    const cookie = parseCookies(req)[DEVICE_COOKIE]
    if (cookie && store.verify(cookie)) return true
    const header = String(req.headers.authorization || '')
    if (header.startsWith('Bearer ') && store.verify(header.slice(7).trim())) return true
    return false
  }

  /* --------------------------------------------------------- 会话读取 */

  function mapSession(row) {
    const values = row?.projections?.values && typeof row.projections.values === 'object' ? row.projections.values : {}
    const next = values.modelSelection?.next || null
    return {
      id: row?.sessionId || '',
      title: typeof values.title === 'string' && values.title ? values.title : '未命名会话',
      running: row?.running === true,
      blank: row?.blank === true,
      updatedAt: row?.updatedAt || 0,
      cwd: typeof row?.cwd === 'string' ? row.cwd : '',
      agentAvailable: row?.agentAvailable !== false,
      agentPreset: values.agentPreset || '',
      model: next
        ? { provider: next.provider || '', model: next.model || '', reasoningEffort: next.reasoningEffort || '' }
        : null,
    }
  }

  /* 归档集合是 workspaceRegistry 的注册表级状态：归档只从"分组界面"隐藏，不会删掉会话本身，
   * 所以 sessionController.list() 里照旧有它 —— 必须在手机端列表里自行剔除，否则电脑上归档了
   * 手机端还看得见。拿不到 registry（旧宿主 / 该服务未装）时返回空集合，退化为不过滤。 */
  function archivedSessionIds() {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (!registry) return new Set()
    const ids = registry.archivedSessionIds
    if (!Array.isArray(ids) || ids.length === 0) return new Set()
    return new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))
  }

  async function listSessions() {
    const value = await controller().list({})
    const rows = Array.isArray(value?.items) ? value.items : []
    return rows.map(mapSession)
  }

  /* 电脑版按"项目（工作区）"分组显示会话，手机也要一样。
   * 分组归属只有 workspaceRegistry 知道（SessionSummary 里只有 cwd），
   * 所以这里把 registry 的分组投影成一组 {id,title,path,sessionIds}，
   * 只保留手机端当前可见（未归档、非空）的会话 id。
   * 拿不到 registry 时返回空数组，客户端会退化成按 cwd 分组。 */
  function workspaceGroups(visibleIds) {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (!registry || typeof registry.list !== 'function') return []
    let rows = []
    try {
      rows = registry.list() || []
    } catch {
      return []
    }
    const groups = []
    for (const workspace of rows) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      const kept = ids.filter((id) => visibleIds.has(id))
      if (kept.length === 0) continue
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      const tail = path.split(/[\\/]/).filter(Boolean).pop() || ''
      groups.push({
        id: workspace?.id || path || tail,
        title: workspace?.title || tail || '未命名项目',
        path,
        sessionIds: kept,
      })
    }
    return groups
  }

  /* 会话日志的游标（= 最后一条事件的 seq）。
   * 不能拿 projections().asOfSeq 当游标：投影在旧会话上可能是 asOfSeq 之外的形态，
   * 而对活动会话又可能超出日志 cursor，page() 会因此报 "past cursor"。
   * 权威来源是 follow() 的 opening snapshot 帧里的 cursor 字段。 */
  const cursorCache = new Map()

  function rememberCursor(sessionId, seq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    const current = cursorCache.get(sessionId)
    if (current === undefined || seq > current) cursorCache.set(sessionId, seq)
  }

  async function withSignal(handler, timeoutMs = 20000) {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(new Error('timeout')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      return await handler(control.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 读 follow() 的 opening snapshot：一次读取同时拿到 cursor、records、hasMore。 */
  async function readSnapshot(sessionId, maxMessages, signal) {
    const control = new AbortController()
    const onAbort = () => control.abort()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const request = { address: { kind: 'session', sessionId } }
      if (Number.isFinite(maxMessages) && maxMessages > 0) request.maxMessages = maxMessages
      for await (const frame of controller().follow(request, control.signal)) {
        if (frame && frame.type === 'snapshot') {
          control.abort()
          rememberCursor(sessionId, frame.cursor)
          return frame
        }
      }
      return null
    } finally {
      control.abort()
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async function latestSeq(sessionId) {
    const cached = cursorCache.get(sessionId)
    if (typeof cached === 'number') return cached
    try {
      const frame = await withSignal((signal) => readSnapshot(sessionId, 1, signal), 15000)
      if (frame && typeof frame.cursor === 'number') return frame.cursor
    } catch (error) {
      log('latestSeq failed', error instanceof Error ? error.message : String(error))
    }
    return seqSeen.get(sessionId) || 0
  }

  /* --------------------------------------------------------- 队列（真源是 spliced 事件） */

  // 我们"从头盯过"的会话：这些会话的队列为空就是真的空，不要再去用 12 条记录的窗口
  // 重放（重放会按索引错位，把早就被取走的排队消息复活成幽灵行）。
  const queueWarm = new Set()
  /** 每会话上一次广播出去的运行状态，避免重复下发 */
  const lastStatus = new Map()
  /** 会话集合（含归档集合）的版本号：每次 workspace 域写入 +1。
   * 客户端只比大小，发现自己落后就重新拉 /api/state —— 比在推送里塞整张表省流量，
   * 也不会像纯帧推送那样在"轮询被别的事件抢先唤醒"时漏掉。 */
  let sessionsRev = 0

  const queueItems = (sessionId) => queueState.list(sessionId)

  // 纯函数版（rebuildQueue 在离线重放时用，其余路径都走 queueState）
  function applySplice(list, data) {
    const textOf = (message) => messageTextOf(message)
    const scratch = createQueueState({ textOf, imageCountOf: messageImageCountOf, now })
    const sessionId = ''
    scratch.set(sessionId, list)
    return scratch.applySpliced(sessionId, data)
  }

  function queueSet(sessionId, list) {
    const clean = queueState.set(sessionId, list)
    queueBroadcast(sessionId)
    return clean
  }

  function queueBroadcast(sessionId) {
    // 注意：这里**不能**加 focusedOnly —— 长轮询客户端可能是在「用户聚焦该会话之前」
    // 就建立的，靠焦点过滤会把 queue 帧丢掉（实测：SSE 能收到、长轮询只收到 event）。
    // 队列帧很小（几个短字符串），直接广播，客户端按 sessionId === 当前会话 过滤即可。
    broadcast('queue', { sessionId, items: queueItems(sessionId) }, { sessionId })
  }

  // 每建立一条推送通道（SSE / 长轮询）都先带一份"当前队列"，
  // 这样即使中间漏过 queue 帧（断线、通道切换），手机也会立刻对齐，而不是永远停在
  // 旧的"排队中…"（用户实测踩过：DSH 早就回完了，手机还显示排队）。
  function queueSyncFrames(focused) {
    const ids = new Set(queueState.sessions())
    for (const id of focused || []) ids.add(id)
    const frames = []
    for (const sessionId of ids) frames.push({ type: 'queue', payload: { sessionId, items: queueItems(sessionId) } })
    return frames
  }

  // 电脑端在**本轮中途插话**（steer）时，宿主先发 `spliced{target:'next-step', inserted:[msg]}`，
  // 真正的 user/message 事件要等下一个步骤边界才落盘。只等 user/message 的话，手机在
  // "电脑上已经发出去了、手机上看不到"这段窗口里就是不同步的。这里先把插话内容作为
  // 一个 steer 帧推给正在看这个会话的客户端，客户端渲染成用户气泡；等 user/message
  // 带着同一个 message.id 到达时再按 id 去重（不会出现两条）。
  function pushSteerFrames(sessionId, data, seq) {
    if (!data || data.target !== 'next-step') return
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    for (const message of inserted) {
      const kind = message?.source?.kind
      if (kind && kind !== 'user') continue
      const text = messageTextOf(message)
      const imageCount = messageImageCountOf(message)
      // 纯图片插话（电脑端贴张图就发）也必须推到手机：早年这里 `if (!text) continue`
      // 直接吞掉，手机端表现是"电脑上插了话，手机上完全没有这条"。
      if (!text && imageCount === 0) continue
      const payload = { sessionId, id: message.id || '', text, imageCount, at: now() }
      // 记进 replay 缓冲：steer 帧没有自己的 seq，长轮询恰好处于两次请求之间
      // （重连、120ms 间隙）时这一帧会永久丢失。挂到触发它的 spliced 事件的 seq 上，
      // 客户端重连时按游标就能补回来。
      if (typeof seq === 'number') remember(sessionId, seq, payload, 'steer')
      broadcast('steer', payload, { focusedOnly: true })
    }
  }

  async function rebuildQueue(sessionId) {
    try {
      const snapshot = await withSignal((signal) => readSnapshot(sessionId, 12, signal), 20000)
      const records = Array.isArray(snapshot?.records) ? snapshot.records : []
      let list = []
      for (const record of records) {
        const event = record?.event || record
        // 注意：turn/start 时**不能**清空队列 —— 宿主的排队消息在下一轮开始才被
        // 取走，而且取走时会自己发一条 `target:'next-turn', removedCount:N` 的
        // spliced 事件。早先在这里清空，会导致"刚发出去的排队消息立刻从手机上消失"
        // （用户反馈：排了 15 分钟都没看到那条消息）。
        if (event?.type === 'agent/inbox/spliced') list = applySplice(list, event.data)
      }
      queueState.set(sessionId, list)
      return list
    } catch (error) {
      log('rebuildQueue failed', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  /* --------------------------------------------------------- 流式片段 */

  // 一条 assistant/message 落地（或新一轮开始）时，流式缓冲必须清零。
  // 不清零的后果（真机 bug）：缓冲里的正文会跨 step、跨轮一直累积，
  // 下一段流式开始时把前几步的内容整段再发一遍，手机上就冒出
  // "三个回答合并在一个 DSH 气泡里"的怪现象，等正式消息到达又自动消失。
  function resetDelta(sessionId) {
    const entry = deltaBuf.get(sessionId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    deltaBuf.delete(sessionId)
  }

  function flushDelta(sessionId) {
    const entry = deltaBuf.get(sessionId)
    if (!entry) return
    entry.timer = 0
    if (!entry.text && !entry.reasoning) {
      deltaBuf.delete(sessionId)
      return
    }
    broadcast('delta', {
      sessionId,
      text: entry.text,
      reasoning: entry.reasoning,
      streaming: true,
    }, { sessionId, focusedOnly: true })
  }

  /* --------------------------------------------------------- 事件订阅 */

  function onSessionEvent(session, event) {
    if (closed) return
    const sessionId = session?.id || session?.sessionId || event?.sessionId
    if (!sessionId || !event || typeof event.type !== 'string') return
    if (typeof event.seq !== 'number') return
    if (isNoise(event.type)) return
    rememberCursor(sessionId, event.seq)
    // 环境快照（runtime-context/time-context）只推进游标，不下发、不占手机流量。
    if (isInjectedContext(event)) return

    // 步骤边界必须清空流式缓冲，否则下一段流式会把前几步的正文拼在一起重发
    // （真机看到的现象：三个回答合成一个 DSH 气泡，等正式消息到了又消失）。
    if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start') {
      resetDelta(sessionId)
    }

    // 队列先算：长轮询会被下面的 event 帧唤醒并结束响应，
    // 顺序反了的话 queue 帧就落在已移除的 client 上，手机永远看不到排队条。
    // 队列的唯一真源是 `agent/inbox/spliced`（宿主取走排队消息时会发
    // `target:'next-turn', removedCount:N`），所以 turn/start 时不要清空。
    if (event.type === 'agent/inbox/spliced') {
      queueWarm.add(sessionId)
      // 电脑端中途插话：必须**先于** queueBroadcast 推 steer 帧。
      // queueBroadcast 会 settlePollers() 立刻结束当前长轮询响应并把 client 移除，
      // 之后再 broadcast('steer') 就没有收件人了 —— 手机要等到下一个步骤边界
      // 的 user/message（实测 4~9 秒）才能看到自己插的话，正是这个顺序造成的。
      pushSteerFrames(sessionId, event.data, event.seq)
      queueState.applySpliced(sessionId, event.data)
      queueBroadcast(sessionId)
    }

    // 运行状态直接从会话事件推导，不依赖 `agent/status`（实测该事件在
    // 本宿主里一次都没触发过，导致手机会话列表永远没有"运行中"）。
    if (event.type === 'turn/start' && lastStatus.get(sessionId) !== 'running') {
      lastStatus.set(sessionId, 'running')
      broadcast('status', { sessionId, status: 'running' })
    }
    if (event.type === 'turn/end' && lastStatus.get(sessionId) !== 'idle') {
      lastStatus.set(sessionId, 'idle')
      broadcast('status', { sessionId, status: 'idle' })
    }

    const trimmed = trimEvent(event, config.maxEventChars)
    const payload = { ...trimmed, sessionId }
    remember(sessionId, event.seq, payload)
    broadcast('event', payload)
  }

  function onAgentStatus(agent, status) {
    if (closed) return
    const sessionId = agent?.session?.id || agent?.id
    if (!sessionId) return
    broadcast('status', { sessionId, status: status === 'running' ? 'running' : 'idle' })
  }

  function onAssistantStream(payload) {
    if (closed) return
    const sessionId = payload?.agent?.session?.id || payload?.sessionId
    if (!sessionId) return
    if (!isFocused(sessionId)) return

    const frame = payload?.frame
    const chunk = frame?.chunk
    if (!chunk || chunk.type === 'done' || frame.type === 'done') return

    if (!deltaBuf.has(sessionId)) deltaBuf.set(sessionId, { text: '', reasoning: '', timer: 0 })
    const entry = deltaBuf.get(sessionId)
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (chunk.type === 'reasoning-delta') entry.reasoning += text
    else entry.text += text

    if (entry.text.length + entry.reasoning.length >= DELTA_MAX_CHARS) {
      if (entry.timer) clearTimeout(entry.timer)
      flushDelta(sessionId)
      return
    }
    if (!entry.timer) {
      entry.timer = setTimeout(() => flushDelta(sessionId), DELTA_FLUSH_MS)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()
    }
  }

  function onUserQuestions(req, next) {
    const sessionId = req?.agent?.session?.id || req?.agent?.id
    if (closed || !sessionId || !isFocused(sessionId)) return next()

    const questions = (Array.isArray(req?.questions) ? req.questions : []).map((question) => ({
      id: String(question?.id ?? ''),
      question: String(question?.question ?? ''),
      detail: typeof question?.detail === 'string' ? question.detail : '',
      header: typeof question?.header === 'string' ? question.header : '',
      multiSelect: question?.multiSelect === true,
      options: Array.isArray(question?.options)
        ? question.options.map((option) => ({
          label: String(option?.label ?? ''),
          description: typeof option?.description === 'string' ? option.description : '',
        }))
        : [],
    }))

    return new Promise((resolve, reject) => {
      const id = randomBytes(8).toString('hex')
      const entry = { id, sessionId, resolve, reject, next, timer: 0, closed: false }

      entry.timer = setTimeout(() => {
        if (entry.closed) return
        entry.closed = true
        pendingQuestions.delete(id)
        broadcast('question-expired', { id, sessionId }, { sessionId, focusedOnly: true })
        try {
          resolve(next())
        } catch (error) {
          reject(error)
        }
      }, QUESTION_FALLBACK_MS)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()

      const signal = req?.signal
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          if (entry.closed) return
          entry.closed = true
          clearTimeout(entry.timer)
          pendingQuestions.delete(id)
          reject(Object.assign(new Error('问答已取消'), { status: 499 }))
        }, { once: true })
      }

      pendingQuestions.set(id, entry)
      broadcast('question', { id, sessionId, questions }, { sessionId, focusedOnly: true })
    })
  }

  function resolveQuestion(id, answers) {
    const entry = pendingQuestions.get(id)
    if (!entry) return false
    entry.closed = true
    clearTimeout(entry.timer)
    pendingQuestions.delete(id)
    try {
      entry.resolve({ answers })
    } catch {}
    broadcast('question-resolved', { id: entry.id }, { sessionId: entry.sessionId, focusedOnly: true })
    return true
  }

  function onApprovalRequest(req, next) {
    if (!closed) {
      const sessionId = req?.session?.id || req?.agent?.session?.id
      broadcast(
        'approval',
        { sessionId: sessionId || '', toolName: req?.toolName || '', reason: typeof req?.reason === 'string' ? req.reason : '' },
        { sessionId, focusedOnly: Boolean(sessionId) },
      )
    }
    return next()
  }

  // 宿主的 inbox 身份事件不带 target：走 queueState.inserted，next-step 的消息会被
  // 前面记下的 id 集合挡掉（否则插话后那条消息会以"排队中"再挂回手机上）。
  function onInboxInserted(payload) {
    if (closed) return
    const sessionId = payload?.agent?.session?.id || payload?.agent?.id
    const message = payload?.message
    if (!sessionId || !message) return
    queueWarm.add(sessionId)
    queueState.inserted(sessionId, message)
    queueBroadcast(sessionId)
  }

  function onInboxGone(payload) {
    if (closed) return
    const sessionId = payload?.agent?.session?.id || payload?.agent?.id
    const id = payload?.message?.id
    if (!sessionId || !id) return
    queueWarm.add(sessionId)
    queueState.gone(sessionId, id)
    queueBroadcast(sessionId)
  }

  /* --------------------------------------------------------- 路由 */

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const path = url.pathname
    const method = req.method || 'GET'

    // 配对页只在电脑本机可开（隧道会把 /admin 也暴露出去）
    if (path === '/admin' || path === '/admin.html') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '配对页只能在电脑本机打开')
        return
      }
    }

    // 根路径闸门：没有配对码也没有已配对设备凭证 → 404（连配对页都不给）。
    // 只在 GET 外壳时判，/api/* 各有自己的鉴权，静态资源照旧可取（它们本身没有信息量）。
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      if (!shellAllowed(req, url)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('Not Found')
        return
      }
    }

    if (method === 'GET' && (STATIC_FILES[path] || path === '/icon.svg')) {
      if (path === '/icon.svg') {
        try {
          const data = readFileSync(ICON)
          res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': data.length, 'cache-control': 'no-cache' })
          res.end(data)
        } catch {
          sendError(req, res, 404, '缺少图标')
        }
        return
      }
      const [name, type] = STATIC_FILES[path]
      sendFile(req, res, name, type)
      return
    }

    if (path === '/api/health') {
      sendJson(req, res, 200, {
        ok: true,
        rev: REV,
        uptimeMs: Math.round(process.uptime() * 1000),
        devices: store.activeCount(),
        streams: [...clients].filter((client) => client.kind === 'sse').length,
        pollers: pollWaiters.size,
      })
      return
    }

    /* ---- 只在电脑本机可用的管理接口 ---- */

    if (path === '/api/dev/reload' && method === 'POST') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在电脑本机重载插件')
        return
      }
      // 注意：`reloadSelf` 是下面 `const` 声明的，此刻还在 TDZ（暂时性死区）。
      // 以前在 setTimeout 里直接调它，只要请求在「监听已起、函数还不存在」这段
      // 窗口内打进来，回调就在 setTimeout 里抛 ReferenceError，整个宿主进程崩掉
      // （2026-10-28 就是这样把 DSH 打崩的）。改成延迟到调用时才取，并逐层兜住。
      sendJson(req, res, 202, { ok: true, rev: REV, reloading: true })
      setTimeout(() => {
        try {
          if (typeof reloadSelf !== 'function') {
            log('dev/reload ignored: plugin still initializing')
            return
          }
          const pending = reloadSelf('dev/reload')
          if (pending && typeof pending.catch === 'function') {
            pending.catch((error) => log('reload failed:', error?.message || error))
          }
        } catch (error) {
          log('reload failed:', error?.message || error)
        }
      }, 200)
      return
    }

    if (path === '/api/paircode') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在电脑本机生成配对码')
        return
      }
      const code = randomBytes(16).toString('hex')
      const expiresAt = now() + config.pairCodeTtlMs
      pairCodes.set(code, expiresAt)
      for (const [old, when] of pairCodes) if (when < now()) pairCodes.delete(old)
      const asked = url.searchParams.get('origin') || ''
      const host = `http://${lanAddress()}:${config.port}`
      // 优先级：显式指定 > 固定公网地址（publicOrigin）> 临时隧道地址 > 局域网。
      // 固定 IP 通了以后必须排在隧道前面，否则二维码会一直指向会变的 trycloudflare 域名。
      const origin = (asked || config.publicOrigin || readTunnelUrl(config) || host).replace(/\/+$/, '')
      sendJson(req, res, 200, {
        ok: true,
        code,
        expiresAt,
        url: `${origin}/?t=${code}`,
        origin,
        lan: host,
      })
      return
    }

    // 开发期自检口：确认宿主是否真的 reload 了这份代码、pair 路由和 tap 有没有挂上。
  if (path === '/api/dev/pairinfo' && method === 'GET') {
    if (!isLoopbackRequest(req)) {
      sendError(req, res, 403, '只能在本机查询')
      return
    }
    sendJson(req, res, 200, {
      ok: true,
      now: now(),
      rev: REV,
      pairRoutes,
      pairTapOk,
      hasWebServer: Boolean(webServer),
    })
    return
  }

  if (path === '/api/qr') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在本机生成二维码')
        return
      }
      const text = url.searchParams.get('text') || ''
      if (!text) {
        sendError(req, res, 400, '缺少内容')
        return
      }
      try {
        if (url.searchParams.get('format') === 'png') {
          const png = qrCodec.toPng(text, { scale: 8, margin: 2 })
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' })
          res.end(png)
        } else {
          const svg = qrCodec.toSvg(text, { margin: 2, width: 320 })
          const buffer = Buffer.from(svg, 'utf8')
          res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'content-length': buffer.length, 'cache-control': 'no-store' })
          res.end(buffer)
        }
      } catch (error) {
        sendError(req, res, 500, error instanceof Error ? error.message : '生成二维码失败')
      }
      return
    }

    if (path === '/api/devices' && method === 'GET') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在本机查看设备')
        return
      }
      sendJson(req, res, 200, { ok: true, devices: store.list() })
      return
    }

    if (path === '/api/devices/revoke' && method === 'POST') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在本机撤销设备')
        return
      }
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const ok = store.revoke(id)
      sendJson(req, res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'not found' })
      return
    }

    if (path === '/api/usage' && method === 'GET') {
      if (!isLoopbackRequest(req)) {
        sendError(req, res, 403, '只能在本机查看用量')
        return
      }
      sendJson(req, res, 200, { ok: true, usage: store.usage() })
      return
    }

    if (path === '/api/pair' && method === 'POST') {
      const body = await readBody(req)
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      const expiresAt = pairCodes.get(code)
      if (!expiresAt || expiresAt < now()) {
        pairCodes.delete(code)
        sendError(req, res, 401, '配对码无效或已过期，请重新扫码')
        return
      }
      pairCodes.delete(code)
      const ua = String(req.headers['user-agent'] || '').slice(0, 200)
      // 经 SSH 反向隧道进来时这里是隧道出口地址（127.0.0.1），不是手机真实 IP。
      const ip = String(req.socket?.remoteAddress || '')
      const { token, device } = store.add(typeof body.name === 'string' ? body.name : '', { ua, ip })
      // 换绑：默认只留这一台。旧设备的连接必须当场掐断，否则它还能挂着 SSE 继续看会话。
      const killedIds = (config.maxDevices === 1
        ? store.revokeOthers(device.id)
        : store.trim(config.maxDevices)).filter((id) => id !== device.id)
      let replaced = 0
      for (const id of killedIds) {
        kickDevice(id, 'replaced')
        replaced += 1
      }
      log('paired', device.id, device.name, `ua="${ua.slice(0, 48)}"`, replaced > 0 ? `replaced=${replaced}` : '')
      const payload = Buffer.from(JSON.stringify({
        ok: true, deviceId: device.id, token, name: device.name, replaced,
      }), 'utf8')
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
        // 给外壳闸门用的凭证 cookie：配对成功后浏览器再访问根路径才放行。
        'set-cookie': `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`,
      })
      res.end(payload)
      return
    }

    /* ---- 以下都需要设备密钥 ---- */

    const device = authenticate(req, url)
    if (!device) {
      sendError(req, res, 401, '未绑定或密钥无效')
      return
    }

    if (path === '/api/events' && method === 'GET') {
      const focused = focusSet(device)
      const client = { kind: 'sse', req, res, device, focused, queue: [], done: false }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      clients.add(client)
      pushFrame(client, 'hello', {
        serverTime: now(),
        rev: REV,
        cursor: cursorSnapshot(),
        // 服务端各会话当前的最大 seq：客户端拿它跟自己本地游标比，就能发现断线期间漏了帧。
        latest: cursorSnapshot(),
        // 各会话已知的运行状态（由 turn/start、turn/end 推导），让会话列表一连上就是对的。
        status: Object.fromEntries(lastStatus),
        // 会话集合/归档集合的版本号（同长轮询）
        sessionsRev,
      })
      replayTo(client, parseCursor(url))
      for (const frame of queueSyncFrames(focused)) pushFrame(client, frame.type, frame.payload)

      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {}
      }, 25_000)
      if (typeof ping.unref === 'function') ping.unref()

      const cleanup = () => {
        clearInterval(ping)
        clients.delete(client)
      }
      req.on('close', cleanup)
      res.on('error', cleanup)
      return
    }

    if (path === '/api/poll' && method === 'GET') {
      const focused = focusSet(device)
      const client = {
        kind: 'poll', req, res, device, focused, queue: [], done: false, timer: 0, aggregateTimer: 0,
      }
      replayTo(client, parseCursor(url))
      // 队列快照单独放在 queueSync 里，不占 frames —— 否则长轮询会"一建立就立刻返回"，
      // 把真正等着的事件推到下一次，白白多一次往返。
      client.syncFrames = queueSyncFrames(focused)
      if (client.queue.length) {
        clients.add(client)
        finishPoll(client)
        return
      }
      // 没有积压：挂起，等 broadcast 或超时
      const waiter = client
      waiter.timer = setTimeout(() => {
        if (waiter.queue.length) {
          finishPoll(waiter)
          return
        }
        sendJson(waiter.req, waiter.res, 200, {
          ok: true,
          frames: [],
          // 同 finishPoll：超时返回也要用"此刻"的队列，否则手机拿回 25 秒前的快照。
          queueSync: queueSyncFrames(waiter.focused),
          status: Object.fromEntries(lastStatus),
          sessionsRev,
          cursor: cursorSnapshot(),
          serverTime: now(),
        })
        waiter.done = true
        clients.delete(waiter)
        pollWaiters.delete(waiter)
      }, POLL_HOLD_MS)
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
      pollWaiters.add(waiter)
      clients.add(waiter)
      req.on('close', () => finishPoll(waiter, true))
      res.on('error', () => finishPoll(waiter, true))
      return
    }

    if (path === '/api/state' && method === 'GET') {
      const sessions = await listSessions()
      const archived = archivedSessionIds()
      const visible = sessions.filter((session) => session.blank !== true && !archived.has(session.id))
      visible.sort((a, b) => b.updatedAt - a.updatedAt)
      const groups = workspaceGroups(new Set(visible.map((session) => session.id)))
      sendJson(req, res, 200, {
        ok: true,
        serverTime: now(),
        sessions: visible,
        // 与电脑版一致：按项目（工作区）分组。没有 registry 时是空数组，
        // 客户端会退化成"按 cwd 分组"，仍然不会退回到一长条平铺列表。
        groups,
        hiddenBlank: sessions.filter((session) => session.blank === true).length,
        hiddenArchived: sessions.filter((session) => archived.has(session.id)).length,
        // 让客户端把"我看到的会话表"与这个版本号绑定：之后收到的帧/长轮询响应里
        // 只要 sessionsRev 更大，就说明列表或归档集合变了，需要重新拉一次。
        sessionsRev,
      })
      return
    }

    if (path === '/api/catalog' && method === 'GET') {
      const catalog = await controller().modelCatalog()
      sendJson(req, res, 200, { ok: true, catalog })
      return
    }

    if (path === '/api/session' && method === 'POST') {
      const body = await readBody(req)
      const value = await controller().create({
        ...(typeof body.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {}),
        ...(typeof body.agentPreset === 'string' && body.agentPreset ? { agentPreset: body.agentPreset } : {}),
      })
      sendJson(req, res, 200, { ok: true, sessionId: value?.sessionId || '' })
      return
    }

      const pageMatch = /^\/api\/session\/([^/]+)\/page$/.exec(path)
    if (pageMatch && method === 'GET') {
      const sessionId = decodeURIComponent(pageMatch[1])
      const limitRaw = Number(url.searchParams.get('limit'))
      // 上限放宽到 60：宿主每接一次 page() 都要把会话回放一遍（代价与会话总长成正比），
      // 页越小就越浪费——真机上 1 条/页时"上滑加载更早记录"慢到不可用。
      const limit = Number.isFinite(limitRaw) ? Math.min(60, Math.max(1, Math.trunc(limitRaw))) : 20
      const beforeRaw = Number(url.searchParams.get('before'))
      const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : 0

      let eventsRaw = []
      let latest = 0
      let hasMore = false

      if (!before) {
        let snapshot = null
        try {
          snapshot = await withSignal((signal) => readSnapshot(sessionId, limit, signal), 20000)
        } catch (error) {
          log('snapshot failed', error instanceof Error ? error.message : String(error))
        }
        if (snapshot) {
          latest = typeof snapshot.cursor === 'number' ? snapshot.cursor : 0
          eventsRaw = Array.isArray(snapshot.records)
            ? snapshot.records.map((record) => record?.event || record)
            : []
          hasMore = snapshot.hasMore === true
        } else {
          const through = await latestSeq(sessionId)
          if (!through || through <= 0) {
            sendJson(req, res, 200, { ok: true, sessionId, latestSeq: 0, events: [], hasMore: false })
            return
          }
          const page = await withSignal((signal) => controller().page({
            address: { kind: 'session', sessionId },
            throughSeq: through,
            maxMessages: limit,
          }, signal), 20000)
          latest = through
          eventsRaw = Array.isArray(page?.records) ? page.records.map((record) => record?.event || record) : []
          hasMore = page?.hasMore === true
        }
      } else {
        let through = cursorCache.get(sessionId)
        if (typeof through !== 'number') through = await latestSeq(sessionId)
        if (!through || through <= 0) {
          sendJson(req, res, 200, { ok: true, sessionId, latestSeq: through || 0, events: [], hasMore: false })
          return
        }
        const page = await withSignal((signal) => controller().page({
          address: { kind: 'session', sessionId },
          throughSeq: through,
          beforeSeq: Math.min(before, through),
          maxMessages: limit,
        }, signal), 20000)
        latest = through
        eventsRaw = Array.isArray(page?.records) ? page.records.map((record) => record?.event || record) : []
        hasMore = page?.hasMore === true
      }

      const events = eventsRaw
        .filter((event) => event && typeof event.type === 'string' && !isNoise(event.type) && !isInjectedContext(event))
        .map((event) => trimEvent(event, config.maxEventChars))
        .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      sendJson(req, res, 200, {
        ok: true,
        sessionId,
        latestSeq: latest,
        events,
        hasMore,
      })
      return
    }

    const eventMatch = /^\/api\/session\/([^/]+)\/event\/(\d+)$/.exec(path)
    if (eventMatch && method === 'GET') {
      const sessionId = decodeURIComponent(eventMatch[1])
      const seq = Number(eventMatch[2])
      // ?full=1：用户在气泡下方点了"展开全文"，这时才拉不截断的完整内容。
      // 默认仍然走 trimEvent，保证列表接口不会被超长正文拖成几 MB。
      const wantFull = url.searchParams.get('full') === '1'
      const value = await withSignal((signal) => controller().inspect(sessionId, signal), 30000)
      const events = Array.isArray(value?.events) ? value.events : []
      const found = events.find((event) => event?.seq === seq)
      if (!found) {
        sendError(req, res, 404, '事件不存在')
        return
      }
      const event = wantFull ? fullEvent(found) : trimEvent(found, config.maxEventChars * 4)
      sendJson(req, res, 200, { ok: true, full: wantFull, event })
      return
    }

    const attachmentMatch = /^\/api\/attachment\/([a-f0-9]{64})$/.exec(path)
    if (attachmentMatch && method === 'GET') {
      const hash = attachmentMatch[1]
      const file = join(dshHome(), 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
      if (!existsSync(file)) {
        sendError(req, res, 404, '附件不存在')
        return
      }
      const data = readFileSync(file)
      res.writeHead(200, {
        'content-type': sniffMediaType(data),
        'content-length': data.length,
        'cache-control': 'private, max-age=31536000, immutable',
      })
      res.end(data)
      return
    }

    if (path === '/api/focus' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) {
        sendError(req, res, 400, '缺少会话')
        return
      }
      const set = focusSet(device)
      if (body.focus === false) set.delete(sessionId)
      else set.add(sessionId)
      sendJson(req, res, 200, { ok: true, focused: [...set] })
      return
    }

    if (path === '/api/prompt' && method === 'POST') {
      const body = await readBody(req, 24_000_000)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      // 图片走宿主 PromptContentPart 的 image 变体：{type:'image', mediaType, data(base64), name?}。
      // 这样手机拍/选的图会像电脑端粘贴图片一样进入会话，走宿主自己的附件存储。
      const images = Array.isArray(body.images)
        ? body.images
            .filter((image) => image && typeof image.data === 'string' && image.data.length > 0)
            .map((image) => ({
              type: 'image',
              mediaType: typeof image.mediaType === 'string' && image.mediaType ? image.mediaType : 'image/jpeg',
              data: image.data,
              ...(typeof image.name === 'string' && image.name ? { name: image.name } : {}),
            }))
        : []
      if (!sessionId || (!text && images.length === 0)) {
        sendError(req, res, 400, '缺少会话或消息内容')
        return
      }
      const mode = body.mode === 'steer' ? 'steer' : 'queue'
      await withSignal((signal) => controller().prompt({
        requestId: randomBytes(8).toString('hex'),
        sessionId,
        mode,
        content: [...(text ? [{ type: 'text', text }] : []), ...images],
        clientTimeZone: 'Asia/Shanghai',
      }, signal), 60000)
      sendJson(req, res, 200, { ok: true, mode, images: images.length })
      return
    }

    if (path === '/api/redirect' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!sessionId || !text) {
        sendError(req, res, 400, '缺少会话或消息内容')
        return
      }
      await withSignal((signal) => controller().prompt({
        requestId: randomBytes(8).toString('hex'),
        sessionId,
        mode: 'steer',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      }, signal), 20000)
      sendJson(req, res, 200, { ok: true })
      return
    }

    if (path === '/api/cancel' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) {
        sendError(req, res, 400, '缺少会话')
        return
      }
      await controller().cancel({ sessionId })
      sendJson(req, res, 200, { ok: true })
      return
    }

    if (path === '/api/model' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const provider = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      if (!sessionId || !provider || !model) {
        sendError(req, res, 400, '缺少会话或模型')
        return
      }
      const effort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort : ''
      const value = await controller().selectModel({
        sessionId,
        provider,
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
      })
      sendJson(req, res, 200, { ok: true, selected: value?.selected ?? null })
      return
    }

    if (path === '/api/answer' && method === 'POST') {
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const answers = Array.isArray(body.answers) ? body.answers : []
      const ok = resolveQuestion(id, answers.map((item) => ({
        id: String(item?.id ?? ''),
        selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
        ...(typeof item?.custom === 'string' && item.custom ? { custom: item.custom } : {}),
      })))
      sendJson(req, res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: '问答已失效' })
      return
    }

    if (path === '/api/queue' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!sessionId) {
        sendError(req, res, 400, '缺少会话')
        return
      }
      if (!queueState.has(sessionId) && !queueWarm.has(sessionId)) await rebuildQueue(sessionId)
      sendJson(req, res, 200, { ok: true, sessionId, items: queueItems(sessionId) })
      return
    }

    if (path === '/api/queue' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const itemId = typeof body.itemId === 'string' ? body.itemId : ''
      const action = body.action
      if (!sessionId || !itemId || !['edit', 'remove', 'steer'].includes(action)) {
        sendError(req, res, 400, '缺少会话/条目或动作不合法')
        return
      }
      try {
        if (action === 'edit') {
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text) {
            sendError(req, res, 400, '编辑内容不能为空')
            return
          }
          // 宿主的 edit 只接受 TextBlock[]：编辑一条带图片的排队消息 = 图片被永久丢弃。
          // 宁可明确拒绝，也不要静默吃掉用户的图。
          const queued = queueItems(sessionId).find((row) => row.itemId === itemId)
          if (queued && queued.imageCount > 0) {
            sendJson(req, res, 409, {
              ok: false,
              code: 'queue-image-locked',
              error: '这条排队消息带图片，编辑会丢失图片；请删除后重新发送',
            })
            return
          }
          await controller().updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text }] } })
          queueState.set(sessionId, queueItems(sessionId).map((item) => (item.itemId === itemId ? { ...item, text } : item)))
          queueBroadcast(sessionId)
        } else if (action === 'remove') {
          await controller().updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
          // 同 steer：用 hide 保住宿主侧索引，等 splice 到了再真正移除。
          queueState.hide(sessionId, itemId)
          queueBroadcast(sessionId)
        } else {
          await controller().updateQueue({ sessionId, itemId, action: { kind: 'steer' } })
          // 插话成功 = 这条消息已经离开 next-turn，进到当前这一步里了。
          // 注意用 hide 而不是 drop：宿主的 `spliced{next-turn, start, removedCount}`
          // 用的是**宿主侧索引**，本地真删会让索引左移、连带删掉后面排队的消息
          // （用户报的"插话一条，整列消失"）。hide 只隐藏，raw 列表保持完整。
          queueState.hide(sessionId, itemId)
          queueBroadcast(sessionId)
        }
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ''
        const message = error instanceof Error ? error.message : String(error)
        if (code === 'session/queue-item-not-found') {
          // 宿主已经不认这条了（被取走/被取消）：本地也摘掉，手机立刻对齐，
          // 不能让用户对着一条幽灵行反复点编辑/删除/插话。
          queueState.drop(sessionId, itemId)
          queueBroadcast(sessionId)
          sendJson(req, res, 409, { ok: false, code: 'queue-stale', error: message })
          return
        }
        if (code === 'session/steer-unavailable') {
          sendJson(req, res, 409, { ok: false, code: 'steer-unavailable', error: message })
          return
        }
        if (code === 'session/inbox-target-conflict' || /no longer pending/i.test(message)) {
          // 这条已经被别的路径取走/改掉了：本地摘掉，让手机与宿主一致。
          queueState.drop(sessionId, itemId)
          queueBroadcast(sessionId)
          sendJson(req, res, 409, { ok: false, code: 'queue-stale', error: message })
          return
        }
        throw error
      }
      sendJson(req, res, 200, { ok: true })
      return
    }

    sendError(req, res, 404, 'not found')
  }

  /* --------------------------------------------------------- bootstrap */

  const server = createServer((req, res) => {
    const started = now()
    const originalEnd = res.end.bind(res)
    res.end = (chunk, ...rest) => {
      try {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.length ?? 0
        store.countOut(bytes)
        const ms = now() - started
        if (ms > 3000) log('slow request', req.method, req.url, `${ms}ms`)
      } catch {}
      return originalEnd(chunk, ...rest)
    }
    handle(req, res).catch((error) => {
      const status = Number.isInteger(error?.status) ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) log('request failed', req.method, req.url, message)
      if (!res.headersSent) sendError(req, res, status >= 400 && status < 600 ? status : 500, message)
      else {
        try {
          res.end()
        } catch {}
      }
    })
  })

  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  server.on('error', (error) => {
    log('listener error', error?.code ?? '', error instanceof Error ? error.message : String(error))
  })

  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}  (配对页: http://127.0.0.1:${config.port}/admin)`)
  })

  /* --------------------------------------------------------- 订阅与清理 */

  const subscribe = (name, listener, options) => {
    try {
      const off = ctx.on(name, listener, { global: true, ...options })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      log('subscribe failed', name, error instanceof Error ? error.message : String(error))
    }
  }

  subscribe('session/event', onSessionEvent)
  subscribe('agent/status', onAgentStatus)
  subscribe('agent/assistant-stream', onAssistantStream)
  subscribe('user-questions/request', onUserQuestions, { prepend: true })
  subscribe('approval/request', onApprovalRequest, { prepend: true })
  subscribe('agent/inbox/inserted', onInboxInserted)
  subscribe('agent/inbox/claimed', onInboxGone)
  subscribe('agent/inbox/discarded', onInboxGone)

  /* 归档/取消归档、新建或删除会话都发生在 workspaceRegistry 的持久化状态里，宿主没有
   * 专门的"会话归档"事件。`domain/changed` 是唯一可靠的信号：宿主自己的 workspace 控制器
   * 也是靠它同步的（asar 里 `changed(change) { if (change.domain !== 'workspace') return; ... }`）。
   * 注意 table 是空字符串（整个 workspace domain 作为一个 put 提交），所以只能按 domain 过滤，
   * 否则归档变更会被漏掉、手机端列表永远不刷新。 */
  subscribe('domain/changed', (change) => {
    if (!change || change.domain !== 'workspace') return
    sessionsRev += 1
    broadcast('sessions', { at: now(), sessionsRev })
  })

  /* 兜底：`domain/changed` 只在 workspace 域**真的发生持久化写入**时才发。
   * 实测有些路径（例如新建一个还没归属工作区的空会话）并不会写这个域，
   * 而归档/取消归档一定改 registry 的内存状态。这里直接盯 registry 的只读 getter，
   * 2.5 秒比对一次签名，变了才广播 —— 内存读取，不发流量。 */
  let archivedSignature = null
  const watchArchive = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      if (!registry) return
      const ids = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []
      const signature = ids.join(',')
      if (archivedSignature === null) {
        archivedSignature = signature
        return
      }
      if (signature === archivedSignature) return
      archivedSignature = signature
      sessionsRev += 1
      broadcast('sessions', { at: now(), sessionsRev })
    } catch (error) {
      log('archive watch failed', error instanceof Error ? error.message : String(error))
    }
  }
  const archiveTimer = setInterval(watchArchive, 2500)
  if (typeof archiveTimer.unref === 'function') archiveTimer.unref()
  disposers.push(() => clearInterval(archiveTimer))

  const shutdown = () => {
    if (closed) return
    closed = true
    for (const off of disposers) {
      try {
        off()
      } catch {}
    }
    for (const client of [...clients]) {
      if (client.kind === 'poll') {
        finishPoll(client, true)
        continue
      }
      try {
        client.res.end()
      } catch {}
    }
    clients.clear()
    pollWaiters.clear()
    for (const entry of deltaBuf.values()) if (entry.timer) clearTimeout(entry.timer)
    deltaBuf.clear()
    for (const [id, entry] of pendingQuestions) {
      entry.closed = true
      clearTimeout(entry.timer)
      try {
        entry.reject(new Error('插件已停止'))
      } catch {}
      pendingQuestions.delete(id)
    }
    try {
      server.close()
    } catch {}
    store.flush()
    log('stopped')
  }

  // ---- DSH 界面里的手机配对按钮（侧边栏底部 + 二维码浮层）--------------------
  // 为什么走这条路：给本包装一个客户端半边（dsh.client + lib/client.js）必须重启 DSH，
  // 而重启会把正在用的会话一起杀掉。宿主半边改完 2 秒内就自动 reload，所以按钮借宿主的
  // 手塞进 DSH 页面：
  //   /mobile-pair/ui.js   返回 web/pair-panel.js（原生 DOM，跑在 DSH 页面里，同源）
  //   /mobile-pair/api/*   给那个脚本用的几个本机专用接口
  //   tapIndex             往 DSH 的 index.html 的 </body> 前插一个 module script
  // 注意：DSH 的命名路由不走它自己的 authorizeIndex，所以这里的接口必须自己做 loopback 校验。
  // 注意：`ctx.webServer` 这个属性是**代理**，只要 `webServer` 不在 inject 里，
  // 一读就 throw「cannot get property "webServer" without inject」——`||` 短路救不了。
  // 所以必须先 typeof 判断，且整个取值过程包在 try/catch 里。
  // 也不能把 webServer 写进 inject：纯 CLI 环境没有这个服务，硬依赖会让插件直接拒绝加载，
  // 同学那种环境就装不上了。取不到就只跳过侧边栏按钮，7788 端口照常工作。
  const getWebServer = () => {
    if (typeof ctx.webServer === 'object' && ctx.webServer) return ctx.webServer
    if (typeof ctx.get === 'function') return ctx.get('webServer')
    return undefined
  }
  let webServer
  try {
    webServer = getWebServer()
  } catch (error) {
    log('webServer 取不到（不影响手机端）:', error instanceof Error ? error.message : String(error))
    webServer = undefined
  }
  let pairRoutes = 0
  let pairTapOk = false

  if (webServer && typeof webServer.register === 'function') {
    const pairOrigin = () =>
      (config.publicOrigin || readTunnelUrl(config) || `http://${lanAddress()}:${config.port}`).replace(/\/+$/, '')

    /**
     * 二维码里要编的入口地址。`?origin=` 允许配对面板手动指定：
     * 多网卡 / VPN 网卡机器上自动挑的地址可能手机连不上，用户选哪个就用哪个。
     * 只接受 http(s) 且必须是本机已知的局域网或公网地址，避免被当成开放跳板。
     */
    const pairOriginFor = (url) => {
      const asked = String((url && url.searchParams.get('origin')) || '').replace(/\/+$/, '')
      if (!/^https?:\/\/[^\s/]+$/i.test(asked)) return pairOrigin()
      const allowed = new Set([
        pairOrigin(),
        ...lanAddresses().map((item) => `http://${item.address}:${config.port}`),
      ])
      return allowed.has(asked) ? asked : pairOrigin()
    }

    const issuePairCode = () => {
      const code = randomBytes(16).toString('hex')
      const expiresAt = now() + config.pairCodeTtlMs
      pairCodes.set(code, expiresAt)
      for (const [old, when] of pairCodes) if (when < now()) pairCodes.delete(old)
      return { code, expiresAt }
    }

    const activeDevices = () => store.list().filter((row) => row.revoked !== true)

    const serveJson = (res, status, value) => {
      if (res.writableEnded) return
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    const guard = (req, res) => {
      if (isLoopbackRequest(req)) return true
      serveJson(res, 403, { ok: false, error: '只能在电脑本机操作' })
      return false
    }

    const routes = []
    const addRoute = (path, handler) => {
      try {
        const dispose = webServer.register({ kind: 'exact', path, handler })
        if (typeof dispose === 'function') routes.push(dispose)
        pairRoutes += 1
      } catch (error) {
        log('pair route', path, 'failed:', error instanceof Error ? error.message : error)
      }
    }

    addRoute('/mobile-pair/ui.js', async (req, res) => {
      if (res.writableEnded) return
      try {
        const { readFile } = await import('node:fs/promises')
        const source = await readFile(join(WEB_DIR, 'pair-panel.js'), 'utf8')
        const body = Buffer.from(source, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        serveJson(res, 500, { ok: false, error: error instanceof Error ? error.message : '读取面板脚本失败' })
      }
    })

    addRoute('/mobile-pair/api/state', (req, res) => {
      if (!guard(req, res)) return
      serveJson(res, 200, {
        ok: true,
        rev: REV,
        devices: activeDevices(),
        origin: pairOrigin(),
        port: config.port,
        streams: clients.size,
        // 自动挑的局域网地址可能选错（VPN 网卡、多网卡机器），
        // 把候选都列给配对面板，连不上时用户能自己换一个。
        lans: lanAddresses().map((item) => `http://${item.address}:${config.port}`),
      })
    })

    addRoute('/mobile-pair/api/code', (req, res) => {
      if (!guard(req, res)) return
      const { code, expiresAt } = issuePairCode()
      serveJson(res, 200, { ok: true, code, expiresAt, url: `${pairOrigin()}/?t=${code}`, origin: pairOrigin() })
    })

    addRoute('/mobile-pair/api/qr.svg', async (req, res, url) => {
      if (!guard(req, res)) return
      const code = String((url && url.searchParams.get('t')) || '')
      if (!code) {
        serveJson(res, 400, { ok: false, error: '缺少配对码' })
        return
      }
      const target = pairOriginFor(url) + `/?t=${code}`
      try {
        const svg = qrCodec.toSvg(target, { margin: 2, width: 320 })
        const body = Buffer.from(svg, 'utf8')
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        serveJson(res, 500, { ok: false, error: error instanceof Error ? error.message : '生成二维码失败' })
      }
    })

    addRoute('/mobile-pair/api/revoke', async (req, res) => {
      if (!guard(req, res)) return
      // 「撤销其他设备」在电脑这边没法区分是哪台手机，索性全部撤掉，重新配一台。
      const killed = activeDevices().map((row) => row.id)
      for (const id of killed) {
        store.revoke(id)
        kickDevice(id, 'revoked')
      }
      log('pair panel revoked', killed.length)
      serveJson(res, 200, { ok: true, revoked: killed.length })
    })

    if (typeof webServer.tapIndex === 'function') {
      try {
        const disposeTap = webServer.tapIndex((html) =>
          String(html).replace('</body>', '<script type="module" src="/mobile-pair/ui.js"></script></body>'),
        )
        if (typeof disposeTap === 'function') routes.push(disposeTap)
        pairTapOk = true
        log('pair panel mounted into DSH index')
      } catch (error) {
        log('pair tapIndex failed:', error instanceof Error ? error.message : error)
      }
    } else {
      log('webServer.tapIndex 不可用，侧边栏按钮未挂载')
    }

    disposers.push(() => {
      for (const dispose of routes) {
        try {
          dispose()
        } catch {}
      }
    })
  } else {
    log('webServer 不可用，侧边栏按钮未挂载')
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => shutdown)
  else if (typeof ctx.on === 'function') ctx.on('dispose', shutdown)

  // ---- 反向隧道（让手机经云服务器公网 IP 访问本插件）------------------------
  // 关键：隧道必须由插件自己托管。以前用启动文件夹里的 powershell 监督进程，
  // 它会被宿主一起带走 —— DSH 一重启，手机就打不开，只能人工救。
  // 现在插件 apply 时拉起 ssh，shutdown 时杀掉，宿主恢复即自动恢复。
  const tunnelConfig = loadTunnelConfig(config, stateDir)
  if (tunnelConfig.enabled && tunnelConfig.server) {
    const t = tunnelConfig
    let child = null
    let timer = null
    const start = () => {
      if (closed) return
      if (!existsSync(t.sshPath)) {
        log('tunnel: ssh not found at', t.sshPath)
        return
      }
      if (t.keyPath && !existsSync(t.keyPath)) {
        log('tunnel: key not found at', t.keyPath)
        return
      }
      const args = ['-i', t.keyPath, '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes', '-N',
        '-R', `0.0.0.0:${t.remotePort}:127.0.0.1:${t.localPort}`,
        `${t.user}@${t.server}`]
      try {
        child = spawn(t.sshPath, args, { stdio: 'ignore', windowsHide: true })
      } catch (error) {
        log('tunnel: spawn failed:', error?.message || error)
        return
      }
      log('tunnel: started pid', child.pid, `-> ${t.server}:${t.remotePort}`)
      child.on('exit', (code) => {
        log('tunnel: exited', code, '- restarting in 15s')
        child = null
        if (closed) return
        timer = setTimeout(start, 15000)
        if (typeof timer.unref === 'function') timer.unref()
      })
      child.on('error', (error) => log('tunnel: error', error?.message || error))
    }

    start()
    disposers.push(() => {
      try { clearTimeout(timer) } catch {}
      const dying = child
      child = null
      if (dying && dying.exitCode === null) {
        try { dying.kill() } catch {}
      }
    })
  }

  // ---- 自加载（改完 lib/index.js 不必重启 DSH）------------------------------
  // 宿主自带的 HMR 在事务标记泄漏后会一直报 "HMR transactions cannot be nested"，
  // 而它只能由宿主进程重启清除。这里给插件自己留一条后路：先关掉当前实例
  // （取消所有事件订阅、关闭 7788 监听、清定时器），再用 ?v=<时间戳> 重新
  // import 本文件并 apply 一次。这样"改服务端代码 → 调一次接口"就生效。
  const reloadSelf = async (reason) => {
    log('reloading:', reason)
    try {
      shutdown()
    } catch {}
    const url = new URL(import.meta.url)
    url.searchParams.set('v', String(Date.now()))
    try {
      const mod = await import(url.href)
      await mod.apply(ctx, rawConfig)
      log('reloaded from', url.pathname + url.search)
      return
    } catch (error) {
      // 新代码有语法错/运行时错时，绝不能把服务留在"已关闭但没重开"的黑洞里：
      // 那个状态没有任何东西会再唤醒它（watcher 已被 shutdown 清掉），
      // 表现为端口直接消失、手机和隧道全部连不上。这里用当前这份还能跑的
      // 模块重新 apply 一次，把服务恢复，等下一次文件变动再试。
      log('reload failed, restoring previous instance:', error?.message || error)
    }
    try {
      await apply(ctx, rawConfig)
      log('restored previous instance')
    } catch (error) {
      log('restore failed:', error?.message || error)
    }
  }

  ACTIVE = { shutdown, reloadSelf }

  // ---- 自动重载（开发期）----------------------------------------------------
  // 每 2 秒看一眼 lib/index.js 的 mtime：变了就自己重载，
  // 这样"改代码 → 等两秒"就生效，完全不用碰 DSH 进程。
  // 另外看一个开关文件 z-reload-flag.txt：写 1 就立刻重载一次。
  // 宿主的 HMR 在用久了以后会卡死，这条开关是最省事的备用扳机。
  //
  // 只在 apply() 的**最后**才启动：以前它紧跟着 reloadSelf 定义就装上，
  // 而那段代码后面还有别的顶层声明。只要此刻 lib/index.js 正在被别人写，
  // 定时器就有机会在「watcher 已起、reloadSelf 还没定义」的窗口里触发，
  // 直接 ReferenceError 把宿主进程带崩。挪到函数末尾就没有这个窗口了。
  const startAutoReload = () => {
    const selfPath = fileURLToPath(import.meta.url)
    const flagPath = join(fileURLToPath(new URL('../', import.meta.url)), 'z-reload-flag.txt')
    let seenMtime = 0
    try {
      seenMtime = statSync(selfPath).mtimeMs
    } catch {}
    let seenFlag = ''
    try {
      seenFlag = readFileSync(flagPath, 'utf8').trim()
    } catch {}
    const watcher = setInterval(() => {
      if (closed) return
      let flag = ''
      try {
        flag = readFileSync(flagPath, 'utf8').trim()
      } catch {}
      if (flag && flag !== seenFlag) {
        seenFlag = flag
        log('reload flag triggered:', flag, 'pid', process.pid)
        reloadSelf('flag').catch((error) => log('flag reload failed:', error?.message || error))
        return
      }
      if (config.autoReload === false) return
      let mtime = 0
      try {
        mtime = statSync(selfPath).mtimeMs
      } catch {
        return
      }
      if (!mtime || mtime === seenMtime) return
      seenMtime = mtime
      log('detected change, reloading')
      reloadSelf('file-change').catch((error) => log('auto reload failed:', error?.message || error))
    }, 2000)
    if (typeof watcher.unref === 'function') watcher.unref()
    disposers.push(() => clearInterval(watcher))
  }

  startAutoReload()
}
