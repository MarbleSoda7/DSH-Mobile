/* 手机接管 DSH — PWA 前端
 * 本地优先：会话与事件写入 IndexedDB，进页面先渲染缓存，再用 seq 游标做增量补齐。
 */

const $ = (id) => document.getElementById(id)
const KEY_TOKEN = 'mr.token'
const KEY_NAME = 'mr.device'

const state = {
  token: '',
  deviceName: '',
  sessions: new Map(),
  // 项目（工作区）分组：服务端 /api/state 的 groups 字段，形状 {id,title,path,sessionIds}。
  // 空数组时 groupSessions() 会退化成按 cwd 分组。
  groups: [],
  // 用户手动折叠起来的项目分组（按 group.key 记），存 localStorage。
  collapsedGroups: new Set(),
  // 待发送的图片：{id, mediaType, data(base64), name, url(blob 预览)}。
  // 发送成功后清空；失败保留以便重试。
  attachments: [],
  running: new Map(),
  turnOpen: new Map(),
  // 每轮开始的时刻，用来算"已完成，用时 x"。
  turnStartedAt: new Map(),
  // 本轮是否已经插过"已完成，用时"汇总行：正文落地时插在正文之前，turn/end 只兜底补一次，
  // 不能每轮出现两条。
  turnSummaryDone: new Map(),
  cursors: {},
  current: '',
  es: null,
  transport: '',
  polling: false,
  pollTimer: 0,
  pollAbort: null,
  sseWatchdog: 0,
  retry: 0,
  retryTimer: 0,
  seen: new Set(),
  events: new Map(),
  // 每个会话已渲染到的最大 seq：增量事件比它小就是"迟到/乱序"，必须重排而不是 append。
  latestSeq: new Map(),
  pending: [],
  queues: new Map(),
  queueIndex: new Map(),
  // 上一次真正渲染出来的排队条下标：用来判断"是不是切换了"，切换才播淡入淡出。
  queueShownAt: new Map(),
  // 最近在本地改过/删过的排队条目：{ sessionId -> Map<itemId, {at, text?, removed?}> }。
  // 服务端快照可能比本地旧（长轮询挂起期间算的），这段时间内以本地为准。
  queueTouched: new Map(),
  // 电脑端插话先到的合成气泡：message.id -> DOM 节点。真 user/message 到达时按 id 替换。
  steerNodes: new Map(),
  editingQueue: '',
  // 分页状态：每会话"是否还有更早的历史"、"正在加载更早"、"已经翻到头的提示是否已画过"。
  // 上滑加载靠这三个字段，省流不代表看不到早期对话。
  older: new Map(),
  loadingOlder: new Set(),
  olderDone: new Set(),
  // 每会话"这一页已经加载过了、要等用户滚离顶部才允许再加载"的门闩。
  // 没有它时，内容不足一屏会在一次滑动里连续翻掉十几页（流量和卡顿都受不了）。
  olderArmed: new Map(),
  delta: { text: '', reasoning: '' },
  deltaNode: null,
  // 用户是否"贴在底部"：只有为真时，新内容/图片加载完成才允许自动滚到底。
  // 用户在翻历史时必须保持原位，否则会被不断拽回去（真机反馈过"抢滚动"）。
  pinBottom: true,
  // 键盘把视口压小之后，是否还要继续贴底（只在"点输入框之前就在底部"时为真）。
  keyboardPinned: false,
  // 点输入框那一刻的贴底状态（pointerdown 记下，focus 时取用）。
  bottomBeforeComposer: null,
  question: null,
  catalog: null,
  lastScrollTop: 0,
  lastFrameAt: 0,
}

/* ------------------------------------------------------------------ idb */

let db = null
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dsh-mobile-remote', 1)
    req.onupgradeneeded = () => {
      const store = req.result
      if (!store.objectStoreNames.contains('events')) store.createObjectStore('events', { keyPath: 'key' })
      if (!store.objectStoreNames.contains('sessions')) store.createObjectStore('sessions', { keyPath: 'id' })
      if (!store.objectStoreNames.contains('meta')) store.createObjectStore('meta', { keyPath: 'key' })
    }
    req.onsuccess = () => { db = req.result; resolve(db) }
    req.onerror = () => reject(req.error)
  })
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store)
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const idb = {
  put: (store, value) => wrap(tx(store, 'readwrite').put(value)),
  get: (store, key) => wrap(tx(store).get(key)),
  all: (store) => wrap(tx(store).getAll()),
  delete: (store, key) => wrap(tx(store, 'readwrite').delete(key)),
  prefix: (store, prefix) => wrap(tx(store).getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'))),
}

const eventKey = (sessionId, seq) => `${sessionId}|${String(seq).padStart(10, '0')}`

async function saveEvent(sessionId, event) {
  try {
    await idb.put('events', { key: eventKey(sessionId, event.seq), sid: sessionId, seq: event.seq, ev: event })
  } catch {}
}

async function saveSessions() {
  try {
    for (const session of state.sessions.values()) await idb.put('sessions', session)
  } catch {}
}

async function saveCursors() {
  try {
    await idb.put('meta', { key: 'cursors', value: state.cursors })
  } catch {}
}

/* --------------------------------------------------------------- helpers */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

// ---- 轻量 Markdown 渲染（零依赖；先转义再拼标签，避免 XSS） ----

/* 本地文件引用：电脑版 DSH 把 `[app.js:952](<D:\...\app.js#L952>)` 渲染成
 * "只有文件名+后缀"的超链接，绝对路径藏在链接里。
 * 手机端如果不做这件事，就会把一长串绝对路径原样铺在气泡里（用户 m00129）。
 * 这里统一渲染成小芯片：只显示文件名（+行号），点一下复制完整路径。
 * 注意（用户 m00358）：只处理"链接形式"的文件引用。行内代码里的纯路径保持原样，
 * 有时候就是要输出完整路径，不要去改。
 */
function isLocalFileTarget(value) {
  const target = String(value || '').trim()
  if (!target) return false
  // 带 scheme 的（http / https / mailto / data…）不是本地文件；但 `D:\` 这种单字母盘符是。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !/^[a-zA-Z]:[\\/]/.test(target)) return false
  if (/^[a-zA-Z]:[\\/]/.test(target)) return true
  if (target.startsWith('\\\\')) return true
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) return true
  // 剩下的是"看起来像文件"的相对路径（含扩展名且带分隔符）
  return /[\\/]/.test(target) && /\.[a-zA-Z0-9]{1,8}(?::\d+)?$/.test(target)
}

function splitFileTarget(value) {
  const raw = String(value || '').trim()
  const hash = raw.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/)
  if (hash) return { path: hash[1], line: hash[2], end: hash[3] || '' }
  const colon = raw.match(/^(.*?\.[a-zA-Z0-9]{1,8}):(\d+)(?:-(\d+))?$/)
  if (colon) return { path: colon[1], line: colon[2], end: colon[3] || '' }
  return { path: raw, line: '', end: '' }
}

function fileChipHtml(target, label) {
  const { path, line, end } = splitFileTarget(target)
  const base = path.split(/[\\/]/).filter(Boolean).pop() || path
  // 标签本身是短名（app.js:12）就用它；是一整条路径就退化成 basename。
  const rawLabel = String(label || '').trim()
  let name = rawLabel && !/[\\/]/.test(rawLabel) ? rawLabel : base
  const lineText = line ? `:${line}${end ? `-${end}` : ''}` : ''
  if (lineText && !name.endsWith(lineText) && !new RegExp(`:${line}(?:-${end || line})?$`).test(name)) name += lineText
  const full = line ? `${path}:${line}${end ? `-${end}` : ''}` : path
  return `<span class="file-chip" role="button" data-path="${escapeHtml(full)}">`
    + `<span class="file-chip-name">${escapeHtml(name)}</span></span>`
}

function mdInline(text) {
  // 先把链接 / 文件芯片抽出来存成占位符，再做转义：
  // 路径里的 `<` `>` `&` 经过 escapeHtml 就没法再解析链接了。
  const saved = []
  const protect = (html) => {
    saved.push(html)
    return `\u0001${saved.length - 1}\u0001`
  }
  const withLinks = String(text ?? '').replace(
    /\[([^\]\n]+)\]\(\s*<?([^)>\n]+?)>?\s*\)/g,
    (match, label, href) => {
      const target = String(href).trim()
      if (/^https?:\/\//i.test(target)) {
        return protect(`<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`)
      }
      if (isLocalFileTarget(target)) return protect(fileChipHtml(target, label))
      return match
    },
  )
  let html = escapeHtml(withLinks)
    // 双反引号代码段（`` `x` ``）：里面单个反引号是字面量。必须排在单反引号之前，
    // 否则外层 `` 会被当成空的 code 段，反引号当正文漏在屏幕上（用户截图里出现过）。
    .replace(/``\s?([^\n]+?)\s?``/g, '<code>$1</code>')
    // 行内代码一律原样显示（用户 m00358：纯路径不要去改，有些时候就是要输出完整路径）。
    // 只有"链接形式的文件引用"才变芯片——那本来在电脑端也是超链接。
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    // 裸链接（前面是行首/空白/左括号才算，避免把已生成 <a href="..."> 再包一层）
    .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
  // 还原占位符（可能是嵌套的，循环几次直到没有）
  for (let guard = 0; guard < 5 && /\u0001\d+\u0001/.test(html); guard += 1) {
    html = html.replace(/\u0001(\d+)\u0001/g, (match, index) => saved[Number(index)] ?? '')
  }
  return html
}

function mdTable(lines) {
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
  const head = cells(lines[0])
  const rows = lines.slice(2).map(cells)
  const headHtml = head.map((cell) => `<th>${mdInline(cell)}</th>`).join('')
  const bodyHtml = rows
    .map((row) => `<tr>${head.map((_, index) => `<td>${mdInline(row[index] ?? '')}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="md-table"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
}

function renderMarkdown(raw) {
  const src = String(raw ?? '')
  const fences = []
  const text = src.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (_, lang, body) => {
    fences.push({ lang, body })
    return `\u0000F${fences.length - 1}\u0000`
  })
  const lines = text.split(/\r?\n/)
  const out = []
  let i = 0
  const isFence = (line) => /^\u0000F\d+\u0000\s*$/.test(line.trim())
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // 围栏代码块
    const fence = line.trim().match(/^\u0000F(\d+)\u0000$/)
    if (fence) {
      const entry = fences[Number(fence[1])]
      out.push(`<pre class="md-pre"><code>${escapeHtml(String(entry?.body ?? '').replace(/\n$/, ''))}</code></pre>`)
      i++
      continue
    }
    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      // 保留真实的标题层级（以前统一降级到 h3~h6，导致 ### 只比正文大一点点，
      // 看起来像"没有标题"）。字号由 CSS 逐级给出，最小的 h6 也明显大于正文。
      out.push(`<h${heading[1].length}>${mdInline(heading[2])}</h${heading[1].length}>`)
      i++
      continue
    }
    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    // 引用
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i].replace(/^\s*>\s?/, '')), i++
      out.push(`<blockquote>${quote.map(mdInline).join('<br>')}</blockquote>`)
      continue
    }
    // 表格：分隔行必须是 |---|---|
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const block = [line, lines[i + 1]]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { block.push(lines[i]); i++ }
      out.push(mdTable(block))
      continue
    }
    // 列表（支持一层缩进；有序/无序混排时断开）
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      const sameKind = (value) => /^\s*\d+[.)]\s+/.test(value) === ordered
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && sameKind(lines[i])) {
        const depth = Math.min(2, Math.floor((lines[i].match(/^\s*/)?.[0].length ?? 0) / 2))
        const body = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        items.push(`<li class="lv${depth}">${mdInline(body)}</li>`)
        i++
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    // 段落（连续非空行合并，行内换行保留）
    const para = []
    while (i < lines.length && lines[i].trim() && !isFence(lines[i])) {
      const next = lines[i]
      if (/^(#{1,6})\s+/.test(next) || /^\s*>/.test(next) || /^\s*([-*+]|\d+[.)])\s+/.test(next)) break
      para.push(next)
      i++
    }
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`)
    else i++
  }
  return out.join('')
}

function renderText(text) {
  return renderMarkdown(text)
}

function ago(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function blocks(message) {
  return message && Array.isArray(message.content) ? message.content : []
}

function messageText(message) {
  return blocks(message).filter((block) => block.type === 'text').map((block) => block.text || '').join('\n').trim()
}

/* ------------------------------------------------------------ attachments */

// 图片用 fetch + blob 取：token 放 header，不写进 <img src>，也不进浏览器历史。
const imageUrls = new Map()

function attachmentHash(attachment) {
  const id = String(attachment?.attachmentId || '')
  const hash = id.includes(':') ? id.split(':').pop() : id
  return /^[0-9a-f]{64}$/i.test(hash) ? hash : ''
}

async function attachmentUrl(hash) {
  if (imageUrls.has(hash)) return imageUrls.get(hash)
  try {
    const res = await fetch(`/api/attachment/${hash}`, { headers: { authorization: `Bearer ${state.token}` } })
    if (!res.ok) return ''
    const url = URL.createObjectURL(await res.blob())
    imageUrls.set(hash, url)
    return url
  } catch {
    return ''
  }
}

function imageNode(attachment) {
  // 本地只知道"有几张图"（排队/插话的乐观渲染）：画占位块，别留空白。
  if (Number(attachment?.pendingCount) > 0) return pendingFigureNode(Number(attachment.pendingCount), '插话图片')
  // 本地待发送/刚发送的图片只有 blob 预览地址，没有 attachmentId —— 直接用它显示，
  // 否则乐观气泡里的图片会一直是"读取失败"。
  if (attachment?.previewUrl && !attachment?.attachmentId) {
    const preview = document.createElement('figure')
    preview.className = 'msg-figure'
    const thumb = document.createElement('img')
    thumb.className = 'msg-image'
    thumb.alt = attachment?.name || '图片'
    thumb.src = attachment.previewUrl
    preview.appendChild(thumb)
    return preview
  }
  const hash = attachmentHash(attachment)
  if (!hash) return null
  const wrap = document.createElement('figure')
  wrap.className = 'msg-figure'
  const img = document.createElement('img')
  img.className = 'msg-image'
  img.loading = 'lazy'
  img.decoding = 'async'
  img.alt = attachment?.name || '图片'
  if (attachment?.width) img.width = attachment.width
  if (attachment?.height) img.height = attachment.height
  wrap.appendChild(img)
  wrap.onclick = () => window.open(img.src, '_blank')
  // 图片是异步取回来的 blob，加载完成时高度才真正确定。若用户本来就在底部，
  // 要把视野跟着推到底，否则最后一张图会把"最新一条"顶出屏幕（进会话时尤其明显）。
  img.onload = () => {
    if (state.pinBottom) scrollBottom()
  }
  attachmentUrl(hash).then((url) => {
    if (url) img.src = url
    else wrap.textContent = `［图片 ${attachment?.name || hash.slice(0, 8)} 读取失败］`
  })
  return wrap
}

/* 图片占位块：排队/插话时本地只知道"有几张图"，拿不到图片本身
 * （服务端的排队快照只回 imageCount，不回 base64，省流量）。
 * 不占位的话，纯图片消息在气泡里就是一片空白，用户会以为图丢了。 */
function pendingFigureNode(count, hint = '图片') {
  const wrap = document.createElement('figure')
  wrap.className = 'msg-figure msg-figure-pending'
  wrap.textContent = `🖼 ${hint} ${count} 张`
  return wrap
}

/* ------------------------------------------------ attachments (image upload) */

// 从相册/相机选图 → 读成 base64 → 排进待发送列表。
// 直接走 prompt 的 image 内容块，不经过额外上传接口：少一次往返、省流量。
const ATTACH_MAX_BYTES = 6 * 1024 * 1024

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function renderAttachments() {
  const bar = $('attach-bar')
  if (!bar) return
  bar.innerHTML = ''
  const items = state.attachments
  bar.classList.toggle('hidden', items.length === 0)
  items.forEach((item, index) => {
    const cell = document.createElement('div')
    cell.className = 'attach-cell'
    const img = document.createElement('img')
    img.className = 'attach-thumb'
    img.src = item.url
    img.alt = item.name || '图片'
    cell.appendChild(img)
    const remove = document.createElement('button')
    remove.className = 'attach-remove'
    remove.type = 'button'
    remove.textContent = '×'
    remove.onclick = () => {
      const item2 = state.attachments[index]
      if (item2 && item2.url) URL.revokeObjectURL(item2.url)
      state.attachments.splice(index, 1)
      renderAttachments()
    }
    cell.appendChild(remove)
    bar.appendChild(cell)
  })
}

async function addFiles(files) {
  const list = Array.from(files || [])
  for (const file of list) {
    if (!file || !/^image\//.test(file.type || '')) {
      toast('只支持图片')
      continue
    }
    if (file.size > ATTACH_MAX_BYTES) {
      toast(`图片太大（${Math.round(file.size / 1024)}KB），请小于 6MB`)
      continue
    }
    try {
      const data = await readAsBase64(file)
      if (!data) continue
      state.attachments.push({
        id: `a${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mediaType: file.type || 'image/png',
        data,
        name: file.name || 'image',
        bytes: file.size,
        url: URL.createObjectURL(file),
      })
    } catch (error) {
      toast(error.message)
    }
  }
  renderAttachments()
}

