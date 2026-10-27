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
  running: new Map(),
  turnOpen: new Map(),
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
  pending: [],
  queues: new Map(),
  editingQueue: '',
  delta: { text: '', reasoning: '' },
  deltaNode: null,
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
function mdInline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    // 裸链接（前面是行首/空白/左括号才算，避免把已生成 <a href="..."> 再包一层）
    .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
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
      const level = Math.min(6, heading[1].length + 2) // 手机里 h1 太大，从 h3 起
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`)
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
  attachmentUrl(hash).then((url) => {
    if (url) img.src = url
    else wrap.textContent = `［图片 ${attachment?.name || hash.slice(0, 8)} 读取失败］`
  })
  return wrap
}

function toast(text, ms = 2600) {
  const node = $('toast')
  node.textContent = text
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), ms)
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
    logout()
    throw new Error('绑定已失效，请重新扫码')
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function logout() {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_NAME)
  state.token = ''
  closeTransport()
  showView('pair')
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
  return data
}

/* ----------------------------------------------------------- session list */

function renderSessions() {
  const list = $('session-list')
  list.innerHTML = ''
  const items = Array.from(state.sessions.values())
    .filter((session) => session && session.blank !== true)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  $('list-empty').classList.toggle('hidden', items.length > 0)
  for (const session of items) {
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
        ${session.cwd ? `<span>${escapeHtml(session.cwd.split(/[\\/]/).pop() || '')}</span>` : ''}
      </div>`
    row.onclick = () => openChat(session.id)
    list.appendChild(row)
  }
}

async function refreshState() {
  const data = await api('/api/state')
  for (const session of data.sessions) {
    state.sessions.set(session.id, session)
    if (typeof session.running === 'boolean') state.running.set(session.id, session.running)
  }
  // 服务端已经删掉的会话，本地一并清掉
  const alive = new Set(data.sessions.map((session) => session.id))
  for (const id of Array.from(state.sessions.keys())) if (!alive.has(id)) state.sessions.delete(id)
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
  box.scrollTop = box.scrollHeight
}

function nearBottom() {
  const box = $('transcript')
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120
}

function renderChatHeader() {
  const session = state.sessions.get(state.current)
  $('chat-title').textContent = session?.title || '会话'
  const model = session?.model ? `${session.model.provider}/${session.model.model}` : ''
  const effort = session?.model?.reasoningEffort || ''
  const running = state.running.get(state.current) === true
  $('chat-sub').textContent = [model, effort, running ? '生成中…' : ''].filter(Boolean).join(' · ')
  $('btn-stop').classList.toggle('hidden', !running)
  $('btn-steer').classList.toggle('hidden', !running)
}

function makeMessageNode(role) {
  const node = document.createElement('div')
  node.className = `msg ${role}`
  return node
}

function appendDivider(text, isError) {
  const node = document.createElement('div')
  node.className = `divider${isError ? ' err' : ''}`
  node.textContent = text
  $('transcript').appendChild(node)
}