function bindAttach() {
  const button = $('btn-attach')
  const input = $('file-input')
  if (button && input) {
    button.onclick = () => input.click()
    input.onchange = async () => {
      await addFiles(input.files)
      input.value = ''
    }
  }
}

function toast(text, ms = 2600) {
  const node = $('toast')
  node.textContent = text
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), ms)
}

/* 确认弹层：`await askConfirm('…', '继续')` → true / false。
 * 不用原生 confirm()：手机上它是浏览器弹窗，样式和 App 完全两张皮，
 * 而且部分内嵌浏览器会把它压到地址栏下面。 */
function askConfirm(message, okLabel = '确定', cancelLabel = '取消') {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'sheet confirm'
    const mask = document.createElement('div')
    mask.className = 'sheet-mask'
    const body = document.createElement('div')
    body.className = 'sheet-body confirm-body'
    const head = document.createElement('div')
    head.className = 'sheet-head'
    head.textContent = '提示'
    const content = document.createElement('div')
    content.className = 'sheet-content confirm-text'
    content.textContent = message
    const foot = document.createElement('div')
    foot.className = 'sheet-foot confirm-foot'
    const cancel = document.createElement('button')
    cancel.className = 'ghost-btn'
    cancel.type = 'button'
    cancel.textContent = cancelLabel
    const ok = document.createElement('button')
    ok.className = 'primary-btn'
    ok.type = 'button'
    ok.textContent = okLabel
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      root.remove()
      resolve(value)
    }
    cancel.onclick = () => finish(false)
    ok.onclick = () => finish(true)
    mask.onclick = () => finish(false)
    foot.append(cancel, ok)
    body.append(head, content, foot)
    root.append(mask, body)
    const host = $('app')
    if (host) host.appendChild(root)
    if (typeof ok.focus === 'function') ok.focus()
  })
}

/* 复制到剪贴板。
 * 公网入口是 http://<IP>:7788，不是安全上下文，navigator.clipboard 直接不存在，
 * 所以必须带 execCommand('copy') 兜底，否则手机上点了文件芯片毫无反应。 */
async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (error) {
    // 落到下面的 execCommand 兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch (error) {
    return false
  }
}

function showView(name) {
  for (const view of ['pair', 'list', 'chat']) $(`view-${view}`).classList.toggle('hidden', view !== name)
}

function setConn(mode, text) {
  const node = $('conn-state')
  node.className = `conn ${mode || ''}`
  node.querySelector('span').textContent = text || (mode === 'on' ? '已连接' : mode === 'off' ? '断开' : '连接中')
}

/* ------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    logout('绑定已失效，请重新扫码')
    throw new Error('绑定已失效，请重新扫码')
  }
  if (!res.ok || data.ok === false) {
    const error = new Error(data.error || `HTTP ${res.status}`)
    if (typeof data.code === 'string') error.code = data.code
    throw error
  }
  return data
}

/* 服务端给外壳（/ 的 index.html）加了一道闸门：没有配对码、也没有设备 cookie 就返回 404，
 * 免得任何人扫到这个 IP:端口 都能看到"这里有台 DSH 的配对页"。
 * 所以拿到 token 之后要把它同步成一个 cookie；JS 这边重装/清缓存后只要 localStorage 还在，
 * 下一次成功加载就会把 cookie 补回去。 */
function rememberDeviceCookie(token) {
  if (!token) return
  try {
    document.cookie = `mr_dev=${encodeURIComponent(token)}; path=/; max-age=31536000; samesite=lax`
  } catch {}
}

function logout(reason) {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_NAME)
  state.token = ''
  closeTransport()
  showView('pair')
  const node = $('pair-error')
  if (node) {
    if (reason) {
      node.textContent = reason
      node.classList.remove('hidden')
    } else {
      node.textContent = ''
      node.classList.add('hidden')
    }
  }
}

/* --------------------------------------------------------------- pairing */

function guessName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  return '手机'
}

async function pair(code) {
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), name: localStorage.getItem(KEY_NAME) || guessName() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || '配对失败')
  state.token = data.token
  state.deviceName = data.name || ''
  localStorage.setItem(KEY_TOKEN, data.token)
  localStorage.setItem(KEY_NAME, state.deviceName)
  rememberDeviceCookie(data.token)
  return data
}

/* ----------------------------------------------------------- session list */

// 把会话按"项目（工作区）"归类，和电脑版一致。
// 分组归属由服务端从 workspaceRegistry 取（groups 字段）；
// 万一宿主没装 registry，就退化成按 cwd 的最后一段目录名分组，绝不退回一长条平铺。
function groupSessions(items) {
  const byId = new Map(items.map((session) => [session.id, session]))
  const groups = []
  const used = new Set()
  for (const group of state.groups || []) {
    const members = []
    for (const id of group.sessionIds || []) {
      const session = byId.get(id)
      if (!session || used.has(id)) continue
      used.add(id)
      members.push(session)
    }
    if (members.length === 0) continue
    members.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    groups.push({ key: group.id || group.path || group.title, title: group.title || '未命名项目', path: group.path || '', sessions: members })
  }
  // 兜底：没归属到任何 workspace 的会话（API 直接创建的、工作区被解绑过的）按 cwd 归堆。
  // 但如果某个 workspace 的 path 与这些 cwd 相同，必须**并进已有的那一组**，
  // 否则列表里会出现两个同名项目（"guide-dog-peta" 两份），手机上看起来像重复。
  const normPath = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
  const groupsByPath = new Map()
  for (const group of groups) {
    const pathKey = normPath(group.path)
    if (pathKey) groupsByPath.set(pathKey, group)
  }
  const loose = new Map()
  for (const session of items) {
    if (used.has(session.id)) continue
    const cwd = session.cwd || ''
    const sameProject = cwd ? groupsByPath.get(normPath(cwd)) : null
    if (sameProject) {
      used.add(session.id)
      sameProject.sessions.push(session)
      continue
    }
    const key = cwd || '__none__'
    if (!loose.has(key)) {
      loose.set(key, { key, title: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '未归类', path: cwd, sessions: [] })
    }
    loose.get(key).sessions.push(session)
  }
  for (const group of groups) {
    if (group.sessions.length > 1) {
      group.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    }
  }
  for (const group of loose.values()) {
    group.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    groups.push(group)
  }
  // 双保险：path 写法不同但标题同名的两块，再合成一块。
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const current = groups[index]
    if (groupsByPath.has(normPath(current.path))) continue
    const twin = groups.findIndex((other, otherIndex) => (
      otherIndex < index
      && other.title === current.title
      && other.sessions.length > 0
      && current.sessions.length > 0
    ))
    if (twin === -1) continue
    groups[twin].sessions.push(...current.sessions)
    groups[twin].sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    groups.splice(index, 1)
  }
  groups.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0))
  return groups
}

function sessionRow(session) {
  const running = state.running.get(session.id) ?? session.running
  const row = document.createElement('div')
  row.className = 'session-item'
  const title = session.title || '未命名会话'
  const model = session.model ? `${session.model.model}${session.model.reasoningEffort ? ' · ' + session.model.reasoningEffort : ''}` : ''
  row.innerHTML = `
      <div class="session-head">
        <div class="session-title">${escapeHtml(title)}</div>
        ${running ? '<span class="tag run">运行中</span>' : ''}
      </div>
      <div class="session-meta">
        <span>${ago(session.updatedAt)}</span>
        ${model ? `<span class="tag">${escapeHtml(model)}</span>` : ''}
      </div>`
  row.onclick = () => openChat(session.id)
  return row
}

function renderSessions() {
  const list = $('session-list')
  list.innerHTML = ''
  const items = Array.from(state.sessions.values())
    .filter((session) => session && session.blank !== true)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  $('list-empty').classList.toggle('hidden', items.length > 0)
  for (const group of groupSessions(items)) {
    const collapsed = state.collapsedGroups.has(group.key)
    const box = document.createElement('div')
    box.className = `session-group${collapsed ? ' collapsed' : ''}`
    const head = document.createElement('button')
    head.className = 'group-head'
    head.innerHTML = `
      <span class="group-chev">⌄</span>
      <span class="group-title">${escapeHtml(group.title)}</span>
      <span class="group-count">${group.sessions.length}</span>`
    head.onclick = () => {
      if (state.collapsedGroups.has(group.key)) state.collapsedGroups.delete(group.key)
      else state.collapsedGroups.add(group.key)
      persistCollapsedGroups()
      renderSessions()
    }
    box.appendChild(head)
    const body = document.createElement('div')
    body.className = 'group-body'
    for (const session of group.sessions) body.appendChild(sessionRow(session))
    box.appendChild(body)
    list.appendChild(box)
  }
}

function persistCollapsedGroups() {
  try {
    localStorage.setItem('mr.collapsedGroups', JSON.stringify(Array.from(state.collapsedGroups)))
  } catch {}
}

async function refreshState() {
  const data = await api('/api/state')
  for (const session of data.sessions) {
    state.sessions.set(session.id, session)
    if (typeof session.running === 'boolean') state.running.set(session.id, session.running)
  }
  // 服务端已经删掉/归档掉的会话，本地一并清掉。
  // 不清的话它会以"本地记忆"的形式永远留在列表里（服务端已经过滤了归档，
  // 这里不清就等于归档永远不生效）。
  const alive = new Set(data.sessions.map((session) => session.id))
  const dropped = []
  for (const id of Array.from(state.sessions.keys())) {
    if (alive.has(id)) continue
    state.sessions.delete(id)
    dropped.push(id)
  }
  for (const id of dropped) await idb.delete('sessions', id).catch(() => {})
  state.groups = Array.isArray(data.groups) ? data.groups : []
  if (typeof data.sessionsRev === 'number') state.sessionsRev = Math.max(state.sessionsRev || 0, data.sessionsRev)
  state.sessionsStale = false
  saveSessions()
  renderSessions()
  if (state.current) renderChatHeader()
}

async function loadLocalSessions() {
  try {
    const rows = await idb.all('sessions')
    for (const row of rows) if (row && row.id) state.sessions.set(row.id, row)
    renderSessions()
  } catch {}
}

/* ------------------------------------------------------------------ chat */

function clearTranscript() {
  $('transcript').innerHTML = ''
  state.deltaNode = null
}

function scrollBottom(force = true) {
  const box = $('transcript')
  if (!force) return
  // 用 scrollHeight 而不是 scrollIntoView：后者在有软键盘/固定输入栏时会算错位置。
  box.scrollTop = box.scrollHeight
  state.pinBottom = true
}

function nearBottom() {
  const box = $('transcript')
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120
}

// 进入会话/收到推送后，若用户本来就贴在底部，就保持"贴底"；用户往上翻历史时
// 立刻解除贴底，避免被新内容或图片加载拽回最下面。
function syncPin() {
  state.pinBottom = nearBottom()
}

/* ---------------------------------------------------------- 软键盘 / 贴底 */

/* 点输入框弹键盘时，可视区域被压小，时间线底部就藏到输入法后面了（用户反馈：
 * "输入框被抬高，底部被遮挡"）。这里做两件事：
 *
 *   1) 布局补偿：支持 `interactive-widget=resizes-content` 的浏览器（Android Chrome）
 *      会自己缩布局视口，innerHeight 跟着变小，算出来的 inset 就是 0，不重复垫高；
 *      不支持的浏览器（iOS Safari 等）布局视口不动，就用 visualViewport 算出差值，
 *      垫到 `.view` 的 padding-bottom 上，输入框才真的在键盘上方。
 *   2) 重新贴底：只有"点输入框之前本来就贴在底部"时才贴。用户正在翻历史时点输入框，
 *      绝不能把他拽回最新一条。
 *
 * 判断"本来就贴底"必须用 pointerdown 那一刻：键盘引起的布局变化会抖动 scroll 事件，
 * scroll 监听会把 pinBottom 改成 false，等 focus 里再量就已经晚了。 */
function keyboardInset() {
  const viewport = window.visualViewport
  if (!viewport) return 0
  const covered = (window.innerHeight || 0) - (viewport.height || 0) - (viewport.offsetTop || 0)
  // 小于 80px 的差值当作地址栏伸缩之类的噪音，别为它垫底。
  return covered > 80 ? Math.round(covered) : 0
}

function setKeyboardInset(inset) {
  const style = document.documentElement && document.documentElement.style
  if (style && typeof style.setProperty === 'function') style.setProperty('--kb-h', `${inset}px`)
}

/** 键盘高度变了（弹出/收起/换输入法）：补偿布局，必要时重新贴底。 */
function applyKeyboardInset() {
  setKeyboardInset(keyboardInset())
  if (state.keyboardPinned) scrollBottom()
}

function bindKeyboardRepin() {
  const area = $('composer')
  if (area) {
    // pointerdown 早于 focus，也早于键盘带来的任何布局变化：用它记下"点之前是否贴底"。
    area.addEventListener('pointerdown', () => {
      state.bottomBeforeComposer = nearBottom()
    })
    area.addEventListener('focus', () => {
      const wasBottom = state.bottomBeforeComposer === null
        ? (state.pinBottom || nearBottom())
        : state.bottomBeforeComposer
      state.bottomBeforeComposer = null
      state.keyboardPinned = wasBottom
      // 键盘动画几百毫秒，有的浏览器只在中途发一次 resize，所以分几拍补贴底。
      for (const delay of [60, 180, 360, 600]) {
        setTimeout(() => {
          if (state.keyboardPinned) {
            setKeyboardInset(keyboardInset())
            scrollBottom()
          }
        }, delay)
      }
    })
    area.addEventListener('blur', () => {
      state.keyboardPinned = false
      setKeyboardInset(0)
      // 收起键盘后布局回到原样，贴底状态要保持住。
      if (state.pinBottom) setTimeout(() => scrollBottom(), 60)
    })
  }
  const viewport = window.visualViewport
  if (viewport && typeof viewport.addEventListener === 'function') {
    viewport.addEventListener('resize', applyKeyboardInset)
    viewport.addEventListener('scroll', applyKeyboardInset)
  }
  window.addEventListener('resize', applyKeyboardInset)
}

function renderChatHeader() {
  const session = state.sessions.get(state.current)
  $('chat-title').textContent = session?.title || '会话'
  const model = session?.model ? `${session.model.model || session.model.provider}` : ''
  const effort = session?.model?.reasoningEffort || ''
  const running = state.running.get(state.current) === true
  $('chat-sub').textContent = [session?.model?.provider, model, effort].filter(Boolean).join(' · ')
  $('btn-stop').classList.toggle('hidden', !running)
  // 输入框右侧的模型键：固定只显示"模型"两个字（模型名太长会挤掉输入框），
  // 点开是切换面板；运行中只换颜色，不改文案。
  $('btn-model').classList.toggle('running', running)
}

function makeMessageNode(role) {
  const node = document.createElement('div')
  node.className = `msg ${role}`
  // 标记成"回答气泡"：turn/end 要把「已完成，用时 x」插在它前面（电脑版顺序），
  // 靠这个类往回找，而不是靠位置猜。
  if (role === 'assistant') node.classList.add('answer')
  return node
}

// 本轮最后一条正式回答的节点：汇总行插在它前面。
// 找不到（纯过程轮、被中止）就返回 null，由 appendTurnSummary 追加到末尾。
function lastAnswerNode(box) {
  const children = Array.from(box.children || [])
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const node = children[i]
    if (node.classList && node.classList.contains('msg') && node.classList.contains('assistant') && node.classList.contains('answer')) return node
  }
  return null
}

function appendDivider(text, isError) {
  const node = document.createElement('div')
  node.className = `divider${isError ? ' err' : ''}`
  node.textContent = text
  $('transcript').appendChild(node)
}

function appendEvent(event, target = null) {
  const sessionId = state.current
  if (!event || typeof event !== 'object' || event.sessionId && event.sessionId !== sessionId) return
  if (!event.optimistic && typeof event.seq === 'number') {
    if (state.seen.has(event.seq)) return
    state.seen.add(event.seq)
  }
  const box = target || $('transcript')
  const stick = target ? false : nearBottom()
  const data = event.data || {}

  switch (event.type) {
    case 'user/message': {
      // 宿主注入的运行时上下文 / 时间采样，role 也是 user，但电脑版不显示，手机端同样丢弃。
      const sourceKind = data.source?.kind || data.message?.source?.kind || ''
      if (sourceKind && sourceKind !== 'user') return
      // 电脑端插话：服务端先用 `steer` 帧推了一个同 id 的合成气泡，这里换成真事件。
      const id = data.id || data.message?.id || ''
      if (id && state.steerNodes.has(id)) {
        state.steerNodes.get(id)?.remove()
        state.steerNodes.delete(id)
      }
      const node = makeMessageNode('user')
      node.appendChild(roleNode('你'))
      // 宿主历史里的 user/message 是扁平的（content/role 直接在 data 上），
      // 少数路径会包一层 data.message，两种都要认，否则"我"发的消息永远不显示。
      const rendered = renderContent(node, data.message || data, { sessionId: event.sessionId || sessionId, seq: event.seq })
      if (!rendered) return
      box.appendChild(node)
      break
    }
    case 'assistant/message': {
      // 正文开始落地 = 这一轮的过程结束：思考/工具行全部收起（电脑版行为）。
      collapseProcessRows()
      // 思考行画在气泡外面，和工具调用同层级（小灰字），不套气泡。
      const thought = appendReasoningRows(box, data.message, { sessionId: event.sessionId || sessionId, seq: event.seq })
      const node = makeMessageNode('assistant')
      node.appendChild(roleNode('DSH'))
      const rendered = renderContent(node, data.message, { sessionId: event.sessionId || sessionId, seq: event.seq })
      if (rendered) box.appendChild(node)
      else if (!thought) return
      break
    }
    case 'tool/call': {
      box.appendChild(toolCallRow(data))
      break
    }
    case 'tool/ptc-dispatch-start':
    case 'tool/ptc-dispatch': {
      // 一次 run_code 里的嵌套子调用：与电脑端一致，画成缩进的一行行。
      const wrap = subCallRow(data)
      if (wrap) box.appendChild(wrap)
      break
    }
    // 老服务端可能已经把 ptc 事件改写成工具调用/子调用，两种都兜住。
    case 'tool/subcall': {
      const wrap = subCallRow(data)
      if (wrap) box.appendChild(wrap)
      break
    }
    case 'tool/result': {
      const updated = toolResultRow(data)
      // 找回对应调用行就地更新时返回 null，此时不新增"已完成"行。
      if (updated) box.appendChild(updated)
      break
    }
    case 'turn/start': {
      // 一轮的起点标记：只是"整轮展开/收起"的边界，本身不显示内容。
      const mark = document.createElement('div')
      mark.className = 'turn-mark'
      box.appendChild(mark)
      state.turnStartedAt.set(sessionId, Number(event.time) || Date.now())
      break
    }
    case 'turn/end': {
      const reason = data.reason?.kind || ''
      // 正文已落地：过程行全部收起。
      collapseProcessRows()
      // 汇总行的位置要跟电脑版一致：过程行 → 「已完成，用时 x」→ 正式回答。
      // 所以插在**本轮最后一条 assistant 气泡之前**，而不是追加在整轮最末尾
      // （追加在末尾会变成"回答完了才说已完成"，用户 m07850 明确要求改掉）。
      appendTurnSummary(event.time, lastAnswerNode(box))
      state.turnStartedAt.delete(state.current)
      if (reason === 'aborted') appendDivider('— 本轮已终止 —', false)
      else if (reason === 'error') appendDivider(`— 出错：${escapeHtml(String(data.reason?.error?.message || '').slice(0, 120))} —`, true)
      break
    }
    default:
      return
  }
  if (stick) scrollBottom()
}

/* --------------------------------------------------- 时间线行（电脑版同构） */

const EV_ICONS = { cmd: '›', read: '⧉', edit: '✎', write: '✎', search: '⌕', web: '⌕', tool: '✕' }

/* 服务端 summarizeToolCall 的兜底动词（老服务端 / 缺 summary 时用）。 */
const FALLBACK_VERBS = {
  pwsh: '运行命令',
  shell: '运行命令',
  bash: '运行命令',
  run_code: '运行代码',
  read: '读取',
  write: '写入',
  edit: '编辑',
  grep: '搜索',
  glob: '查找文件',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  compress: '压缩上下文',
  record_experience: '记录经验',
  search_experience: '检索经验',
  todo_write: '更新清单',
  present: '产出文件',
  subagent: '派发子任务',
  subagent_fork: '派发子任务',
}

const TOOL_ICONS = { 运行命令: '›', 运行代码: '›', 读取: '⧉', 写入: '✎', 编辑: '✎', 搜索: '⌕', 查找文件: '⌕', 联网搜索: '⌕', 抓取网页: '⌕', 压缩上下文: '⤓', 产出文件: '▣' }

function fallbackVerb(name) {
  return FALLBACK_VERBS[name] || String(name || '工具')
}

function iconFor(summary, name) {
  const verb = summary?.verb || fallbackVerb(name)
  return TOOL_ICONS[verb] || '✕'
}

function roleNode(text) {
  const node = document.createElement('div')
  node.className = 'role'
  node.textContent = text
  return node
}

function eventRow({ icon, verb, target, extra, className = '' }) {
  const row = document.createElement('div')
  // 必须带 `ev-row`：样式表里所有过程行规则（灰色、12.5px、单行 flex）都挂在 .ev-row 上。
  // 曾经这里写成 `ev`，没有任何规则命中，于是"编辑/读取/已完成"退化成白色 15px 正文，
  // 也不会排在同一行。
  row.className = `ev-row ${className}`.trim()
  // 用 createElement 逐个建节点而不是拼 innerHTML：
  // 结算事件要回头改这一行里的图标/动作词（把"运行命令"变成带结果的那一行），
  // 拼 innerHTML 之后就拿不到那些 span 了。
  const iconEl = document.createElement('span')
  iconEl.className = 'ev-ico'
  iconEl.textContent = icon
  row.appendChild(iconEl)

  const verbEl = document.createElement('span')
  verbEl.className = 'ev-verb'
  verbEl.textContent = verb
  row.appendChild(verbEl)

  if (target) {
    const dot = document.createElement('span')
    dot.className = 'ev-dot'
    dot.textContent = '·'
    row.appendChild(dot)
    const targetEl = document.createElement('span')
    targetEl.className = 'ev-target'
    targetEl.textContent = target
    row.appendChild(targetEl)
  }

  if (extra) {
    const extraEl = document.createElement('span')
    extraEl.className = 'ev-extra'
    extraEl.textContent = extra
    row.appendChild(extraEl)
  }
  return row
}

function expandable(row, body, className = '') {
  const wrap = document.createElement('div')
  wrap.className = `ev-wrap ${className}`.trim()
  wrap.appendChild(row)
  if (body) {
    const pre = document.createElement('pre')
    pre.className = 'ev-detail'
    pre.textContent = body
    wrap.appendChild(pre)
    row.onclick = () => wrap.classList.toggle('open')
  }
  return wrap
}