function appendEvent(event) {
  const sessionId = state.current
  if (!event || typeof event !== 'object' || event.sessionId && event.sessionId !== sessionId) return
  if (!event.optimistic && typeof event.seq === 'number') {
    if (state.seen.has(event.seq)) return
    state.seen.add(event.seq)
  }
  const box = $('transcript')
  const stick = nearBottom()
  const data = event.data || {}

  switch (event.type) {
    case 'user/message': {
      const node = makeMessageNode('user')
      node.appendChild(roleNode('你'))
      // 宿主历史里的 user/message 是扁平的（content/role 直接在 data 上），
      // 少数路径会包一层 data.message，两种都要认，否则"我"发的消息永远不显示。
      const rendered = renderContent(node, data.message || data)
      if (!rendered) return
      box.appendChild(node)
      break
    }
    case 'assistant/message': {
      const node = makeMessageNode('assistant')
      node.appendChild(roleNode('DSH'))
      const rendered = renderContent(node, data.message)
      if (!rendered) return
      box.appendChild(node)
      break
    }
    case 'tool/call': {
      box.appendChild(toolCallRow(data))
      break
    }
    case 'tool/result': {
      box.appendChild(toolResultRow(data))
      break
    }
    case 'turn/end': {
      const reason = data.reason?.kind || ''
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

function roleNode(text) {
  const node = document.createElement('div')
  node.className = 'role'
  node.textContent = text
  return node
}

function eventRow({ icon, verb, target, extra, className = '' }) {
  const row = document.createElement('div')
  row.className = `ev ${className}`.trim()
  row.innerHTML = `<span class="ev-ico">${escapeHtml(icon)}</span>` +
    `<span class="ev-verb">${escapeHtml(verb)}</span>` +
    (target ? `<span class="ev-dot">·</span><span class="ev-target">${escapeHtml(target)}</span>` : '') +
    (extra ? `<span class="ev-extra">${escapeHtml(extra)}</span>` : '')
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

function toolCallRow(data) {
  const summary = data.summary || { kind: 'other', verb: '工具调用', target: data.name || 'tool', extra: '' }
  const row = eventRow({
    icon: EV_ICONS[summary.kind] || '›',
    verb: summary.verb,
    target: summary.target,
    extra: summary.extra,
  })
  const args = data.arguments ? String(data.arguments) : ''
  return expandable(row, args && args !== '{}' ? prettyArgs(args) : '', 'ev-tool')
}

function toolResultRow(data) {
  const message = data.message || {}
  const text = messageText(message)
  const failed = message.isError === true || data.error != null
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

/** 把一条消息的 content 块渲染进 node：文字、图片、思考、内联工具调用。返回是否有内容。 */
function renderContent(node, message) {
  let rendered = false
  for (const block of blocks(message)) {
    if (block.type === 'text' && block.text) {
      const text = document.createElement('div')
      text.className = 'msg-text'
      text.innerHTML = renderText(block.text)
      node.appendChild(text)
      rendered = true
    } else if (block.type === 'reasoning' && block.text) {
      const first = clip(block.text, 40)
      const row = eventRow({ icon: '⊗', verb: '思考', target: first, className: 'ev-think' })
      node.appendChild(expandable(row, block.text, 'ev-think-wrap'))
      rendered = true
    } else if (block.type === 'image' || block.type === 'attachment') {
      const figure = imageNode(block.attachment || block)
      if (figure) {
        node.appendChild(figure)
        rendered = true
      }
    } else if (block.type === 'tool-call') {
      const row = eventRow({ icon: '›', verb: '工具调用', target: block.name || 'tool', className: 'ev-inline' })
      node.appendChild(row)
      rendered = true
    }
  }
  return rendered
}

function ensureDeltaNode() {
  if (state.deltaNode && state.deltaNode.isConnected) return state.deltaNode
  const node = makeMessageNode('assistant streaming')
  node.innerHTML = `<div class="role">DSH</div><div class="delta-body"></div>`
  $('transcript').appendChild(node)
  state.deltaNode = node
  return node
}

function applyDelta(payload) {
  if (payload.sessionId !== state.current) return
  if (payload.streaming === false) return
  const stick = nearBottom()
  state.delta.text = payload.text || ''
  state.delta.reasoning = payload.reasoning || ''
  const node = ensureDeltaNode()
  node.querySelector('.delta-body').innerHTML = renderText(state.delta.text) || '<span class="muted">…</span>'
  if (stick) scrollBottom()
}

function clearDelta() {
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
  clearTranscript()
  clearDelta()
  showView('chat')
  renderChatHeader()
  scrollBottom()

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
        changed = true
      }
      await saveEvent(sessionId, event)
    }
    if (typeof page.latestSeq === 'number') {
      // 游标只跟着"真正拿到的记录"走。直接把它推到 latestSeq 会在漏收时永久跳过中间事件。
      let maxSeq = state.cursors[sessionId] || 0
      for (const event of page.events) if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
      state.cursors[sessionId] = maxSeq
      saveCursors()
    }
    // 用历史事件推断"这一轮是不是还没结束"，手机上才能决定第二条消息是排队还是新开一轮
    let open = false
    for (const ev of Array.from(state.events.values()).sort((a, b) => a.seq - b.seq)) {
      if (ev.type === 'turn/start') open = true
      else if (ev.type === 'turn/end') open = false
    }
    state.turnOpen.set(sessionId, open)
    if (changed) reflow()
    scrollBottom()
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

function reflow() {
  clearTranscript()
  clearDelta()
  state.seen = new Set()
  const ordered = Array.from(state.events.values()).sort((a, b) => a.seq - b.seq)
  for (const event of ordered) appendEvent(event)
  // 还没被服务端事件确认的本地消息（乐观气泡）也要重建，否则一发消息就"消失"。
  // 但只重建属于当前会话的那几条：pending 是跨会话共用的表，不过滤就会串台。
  prunePending()
  for (const item of state.pending) {
    appendEvent(item.event)
  }
}

/* 乐观气泡表：每条都必须带 sessionId（见 pendingPush）。
 * 历史 bug：整张表没有会话归属，openChat 切换时不清，reflow() 又无条件重画
 * → 在会话 A 发的消息，切到会话 B 后被渲染进 B 的时间线。 */
const PENDING_TTL = 120_000

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
  const text = messageText(data.message || data)
  if (!text) return
  const owner = sessionId || event.sessionId || ''
  const index = state.pending.findIndex((item) => item.text === text)
  if (index < 0) return
  const settledSession = state.pending[index].sessionId
  state.pending.splice(index, 1)
  // 只有撤掉的那条属于当前会话时才重画；别的会话不碰当前时间线。
  if (settledSession === state.current) reflow()
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
  for (const type of ['event', 'status', 'delta', 'question', 'question-resolved', 'question-expired', 'approval', 'queue']) {
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

function handleFrame(type, payload) {
  state.lastFrameAt = Date.now()
  if (type === 'hello') {
    state.retry = 0
    setConn('on', state.transport === 'poll' ? '省流模式' : '已连接')
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
    if (event.type === 'assistant/message') clearDelta()
    // 一轮是否在跑，用本轮自己的 turn/start、turn/end 事件判断最可靠：
    // 宿主下发的 session.running / agent/status 在"秒失败"的会话里会立刻变回 false。
    if (event.type === 'turn/start') {
      state.turnOpen.set(sessionId, true)
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
    state.events.set(event.seq, event)
    appendEvent(event)
    return
  }
  if (type === 'status') {
    state.running.set(payload.sessionId, payload.status === 'running')
    const session = state.sessions.get(payload.sessionId)
    if (session) state.sessions.set(payload.sessionId, { ...session, running: payload.status === 'running' })
    if (payload.sessionId === state.current) renderChatHeader()
    if (!$('view-list').classList.contains('hidden')) renderSessions()
    return
  }
  if (type === 'delta') {
    applyDelta(payload)
    return
  }
  if (type === 'queue') {
    const items = Array.isArray(payload.items) ? payload.items : []
    // 服务端是唯一真源。本地"发送中…"占位只在**很短的时间窗**内保留（刚发出、
    // 服务端还没认下的那一两百毫秒）；超过 6 秒还没出现在服务端队列里，就认为它
    // 已经被取走或失败，直接丢掉——否则它会永远挂在手机上当"排队中"。
    const texts = new Set(items.map((row) => row.text))
    const now = Date.now()
    const kept = (state.queues.get(payload.sessionId) || []).filter((row) => {
      if (!row.pending) return false
      if (texts.has(row.text)) return false
      return now - (row.at || 0) < 6000
    })
    const merged = [...items]
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
  }
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
  box.innerHTML = ''
  box.classList.toggle('hidden', items.length === 0)
  for (const item of items) {
    if (state.editingQueue === item.itemId) {
      box.appendChild(queueEditRow(item))
      continue
    }
    const row = document.createElement('div')
    row.className = `queue-item${item.pending ? ' pending' : ''}`
    const text = document.createElement('div')
    text.className = 'queue-text'
    text.textContent = item.text || '（无文字内容）'
    row.appendChild(text)
    if (item.pending) {
      // 服务端还没确认，先占位，不给编辑/删除按钮
      const tag = document.createElement('span')
      tag.className = 'queue-pending'
      tag.textContent = '发送中…'
      row.appendChild(tag)
      box.appendChild(row)
      continue
    }
    row.appendChild(queueButton('✎', '编辑', () => {
      state.editingQueue = item.itemId
      renderQueue()
    }))
    row.appendChild(queueButton('🗑', '删除', () => queueAction(item, 'remove')))
    row.appendChild(queueButton('↑', '插话到本轮', () => queueAction(item, 'steer')))
    box.appendChild(row)
  }
}

async function queueAction(item, action, text) {
  if (!state.current) return
  try {
    await api('/api/queue', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.current,
        itemId: item.itemId,
        action,
        ...(typeof text === 'string' ? { text } : {}),
      }),
    })
    if (action === 'remove') {
      const rest = (state.queues.get(state.current) || []).filter((row) => row.itemId !== item.itemId)
      state.queues.set(state.current, rest)
      renderQueue()
    } else if (action === 'steer') {
      toast('已插话到本轮')
    }
  } catch (error) {
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

async function send(mode = 'queue') {
  const area = $('composer')
  const text = area.value.trim()
  if (!text || !state.current) return
  const sessionId = state.current
  const queued = mode === 'queue' && (state.turnOpen.get(sessionId) === true || state.running.get(sessionId) === true)
  area.value = ''
  autosize()
  // 排队中（本轮还在跑）的消息由服务端 inbox 事件驱动显示在"排队"条里，
  // 不往时间线上插一个假的已完成气泡——否则它永远等不到对应的真实事件。
  let optimisticSeq = 0
  let optimisticQueue = ''
  if (queued) {
    // 先把排队条画出来，等服务端 `queue` 帧到达后再对齐（含 itemId）
    optimisticQueue = `pending-${Date.now()}`
    const rows = state.queues.get(sessionId) || []
    rows.push({ itemId: optimisticQueue, text, at: Date.now(), pending: true })
    state.queues.set(sessionId, rows)
    renderQueue()
  } else {
    optimisticSeq = -Date.now()
    const optimistic = {
      type: 'user/message',
      seq: optimisticSeq,
      time: Date.now(),
      optimistic: true,
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    }
    // 乐观气泡必须记住"发给了哪个会话"：只存进全局数组，切对话时 reflow()
    // 会把它重新画到另一个对话的时间线上（就是跨会话串话的直接来源）。
    pendingPush(sessionId, optimisticSeq, text, optimistic)
    appendEvent(optimistic)
  }
  try {
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, text, mode }) })
  } catch (error) {
    if (optimisticSeq) {
      dropPending(sessionId, optimisticSeq)
      reflow()
    }
    if (optimisticQueue) {
      state.queues.set(sessionId, (state.queues.get(sessionId) || []).filter((row) => row.itemId !== optimisticQueue))
      renderQueue()
    }
    toast(error.message)
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

  const params = new URLSearchParams(location.search)
  const tokenParam = params.get('t')
  if (tokenParam) {
    showView('pair')
    $('pair-code').value = tokenParam
    history.replaceState({}, '', location.pathname)
    try {
      await pair(tokenParam)
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
    await pair(code)
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
$('btn-send').onclick = () => send('queue')
$('btn-steer').onclick = () => send('steer')
$('q-submit').onclick = submitQuestion
$('q-dismiss').onclick = closeQuestion

for (const node of document.querySelectorAll('[data-close]')) {
  node.onclick = () => $('sheet-model').classList.add('hidden')
}

$('composer').addEventListener('input', autosize)
$('composer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send('queue')
  }
})

$('transcript').addEventListener('scroll', () => {
  const box = $('transcript')
  $('btn-bottom').classList.toggle('hidden', box.scrollHeight - box.scrollTop - box.clientHeight < 240)
})
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