// 正文落地后，把这一轮里还展开着的过程行（思考/工具）全部收起：
// 电脑版就是这个行为，长回答时不会让一堆细节把正文挤走。
// 除了 .ev-wrap，还要处理 <details>（流式思考块），否则"输出完成后收起所有思考"做不到。
function collapseProcessRows() {
  const box = $('transcript')
  for (const node of box.children) {
    if (!node.classList) continue
    if (node.classList.contains('ev-wrap') && node.classList.contains('open')) {
      node.classList.remove('open')
    }
    if (node.classList.contains('msg')) {
      for (const detail of node.querySelectorAll('details')) {
        if (detail.open) detail.open = false
      }
    }
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

// 一轮结束给一行分隔式的"已完成，用时 x"（电脑版同款）：
// 点这一行会把本轮的所有思考/工具行整批展开或收起。
//
// 位置很关键（用户 m07850 的要求）：电脑版是「过程全部收起 → 一行"已完成，用时 xx"
// → 正式回答」。所以正文落地时就要把这条汇总行插在**正文之前**，而不是等 turn/end
// 之后追加在最后（那样汇总行会跑到回答下面，看起来像"回答完了才说已完成"）。
function appendTurnSummary(endAt, before = null) {
  const started = state.turnStartedAt.get(state.current) || 0
  const end = Number(endAt) || Date.now()
  const ms = started ? end - started : 0
  const label = ms > 0 ? `已完成，用时 ${formatDuration(ms)}` : '已完成'
  const row = document.createElement('div')
  row.className = 'turn-summary'
  row.innerHTML = `<span class="turn-summary-text">${escapeHtml(label)}</span><span class="ev-chev">⌄</span>`
  row.onclick = () => toggleTurnProcess(row)
  const host = $('transcript')
  const parent = before ? (before.parentNode || before.parent || null) : null
  if (before && parent === host) host.insertBefore(row, before)
  else host.appendChild(row)
  // 汇总行一落地就把这一轮的过程行藏起来（一级收起）：
  // 屏幕上只剩「已完成，用时 x」和正式回答，过程信息点一下才露缩略、再点才露全文。
  stowTurnProcess(row)
  state.turnSummaryDone.set(state.current, true)
  return row
}

// 这一轮里属于「已完成」的过程行（思考 / 运行命令 / 读取 / 编辑 …），只收 .ev-wrap，
// 正文气泡、分隔线、上一个 turn-mark 之前的都不动。
// 结构上优先认「汇总行下面的连续 ev-wrap」（stowTurnProcess 会把它们挪到下面），
// 同时兼容汇总行上面的老位置，这样无论谁先跑都能收干净。
function turnProcessNodes(summaryRow) {
  const box = $('transcript')
  const children = Array.from(box.children || [])
  const index = children.indexOf(summaryRow)
  if (index < 0) return []
  const targets = []
  // 1) 汇总行上方：往上数到本轮 turn-mark / 上一条正文为止
  let back = index - 1
  while (back >= 0) {
    const node = children[back]
    if (node.classList && (node.classList.contains('turn-mark') || node.classList.contains('msg'))) break
    if (node.classList && node.classList.contains('ev-wrap')) targets.unshift(node)
    back -= 1
  }
  // 2) 汇总行下方：往下数到「正文气泡 / 下一轮」为止
  let forward = index + 1
  while (forward < children.length) {
    const node = children[forward]
    if (node.classList && (node.classList.contains('turn-mark') || node.classList.contains('msg') || node.classList.contains('turn-summary'))) break
    if (node.classList && node.classList.contains('ev-wrap')) targets.push(node)
    forward += 1
  }
  return targets
}

// 一级收起（默认态）：把这一轮的过程行整批藏进「已完成，用时 x」这一行里。
// 注意这里不用 .open —— .open 是二级状态（展开某一条的完整内容）。
// 一级只做"从屏幕上撤掉"，屏幕上只剩一行「已完成」+ 正式回答。
function stowTurnProcess(summaryRow) {
  const box = $('transcript')
  const targets = turnProcessNodes(summaryRow)
  // 位置很关键（用户 m00261）：过程行必须排在汇总行**下面**。
  // 原来它们在汇总行上面，一级展开时内容把标题顶下去一大截，
  // 「已完成 / 已思考」跑到屏幕外，想收起还得往下翻回去找。
  // 现在统一挪到汇总行之后：展开就往标题下方长，标题原地不动，点一下就能收起。
  let anchor = summaryRow
  for (const node of targets) {
    if (node.previousSibling === anchor) {
      anchor = node
      continue
    }
    box.insertBefore(node, anchor.nextSibling)
    anchor = node
  }
  for (const node of targets) {
    node.classList.add('ev-stowed')
    node.classList.remove('open')
    const row = node.children && node.children[0]
    if (row && row.setAttribute) row.setAttribute('aria-expanded', 'false')
  }
  summaryRow.classList.remove('open')
}

// 点「已完成，用时 x」：一级展开 / 收起。
//   展开 → 露出这一轮的过程行缩略（「✦ 思考 · 前 60 字…」「› 运行命令 · 描述 · 143 字」）；
//   收起 → 再整批藏回去。
// 二级展开是点其中某一行（.ev-wrap 的 row.onclick），才显示完整思考 / 命令内容。
function toggleTurnProcess(summaryRow) {
  const targets = turnProcessNodes(summaryRow)
  const stowed = targets.some((node) => node.classList.contains('ev-stowed'))
  for (const node of targets) {
    node.classList.toggle('ev-stowed', !stowed)
    // 一级切换时把二级状态也归零：展开后先看到的是缩略行，
    // 而不是上一次留下的某条完整内容。
    node.classList.remove('open')
    const row = node.children && node.children[0]
    if (row && row.setAttribute) row.setAttribute('aria-expanded', stowed ? 'true' : 'false')
  }
  summaryRow.classList.toggle('open', stowed)
}

function toolCallRow(data) {
  const name = String(data.name || '')
  const summary = data.summary || null
  const verb = summary?.verb || fallbackVerb(name)
  const target = summary?.target ?? String(data.arguments || '')
  const row = eventRow({
    icon: iconFor(summary, name),
    verb,
    target,
    extra: summary?.extra || '',
  })
  const args = data.arguments ? String(data.arguments) : ''
  const wrap = expandable(row, args && args !== '{}' ? prettyArgs(args) : '', 'ev-tool')
  // 记下 callId：结算事件到达时就地更新这一行，而不是再追加一条"已完成"。
  // 电脑版一次工具调用只有一行；手机端原来是"运行命令 + 已完成"两行，
  // 看起来就像一直在"思考→运行命令→已完成"地打转。
  const callId = String(data.callId || '')
  if (callId) wrap.dataset.call = callId
  return wrap
}

// run_code 里的嵌套工具调用（读取 / 搜索 / 查看子智能体…）：
// 电脑版把它们画成缩进的一行行，这里是同一套行样式 + 一层缩进。
// `-start` 与结算事件共用同一个 subCallId，已存在就原地更新成结果行，不重复追加。
function subCallRow(data) {
  const name = String(data.name || '')
  const summary = data.summary || null
  const verb = summary?.verb || fallbackVerb(name)
  const target = summary?.target ?? ''
  const extra = summary?.extra || ''
  const failed = data.isError === true
  const text = data.message ? messageText(data.message) : ''

  const row = eventRow({
    icon: failed ? '✕' : iconFor(summary, name),
    verb: failed ? '执行失败' : verb,
    target,
    extra: failed ? '' : extra,
    className: failed ? 'ev-fail' : '',
  })
  const wrap = expandable(row, text ? text.slice(0, 4000) : '', 'ev-sub')
  const id = String(data.subCallId || '')
  if (id) {
    // 按 dataset 找已存在的同一子调用行（不用属性选择器：老宿主/测试替身的
    // querySelector 只认类名，属性选择器会静默匹配不到，于是同一子调用出现两行）。
    const existing = Array.from($('transcript').querySelectorAll('.ev-sub'))
      .find((node) => node.dataset && node.dataset.sub === id)
    // 没有结算内容（-start）时不覆盖已有节点，避免把结果行退回成开始行。
    if (existing) {
      if (!text) return null
      // 用 insertBefore + remove 而不是 replaceWith：两者语义一致，
      // 但前者在更老的宿主/测试替身里也有，不会被静默跳过。
      const parent = existing.parent
      if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(wrap, existing)
      existing.remove()
      wrap.dataset.sub = id
      return null
    }
  }
  wrap.dataset.sub = id
  return wrap
}

function toolResultRow(data) {
  const message = data.message || {}
  const text = messageText(message)
  const failed = message.isError === true || data.error != null

  // 一次工具调用在电脑版上只有一行：调用行自己变成"带结果的行"。
  // 这里按 callId 找回那条调用行就地补上结果，不再追加第二条"已完成"。
  const callId = String(message.toolCallId || data.toolCallId || message.source?.callId || data.source?.callId || '')
  if (callId) {
    const existing = Array.from($('transcript').querySelectorAll('.ev-tool'))
      .find((node) => node.dataset && node.dataset.call === callId)
    if (existing) {
      const row = existing.children && existing.children[0]
      if (row) {
        // 图标从"动作"换成结果态；动作词与目标保持不变，只补结果标记。
        const icon = row.querySelector('.ev-ico')
        if (icon) icon.textContent = failed ? '✕' : '✓'
        const verb = row.querySelector('.ev-verb')
        if (verb && failed) verb.textContent = `${verb.textContent} · 失败`
        if (text) {
          const extra = document.createElement('span')
          extra.className = failed ? 'ev-extra ev-fail' : 'ev-extra'
          extra.textContent = `${text.length} 字`
          row.appendChild(extra)
        }
        existing.classList.toggle('ev-fail', failed)
      }
      if (text) {
        let detail = existing.querySelector('.ev-detail')
        if (!detail) {
          detail = document.createElement('pre')
          detail.className = 'ev-detail'
          existing.appendChild(detail)
        }
        detail.textContent = text.slice(0, 4000)
        // 有结果详情才允许点开；只有参数时点开看参数。
        if (!row.onclick && existing.children[0]) existing.children[0].onclick = () => existing.classList.toggle('open')
      }
      return null
    }
  }

  const row = eventRow({
    icon: failed ? '✕' : '✓',
    verb: failed ? '执行失败' : '已完成',
    target: clip(String(data.name || ''), 40),
    extra: text ? `${text.length} 字` : '',
    className: failed ? 'ev-fail' : 'ev-ok',
  })
  return expandable(row, text.slice(0, 4000), 'ev-result')
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** 把一条消息的 content 块渲染进 node：文字、图片、内联工具调用。返回是否有内容。
 *
 *  思考块不在这里画：电脑版把思考当成"过程行"，和工具调用同层级的小灰字，
 *  不属于任何气泡。所以这里只把 reasoning 收集起来，由调用方在气泡**外面**
 *  用 appendReasoningRows() 渲染，避免思考被塞进 DSH 气泡里变成一大块正文。
 *
 *  超长正文不会整段下发：服务端在 block 上标了 `truncated: {shown, total}`，
 *  这里只画前 shown 个字，并在末尾挂一个"展开全文"按钮，点了才去拉完整内容。
 */
function renderContent(node, message, ctx = {}) {
  let rendered = false
  let truncated = null
  for (const block of blocks(message)) {
    if (block.type === 'text' && block.text) {
      const text = document.createElement('div')
      text.className = 'msg-text'
      text.innerHTML = renderText(block.text)
      node.appendChild(text)
      rendered = true
      if (block.truncated) {
        truncated = { kind: 'text', total: block.truncated.total, target: text, shown: block.truncated.shown }
      }
    } else if (block.type === 'reasoning' && block.text) {
      // 交给 appendReasoningRows()
      continue
    } else if (block.type === 'image' || block.type === 'attachment') {
      const figure = imageNode(block.attachment || block)
      if (figure) {
        node.appendChild(figure)
        rendered = true
      }
    } else if (block.type === 'tool-call') {
      // 正文里的 tool-call 块是 assistant message 的内联副本；
      // 独立 `tool/call` 事件已经渲染了一行，这里再画就会重复。
      continue
    }
  }
  if (truncated) moreButton(node, truncated, ctx)
  return rendered
}

/** 气泡下方的"展开全文"按钮：默认只显示前 N 个字，点一下才向服务器要完整内容。
 *  这样长消息/长输出既不会撑爆屏幕，也不会在滑动时白白消耗流量。 */
function moreButton(node, info, ctx) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'msg-more'
  button.textContent = `展开全文（共 ${info.total} 字，已显示 ${info.shown} 字）`
  node.appendChild(button)
  button.onclick = async () => {
    if (!ctx.sessionId || typeof ctx.seq !== 'number' || ctx.seq <= 0) {
      button.textContent = '完整内容需要重新进入会话后再试'
      return
    }
    button.disabled = true
    button.textContent = '正在加载完整内容…'
    try {
      const data = await api(`/api/session/${encodeURIComponent(ctx.sessionId)}/event/${ctx.seq}?full=1`)
      const full = blocks(data.event?.data?.message || data.event?.data || {}).find(
        (block) => block.type === 'text' || block.type === 'reasoning',
      )
      if (!full?.text) throw new Error('没有取得完整内容')
      info.target.innerHTML = renderText(full.text)
      button.remove()
    } catch (error) {
      button.disabled = false
      button.textContent = `加载失败，点此重试（共 ${info.total} 字）`
      toast(error.message)
    }
  }
}

/** 把一条消息里的思考块渲染成气泡**外面**的过程行（灰色小字、可展开）。
 *  返回渲染出来的行数，供调用方决定要不要把这段过程算作"有内容"。
 *  思考同样会被服务端截断：截断时不给"展开全文"按钮，直接在详情末尾说明，
 *  因为思考本身只是过程信息，不需要为它多花一次请求和流量。 */
function appendReasoningRows(box, message, ctx = {}) {
  let count = 0
  for (const block of blocks(message)) {
    if (block.type !== 'reasoning' || !block.text) continue
    const row = eventRow({ icon: '✦', verb: '思考', target: clip(block.text, 60), className: 'ev-think' })
    const detail = block.truncated
      ? `${block.text}\n\n…（思考共 ${block.truncated.total} 字，这里显示前 ${block.truncated.shown} 字）`
      : block.text
    box.appendChild(expandable(row, detail, 'ev-think-wrap'))
    count += 1
  }
  return count
}

function ensureDeltaNode() {
  if (state.deltaNode && state.deltaNode.isConnected) return state.deltaNode
  const node = makeMessageNode('assistant streaming')
  // 逐节点构建而不是拼 innerHTML：<details> 是嵌套结构，拼字符串在无 DOM 的
  // 测试替身里解析不出来，也容易和 Markdown 渲染互相干扰。
  const role = document.createElement('div')
  role.className = 'role'
  role.textContent = 'DSH'
  node.appendChild(role)
  const think = document.createElement('details')
  think.className = 'delta-think hidden'
  const summary = document.createElement('summary')
  summary.textContent = '✦ 思考'
  think.appendChild(summary)
  const thinkBody = document.createElement('pre')
  thinkBody.className = 'delta-think-body'
  think.appendChild(thinkBody)
  node.appendChild(think)
  const body = document.createElement('div')
  body.className = 'delta-body'
  node.appendChild(body)
  $('transcript').appendChild(node)
  state.deltaNode = node
  return node
}

// 一条 assistant/message 落地 = 这一步流式结束。记下"已落地的正文"，
// 之后若有同前缀的 delta 迟到（长轮询续传/SSE 重连时很常见），applyDelta 会把它丢掉。
function closeDeltaWith(event) {
  const data = (event && event.data) || {}
  const finalText = normText(messageText(data.message || data))
  clearDelta()
  if (!state.delta.closed && finalText) state.delta.closed = { at: Date.now(), text: finalText }
}

function applyDelta(payload) {
  if (payload.sessionId !== state.current) return
  if (payload.streaming === false) return
  // 迟到的 delta：这一步的 assistant/message 已经落地，再来一段同样的前缀就是重放。
  // 直接丢，否则会在正文后面再冒一个"DSH"气泡（曾经的错乱来源之一）。
  const closed = state.delta.closed
  if (closed && Date.now() - closed.at < 4000 && payload.text && closed.text.startsWith(payload.text)) return
  const stick = nearBottom()
  state.delta.text = payload.text || ''
  state.delta.reasoning = payload.reasoning || ''
  const node = ensureDeltaNode()
  // 思考内容也实时显示，但塞进一个默认收起的 <details>：
  // 用户要求"输出完成后把思考全收起来"，流式期间同样不该让长思考占满屏幕。
  const think = node.querySelector('.delta-think')
  const thinkBody = node.querySelector('.delta-think-body')
  if (think && thinkBody) {
    const thinking = String(state.delta.reasoning || '').trim()
    if (thinking) {
      think.classList.remove('hidden')
      thinkBody.textContent = thinking
    } else {
      think.classList.add('hidden')
    }
  }
  const bodyNode = node.querySelector('.delta-body')
  if (bodyNode) {
    bodyNode.innerHTML = renderText(state.delta.text) || '<span class="delta-wait">运行中…</span>'
  }
  // 还没有正文时不要摆出一个"空气泡"：用户看到的就是一行"运行中…"。
  node.classList.toggle('waiting', !state.delta.text)
  if (stick) scrollBottom()
}

function clearDelta() {
  if (state.delta.text) state.delta.closed = { at: Date.now(), text: state.delta.text }
  state.delta.text = ''
  state.delta.reasoning = ''
  if (state.deltaNode) {
    state.deltaNode.remove()
    state.deltaNode = null
  }
}

async function openChat(sessionId) {
  state.current = sessionId
  state.seen = new Set()
  state.events = new Map()
  // 换会话时清掉上一轮的开始时刻，否则「已完成，用时」会算出跨会话的荒唐值。
  state.turnStartedAt.delete(sessionId)
  // 翻页状态也按会话重置，否则第二次进同一个会话会被上一轮的"已到底"判死。
  state.older.delete(sessionId)
  state.olderDone.delete(sessionId)
  state.loadingOlder.delete(sessionId)
  state.olderArmed.set(sessionId, true)
  // steer 合成气泡属于"上一眼看到的会话"，换会话必须清掉，否则 reflow 时
  // 会把它当作快照补回新会话的时间线里（串台）。
  state.steerNodes.clear()
  clearTranscript()
  clearDelta()
  showView('chat')
  renderChatHeader()
  // 进会话默认停在最新一条：贴底标志先置真，后面的每次渲染/图片加载都会跟着贴底。
  state.pinBottom = true
  scrollBottom()
  // 布局要过一帧才稳定（字体、安全区、图片占位），再补两次，避免"打开了却停在半空"。
  // 用 rAF + 一次延时即可；这里不能再叠加更多定时器，否则会在用户已经开始滑动后
  // 还去改 scrollTop，真机表现为"手指滑不动"。
  requestAnimationFrame(() => {
    if (!state.pinBottom) return
    scrollBottom()
  })

  // 1) 先用本地缓存渲染
  try {
    const rows = await idb.prefix('events', `${sessionId}|`)
    const cached = rows.sort((a, b) => a.seq - b.seq)
    for (const row of cached) {
      if (row.seq <= 0) continue
      state.events.set(row.seq, row.ev)
      state.seen.add(row.seq)
    }
    reflow()
  } catch {}

  // 2) 告诉服务端"手机正在看这个会话"（宿主提问会接管到这里）
  api('/api/focus', { method: 'POST', body: JSON.stringify({ sessionId, focus: true }) }).catch(() => {})
  state.editingQueue = ''
  loadQueue(sessionId)

  // 3) 拉一段历史 + 最新游标，补齐缓存空洞
  try {
    const page = await api(`/api/session/${encodeURIComponent(sessionId)}/page?limit=6`)
    let changed = false
    for (const event of page.events) {
      if (!state.events.has(event.seq)) {
        state.events.set(event.seq, event)
        if (event.type === 'model/selection') applyModelSelection(sessionId, event.data)
        changed = true
      }
      await saveEvent(sessionId, event)
    }
    if (typeof page.latestSeq === 'number') {
      // 游标只跟着"真正拿到的记录"走。直接把它推到 latestSeq 会在漏收时永久跳过中间事件。
      let maxSeq = state.cursors[sessionId] || 0
      for (const event of page.events) if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
      state.cursors[sessionId] = maxSeq
      state.latestSeq.set(sessionId, maxSeq)
      saveCursors()
    }
    state.older.set(sessionId, page.hasMore !== false)
    state.olderDone.delete(sessionId)
    state.loadingOlder.delete(sessionId)
    // 用历史事件推断"这一轮是不是还没结束"，手机上才能决定第二条消息是排队还是新开一轮
    let open = false
    let startedAt = 0
    for (const ev of Array.from(state.events.values()).sort((a, b) => a.seq - b.seq)) {
      if (ev.type === 'turn/start') {
        open = true
        startedAt = Number(ev.time) || 0
      } else if (ev.type === 'turn/end') {
        open = false
        startedAt = 0
      }
    }
    state.turnOpen.set(sessionId, open)
    if (startedAt) state.turnStartedAt.set(sessionId, startedAt)
    else state.turnStartedAt.delete(sessionId)
    if (changed) reflow()
    // 历史补齐后，只有用户仍在底部才跟着滚到底；正在翻历史时保持原位。
    if (state.pinBottom) scrollBottom()
    if (state.events.size === 0) appendDivider('这个会话还没有内容', false)
  } catch (error) {
    toast(error.message)
  }
}

// 对齐"当前会话的最新状态"：只补手机还没拿到的事件，不重下历史。
// 用在回到前台、以及推送通道被判定死亡后重连时，保证不会长期停在旧画面。
async function loadLatest(sessionId) {
  const page = await api(`/api/session/${encodeURIComponent(sessionId)}/page?limit=8`)
  let changed = false
  let maxSeq = state.cursors[sessionId] || 0
  for (const event of page.events || []) {
    if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
    if (!state.events.has(event.seq)) {
      state.events.set(event.seq, event)
      await saveEvent(sessionId, event)
      changed = true
    }
  }
  state.cursors[sessionId] = Math.max(state.cursors[sessionId] || 0, maxSeq)
  saveCursors()
  for (const event of page.events || []) {
    if (event.type === 'user/message') settlePending(event, sessionId)
    if (event.type === 'turn/start') state.turnOpen.set(sessionId, true)
    if (event.type === 'turn/end') state.turnOpen.set(sessionId, false)
  }
  if (sessionId === state.current) {
    if (changed) reflow()
    loadQueue(sessionId)
  }
}

// 向上翻页：把比当前最早一条更早的历史拉一页回来。
// 关键点（曾经踩过）：服务端 page 的 throughSeq 必须落在游标之内，所以 before 用
// "当前会话最小 seq"，服务端再自己 clamp。加载完要把视口锚回原来的位置，
// 否则新内容插到顶部会让用户眼前的文字突然跳走。
//
// 每次只取 1 轮的历史（服务端 maxMessages 是"消息轮数"，一轮约 3~7 条事件，
// 实测 limit=1 → 2 条 3.1KB，limit=3 → 9 条 20KB）。用户是在手机上一点一点
// 上滑回看的，一次给太多既费流量，也会让"再滑到顶"等很久。
//
// 但 limit=1 有个坑：服务端 page() 按"轮"切分，某些游标位置正好落在轮边界上，
// 会返回**空页但 hasMore=true**（实测 before=12109&limit=1 → 0 条）。所以下面
// 撞到空页时用更大的页重试一次，而不是就此判定"到底了"。
const OLDER_PAGE = 1
const OLDER_PAGE_RETRY = 9

async function loadOlder(sessionId) {
  if (!sessionId || sessionId !== state.current) return
  if (state.loadingOlder.has(sessionId)) return
  if (state.older.get(sessionId) === false) return
  // 门闩：上一页刚加载完还没滚离顶部时不再翻页，避免一次滑动连翻多页。
  if (state.olderArmed.get(sessionId) === false) return
  if (state.events.size === 0) return
  const seqs = Array.from(state.events.keys()).filter((seq) => typeof seq === 'number' && seq > 0)
  if (seqs.length === 0) return
  const oldest = Math.min(...seqs)
  if (oldest <= 1) {
    noteOlderDone(sessionId)
    return
  }
  state.loadingOlder.add(sessionId)
  const box = $('transcript')
  const prevHeight = box.scrollHeight
  const prevTop = box.scrollTop
  let hint = null
  try {
    // 顶部给一行"正在加载更早…"，网络慢时用户不至于以为卡住了。
    // 注意：这一行会让 scrollHeight 变大，锚定补偿必须把它算进去，
    // 否则加载完成时视口会往下跳一截（真机上表现为"内容闪一下又回来"）。
    hint = document.createElement('div')
    hint.className = 'older-loading'
    hint.textContent = '正在加载更早的记录…'
    box.insertBefore(hint, box.firstChild)
    // 先按小页取；如果落在轮边界上拿回空页，用更大的页重试一次。
    // 不做这个自愈的话，用户在某个位置滑到顶就再也翻不动了。
    let page = null
    const added = []
    let hasMore = false
    for (const limit of [OLDER_PAGE, OLDER_PAGE_RETRY]) {
      page = await api(`/api/session/${encodeURIComponent(sessionId)}/page?limit=${limit}&before=${oldest}`)
      const events = page.events || []
      for (const event of events) {
        if (typeof event.seq !== 'number' || event.seq >= oldest) continue
        if (state.events.has(event.seq)) continue
        state.events.set(event.seq, event)
        await saveEvent(sessionId, event)
        added.push(event)
      }
      hasMore = page.hasMore === true
      if (added.length > 0 || !hasMore) break
    }
    state.older.set(sessionId, hasMore)
    if (added.length === 0 || hasMore !== true) noteOlderDone(sessionId, added.length === 0)
    if (sessionId !== state.current) return
    if (added.length > 0) {
      // 先把"正在加载"那行摘掉，再往顶部插新内容，避免它夹在旧内容中间。
      if (hint) hint.remove()
      hint = null
      // 只把新拿到的这几条插到顶部，不做整表 reflow：
      // 翻到第五页时 state.events 已经上千条，整表重建在手机上会明显卡顿。
      prependOlder(added)
      // 锚定：把滚动位置补偿回用户原来盯着的那些内容。
      const grew = box.scrollHeight - prevHeight
      box.scrollTop = prevTop + Math.max(0, grew)
      // 上闩：必须滚离顶部（>240px）才允许翻下一页。
      // 例外：这一页加载完仍然撑不满一屏（用户滚不动，永远离不开顶部），
      // 那就继续允许加载，否则会卡在"页面比屏幕还短"的状态翻不下去。
      const viewport = box.clientHeight || 0
      const scrollable = viewport > 0 && box.scrollHeight > viewport + 80
      state.olderArmed.set(sessionId, !scrollable)
      // 翻页期间用户的手指还在屏幕上：立刻复位贴底状态，避免下一次 reflow 把他拽回底部。
      state.pinBottom = false
    }
  } finally {
    if (hint) hint.remove()
    state.loadingOlder.delete(sessionId)
  }
}

// 把一页更早的事件按 seq 升序渲染后插到时间线最前面。
// 前提：调用方保证这些事件的 seq 都小于当前已有最小 seq（loadOlder 已过滤）。
function prependOlder(events) {
  const box = $('transcript')
  const ordered = events.slice().sort((a, b) => a.seq - b.seq)
  // 临时容器承接渲染结果，避免逐条 insertBefore 触发多次重排。
  const holder = document.createElement('div')
  const realBox = box
  const pendingBefore = state.seen
  state.seen = new Set()
  for (const event of ordered) appendEvent(event, holder)
  state.seen = pendingBefore
  const nodes = Array.from(holder.children || [])
  const anchor = realBox.firstChild || null
  for (const node of nodes) {
    if (node.classList) node.classList.add('older-in')
    realBox.insertBefore(node, anchor)
  }
  // 淡入动画只动透明度，不改高度：滚动锚定在同一帧里已经补偿过，
  // 所以"内容从上方长出来"时用户盯着的那一行不会位移（避免视觉跳变）。
}

// 翻到头了给一行提示（只画一次，避免每次上滑都重复）。
function noteOlderDone(sessionId, silent = false) {
  if (state.olderDone.has(sessionId)) return
  state.olderDone.add(sessionId)
  if (silent || sessionId !== state.current) return
  const box = $('transcript')
  const note = document.createElement('div')
  note.className = 'divider'
  note.textContent = '— 已经是全部记录了 —'
  box.insertBefore(note, box.firstChild)
  box.scrollTop = 0
}

function reflow() {
  // 插话的合成气泡（steer 帧先于 user/message 到达时画出来的）必须跨 reflow 存活：
  // clearTranscript() 会清空 DOM 和 state.steerNodes，若不在重建时补回，
  // "手机上自己插话"就会先出现再整条消失（真机上表现为闪一下）。这里先留快照。
  const steerSnapshot = Array.from(state.steerNodes.entries())
  // 重建会把滚动位置清零。用户正在上面读历史时（不在底部），必须把位置还原回去，
  // 否则每来一条推送、每翻一页，视野就被拽走一次——真机上表现为"跟我抢滚动"。
  const box = $('transcript')
  const keepAnchor = !nearBottom()
  const prevTop = box.scrollTop
  const prevHeight = box.scrollHeight
  clearTranscript()
  // clearTranscript() 已经把 DOM 清空，流式节点随之内消失；这里只复位缓冲，
  // 但不打 closed 标记（reflow 不是"正文落地"，不该触发迟到 delta 的抑制窗口）。
  state.delta.text = ''
  state.delta.reasoning = ''
  state.seen = new Set()
  const ordered = Array.from(state.events.values()).sort((a, b) => a.seq - b.seq)
  for (const event of ordered) appendEvent(event)
  state.latestSeq.set(state.current, ordered.length ? ordered[ordered.length - 1].seq || 0 : 0)
  // 还没被服务端事件确认的本地消息（乐观气泡）也要重建，否则一发消息就"消失"。
  // 但只重建属于当前会话的那几条：pending 是跨会话共用的表，不过滤就会串台。
  prunePending()
  for (const item of state.pending) {
    if (item.sessionId !== state.current) continue
    appendEvent(item.event)
  }
  for (const [id, node] of steerSnapshot) {
    if (!state.steerNodes.has(id)) state.steerNodes.set(id, node)
    box.appendChild(node)
  }
  if (keepAnchor) {
    // 顶部插入内容时 scrollHeight 变大，位置要按增量补偿；底部追加时不用动。
    const grew = box.scrollHeight - prevHeight
    box.scrollTop = Math.max(0, prevTop + (grew > 0 ? grew : 0))
  } else {
    box.scrollTop = box.scrollHeight
  }
}

/* 乐观气泡表：每条都必须带 sessionId（见 pendingPush）。
 * 历史 bug：整张表没有会话归属，openChat 切换时不清，reflow() 又无条件重画
 * → 在会话 A 发的消息，切到会话 B 后被渲染进 B 的时间线。 */
const PENDING_TTL = 120_000
// 本地排队改动（编辑/删除/插话）在多长时间内压过服务端快照。
// 取 2.5 秒：足够覆盖一次长轮询往返 + 宿主 updateQueue 的确认，
// 又不会长到把宿主的真实变化挡住（宿主的 splice 帧会带来权威结果）。
const QUEUE_TOUCH_MS = 2500

/** 记下"这个条目刚被本地改过"，短时间内不让旧快照覆盖回去。 */
function touchQueue(sessionId, itemId, patch = {}) {
  let map = state.queueTouched.get(sessionId)
  if (!map) {
    map = new Map()
    state.queueTouched.set(sessionId, map)
  }
  map.set(itemId, { at: Date.now(), ...(map.get(itemId) || {}), ...patch })
}

function pendingPush(sessionId, seq, text, event) {
  state.pending.push({ sessionId, seq, text, at: Date.now(), event })
}

// 兜底：服务端事件可能因为断流/切页而永远不到，超时的气泡自己退场。
function prunePending(now = Date.now()) {
  const kept = state.pending.filter((item) => now - (item.at || 0) < PENDING_TTL)
  if (kept.length !== state.pending.length) state.pending = kept
}

function dropPending(sessionId, seq) {
  state.pending = state.pending.filter((item) => !(item.seq === seq && item.sessionId === sessionId))
}

// 服务端把这条消息记下来后，本地乐观气泡就撤掉，避免重复。
// 必须连会话一起比对：只按文本匹配会误伤别的对话里同文的消息。
function settlePending(event, sessionId) {
  const data = event.data || {}
  const text = normText(messageText(data.message || data))
  if (!text) return
  const owner = sessionId || event.sessionId || ''
  // 回显文本可能带尾随空格/被裁剪过，比较前统一归一化，否则同一条会显示两遍。
  const index = state.pending.findIndex((item) => normText(item.text) === text && (!owner || item.sessionId === owner))
  if (index < 0) return
  const settledSession = state.pending[index].sessionId
  state.pending.splice(index, 1)
  // 只有撤掉的那条属于当前会话时才重画；别的会话不碰当前时间线。
  if (settledSession === state.current) reflow()
}

// 文本归一化：首尾空白、连续空白、全角空格都折叠掉。
function normText(value) {
  return String(value || '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function leaveChat() {
  const sessionId = state.current
  if (sessionId) api('/api/focus', { method: 'POST', body: JSON.stringify({ sessionId, focus: false }) }).catch(() => {})
  state.current = ''
  showView('list')
  renderSessions()
}

/* -------------------------------------------------------------- transport */

function encodeCursor() {
  const text = JSON.stringify(state.cursors)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mergeCursor(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  for (const [sessionId, seq] of Object.entries(snapshot)) {
    if (typeof seq !== 'number') continue
    if (seq > (state.cursors[sessionId] || 0)) state.cursors[sessionId] = seq
  }
  saveCursors()
}

/* SSE 是首选：一条长连接推所有增量。但有些反代（Cloudflare 临时隧道就是）
 * 会把 chunked 响应攒到结束才发，EventSource 看起来就是"连上了但半个字都不来"。
 * 所以 4 秒内没收到 hello 就切长轮询：请求立刻返回已有帧，空闲时最多挂 25 秒。 */
function connect() {
  if (!state.token) return
  closeTransport()
  setConn('', '连接中')
  startSse()
}

function closeTransport() {
  state.transport = ''
  if (state.es) {
    try { state.es.close() } catch {}
    state.es = null
  }
  if (state.sseWatchdog) {
    clearTimeout(state.sseWatchdog)
    state.sseWatchdog = 0
  }
  state.polling = false
  if (state.pollTimer) {
    clearTimeout(state.pollTimer)
    state.pollTimer = 0
  }
  if (state.pollAbort) {
    try { state.pollAbort.abort() } catch {}
    state.pollAbort = null
  }
}

function startSse() {
  const url = `/api/events?k=${encodeURIComponent(state.token)}&c=${encodeURIComponent(encodeCursor())}`
  const es = new EventSource(url)
  state.es = es
  state.transport = 'sse'
  es.addEventListener('hello', () => {
    if (state.sseWatchdog) {
      clearTimeout(state.sseWatchdog)
      state.sseWatchdog = 0
    }
    state.retry = 0
    setConn('on', '已连接')
  })
  for (const type of ['event', 'status', 'delta', 'question', 'question-resolved', 'question-expired', 'approval', 'queue', 'kicked']) {
    es.addEventListener(type, (message) => {
      let payload
      try { payload = JSON.parse(message.data) } catch { return }
      handleFrame(type, payload)
    })
  }
  es.onerror = () => {
    try { es.close() } catch {}
    if (state.es === es) state.es = null
    if (state.transport !== 'sse') return
    setConn('off', '重连中')
    state.polling = false
    scheduleReconnect()
  }
  state.sseWatchdog = setTimeout(() => {
    if (state.transport !== 'sse' || !state.es) return
    // SSE 一直收不到首帧：这条链路上大概率被反代缓冲了，改用长轮询。
    startPoll()
  }, 4000)
}

function startPoll() {
  if (state.es) {
    try { state.es.close() } catch {}
    state.es = null
  }
  if (state.sseWatchdog) {
    clearTimeout(state.sseWatchdog)
    state.sseWatchdog = 0
  }
  state.transport = 'poll'
  state.polling = true
  setConn('on', '省流模式')
  pollOnce()
}

async function pollOnce() {
  if (!state.polling || !state.token) return
  const controller = new AbortController()
  state.pollAbort = controller
  const guard = setTimeout(() => controller.abort(), 40000)
  let ok = false
  try {
    const url = `/api/poll?k=${encodeURIComponent(state.token)}&c=${encodeURIComponent(encodeCursor())}`
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (res.status === 401) {
      logout()
      return
    }
    const data = await res.json()
    // 注意：**不能** mergeCursor(data.cursor)。服务端的 cursor 是"它自己看到的最新 seq"，
    // 而我们可能漏收过事件（断线期间产生的）。拿它当客户端游标，会让客户端"以为收到了"，
    // 从此永久跳过那几条 —— 实测表现就是：手机停在旧状态，DSH 其实早就回完了。
    // 客户端游标只能由真正收到的帧推进（见 handleFrame 的 event 分支）。
    for (const frame of data.queueSync || []) handleFrame(frame.type, frame.payload)
    for (const frame of data.frames || []) handleFrame(frame.type, frame.payload)
    // 长轮询没有 hello 帧：每次响应都带一份运行状态快照，用它同步会话列表。
    if (data.status && typeof data.status === 'object') applyStatuses(data.status)
    // 会话集合版本号：长轮询被别的事件抢先唤醒时不会带 sessions 帧，
    // 但版本号每次响应都带，所以这里补一次比对就不会漏掉归档变化。
    applySessionsRev(data.sessionsRev)
    state.retry = 0
    setConn('on', '省流模式')
    ok = true
  } catch {
    if (!state.polling) return
    setConn('off', '重连中')
  } finally {
    clearTimeout(guard)
    if (state.pollAbort === controller) state.pollAbort = null
  }
  if (!state.polling) return
  const delay = ok ? 120 : Math.min(15_000, 1000 * Math.pow(1.8, state.retry++))
  state.pollTimer = setTimeout(pollOnce, delay)
}

/** 把服务端下发的 `{sessionId: 'running'|'idle'}` 并进本地状态，并刷新列表/头部 */
function applyStatuses(statuses) {
  if (!statuses || typeof statuses !== 'object') return 0
  let changed = 0
  for (const [sessionId, status] of Object.entries(statuses)) {
    const running = status === 'running'
    if (state.running.get(sessionId) !== running) changed += 1
    state.running.set(sessionId, running)
    const session = state.sessions.get(sessionId)
    if (session) state.sessions.set(sessionId, { ...session, running })
  }
  if (changed) {
    if (!$('view-list').classList.contains('hidden')) renderSessions()
    if (state.current) renderChatHeader()
  }
  return changed
}

/** 电脑端切了模型/思考强度：宿主往会话追加 model/selection 事件，手机据此同步。 */
function applyModelSelection(sessionId, data) {
  if (!data || !sessionId) return
  const model = {
    provider: data.provider || '',
    model: data.model || '',
    reasoningEffort: data.reasoningEffort || '',
  }
  const session = state.sessions.get(sessionId)
  if (session) state.sessions.set(sessionId, { ...session, model })
  if (sessionId === state.current) renderChatHeader()
}

function handleFrame(type, payload) {
  state.lastFrameAt = Date.now()
  // 被换绑：服务端换了新设备绑定时会立刻推这一帧，然后把连接关掉。
  // 必须主动清 token 回配对页，否则界面会一直显示"重连中"，像卡死一样。
  if (type === 'kicked') {
    logout('这台手机已被新的配对替换，请重新扫码')
    return
  }
  if (type === 'hello') {
    state.retry = 0
    setConn('on', state.transport === 'poll' ? '省流模式' : '已连接')
    // 各会话运行状态：一连上就按服务端给的值刷新列表，不用等下一次 turn/start。
    // 还顺手补发了其它设备的"运行中"，避免会话列表显示成静止。
    applyStatuses(payload && payload.status)
    // 会话集合版本号（归档/新建/删除）：连上就对齐，别等下一次推送。
    applySessionsRev(payload && payload.sessionsRev)
    // 断线期间漏帧自愈：服务端告诉我们各会话的最大 seq，比本地游标新就补一次。
    const latest = payload && payload.latest
    if (latest && typeof latest === 'object') {
      let behind = false
      for (const [sessionId, seq] of Object.entries(latest)) {
        if (typeof seq !== 'number') continue
        if (seq > (state.cursors[sessionId] || 0)) behind = true
      }
      if (behind) {
        refreshState().catch(() => {})
        if (state.current) loadLatest(state.current).catch(() => {})
      }
    }
    return
  }
  if (type === 'event') {
    const event = payload
    const sessionId = event.sessionId || state.current
    if (typeof event.seq === 'number') {
      state.cursors[sessionId] = Math.max(state.cursors[sessionId] || 0, event.seq)
      saveCursors()
    }
    saveEvent(sessionId, event)
    // 先认下乐观气泡，再判断是不是当前会话。顺序反了的话，发完消息立刻切走，
    // 这条 user/message 会被下面的 return 丢掉，气泡就永久留在表里。
    if (event.type === 'user/message') settlePending(event, sessionId)
    if (sessionId !== state.current) {
      if (event.type === 'assistant/message' || event.type === 'turn/end') {
        const session = state.sessions.get(sessionId)
        if (session) state.sessions.set(sessionId, { ...session, updatedAt: Date.now() })
      }
      return
    }
    if (event.type === 'assistant/message') closeDeltaWith(event)
    // 一轮是否在跑，用本轮自己的 turn/start、turn/end 事件判断最可靠：
    // 宿主下发的 session.running / agent/status 在"秒失败"的会话里会立刻变回 false。
    if (event.type === 'turn/start') {
      state.turnOpen.set(sessionId, true)
      state.turnStartedAt.set(sessionId, Number(event.time) || Date.now())
      // 队列不要在 turn/start 时清空：宿主取走排队消息时会自己发一条
      // `target:'next-turn', removedCount:N` 的 spliced 事件，服务端据此更新并推送 queue 帧。
      // 早先在这里清空，会让"刚发出去还没被取走的排队消息"立刻从手机上消失。
      // 队列帧只在变化瞬间推送；重连或错过时用一次拉取对齐（很小，只在轮次边界发生）
      if (sessionId === state.current) loadQueue(sessionId)
    }
    if (event.type === 'turn/end') {
      state.turnOpen.set(sessionId, false)
      // 一轮结束时，服务端队列里还没被认下的"发送中…"占位不可能再变成排队消息了：
      // 要么已经被取走（会有 user/message 事件），要么发送失败。全部丢掉，避免常驻。
      const rows = state.queues.get(sessionId) || []
      const kept = rows.filter((row) => !row.pending)
      if (kept.length !== rows.length) {
        state.queues.set(sessionId, kept)
        if (sessionId === state.current) renderQueue()
      }
      if (sessionId === state.current) loadQueue(sessionId)
    }
    if (event.type === 'model/selection') applyModelSelection(sessionId, event.data)
    state.events.set(event.seq, event)
    // 增量事件必须按 seq 归位：轮询批量、SSE 与补洞交错时可能乱序到达，
    // 直接 append 会让正文跑到工具行后面、甚至跨轮（"消息错乱"的主因之一）。
    const latest = state.latestSeq.get(sessionId) || 0
    if (typeof event.seq === 'number' && event.seq < latest) reflow()
    else {
      if (typeof event.seq === 'number') state.latestSeq.set(sessionId, event.seq)
      appendEvent(event)
    }
    return
  }
  if (type === 'status') {
    applyStatuses({ [payload.sessionId]: payload.status })
    return
  }
  if (type === 'steer') {
    // 本轮中途插话：宿主先发 spliced，真正的 user/message 要等下一个步骤边界才落盘。
    // 这里先按消息 id 渲染一个用户气泡，等真事件到达再替换。
    // 如果是"手机上自己发的插话"，本地已经有乐观气泡了：把它撤掉换成这个可被
    // 真事件替换的节点，否则同一条会显示两遍。
    if (!payload || payload.sessionId !== state.current) return
    const id = payload.id || ''
    const text = payload.text || ''
    const imageCount = Number(payload.imageCount) || 0
    // 纯图片插话（电脑端贴图直接发）没有正文：不能因为 text 为空就把整条丢掉，
    // 否则手机端"电脑上插了话却什么都看不到"（用户反馈）。
    if (!id || (!text && imageCount === 0)) return
    const pendingIndex = state.pending.findIndex(
      (row) => row.sessionId === state.current && normText(row.text) === normText(text),
    )
    if (pendingIndex >= 0) state.pending.splice(pendingIndex, 1)
    const existing = state.steerNodes.get(id)
    if (existing) {
      existing.querySelector('.msg-text')?.replaceChildren(document.createTextNode(text))
      existing.querySelector('.msg-figure-pending')?.remove()
      if (imageCount > 0) existing.appendChild(pendingFigureNode(imageCount, '插话图片'))
      if (pendingIndex >= 0) reflow()
      return
    }
    const node = makeMessageNode('user')
    node.appendChild(roleNode('你'))
    if (text) {
      const body = document.createElement('div')
      body.className = 'msg-text'
      body.textContent = text
      node.appendChild(body)
    }
    if (imageCount > 0) node.appendChild(pendingFigureNode(imageCount, '插话图片'))
    node.dataset.steerId = id
    $('transcript').appendChild(node)
    state.steerNodes.set(id, node)
    if (pendingIndex >= 0) reflow()
    else scrollBottom()
    return
  }
  if (type === 'delta') {
    applyDelta(payload)
    return
  }
  if (type === 'queue') {
    const items = Array.isArray(payload.items) ? payload.items : []
    // 服务端是唯一真源，但它可能带回"上一刻"的快照（长轮询挂起期间算好的、
    // 或帧在写盘路上）。用户刚点过编辑/删除的那一小段窗口里，以本地为准，
    // 否则会出现"点了保存却弹回旧文本""删了又冒出来"的观感。
    const touches = state.queueTouched.get(payload.sessionId) || new Map()
    const now = Date.now()
    for (const [itemId, info] of touches) {
      if (now - info.at > QUEUE_TOUCH_MS) touches.delete(itemId)
    }
    const serverItems = items.map((row) => {
      const info = touches.get(row.itemId)
      if (!info) return row
      // 本地改过文本：保留本地的，别被旧快照覆盖。
      if (info.text !== undefined && row.text !== info.text) return { ...row, text: info.text }
      return row
    })
    // 本地刚删掉/插话掉的条目：快照里还有它也别加回来（等宿主 splice 确认）。
    const alive = serverItems.filter((row) => {
      const info = touches.get(row.itemId)
      return !(info && info.removed)
    })
    // 本地"发送中…"占位只在**很短的时间窗**内保留（刚发出、服务端还没认下的
    // 那一两百毫秒）；超过 6 秒还没出现在服务端队列里，就认为它已经被取走或
    // 失败，直接丢掉——否则它会永远挂在手机上当"排队中"。
    const texts = new Set(alive.map((row) => row.text))
    const kept = (state.queues.get(payload.sessionId) || []).filter((row) => {
      if (!row.pending) return false
      if (texts.has(row.text)) return false
      return now - (row.at || 0) < 6000
    })
    const merged = [...alive]
    for (const row of kept) merged.push(row)
    state.queues.set(payload.sessionId, merged)
    if (payload.sessionId === state.current) renderQueue()
    return
  }
  if (type === 'question') {
    openQuestion(payload)
    return
  }
  if (type === 'question-resolved') {
    closeQuestion()
    return
  }
  if (type === 'question-expired') {
    closeQuestion()
    toast('手机没有及时回答，已交回电脑端')
    return
  }
  if (type === 'approval') {
    toast(`需要审批：${payload.toolName || '操作'}（请在电脑上确认）`, 4000)
    return
  }
  if (type === 'sessions') {
    // 电脑端归档 / 取消归档 / 新建会话后，服务端只推一个"列表变了"的信号，
    // 真正的数据仍由 /api/state 拉取（不在推送里塞整张表，省流量）。
    state.sessionsRev = Math.max(state.sessionsRev || 0, Number(payload && payload.sessionsRev) || 0)
    state.sessionsStale = true
    refreshState().catch(() => {})
    return
  }
  // 长轮询响应里带的版本号：比本地新就说明错过了 sessions 帧（轮询被别的事件抢先唤醒），
  // 补一次拉取，否则"电脑上归档了、手机还显示"会一直挂着。
  if (type === 'poll-rev') {
    applySessionsRev(payload && payload.sessionsRev)
  }
}

/** 会话表版本号：落后就标记为过期并重新拉 /api/state。
 * 只比数字、不传整表，既省流量，也不会因为某次推送被别的事件抢先而永久漏掉。 */
function applySessionsRev(rev) {
  const next = Number(rev)
  if (!Number.isFinite(next) || next <= 0) return
  if (next <= (state.sessionsRev || 0)) return
  state.sessionsRev = next
  state.sessionsStale = true
  refreshState().catch(() => {})
}

function scheduleReconnect() {
  if (state.retryTimer) return
  const delay = Math.min(30_000, 1000 * Math.pow(1.7, state.retry++))
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0
    if (!document.hidden) connect()
  }, delay)
}

/* -------------------------------------------------------------- question */

function openQuestion(payload) {
  state.question = { id: payload.id, sessionId: payload.sessionId, questions: payload.questions || [], selected: {}, custom: {} }
  for (const question of state.question.questions) {
    state.question.selected[question.id] = new Set()
    state.question.custom[question.id] = ''
  }
  renderQuestion()
  $('sheet-question').classList.remove('hidden')
}

function closeQuestion() {
  state.question = null
  $('sheet-question').classList.add('hidden')
}

function renderQuestion() {
  const box = $('q-content')
  box.innerHTML = ''
  const current = state.question
  if (!current) return
  for (const question of current.questions) {
    const wrap = document.createElement('div')
    wrap.className = 'q-item'
    const head = document.createElement('h3')
    head.textContent = question.header || question.question || '需要补充信息'
    wrap.appendChild(head)
    if (question.detail) {
      const detail = document.createElement('p')
      detail.textContent = question.detail
      wrap.appendChild(detail)
    }
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        const button = document.createElement('button')
        button.className = 'option'
        button.innerHTML = `${escapeHtml(option.label)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}`
        button.onclick = () => {
          const set = current.selected[question.id]
          if (question.multiSelect) {
            if (set.has(option.label)) set.delete(option.label)
            else set.add(option.label)
          } else {
            set.clear()
            set.add(option.label)
          }
          for (const node of wrap.querySelectorAll('.option')) node.classList.remove('active')
          for (const label of set) {
            for (const node of wrap.querySelectorAll('.option')) {
              if (node.textContent.startsWith(label)) node.classList.add('active')
            }
          }
        }
        wrap.appendChild(button)
      }
    }
    const custom = document.createElement('textarea')
    custom.className = 'q-custom'
    custom.placeholder = '也可以自己输入（可选）'
    custom.value = current.custom[question.id] || ''
    custom.oninput = () => { current.custom[question.id] = custom.value }
    wrap.appendChild(custom)
    box.appendChild(wrap)
  }
}

async function submitQuestion() {
  const current = state.question
  if (!current) return
  const answers = current.questions.map((question) => ({
    id: question.id,
    selected: Array.from(current.selected[question.id] || []),
    ...(current.custom[question.id] ? { custom: current.custom[question.id] } : {}),
  }))
  try {
    await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: current.id, answers }) })
    closeQuestion()
  } catch (error) {
    toast(error.message)
  }
}

/* ----------------------------------------------------------------- model */

async function openModelSheet() {
  $('sheet-model').classList.remove('hidden')
  if (!state.catalog) {
    $('model-content').innerHTML = '<p class="muted">读取模型目录…</p>'
    try {
      const data = await api('/api/catalog')
      state.catalog = data.catalog
    } catch (error) {
      $('model-content').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`
      return
    }
  }
  renderModelSheet()
}

function renderModelSheet() {
  const box = $('model-content')
  box.innerHTML = ''
  const catalog = state.catalog || {}
  const session = state.sessions.get(state.current)
  const active = session?.model || {}
  const groups = Array.isArray(catalog.groups) ? catalog.groups : []
  if (groups.length === 0) box.innerHTML = '<p class="muted">没有可用模型。</p>'
  for (const group of groups) {
    const wrap = document.createElement('div')
    wrap.className = 'model-group'
    const title = document.createElement('h3')
    title.textContent = group.name || group.id
    wrap.appendChild(title)
    for (const model of group.models || []) {
      const item = document.createElement('div')
      const isActive = active.provider === group.id && active.model === model.id
      item.className = `model-item${isActive ? ' active' : ''}`
      item.innerHTML = `<div>${escapeHtml(model.name || model.id)}</div>${model.description ? `<small>${escapeHtml(model.description)}</small>` : ''}`
      item.onclick = () => applyModel(group.id, model.id, model.reasoning?.defaultEffort || '')
      if (isActive && model.reasoning && Array.isArray(model.reasoning.efforts)) {
        const row = document.createElement('div')
        row.className = 'effort-row'
        for (const effort of model.reasoning.efforts) {
          const chip = document.createElement('button')
          chip.className = `effort${active.reasoningEffort === effort.id ? ' active' : ''}`
          chip.textContent = effort.name || effort.id
          chip.onclick = (clickEvent) => {
            clickEvent.stopPropagation()
            applyModel(group.id, model.id, effort.id)
          }
          row.appendChild(chip)
        }
        item.appendChild(row)
      }
      wrap.appendChild(item)
    }
    box.appendChild(wrap)
  }
}

async function applyModel(provider, model, reasoningEffort) {
  if (!state.current) return
  try {
    await api('/api/model', { method: 'POST', body: JSON.stringify({ sessionId: state.current, provider, model, reasoningEffort }) })
    const session = state.sessions.get(state.current) || { id: state.current }
    state.sessions.set(state.current, { ...session, model: { provider, model, reasoningEffort } })
    renderChatHeader()
    renderModelSheet()
    toast('已切换模型')
  } catch (error) {
    toast(error.message)
  }
}

/* -------------------------------------------------------------- composer */

function autosize() {
  const area = $('composer')
  area.style.height = 'auto'
  area.style.height = `${Math.min(132, area.scrollHeight)}px`
}

/* ------------------------------------------------------------ queue strip */

function queueButton(label, title, onClick) {
  const button = document.createElement('button')
  button.className = 'queue-btn'
  button.textContent = label
  button.title = title
  button.onclick = onClick
  return button
}

function queueEditRow(item) {
  const row = document.createElement('div')
  row.className = 'queue-item editing'
  const area = document.createElement('textarea')
  area.className = 'queue-edit'
  area.value = item.text || ''
  const imageCount = Number(item.imageCount) || 0
  if (imageCount > 0) {
    // 用户已经确认过才会进到这里，但输入框里得再提醒一次，免得他以为图还留着。
    area.placeholder = `原消息带 ${imageCount} 张图片，保存后只保留文字`
  }
  const save = queueButton('✓', '保存', async () => {
    const text = area.value.trim()
    if (!text) return
    await queueAction(item, 'edit', text)
    state.editingQueue = ''
    renderQueue()
  })
  const cancel = queueButton('×', '取消', () => {
    state.editingQueue = ''
    renderQueue()
  })
  row.append(area, save, cancel)
  requestAnimationFrame(() => {
    area.focus()
    area.style.height = 'auto'
    area.style.height = `${Math.min(96, area.scrollHeight)}px`
  })
  return row
}

function renderQueue() {
  const box = $('queue')
  if (!box) return
  const items = state.queues.get(state.current) || []
  // 当前显示的是第几条：切换时做一个淡入淡出，别硬切（用户要求"不要跳变"）。
  const prevIndex = state.queueShownAt.get(state.current)
  state.queueShownAt.set(state.current, clampQueueIndex(items))
  box.innerHTML = ''
  box.classList.toggle('hidden', items.length === 0)
  // 多条排队消息时，一次只展开一条，上下滑动切换（用户要的"上下切换消息"）。
  // 用单条可视高度，避免队列条把整个聊天区挤没。
  const index = clampQueueIndex(items)
  const swapped = items.length > 1 && prevIndex !== undefined && prevIndex !== index
  if (swapped) {
    // 重新触发动画：先摘掉类、强制回流、再加上。
    box.classList.remove('queue-swap')
    void box.offsetWidth
    box.classList.add('queue-swap')
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const row = rowForItem(item)
    if (items.length > 1) row.style.display = i === index ? '' : 'none'
    if (items.length > 1 && i === index && swapped) row.classList.add('queue-row-in')
    box.appendChild(row)
  }
  if (items.length > 1) box.appendChild(queuePager(items.length, index))
}

/** 当前展开第几条排队消息（越界自动收敛）。 */
function clampQueueIndex(items) {
  const raw = state.queueIndex.get(state.current) || 0
  const index = Math.max(0, Math.min(items.length - 1, raw))
  state.queueIndex.set(state.current, index)
  return index
}

/** 把一条排队消息画成一行（编辑态换成输入框）。 */
function rowForItem(item) {
  if (state.editingQueue === item.itemId) return queueEditRow(item)
  const row = document.createElement('div')
  row.className = `queue-item${item.pending ? ' pending' : ''}`
  const imageCount = Number(item.imageCount) || 0
  const text = document.createElement('div')
  text.className = 'queue-text'
  text.textContent = item.text || (imageCount > 0 ? `图片 ${imageCount} 张` : '（无文字内容）')
  row.appendChild(text)
  if (imageCount > 0) {
    // 排队行必须让人一眼看出"这条带图"，否则纯图片排队看起来像一条空消息。
    const tag = document.createElement('span')
    tag.className = 'queue-images'
    tag.textContent = `🖼 ${imageCount}`
    tag.title = `包含 ${imageCount} 张图片`
    row.appendChild(tag)
  }
  if (item.pending) {
    // 服务端还没确认，先占位，不给编辑/删除按钮
    const tag = document.createElement('span')
    tag.className = 'queue-pending'
    tag.textContent = '发送中…'
    row.appendChild(tag)
    return row
  }
  // 带图片的排队消息也能编辑，但必须先说清楚代价：宿主 updateQueue 的 edit 只收
  // 文本块，一编辑图片就永久丢了（服务端也会拒），所以点之前让用户确认一次。
  row.appendChild(queueButton('✎', imageCount > 0 ? '编辑（会丢失图片）' : '编辑', async () => {
    if (imageCount > 0) {
      const okd = await askConfirm(
        `这条排队消息带着 ${imageCount} 张图片。编辑后只保留文字，图片会被丢掉，无法找回。要继续吗？`,
        '继续编辑',
      )
      if (!okd) return
    }
    state.editingQueue = item.itemId
    renderQueue()
  }))
  row.appendChild(queueButton('🗑', '删除', () => queueAction(item, 'remove')))
  row.appendChild(queueButton('↑', '插话到本轮', () => queueAction(item, 'steer')))
  return row
}

/** 多条排队时的页码点：点一下切到那条，也提示"左右滑"。 */
function queuePager(total, index) {
  const bar = document.createElement('div')
  bar.className = 'queue-pager'
  const hint = document.createElement('span')
  hint.className = 'queue-pager-hint'
  hint.textContent = `${index + 1}/${total} · 上下滑动切换`
  bar.appendChild(hint)
  const dots = document.createElement('div')
  dots.className = 'queue-dots'
  for (let i = 0; i < total; i += 1) {
    const dot = document.createElement('button')
    dot.className = `queue-dot${i === index ? ' on' : ''}`
    dot.type = 'button'
    dot.setAttribute('aria-label', `第 ${i + 1} 条排队消息`)
    dot.onclick = () => {
      state.queueIndex.set(state.current, i)
      renderQueue()
    }
    dots.appendChild(dot)
  }
  bar.appendChild(dots)
  return bar
}

/** 本地摘掉一行排队消息（服务端说它已经不是排队消息时也用它对齐）。 */
function dropQueueRow(itemId, sessionId = state.current) {
  const rest = (state.queues.get(sessionId) || []).filter((row) => row.itemId !== itemId)
  state.queues.set(sessionId, rest)
  if (sessionId === state.current) renderQueue()
}

/* 本地先改、再发请求：网络往返哪怕只有几十毫秒，用户点了"保存"却看到旧文本
 * 也会以为没生效（用户实测："看似没修改，实际已经修改好了"）。所以三个动作都
 * 立刻改本地，失败再回滚。 */
function setQueueText(itemId, text, sessionId = state.current, dropImages = false) {
  const rows = state.queues.get(sessionId) || []
  state.queues.set(sessionId, rows.map((row) => {
    if (row.itemId !== itemId) return row
    // 编辑走的是宿主 edit（只收文本块），图片在服务端已经被丢掉，
    // 本地也要立刻把张数清零，否则排队行还挂着 🖼 图标，用户以为图还在。
    return dropImages ? { ...row, text, imageCount: 0 } : { ...row, text }
  }))
  if (sessionId === state.current) renderQueue()
}

async function queueAction(item, action, text) {
  if (!state.current) return
  const sessionId = state.current
  const snapshot = (state.queues.get(sessionId) || []).slice()
  // 立刻反映到界面：编辑改文本、删除/插话摘掉行；插话还要立刻出现"你"的气泡。
  if (action === 'edit' && typeof text === 'string') {
    setQueueText(item.itemId, text, sessionId, true)
    touchQueue(sessionId, item.itemId, { text, imageCount: 0 })
  }
  if (action === 'remove' || action === 'steer') {
    dropQueueRow(item.itemId)
    touchQueue(sessionId, item.itemId, { removed: true })
  }
  const optimisticSeq = action === 'steer' ? -Date.now() : 0
  if (action === 'steer') {
    // 插话后立刻出现的"你"气泡也要能看出带了图（本地没有 base64，只有张数）。
    const imageCount = Number(item.imageCount) || 0
    const optimistic = {
      type: 'user/message',
      seq: optimisticSeq,
      sessionId,
      time: Date.now(),
      optimistic: true,
      data: {
        message: {
          role: 'user',
          content: [
            ...(item.text ? [{ type: 'text', text: item.text }] : []),
            ...(imageCount > 0
              ? [{ type: 'image', attachment: { attachmentId: '', mediaType: '', name: '', pendingCount: imageCount } }]
              : []),
          ],
        },
      },
    }
    pendingPush(sessionId, optimisticSeq, item.text || `[${imageCount} 张图片]`, optimistic)
    appendEvent(optimistic)
    scrollBottom()
    toast('已插话到本轮')
  }
  try {
    await api('/api/queue', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        itemId: item.itemId,
        action,
        ...(typeof text === 'string' ? { text } : {}),
      }),
    })
  } catch (error) {
    // 回滚到点之前的样子，别让用户对着一份"假成功"的队列。
    state.queues.set(sessionId, snapshot)
    state.queueTouched.delete(sessionId)
    if (sessionId === state.current) renderQueue()
    if (optimisticSeq) {
      dropPending(sessionId, optimisticSeq)
      if (sessionId === state.current) reflow()
    }
    if (error && error.code === 'queue-stale') {
      dropQueueRow(item.itemId, sessionId)
      toast('这条排队消息已经不在队列里了，已从列表移除')
      return
    }
    if (error && error.code === 'steer-unavailable') {
      toast('这一轮已经不能再插话了')
      loadQueue(sessionId)
      return
    }
    toast(error.message)
  }
}

async function loadQueue(sessionId) {
  try {
    const data = await api(`/api/queue?sessionId=${encodeURIComponent(sessionId)}`)
    state.queues.set(sessionId, Array.isArray(data.items) ? data.items : [])
    if (sessionId === state.current) renderQueue()
  } catch {}
}

/* 排队条的上下滑动手势：多条排队消息时，一次只显示一条，上下滑动切换。
 * 用 touch 事件而不是 scroll 容器：排队条最多 32vh，做成可滚列表会跟聊天区
 * 抢滚动；这里只关心"上/下各滑一条"，阈值 28px，且必须在同一条内。
 */
function bindQueueSwipe() {
  const box = $('queue')
  if (!box || box.dataset.swipeBound === '1') return
  box.dataset.swipeBound = '1'
  let startY = 0
  let startX = 0
  let tracking = false

  const count = () => (state.queues.get(state.current) || []).length
  const move = (delta) => {
    const total = count()
    if (total < 2) return
    const current = state.queueIndex.get(state.current) || 0
    const next = Math.max(0, Math.min(total - 1, current + delta))
    if (next === current) return
    state.queueIndex.set(state.current, next)
    renderQueue()
  }

  box.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return
    // 正在编辑某条时不要抢手势（用户可能在选词/拖光标）
    if (state.editingQueue) return
    const target = event.target
    if (target && target.closest && target.closest('textarea, input, .queue-btn')) return
    startY = event.touches[0].clientY
    startX = event.touches[0].clientX
    tracking = true
  }, { passive: true })

  box.addEventListener('touchend', (event) => {
    if (!tracking) return
    tracking = false
    const touch = event.changedTouches && event.changedTouches[0]
    if (!touch) return
    const dy = touch.clientY - startY
    const dx = touch.clientX - startX
    if (Math.abs(dy) < 28) return
    if (Math.abs(dy) < Math.abs(dx) * 1.4) return
    move(dy < 0 ? 1 : -1)
  }, { passive: true })

  // 桌面/调试时也能用滚轮切
  box.addEventListener('wheel', (event) => {
    if (count() < 2) return
    if (Math.abs(event.deltaY) < 18) return
    event.preventDefault()
    move(event.deltaY > 0 ? 1 : -1)
  }, { passive: false })
}


async function send(mode = 'auto') {
  const area = $('composer')
  const text = area.value.trim()
  const images = state.attachments.slice()
  if ((!text && images.length === 0) || !state.current) return
  const sessionId = state.current
  // 默认行为必须与 DSH 一致：**永远是排队**（queue），由宿主决定这条消息是本轮
  // 之后执行、还是作为新一轮开始。以前这里按"是否在跑"自动切成 steer，结果用户
  // 点发送就成了"插话"，排队功能看起来消失了（用户踩过）。插话只能通过长按/
  // 显式入口触发，绝不由默认发送键隐式决定。
  const effective = mode === 'auto' ? 'queue' : mode
  const running = state.turnOpen.get(sessionId) === true || state.running.get(sessionId) === true
  area.value = ''
  autosize()

  // 图片随消息一起发：宿主 prompt 的 content 支持 {type:'image', mediaType, data(base64)}，
  // 不需要额外的上传接口（省一次往返，也省流量）。
  const payload = { sessionId, text, mode: effective }
  if (images.length > 0) {
    payload.images = images.map((item) => ({ data: item.data, mediaType: item.mediaType, name: item.name }))
  }
  const clearAttachments = () => {
    for (const item of state.attachments) if (item.url) URL.revokeObjectURL(item.url)
    state.attachments = []
    renderAttachments()
  }

  // 本轮正在跑：这条消息是"排队消息"，用户期望的是**立刻看到排队条**，
  // 而不是先出现一个聊天气泡（那会让人以为已经发出去了，等半天才有排队框）。
  // 所以运行中只插排队占位，气泡留给宿主的 user/message 事件。
  if (effective === 'queue' && running) {
    const placeholder = {
      itemId: `pending-${Date.now()}`,
      text: text || `[${images.length} 张图片]`,
      imageCount: images.length,
      at: Date.now(),
      pending: true,
    }
    const rows = state.queues.get(sessionId) || []
    state.queues.set(sessionId, [...rows, placeholder])
    if (sessionId === state.current) renderQueue()
    try {
      await api('/api/prompt', { method: 'POST', body: JSON.stringify(payload) })
      clearAttachments()
    } catch (error) {
      const kept = (state.queues.get(sessionId) || []).filter((row) => row.itemId !== placeholder.itemId)
      state.queues.set(sessionId, kept)
      if (sessionId === state.current) renderQueue()
      toast(error.message)
    }
    return
  }

  const optimisticSeq = -Date.now()
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const item of images) content.push({ type: 'image', attachment: { attachmentId: '', mediaType: item.mediaType, bytes: item.bytes || 0, name: item.name, previewUrl: item.url } })
  const optimistic = {
    type: 'user/message',
    seq: optimisticSeq,
    sessionId,
    time: Date.now(),
    optimistic: true,
    data: { message: { role: 'user', content } },
  }
  pendingPush(sessionId, optimisticSeq, text || `[${images.length} 张图片]`, optimistic)
  appendEvent(optimistic)
  scrollBottom()
  try {
    await api('/api/prompt', { method: 'POST', body: JSON.stringify(payload) })
    clearAttachments()
  } catch (error) {
    dropPending(sessionId, optimisticSeq)
    reflow()
    toast(error.message)
  }
}

// 显式插话：只在"本轮正在跑"时有意义，长按发送键（或排队条的 ↑）才会走到这里。
// 纯图片插话必须放行：以前这里 `if (!text) return`，导致"贴张图长按发送"毫无反应。
async function steerNow() {
  const area = $('composer')
  const text = area.value.trim()
  if ((!text && state.attachments.length === 0) || !state.current) return
  const sessionId = state.current
  if (!(state.turnOpen.get(sessionId) === true || state.running.get(sessionId) === true)) {
    toast('当前没有正在执行的回合，直接发送即可')
    return
  }
  await send('steer')
}

/* 发送键的两个动作：
 *   点一下   → send('auto')，也就是排队（与电脑端 DSH 的默认行为一致）；
 *   长按 500ms → steerNow()，插话到正在跑的这一轮里。
 * 手机上没有第二个按钮的位置，长按是最省空间的做法；排队条里的 ↑ 也还能插话，
 * 两条路都通。onclick 在长按抬手后依然会触发，所以用 longPressed 标志吞掉那一次。
 */
const STEER_HOLD_MS = 500

function bindSendButton() {
  const button = $('btn-send')
  if (!button) return
  let timer = 0
  let longPressed = false
  const cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = 0
    }
  }
  button.addEventListener('pointerdown', () => {
    longPressed = false
    cancel()
    timer = setTimeout(() => {
      timer = 0
      longPressed = true
      if (navigator.vibrate) navigator.vibrate(12)
      steerNow()
    }, STEER_HOLD_MS)
  })
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(event, cancel)
  }
  button.onclick = () => {
    if (longPressed) {
      longPressed = false
      return
    }
    send('auto')
  }
}

async function stopTurn() {
  if (!state.current) return
  try {
    await api('/api/cancel', { method: 'POST', body: JSON.stringify({ sessionId: state.current }) })
    toast('已请求终止')
  } catch (error) {
    toast(error.message)
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    await openDb()
  } catch {}

  try {
    const cursors = await idb.get('meta', 'cursors')
    if (cursors && cursors.value) state.cursors = cursors.value
  } catch {}

  state.token = localStorage.getItem(KEY_TOKEN) || ''
  state.deviceName = localStorage.getItem(KEY_NAME) || ''
  rememberDeviceCookie(state.token)
  // 折叠状态跟着设备走：用户折叠过的项目组，下次打开还是折叠的。
  try {
    const saved = JSON.parse(localStorage.getItem('mr.collapsedGroups') || '[]')
    if (Array.isArray(saved)) state.collapsedGroups = new Set(saved.map(String))
  } catch {}

  const params = new URLSearchParams(location.search)
  const tokenParam = params.get('t')
  if (tokenParam) {
    showView('pair')
    $('pair-code').value = tokenParam
    history.replaceState({}, '', location.pathname)
    try {
      const info = await pair(tokenParam)
      if (info && info.replaced > 0) toast('已绑定，旧设备已解绑')
      await afterPair()
      return
    } catch (error) {
      $('pair-error').textContent = error.message
      $('pair-error').classList.remove('hidden')
      return
    }
  }

  if (!state.token) {
    showView('pair')
    return
  }
  await afterPair()
}

async function afterPair() {
  showView('list')
  await loadLocalSessions()
  connect()
  await refreshState().catch((error) => toast(error.message))
}

/* ----------------------------------------------------------------- events */

$('pair-submit').onclick = async () => {
  const code = $('pair-code').value.trim()
  if (!code) return
  $('pair-error').classList.add('hidden')
  try {
    if ($('pair-name').value.trim()) localStorage.setItem(KEY_NAME, $('pair-name').value.trim())
    const info = await pair(code)
    if (info && info.replaced > 0) toast('已绑定，旧设备已解绑')
    await afterPair()
  } catch (error) {
    $('pair-error').textContent = error.message
    $('pair-error').classList.remove('hidden')
  }
}

$('btn-refresh').onclick = async () => {
  try {
    await refreshState()
    toast('已刷新')
  } catch (error) {
    toast(error.message)
  }
}
$('btn-back').onclick = leaveChat
$('btn-stop').onclick = stopTurn
$('btn-model').onclick = openModelSheet
$('btn-send').onclick = () => send('auto') // 先绑一次，bindSendButton 会覆盖它
bindSendButton()
bindAttach()
bindKeyboardRepin()
$('q-submit').onclick = submitQuestion
$('q-dismiss').onclick = closeQuestion

for (const node of document.querySelectorAll('[data-close]')) {
  node.onclick = () => $('sheet-model').classList.add('hidden')
}

$('composer').addEventListener('input', autosize)
$('composer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send('auto')
  }
})

// 上滑翻页的滚动监听。
// 关键：loadOlder 用 `before=` 当前最小 seq 往回取一页，服务端 limit 是"轮数"，
// 一轮可能只有 3 条事件——所以"上滑一次"必须真的能触发。
//
// 另一个坑：如果页面本身在滚（body 溢出）而不是 #transcript 在滚，挂在 transcript
// 上的 scroll 永远不触发，表现就是"上滑毫无反应、还容易触发下拉刷新"。所以这里
// 同时监听 window/document，并取两者的较小值判断是否到了顶部。
function scrollTopOf(box) {
  // 取**较大值**：容器在滚时 box.scrollTop 是真实位移，body 在滚时 window.scrollY 是真实位移，
  // 另一个通常是 0。曾经这里用了 Math.min，结果 body 不滚时恒等于 0 →
  // "滚离顶部再上闩"的条件（top > 240）永远不成立，翻完第一页就再也翻不动。
  const docTop = window.scrollY || document.documentElement?.scrollTop || 0
  return Math.max(box.scrollTop || 0, docTop)
}

let olderTimer = 0
function onTranscriptScroll() {
  const box = $('transcript')
  const top = scrollTopOf(box)
  // 贴底状态跟着用户的手指走：离开底部就解除，回到底部就恢复。
  state.pinBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  $('btn-bottom').classList.toggle('hidden', box.scrollHeight - box.scrollTop - box.clientHeight < 240)
  // 滚离顶部就重新允许翻页（用户往下看过了，再滑回顶部应该再给一页）。
  if (top > 240 && state.olderArmed.get(state.current) === false) {
    state.olderArmed.set(state.current, true)
  }
  // 上滑到接近顶部就继续往更早的方向翻一页。省流是"默认不预取"，不是"永远不给看"。
  if (top > 160) return
  if (olderTimer) return
  olderTimer = setTimeout(() => {
    olderTimer = 0
    // 延迟到这一帧滚动静止后再判断：滚动位置可能已经被锚定改掉了。
    if (scrollTopOf($('transcript')) > 160) return
    loadOlder(state.current).catch(() => {})
  }, 120)
  // 立刻把门闩放开，让"滚到顶 → 加载 → 继续滚到顶"能连续工作；
  // 真正的防连翻由 loadingOlder 与 hasMore 控制。
  state.olderArmed.set(state.current, true)
}

$('transcript').addEventListener('scroll', onTranscriptScroll, { passive: true })
// 文件芯片：点一下复制完整路径（手机上没法"打开本地文件"，复制是最有用的一步）。
// 用事件委托，历史消息重放/翻页插入的节点不需要单独绑定。
$('transcript').addEventListener('click', (event) => {
  const chip = event.target && event.target.closest ? event.target.closest('.file-chip') : null
  if (!chip) return
  event.preventDefault()
  const path = chip.dataset.path || ''
  copyText(path).then((ok) => toast(ok ? `已复制路径：${shortPath(path)}` : '复制失败，请长按选择'))
})

function shortPath(path) {
  const value = String(path || '')
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : value
}
window.addEventListener('scroll', onTranscriptScroll, { passive: true })
document.addEventListener('scroll', onTranscriptScroll, { passive: true, capture: true })
// 排队条：多条时上下滑动切换（必须在这里绑定，元素在 boot 时已存在）
bindQueueSwipe()
$('btn-bottom').onclick = () => scrollBottom()

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 页面在后台就别再保持长连接/长轮询了，省流量也省电。
    closeTransport()
    return
  }
  if (!state.transport && state.token) connect()
  // 回前台先对齐一次"最新发生了什么"，即使推送通道卡住也不会停在旧状态。
  if (state.current) loadLatest(state.current).catch(() => {})
  refreshState().catch(() => {})
})

// 兜底：45 秒一个新帧都没有（连 hello/ping 都没有），说明这条通道已经死了但 fetch
// 还没报错（移动网络切换时很常见）。主动重连，避免手机永久停在旧画面。
setInterval(() => {
  if (document.hidden || !state.token) return
  const last = state.lastFrameAt || 0
  if (Date.now() - last < 45000) return
  if (!state.transport) { connect(); return }
  closeTransport()
  connect()
}, 15000)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

boot()
