// 手机端时间线“消息错乱”的回归测试（无浏览器：自带最小 DOM + IDB 替身）。
//
//   node tools/timeline-probe.mjs                     # 测 web/app.js
//   node tools/timeline-probe.mjs --source <path>     # 测指定副本（做反向对照）
//
// 关键约定：每个用例都**先断言坏行为确实会发生**（在 --expect-bug 模式下），
// 修好之后同一用例在正常模式下通过。这样测试才不会“空转全绿”。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const sourceIndex = args.indexOf('--source')
const sourcePath = sourceIndex >= 0 ? resolve(args[sourceIndex + 1]) : join(here, '..', 'web', 'app.js')
const expectBug = args.includes('--expect-bug')

/* ------------------------------------------------------------------ DOM 替身 */

let idSeq = 0

class ClassList {
  constructor(element) {
    this.element = element
    this.set = new Set()
  }
  add(...names) { for (const name of names) this.set.add(name) }
  remove(...names) { for (const name of names) this.set.delete(name) }
  contains(name) { return this.set.has(name) }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : Boolean(force)
    if (want) this.set.add(name)
    else this.set.delete(name)
    return want
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.id = ''
    this.children = []
    this.parent = null
    this.classList = new ClassList(this)
    this.style = {
      props: new Map(),
      setProperty(name, value) {
        this.props.set(String(name), String(value))
      },
      getPropertyValue(name) {
        return this.props.get(String(name)) || ''
      },
    }
    this.dataset = {}
    this._html = ''
    this._text = ''
    this.listeners = new Map()
    this.scrollTop = 0
    this.scrollHeight = 1000
    this.clientHeight = 500
    this.value = ''
    this.uid = ++idSeq
  }
  // 真实 DOM 的兄弟/父指针。app.js 里"把过程行挪到汇总行下面"用的是
  // insertBefore(node, anchor.nextSibling)，替身缺这个 getter 时会退化成 append 到末尾
  // （T27 因此假失败）。这里补齐，保证"移动"语义和浏览器一致。
  get parentNode() { return this.parent || null }
  get nextSibling() {
    const owner = this.parent
    if (!owner || !Array.isArray(owner.children)) return null
    const index = owner.children.indexOf(this)
    return index >= 0 && index + 1 < owner.children.length ? owner.children[index + 1] : null
  }
  get previousSibling() {
    const owner = this.parent
    if (!owner || !Array.isArray(owner.children)) return null
    const index = owner.children.indexOf(this)
    return index > 0 ? owner.children[index - 1] : null
  }
  get firstChild() {
    return this.children.length ? this.children[0] : null
  }
  get isConnected() {
    let node = this
    while (node.parent) node = node.parent
    return node === document.body
  }
  set className(value) {
    this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean))
  }
  get className() {
    return Array.from(this.classList.set).join(' ')
  }
  set innerHTML(value) {
    this._html = String(value)
    this._text = ''
    this.children = []
  }
  get innerHTML() {
    return this._html
  }
  set textContent(value) {
    this._text = String(value)
    this._html = ''
  }
  get textContent() {
    // 真实 DOM 的 textContent 是"自身文本 + 所有后代文本"的拼接。早期替身只返回自身
    // _text，于是「roleNode('你') 之后再 append 正文」的气泡在断言里只剩角色名，
    // 正确实现会被判成失败（T9 就这样假失败过一次）。
    const own = this._text
      ? this._text
      : this._html
        ? String(this._html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        : ''
    return own + this.children.map((child) => child.textContent).join('')
  }
  appendChild(child) {
    this._detach(child)
    child.parent = this
    this.children.push(child)
    return child
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  insertBefore(child, ref) {
    // 真实 DOM 的 insertBefore 是"移动"：先把节点从原父节点摘下来。
    // 早期替身忘了这一步，于是"把过程行挪到汇总行下面"看起来成了复制一份（T27 抓到）。
    this._detach(child)
    const index = this.children.indexOf(ref)
    child.parent = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  _detach(child) {
    const owner = child && child.parent
    if (!owner || !Array.isArray(owner.children)) return
    const index = owner.children.indexOf(child)
    if (index >= 0) owner.children.splice(index, 1)
    child.parent = null
  }
  remove() {
    if (!this.parent) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  }
  removeEventListener() {}
  querySelector(selector) {
    // 只按类名/标签在子树里真实查找。早期替身对任何选择器都返回一个固定 div，
    // 于是「按钮不存在」的断言永远为真、「按钮存在」的断言拿到的是空壳（没有 onclick）。
    const raw = String(selector || '')
    const byClass = raw.startsWith('.')
    const wanted = byClass ? raw.slice(1) : raw.toLowerCase()
    const match = (node) =>
      byClass ? Boolean(node.classList?.set?.has(wanted)) : String(node.tagName || '').toLowerCase() === wanted
    const walk = (node) => {
      for (const child of node.children || []) {
        if (match(child)) return child
        const deep = walk(child)
        if (deep) return deep
      }
      return null
    }
    const found = walk(this)
    if (found) return found
    // 按标签名查（例如 innerHTML 里写的 <span>）在替身里没有解析过程，
    // 返回一个占位节点让 setConn 之类"只写文字"的代码继续跑。
    if (!byClass) {
      if (!this._slots) this._slots = new Map()
      if (!this._slots.has(raw)) this._slots.set(raw, new El(raw))
      return this._slots.get(raw)
    }
    return null
  }
  querySelectorAll(selector) {
    // 和 querySelector 同一套匹配规则，返回子树里所有命中的节点。
    // 之前恒返回空数组，导致"多行子调用""按钮都消失"这类数量断言永远测不出来。
    const raw = String(selector || '')
    const byClass = raw.startsWith('.')
    const wanted = byClass ? raw.slice(1) : raw.toLowerCase()
    const match = (node) =>
      byClass ? Boolean(node.classList?.set?.has(wanted)) : String(node.tagName || '').toLowerCase() === wanted
    const out = []
    const walk = (node) => {
      for (const child of node.children || []) {
        if (match(child)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    // innerHTML 在这个替身里只是一段字符串（不解析成 DOM），所以
    // 走 innerHTML 拼出来的节点在子树里根本不存在。给这些查询留一个代理：
    // 完全找不到时才退回去问 innerHTML 里有没有这个字符串。
    // 真实浏览器里 querySelectorAll 永远不会返回"只为截图存在"的节点，
    // 这个代理只解决替身不解析 HTML 的局限，不改变被测逻辑。
    if (!out.length) {
      const own = String(this.innerHTML || '')
      const hit = byClass ? own.includes(`class="${wanted}`) : own.toLowerCase().includes(`<${wanted}`)
      if (hit) out.push(new El('div'))
    }
    return out
  }
  closest() {
    return null
  }
  focus() {}
  setAttribute() {}
  getAttribute() {
    return null
  }
}

const registry = new Map()
const document = {
  hidden: false,
  body: new El('body'),
  // app.js 里写 CSS 变量用的是 document.documentElement.style.setProperty（软键盘 --kb-h）。
  documentElement: new El('html'),
  createElement: (tag) => new El(tag),
  getElementById: (id) => {
    if (!registry.has(id)) {
      const element = new El('div')
      element.id = id
      registry.set(id, element)
      document.body.appendChild(element)
    }
    return registry.get(id)
  },
  querySelector: () => new El('div'),
  querySelectorAll: () => [],
  addEventListener: () => {},
}

const storeMap = () => new Map()
const stores = { events: storeMap(), sessions: storeMap(), meta: storeMap() }
const request = (fn) => {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null }
  setImmediate(() => {
    try {
      req.result = fn()
      if (req.onsuccess) req.onsuccess()
    } catch (error) {
      req.error = error
      if (req.onerror) req.onerror()
    }
  })
  return req
}
const objectStore = (name) => ({
  put: (value) => request(() => { stores[name].set(value.key ?? value.id, value); return value.key ?? value.id }),
  get: (key) => request(() => stores[name].get(key)),
  delete: (key) => request(() => { stores[name].delete(key); return undefined }),
  getAll: (range) => request(() => {
    const rows = Array.from(stores[name].values())
    if (!range) return rows
    return rows.filter((row) => { const key = row.key ?? row.id; return key >= range.lower && key <= range.upper })
  }),
})
const indexedDB = {
  open: () => {
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
    setImmediate(() => {
      req.result = {
        transaction: () => ({ objectStore }),
        objectStoreNames: { contains: () => true },
      }
      if (req.onsuccess) req.onsuccess()
    })
    return req
  },
}
class IDBKeyRange {
  constructor(lower, upper) { this.lower = lower; this.upper = upper }
  static bound(lower, upper) { return new IDBKeyRange(lower, upper) }
}

const localStorage = {
  map: new Map(),
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null },
  setItem(key, value) { this.map.set(key, String(value)) },
  removeItem(key) { this.map.delete(key) },
}

// 网络一律不真发：只记录，避免测试依赖宿主。
const fetchCalls = []
// 请求体也记下来：图片上传、prompt 的 mode / images 都要靠它断言。
const fetchBodies = []
// page 的返回内容可被用例改写（T11 翻页需要真返回更早的事件）。
let pageHandler = () => ({ ok: true, events: [], latestSeq: 0, hasMore: false })
// /api/state 的返回内容也可被用例改写（T18 归档过滤要用真实的会话列表）。
let stateHandler = null
const fetchStub = async (url, options = {}) => {
  const target = String(url)
  fetchCalls.push(target)
  if (options && options.body) {
    try {
      fetchBodies.push({ url: target, body: JSON.parse(options.body) })
    } catch {
      fetchBodies.push({ url: target, body: options.body })
    }
  }
  const json = target.includes('/api/state')
    ? stateHandler
      ? stateHandler(target)
      : { ok: true, sessions: [], hiddenBlank: 0, defaultModel: null, groups: [] }
    : target.includes('/api/catalog')
      ? { ok: true, catalog: { default: null, groups: [] } }
      : target.includes('/page')
        ? pageHandler(target)
        : target.includes('/event/')
          ? eventHandler(target)
          : target.includes('/api/queue')
            ? { ok: true, items: [] }
            : target.includes('/api/poll')
              ? { ok: true, frames: [], queueSync: [], cursor: {} }
              : { ok: true }
  return { ok: true, status: 200, json: async () => json }
}
// 单条事件（"展开全文"按需拉取完整内容）可被用例改写。
let eventHandler = () => ({ ok: true, full: true, event: null })
class EventSource {
  constructor(url) { this.url = url; this.listeners = new Map() }
  addEventListener(name, fn) { this.listeners.set(name, fn) }
  close() {}
}
// 触感替身：真机走 navigator.vibrate，这里只记录调用参数，
// 让 T38 能断言"长按插话确实震了、用的是哪套节奏"。
const navigator = {
  vibrateCalls: [],
  vibrate(pattern) {
    this.vibrateCalls.push(pattern)
    return true
  },
}
const locationStub = { search: '', hash: '', href: 'http://127.0.0.1:7788/' }
// 软键盘：app.js 用 window.innerHeight 与 window.visualViewport 算被输入法盖住的高度。
// 替身给可改的高度，T31 直接改这两个值来模拟"键盘弹出"。
const windowStub = {
  innerHeight: 800,
  visualViewport: { height: 800, offsetTop: 0, addEventListener: () => {} },
  addEventListener: () => {},
}
// 选图用到的 FileReader：Node 没有，给个最小替身。
// 读的是 file.__base64（用例直接给内容），readAsDataURL 异步回调 onload。
class FileReaderStub {
  constructor() {
    this.result = ''
    this.onload = null
    this.onerror = null
  }
  readAsDataURL(file) {
    const base64 = String((file && file.__base64) || '')
    const type = (file && file.type) || 'image/png'
    this.result = `data:${type};base64,${base64}`
    setTimeout(() => {
      if (this.onload) this.onload()
    }, 0)
  }
}

/* ------------------------------------------------------------------ 载入脚本 */

// app.js 里 input 自适应高度用了 requestAnimationFrame（真实浏览器一定有）。
// 替身环境没有，按"立刻回调"实现即可，测的是回调里做了什么，不是动画节拍。
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

const source = readFileSync(sourcePath, 'utf8')
const factory = new Function(
  'window', 'document', 'navigator', 'localStorage', 'indexedDB', 'IDBKeyRange', 'EventSource', 'fetch', 'location', 'console', 'FileReader', 'Blob',
  source + '\nreturn { state, handleFrame, reflow, appendEvent, openChat, settlePending, pendingPush, applyDelta, clearDelta, closeTransport, loadQueue, loadOlder, renderSessions, refreshState, groupSessions, addFiles, renderAttachments, send, renderQueue, dropQueueRow, setQueueText, touchQueue, mdInline, renderMarkdown, renderText, copyText, rowForItem, steerNow, queueAction, imageNode, pendingFigureNode, keyboardInset, applyKeyboardInset, rememberDeviceCookie, logout, haptic, prependOlder, turnProcessNodes, stowTurnProcess, toggleTurnProcess, restowAllSummaries, appendTurnSummary, loadUnread, markUnread, markSeen, seedUnreadFromSnapshot, noteLastSeq, sessionRow, showFinishedChip, noticeTurnFinished, dismissFinishedChip, leaveChat }',
)
const app = factory(windowStub, document, navigator, localStorage, indexedDB, IDBKeyRange, EventSource, fetchStub, locationStub, console, FileReaderStub, Blob)

/* ------------------------------------------------------------------ 断言工具 */

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''))
  }
}

// 把 transcript 里的文字按 DOM 顺序拼出来（忽略样式节点）
function timelineText() {
  const box = document.getElementById('transcript')
  return box.children.map((node) => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function reset(sessionId = 'sess-A') {
  const box = document.getElementById('transcript')
  box.children = []
  box.innerHTML = ''
  app.state.current = sessionId
  app.state.events = new Map()
  app.state.seen = new Set()
  app.state.pending = []
  app.state.queues = new Map()
  app.state.queueTouched = new Map()
  app.state.queueIndex = new Map()
  app.state.queueShownAt = new Map()
  app.state.steerNodes = new Map()
  app.state.older = new Map()
  app.state.olderDone = new Set()
  app.state.loadingOlder = new Set()
  app.state.olderArmed = new Map()
  app.state.delta = { text: '', reasoning: '' }
  app.clearDelta()
}

const userEv = (seq, text) => ({ type: 'user/message', seq, time: seq, sessionId: 'sess-A', data: { role: 'user', content: [{ type: 'text', text }] } })
const asstEv = (seq, text) => ({ type: 'assistant/message', seq, time: seq, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

/* ------------------------------------------------------------------ 用例 */

console.log('源码：' + sourcePath)

// T1 乱序到达：seq 3 先到、seq 2 后到，时间线必须仍按 seq 排列。
reset()
app.handleFrame('event', userEv(1, '第一句'))
app.handleFrame('event', asstEv(3, '第三句'))
app.handleFrame('event', userEv(2, '第二句'))
check('T1 乱序到达后仍按 seq 排列', JSON.stringify(timelineText()) === JSON.stringify(['你第一句', '你第二句', 'DSH第三句']), JSON.stringify(timelineText()))

// T2 迟到的 delta：assistant/message 已经落地，之后又收到同一段的 delta 帧，
//    不允许再冒出一个“DSH”气泡（重复/错位）。
reset()
app.handleFrame('event', asstEv(5, '最终答复'))
app.handleFrame('delta', { sessionId: 'sess-A', text: '最终答复', streaming: true })
const afterLateDelta = timelineText()
check('T2 迟到 delta 不产生重复气泡', afterLateDelta.length === 1 && afterLateDelta[0] === 'DSH最终答复', JSON.stringify(afterLateDelta))

// T3 乐观气泡与服务端回显文本不完全一致（尾随空格/换行）时，不能显示两条。
reset()
app.pendingPush('sess-A', -1, '继续 ', { type: 'user/message', seq: -1, optimistic: true, sessionId: 'sess-A', data: { role: 'user', content: [{ type: 'text', text: '继续 ' }] } })
app.reflow()
app.handleFrame('event', userEv(7, '继续'))
const afterEcho = timelineText()
check('T3 回显文本带空白时不重复', afterEcho.length === 1 && afterEcho[0] === '你继续', JSON.stringify(afterEcho))

// T4 切会话后旧事件不得混进新会话的时间线。
reset('sess-A')
app.handleFrame('event', userEv(11, 'A 的消息'))
app.state.current = 'sess-B'
app.state.events = new Map()
app.state.seen = new Set()
document.getElementById('transcript').children = []
app.handleFrame('event', { ...userEv(12, 'B 的消息'), sessionId: 'sess-B' })
app.handleFrame('event', userEv(13, 'A 的迟到消息'))
const mixed = timelineText()
check('T4 切会话后不串台', mixed.length === 1 && mixed[0] === '你B 的消息', JSON.stringify(mixed))

// T5 重连补洞：hello 带服务端最新游标，若比本地游标新，必须触发一次对齐拉取。
reset()
app.state.cursors = { 'sess-A': 5 }
const before = fetchCalls.length
app.handleFrame('hello', { serverTime: Date.now(), latest: { 'sess-A': 9 } })
await new Promise((resolve) => setTimeout(resolve, 50))
const pulled = fetchCalls.slice(before).some((url) => url.includes('/page'))
check('T5 发现漏帧后触发对齐拉取', pulled, JSON.stringify(fetchCalls.slice(before)))

// T6 思考/调用默认收成一行：点击才展开，正文落地后自动全部收起，一轮结束给出"已完成，用时"。
reset()
app.handleFrame('event', { type: 'tool/call', seq: 1, time: 1000, sessionId: 'sess-A', data: { name: 'pwsh', arguments: '{"command":"dir"}', summary: { kind: 'cmd', verb: '运行命令', target: 'dir' } } })
const box = document.getElementById('transcript')
const firstWrap = box.children[0]
const collapsedByDefault = Boolean(firstWrap) && firstWrap.classList.contains('ev-wrap') && !firstWrap.classList.contains('open')
check('T6 过程行默认只有一行（未展开）', collapsedByDefault, firstWrap ? firstWrap.className : 'no-node')
const row = firstWrap && firstWrap.children[0]
if (row && typeof row.onclick === 'function') row.onclick()
const expanded = Boolean(firstWrap) && firstWrap.classList.contains('open')
if (row && typeof row.onclick === 'function') row.onclick()
const collapsedAgain = Boolean(firstWrap) && !firstWrap.classList.contains('open')
check('T6 点击可展开、再点收回', expanded && collapsedAgain, 'expanded=' + expanded + ' collapsed=' + collapsedAgain)
if (row && typeof row.onclick === 'function') row.onclick()
app.handleFrame('event', asstEv(2, '正文到了'))
// 契约变更（用户 m01458）：用户亲手点开的行，后续事件不许把它收回去。
// 「自动收起」只对没被点开过的行生效（对照用例见 T36）。
const keptByUser = Boolean(firstWrap) && firstWrap.classList.contains('open')
check('T6 用户点开的过程行不被新正文收回', keptByUser, firstWrap ? firstWrap.className : 'no-node')
app.handleFrame('event', { type: 'turn/start', seq: 3, time: 1000, sessionId: 'sess-A', data: {} })
app.handleFrame('event', { type: 'turn/end', seq: 4, time: 1000 + 65000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })
// 汇总行现在插在正式回答之前（电脑版顺序），所以不能再取"最后一个节点"。
const summaryNode = box.children.find((node) => node.className && node.className.includes('turn-summary'))
const summaryText = summaryNode ? summaryNode.textContent.replace(/\s+/g, ' ').trim() : ''
check('T6 一轮结束有「已完成，用时」汇总行', /已完成，用时 1 分 5 秒/.test(summaryText), summaryText)

// T6d 汇总行位置：过程行 → 「已完成，用时 x」→ 正式回答 的"回答在最后"必须成立，
//      但过程行要从汇总行**上面**挪到下面（用户 m00261：一级展开要在标题下方展开，
//      否则标题被顶到屏幕外，想收起还得往下翻回去找）。
reset()
app.handleFrame('event', { type: 'turn/start', seq: 20, time: 2000, sessionId: 'sess-A', data: {} })
app.handleFrame('event', {
  type: 'tool/call', seq: 21, time: 2100, sessionId: 'sess-A',
  data: { name: 'pwsh', arguments: '{"command":"dir"}', summary: { kind: 'cmd', verb: '运行命令', target: 'dir' } },
})
app.handleFrame('event', asstEv(22, '正式的最终回答'))
app.handleFrame('event', { type: 'turn/end', seq: 23, time: 2000 + 12000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })
const orderBox = document.getElementById('transcript')
const orderClasses = orderBox.children.map((node) => node.className)
const summaryIndex = orderClasses.findIndex((name) => name.includes('turn-summary'))
const answerIndex = orderClasses.findIndex((name) => name.includes('msg') && name.includes('assistant'))
const evIndex = orderClasses.findIndex((name) => name.includes('ev-wrap'))
check('T6d 汇总行在正式回答之前', summaryIndex >= 0 && answerIndex > summaryIndex, JSON.stringify(orderClasses))
check('T6d 过程行排在汇总行下面（一级展开时标题不被顶走）', evIndex > summaryIndex && answerIndex > evIndex, JSON.stringify(orderClasses))

// T25 两级折叠（用户 m08390 的要求）：
//   ① 一轮结束，过程行必须整批藏进「已完成，用时 x」（不是只关掉详情，是根本不显示）；
//   ② 点「已完成」只做一级展开——露出缩略行，但每条的完整内容仍是收起的；
//   ③ 再点某一行（如"思考"）才是二级展开，显示全文；再点「已完成」整批藏回。
reset()
app.handleFrame('event', { type: 'turn/start', seq: 30, time: 3000, sessionId: 'sess-A', data: {} })
app.handleFrame('event', {
  type: 'assistant/message', seq: 31, time: 3100, sessionId: 'sess-A',
  data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考全文：先看目录结构再说' }] } },
})
app.handleFrame('event', {
  type: 'tool/call', seq: 32, time: 3200, sessionId: 'sess-A',
  data: { name: 'pwsh', arguments: '{"command":"dir"}', summary: { kind: 'cmd', verb: '运行命令', target: 'dir' } },
})
app.handleFrame('event', asstEv(33, '这是最终回答'))
app.handleFrame('event', { type: 'turn/end', seq: 34, time: 9000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })
const foldBox = document.getElementById('transcript')
const foldWraps = foldBox.children.filter((node) => node.classList && node.classList.contains('ev-wrap'))
const foldSummary = foldBox.children.find((node) => node.className && node.className.includes('turn-summary'))
const stowedAfterEnd = foldWraps.length > 0 && foldWraps.every((node) => node.classList.contains('ev-stowed'))
check('T25 一轮结束过程行整批收进「已完成」', stowedAfterEnd, foldWraps.map((n) => n.className).join(' | '))
check('T25 回答气泡不被一起收掉', foldBox.children.some((node) => node.classList && node.classList.contains('msg') && node.textContent.includes('这是最终回答')))

if (foldSummary && typeof foldSummary.onclick === 'function') foldSummary.onclick()
const shownAgain = foldWraps.every((node) => !node.classList.contains('ev-stowed'))
const stillClosed = foldWraps.every((node) => !node.classList.contains('open'))
check('T25 点「已完成」一级展开只露缩略行（全文仍收起）', shownAgain && stillClosed,
  'shown=' + shownAgain + ' closed=' + stillClosed)

const foldThinkWrap = foldWraps.find((node) => node.classList.contains('ev-think-wrap'))
const foldThinkRow = foldThinkWrap && foldThinkWrap.children[0]
if (foldThinkRow && typeof foldThinkRow.onclick === 'function') foldThinkRow.onclick()
const thinkOpened = Boolean(foldThinkWrap) && foldThinkWrap.classList.contains('open')
check('T25 点某一行（思考）才是二级展开全文', thinkOpened, foldThinkWrap ? foldThinkWrap.className : 'no-think-wrap')

if (foldSummary && typeof foldSummary.onclick === 'function') foldSummary.onclick()
const reStowed = foldWraps.every((node) => node.classList.contains('ev-stowed') && !node.classList.contains('open'))
check('T25 再点「已完成」整批藏回且二级状态归零', reStowed, foldWraps.map((n) => n.className).join(' | '))

// T6b 过程行必须带 .ev-row（灰色 12.5px 单行）：曾经写成 .ev，样式表里没有对应规则，
// 结果"编辑/读取/已完成"退化成白色 15px 正文、也不在同一行。这条断言防止再退化。
reset()
app.handleFrame('event', { type: 'tool/call', seq: 11, time: 11, sessionId: 'sess-A', data: { name: 'read', arguments: '{"file_path":"a/b.js"}', summary: { kind: 'read', verb: '读取', target: 'a\\b.js' } } })
app.handleFrame('event', { type: 'tool/result', seq: 12, time: 12, sessionId: 'sess-A', data: { name: 'read', message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'ok' }] } } })
const rowBox = document.getElementById('transcript')
const wraps = rowBox.children.filter((node) => node.classList && node.classList.contains('ev-wrap'))
const rowsOk = wraps.length === 2 && wraps.every((wrap) => wrap.children[0] && wrap.children[0].classList.contains('ev-row'))
check('T6b 过程行用 .ev-row 渲染（灰色单行样式生效）', rowsOk, wraps.map((w) => w.children[0] && w.children[0].className).join(' | '))

// T6c 思考必须是气泡外面的过程行，不能塞进 DSH 气泡里（用户明确要求"思考不可以有聊天气泡"）。
reset()
app.handleFrame('event', {
  type: 'assistant/message', seq: 13, time: 13, sessionId: 'sess-A',
  data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想一下这个文件怎么读' }, { type: 'text', text: '读完了' }] } },
})
const thinkBox = document.getElementById('transcript')
const thinkWrap = thinkBox.children.find((node) => node.classList && node.classList.contains('ev-think-wrap'))
const thinkRow = thinkWrap && thinkWrap.children[0]
const inBubble = thinkBox.children.some((node) => node.classList && node.classList.contains('msg') && node.textContent.includes('先想一下'))
check('T6c 思考是气泡外的过程行（不在 DSH 气泡内）', Boolean(thinkWrap) && thinkRow.classList.contains('ev-row') && !inBubble,
  'wrap=' + (thinkWrap ? thinkWrap.className : 'none') + ' inBubble=' + inBubble)

// T7 宿主注入的运行时上下文/时间采样（role 是 user，但 source.kind 不是 user）：电脑版不显示，手机端也不显示。
reset()
app.handleFrame('event', { type: 'user/message', seq: 21, time: 21, sessionId: 'sess-A', data: { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. working dir D:\\foo' }] } })
app.handleFrame('event', { type: 'user/message', seq: 22, time: 22, sessionId: 'sess-A', data: { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 3' }] } })
app.handleFrame('event', userEv(23, '真人说的话'))
const sysNodes = document.getElementById('transcript').children
const sysText = sysNodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()).join(' | ')
check('T7 环境快照完全不显示（只留真人消息）', sysNodes.length === 1 && /真人说的话/.test(sysText) && !/运行时上下文|时间采样|runtime context/.test(sysText), sysText)

// T8 电脑版的时间线里没有"工具调用 · pwsh"这种既无动词也无摘要的行：
//    ① 老事件没有 summary 时按工具名兜底成动作动词；② 正文里的 tool-call 块不再重复画一遍。
reset()
app.handleFrame('event', { type: 'tool/call', seq: 31, time: 31, sessionId: 'sess-A', data: { name: 'pwsh', arguments: '{"command":"dir"}' } })
app.handleFrame('event', { type: 'tool/call', seq: 32, time: 32, sessionId: 'sess-A', data: { name: 'edit', arguments: '{"file_path":"a.js"}' } })
app.handleFrame('event', { type: 'assistant/message', seq: 33, time: 33, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text: '正文' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } } })
const t8Text = document.getElementById('transcript').children.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | ')
const dupCount = (t8Text.match(/运行命令/g) || []).length
check('T8 无 summary 时按工具名兜底动词，不再出现「工具调用」', !/工具调用/.test(t8Text) && /运行命令/.test(t8Text) && /编辑/.test(t8Text), t8Text)
check('T8 正文里的 tool-call 块不重复渲染', dupCount === 1, '运行命令出现 ' + dupCount + ' 次')

// T9 电脑端插话：宿主先推 steer 帧（不等步骤边界），客户端立即画出"你"的气泡；
//    真正的 user/message 带着同一个 message.id 到达时替换它，不能出现两条。
reset()
app.handleFrame('steer', { sessionId: 'sess-A', id: 'msg-1', text: '插话：先别数了', at: Date.now() })
const t9AfterFrame = timelineText()
check('T9 收到 steer 帧立即出现用户气泡', t9AfterFrame.length === 1 && /插话：先别数了/.test(t9AfterFrame[0]), JSON.stringify(t9AfterFrame))
app.handleFrame('event', { type: 'user/message', seq: 41, time: 41, sessionId: 'sess-A', data: { role: 'user', id: 'msg-1', content: [{ type: 'text', text: '插话：先别数了' }] } })
const t9AfterReal = timelineText()
check('T9 真实 user/message 到达后只剩一条', t9AfterReal.length === 1 && /插话：先别数了/.test(t9AfterReal[0]), JSON.stringify(t9AfterReal))
check('T9 合成气泡表已清空', app.state.steerNodes.size === 0, 'size=' + app.state.steerNodes.size)

// T10 手机上自己插话：本地已有乐观气泡，随后的 steer 帧不能让它变成两条。
reset()
const optimistic = { type: 'user/message', seq: -1, sessionId: 'sess-A', optimistic: true, data: { message: { role: 'user', content: [{ type: 'text', text: '我自己插的话' }] } } }
app.pendingPush('sess-A', -1, '我自己插的话', optimistic)
app.appendEvent(optimistic)
app.handleFrame('steer', { sessionId: 'sess-A', id: 'msg-2', text: '我自己插的话', at: Date.now() })
const t10Text = timelineText()
check('T10 自己插话不出现两条', t10Text.filter((text) => /我自己插的话/.test(text)).length === 1, JSON.stringify(t10Text))

// T11 上滑翻早期记录：页面上只有 seq 91..93 时，loadOlder 必须去请求 before=91 的那一页，
//     把更早的事件插进来，且不能在"还有更多"时提前放弃。
reset()
for (const seq of [91, 92, 93]) app.handleFrame('event', userEv(seq, `第 ${seq} 条`))
pageHandler = (target) => {
  if (!target.includes('before=')) return { ok: true, events: [], latestSeq: 93, hasMore: true }
  const before = Number((target.match(/before=(\d+)/) || [])[1] || 0)
  const older = [before - 3, before - 2, before - 1]
    .filter((seq) => seq > 0)
    .map((seq) => userEv(seq, `第 ${seq} 条`))
  return { ok: true, events: older, latestSeq: 93, hasMore: before - 3 > 1 }
}
await app.loadOlder('sess-A')
const t11Text = timelineText()
check('T11 上滑能加载更早的记录', t11Text.some((text) => /第 90 条/.test(text)) && t11Text.length === 6, JSON.stringify(t11Text))
check('T11 翻页请求带 before 游标', fetchCalls.some((call) => call.includes('/page') && call.includes('before=91')), fetchCalls.filter((call) => call.includes('/page')).join(' | '))

// T12 门闩：刚翻完一页、还没滚离顶部时，再触发不能继续翻（一次滑动只翻一页）。
app.state.olderArmed.set('sess-A', false)
const latchBefore = fetchCalls.filter((call) => call.includes('before=')).length
await app.loadOlder('sess-A')
const latchAfter = fetchCalls.filter((call) => call.includes('before=')).length
check('T12 滚离顶部之前不再继续翻页', latchAfter === latchBefore, `requests ${latchBefore} -> ${latchAfter}`)

// T13 滚离顶部后继续滑到顶，能翻到会话开头并置 hasMore=false。
app.state.olderArmed.set('sess-A', true)
pageHandler = (target) => {
  const before = Number((target.match(/before=(\d+)/) || [])[1] || 0)
  // 第 88 条已是最早的一条：再往前就没有了。
  if (before <= 88) return { ok: true, events: [], latestSeq: 93, hasMore: false }
  return { ok: true, events: [userEv(88, '第 88 条')], latestSeq: 93, hasMore: false }
}
const beforeCount = fetchCalls.filter((call) => call.includes('before=')).length
await app.loadOlder('sess-A')
const afterCount = fetchCalls.filter((call) => call.includes('before=')).length
check('T13 翻到头后记录 hasMore=false', app.state.older.get('sess-A') === false, `older=${app.state.older.get('sess-A')} requests=${afterCount - beforeCount}`)

// T14 轮边界自愈：服务端 page() 按"轮"切分，某些游标位置会返回空页但 hasMore=true。
//     客户端必须用更大的页重试，而不是就此判定"到底了"。
//     （页大小已从 1 提到 20：宿主每页都要回放整个会话，小页慢到不可用。）
reset()
for (const seq of [91, 92, 93]) app.handleFrame('event', userEv(seq, `第 ${seq} 条`))
app.state.olderArmed.set('sess-A', true)
pageHandler = (target) => {
  const limit = Number((target.match(/limit=(\d+)/) || [])[1] || 0)
  const before = Number((target.match(/before=(\d+)/) || [])[1] || 0)
  // 小页正好落在轮边界：怎么问都是空页，但 hasMore 仍是 true。
  if (limit <= 20) return { ok: true, events: [], latestSeq: 93, hasMore: true }
  return { ok: true, events: [userEv(88, '第 88 条'), userEv(89, '第 89 条')], latestSeq: 93, hasMore: true }
}
const retryBefore = fetchCalls.filter((call) => call.includes('before=')).length
await app.loadOlder('sess-A')
const retryAfter = fetchCalls.filter((call) => call.includes('before=')).length
const retryText = timelineText()
check('T14 空页用更大页重试并取回更早记录', retryText.some((text) => /第 88 条/.test(text)), JSON.stringify(retryText))
check('T14 重试确实发生了（2 次请求）', retryAfter - retryBefore === 2, `requests ${retryBefore} -> ${retryAfter}`)
check('T14 空页不清空 hasMore', app.state.older.get('sess-A') === true, `older=${app.state.older.get('sess-A')}`)

// T15 长消息不整段下发：服务端在 block 上标 truncated 时，气泡里只出现前 N 字，
//     并给出"展开全文"按钮；点击才去 /event/:seq?full=1 拉完整内容。
reset()
const longHead = '前段文字'.repeat(20)
const truncatedEv = {
  type: 'user/message',
  seq: 77,
  time: 77,
  sessionId: 'sess-A',
  data: { role: 'user', content: [{ type: 'text', text: longHead, truncated: { shown: longHead.length, total: 5000 } }] },
}
app.handleFrame('event', truncatedEv)
// 用 querySelectorAll 而不是 querySelector：按钮是 renderContent 里 appendChild 上去的，
// 真实浏览器的 querySelector 会命中祖先自身匹配，替身只从 children 往下找。
// 两者对"后代"语义一致，但 querySelector('.x') 在这个替身里会漏掉某些层级（T15 就这样挂了）。
const moreBtn = document.getElementById('transcript').querySelectorAll('.msg-more')[0] || null
check('T15 截断消息显示"展开全文"按钮', Boolean(moreBtn) && /共 5000 字/.test(moreBtn.textContent), moreBtn ? moreBtn.textContent : 'no button')
check('T15 截断消息不显示被截掉的内容', !timelineText().join(' ').includes('已截断'), JSON.stringify(timelineText()).slice(0, 120))
eventHandler = () => ({ ok: true, full: true, event: { type: 'user/message', seq: 77, data: { role: 'user', content: [{ type: 'text', text: '完整内容整段' }] } } })
if (moreBtn) await moreBtn.onclick()
const afterFull = timelineText().join(' ')
check('T15 点击后拉到并显示完整内容', afterFull.includes('完整内容整段'), afterFull.slice(0, 120))
check('T15 展开后请求带 full=1', fetchCalls.some((call) => call.includes('/event/77') && call.includes('full=1')), fetchCalls.filter((call) => call.includes('/event/')).join(' | '))
check('T15 展开后按钮消失', !document.getElementById('transcript').querySelector('.msg-more'))

// T16：run_code 里的嵌套子调用（读取/搜索/查看子智能体）要和电脑端一样逐条显示成缩进行。
//      -start 与结算共用 subCallId：先出开始行，结算到达后原地替换成结果行，不能出现两行。
app.state.current = 'sess-A'
app.state.seen = new Set()
app.state.events = new Map()
document.getElementById('transcript').innerHTML = ''
app.handleFrame('event', {
  sessionId: 'sess-A',
  type: 'tool/ptc-dispatch-start',
  seq: 300,
  time: Date.now(),
  data: { subCallId: 'sub-1', name: 'read', summary: { kind: 'read', verb: '读取', target: 'D:/tmp/a.js', extra: '' } },
})
const subRows = () => document.getElementById('transcript').querySelectorAll('.ev-sub')
check('T16 子调用开始行出现', subRows().length === 1, String(subRows().length))
check('T16 开始行是缩进的子调用行', timelineText().join(' ').includes('读取'), timelineText().join(' ').slice(0, 80))

app.handleFrame('event', {
  sessionId: 'sess-A',
  type: 'tool/ptc-dispatch',
  seq: 301,
  time: Date.now(),
  data: {
    subCallId: 'sub-1',
    name: 'read',
    summary: { kind: 'read', verb: '读取', target: 'D:/tmp/a.js', extra: '' },
    isError: false,
    message: { content: [{ type: 'text', text: 'file body' }] },
  },
})
check('T16 结算后仍只有一行（原地替换）', subRows().length === 1, String(subRows().length))
// 替身的 querySelector 只认单个类名（不支持 ".a .b" 后代选择器），所以从子调用行里找详情。
check('T16 结算内容进了详情', (subRows()[0]?.querySelector('.ev-detail')?.textContent || '').includes('file body'))

// 一次 run_code 里跑多个子命令：手机端必须是多行，而不是合并成一条"运行命令"。
app.state.seen = new Set()
app.state.events = new Map()
document.getElementById('transcript').innerHTML = ''
for (const [i, name] of [['read', '读取'], ['grep', '搜索'], ['list', '浏览目录']].entries()) {
  app.handleFrame('event', {
    sessionId: 'sess-A',
    type: 'tool/ptc-dispatch-start',
    seq: 310 + i,
    time: Date.now(),
    data: { subCallId: `sub-${i}`, name: name[0], summary: { kind: name[0], verb: name[1], target: `t${i}`, extra: '' } },
  })
}
check('T16 多个子命令显示成多行', subRows().length === 3, String(subRows().length))
const subText = timelineText().join(' ')
check('T16 多个子命令各自的动作词都在', subText.includes('读取') && subText.includes('搜索') && subText.includes('浏览目录'), subText.slice(0, 120))

// T17：一次工具调用在电脑版只有一行。调用行 + 结算事件必须合并成同一行，
//      而不是"运行命令"一行 + "已完成"一行（那看起来像一直在打转）。
app.state.seen = new Set()
app.state.events = new Map()
document.getElementById('transcript').innerHTML = ''
app.handleFrame('event', {
  sessionId: 'sess-A',
  type: 'tool/call',
  seq: 400,
  time: Date.now(),
  data: { callId: 'call-1', name: 'pwsh', arguments: '{"command":"ls"}', summary: { kind: 'pwsh', verb: '运行命令', target: 'List files', extra: '' } },
})
check('T17 调用行出现', document.getElementById('transcript').querySelectorAll('.ev-tool').length === 1)
app.handleFrame('event', {
  sessionId: 'sess-A',
  type: 'tool/result',
  seq: 401,
  time: Date.now(),
  data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.js b.js' }], isError: false } },
})
const toolRows = () => document.getElementById('transcript').querySelectorAll('.ev-tool')
check('T17 结算后仍只有一行（不追加"已完成"）', toolRows().length === 1, String(toolRows().length))
check('T17 结算后没有独立的已完成行', document.getElementById('transcript').querySelectorAll('.ev-result').length === 0)
const toolText = timelineText().join(' ')
check('T17 结果字数补到同一行', toolText.includes('运行命令') && toolText.includes('9 字'), toolText.slice(0, 120))
check('T17 结果详情可就地展开', (toolRows()[0]?.querySelector('.ev-detail')?.textContent || '').includes('a.js b.js'))

// T18 电脑端归档会话后，服务端推 `sessions` 帧，客户端应重新拉 /api/state
//     并在列表里把已归档的会话去掉（用户 m06926：「dsh上归档的对话手机上没有同步删除」）。
console.log('T18 归档变化推 sessions 帧后列表刷新')
{
  app.state.sessions = new Map()
  app.state.sessions.set('sess-alive', { id: 'sess-alive', title: '还在的会话', updatedAt: 2, blank: false })
  app.state.sessions.set('sess-archived', { id: 'sess-archived', title: '已归档的会话', updatedAt: 1, blank: false })
  app.renderSessions()
  check(
    'T18 归档前两个会话都在列表里',
    document.getElementById('session-list').querySelectorAll('.session-item').length === 2,
    String(document.getElementById('session-list').querySelectorAll('.session-item').length),
  )
  // 服务端过滤归档后的真实响应形状
  stateHandler = () => ({ ok: true, sessions: [{ id: 'sess-alive', title: '还在的会话', updatedAt: 2, blank: false }], hiddenBlank: 0, hiddenArchived: 1 })
  app.handleFrame('sessions', { at: Date.now() })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const rows = document.getElementById('session-list').querySelectorAll('.session-item')
  check('T18 收到 sessions 帧后已归档会话消失', rows.length === 1, String(rows.length))
  check(
    'T18 剩下的是没归档的那个',
    timelineText().length >= 0 && rows[0]?.textContent.includes('还在的会话'),
    rows[0]?.textContent || '',
  )
}

// T19 会话按项目（工作区）分组显示，组头可折叠（用户 m07568 第 2 条）。
console.log('T19 会话按项目分组')
{
  reset()
  app.state.sessions = new Map()
  app.state.sessions.set('s1', { id: 's1', title: '甲会话', updatedAt: 30, blank: false, cwd: 'D:\\work\\alpha' })
  app.state.sessions.set('s2', { id: 's2', title: '乙会话', updatedAt: 20, blank: false, cwd: 'D:\\work\\beta' })
  app.state.sessions.set('s3', { id: 's3', title: '丙会话', updatedAt: 10, blank: false, cwd: 'D:\\work\\alpha' })
  app.state.groups = [
    { id: 'w1', title: 'alpha 项目', path: 'D:\\work\\alpha', sessionIds: ['s1', 's3'] },
    { id: 'w2', title: 'beta 项目', path: 'D:\\work\\beta', sessionIds: ['s2'] },
  ]
  app.state.collapsedGroups = new Set()
  app.renderSessions()
  const list = document.getElementById('session-list')
  const groups = list.querySelectorAll('.session-group')
  check('T19 会话被分成两个项目组', groups.length === 2, `groups=${groups.length}`)
  const titles = groups.map((group) => group.querySelector('.group-head').textContent.replace(/\s+/g, ' ').trim())
  check('T19 组头显示项目名与数量', /alpha 项目/.test(titles[0]) && /2/.test(titles[0]), titles[0] || '')
  check('T19 组内会话数量正确', groups[0].querySelectorAll('.session-item').length === 2, String(groups[0].querySelectorAll('.session-item').length))
  // 点组头折叠
  groups[0].querySelector('.group-head').onclick()
  const collapsed = document.getElementById('session-list').querySelectorAll('.session-group')[0]
  check('T19 点击组头后折叠', collapsed.classList.contains('collapsed'), collapsed.className)
  // 没在 groups 里的会话按 cwd 兜底成组，不能丢
  app.state.collapsedGroups = new Set()
  app.state.groups = []
  app.renderSessions()
  const fallback = document.getElementById('session-list').querySelectorAll('.session-group')
  check('T19 无分组信息时按 cwd 兜底成组', fallback.length === 2, `groups=${fallback.length}`)
}

// T23 同一个项目不能出现两块同名分组（用户 m07850：「有两个 guide dog peta」）。
//     成因：某会话的 cwd 与已有 workspace 的 path 相同、但它不在该 workspace 的 sessionIds 里
//     （API 新建的会话、解绑过的会话），旧逻辑会按 cwd 再建一个同名组。
console.log('T23 同名项目不重复分组')
{
  reset()
  app.state.sessions = new Map()
  app.state.sessions.set('a1', { id: 'a1', title: '组内会话', updatedAt: 30, blank: false, cwd: 'D:\\work\\alpha' })
  app.state.sessions.set('a2', { id: 'a2', title: '游离会话', updatedAt: 40, blank: false, cwd: 'D:\\work\\alpha' })
  app.state.sessions.set('a3', { id: 'a3', title: '别的项目', updatedAt: 10, blank: false, cwd: 'D:\\work\\beta' })
  app.state.groups = [
    { id: 'w1', title: 'alpha 项目', path: 'D:\\work\\alpha', sessionIds: ['a1'] },
  ]
  app.state.collapsedGroups = new Set()
  app.renderSessions()
  const groups = document.getElementById('session-list').querySelectorAll('.session-group')
  const titles = groups.map((group) => group.querySelector('.group-head').textContent.replace(/\s+/g, ' ').trim())
  const alphaCount = titles.filter((title) => title.includes('alpha 项目')).length
  check('T23 同一个项目只有一块分组', alphaCount === 1, titles.join(' | '))
  check('T23 游离会话并进同路径的项目', groups[0].querySelectorAll('.session-item').length === 2, String(groups[0].querySelectorAll('.session-item').length))
}

// T20 手机端选图 → base64 随 prompt 一起发（用户 m07568 第 3 条）。
console.log('T20 图片随消息发送')
{
  reset()
  app.state.attachments = []
  app.state.current = 'sess-A'
  // 真机上 file 是 File(Blob)：这里用真 Blob 才过得了 URL.createObjectURL。
  const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
  file.__base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  file.name = 'pixel.png'
  await app.addFiles([file])
  check('T20 选图后进入待发送列表', app.state.attachments.length === 1, String(app.state.attachments.length))
  check('T20 图片读成 base64', String(app.state.attachments[0]?.data || '').startsWith('iVBOR'), String(app.state.attachments[0]?.data || '').slice(0, 12))
  check('T20 媒体类型正确', app.state.attachments[0]?.mediaType === 'image/png', String(app.state.attachments[0]?.mediaType))
  const bar = document.getElementById('attach-bar')
  check('T20 附件栏出现缩略图', bar.querySelectorAll('.attach-thumb').length === 1, String(bar.querySelectorAll('.attach-thumb').length))
  app.state.turnOpen = new Map()
  app.state.running = new Map()
  document.getElementById('composer').value = '看图'
  const bodyBefore = fetchBodies.length
  await app.send('auto')
  const promptCall = fetchBodies.slice(bodyBefore).find((item) => item.url.includes('/api/prompt'))
  check('T20 prompt 请求带 images', Array.isArray(promptCall?.body?.images) && promptCall.body.images.length === 1, JSON.stringify(promptCall?.body || {}).slice(0, 120))
  check('T20 图片数据随请求发出', String(promptCall?.body?.images?.[0]?.data || '').startsWith('iVBOR'), String(promptCall?.body?.images?.[0]?.data || '').slice(0, 12))
  check('T20 发送后清空待发送图片', app.state.attachments.length === 0, String(app.state.attachments.length))
}

// T21 输出完成后把思考全部收起（用户 m07568 第 1 条）。
//     - 正文落地时，思考行必须是收起状态；
//     - 用户手动展开过，也要在这一轮结束时被收起；
//     - 流式期间的思考块（details）同样不能留成展开。
console.log('T21 输出完成后收起所有思考')
{
  reset()
  app.handleFrame('event', {
    type: 'assistant/message', seq: 70, time: 7000, sessionId: 'sess-A',
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想很久很久然后给答案' }, { type: 'text', text: '答案在这里' }] } },
  })
  const box = document.getElementById('transcript')
  const thinkWrap = box.querySelector('.ev-think-wrap')
  check('T21 思考行画在气泡外', Boolean(thinkWrap) && !thinkWrap.closest('.msg'), thinkWrap ? thinkWrap.className : 'none')
  check('T21 正文落地后思考默认收起', thinkWrap && !thinkWrap.classList.contains('open'), thinkWrap ? thinkWrap.className : 'none')
  // 用户手动展开（thinkWrap 为 null 说明前面的断言已失败，这里不能崩，否则整份用例跑不完）
  if (thinkWrap) thinkWrap.classList.add('open')
  app.handleFrame('event', { type: 'turn/end', seq: 71, time: 8000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })
  check('T21 一轮结束后已展开的思考被收起', Boolean(thinkWrap) && !thinkWrap.classList.contains('open'), thinkWrap ? thinkWrap.className : 'none')
  // 流式思考块（details）也不能保持展开
  app.state.current = 'sess-A'
  app.applyDelta({ sessionId: 'sess-A', text: '正在写', reasoning: '流式思考内容', streaming: true })
  const details = document.querySelector('.delta-think')
  check('T21 流式思考用可折叠块显示', Boolean(details) && !details.classList.contains('hidden'), details ? details.className : 'none')
  if (details) details.open = true
  app.clearDelta()
  // 假 DOM 的 remove() 不会把节点从 registry 里摘掉，所以断言"流式节点已释放"要看状态位，
  // 不能靠 querySelector 找残留节点（那是测试替身的限制，不是实现问题）。
  check('T21 流式结束思考块随之释放', app.state.deltaNode === null, String(app.state.deltaNode))
}

// T22 排队条的合并规则（用户 m07884：「手机发送排队信息会直接消失吞掉」）。
//     服务端是唯一真源，但刚落地的占位不能立刻被清掉，否则用户点完发送就看不到任何东西：
//       - 服务端已认下（items 里有同文本）→ 丢掉本地占位，只留服务端那条；
//       - 服务端还没认下（items 空）且占位很新 → 保留占位（"发送中…"）；
//       - 占位太老（> 6 秒）→ 丢掉，避免永远挂在手机上。
console.log('T22 排队条占位与服务端快照合并')
{
  reset()
  app.state.current = 'sess-A'
  const fresh = { itemId: 'pending-1', text: '刚发出的排队消息', at: Date.now(), pending: true }
  app.state.queues.set('sess-A', [fresh])
  app.handleFrame('queue', { sessionId: 'sess-A', items: [] })
  const keptFresh = (app.state.queues.get('sess-A') || []).length
  check('T22 刚落地的占位不会被空快照清掉', keptFresh === 1, String(keptFresh))

  const stale = { itemId: 'pending-2', text: '很久以前的排队消息', at: Date.now() - 60000, pending: true }
  app.state.queues.set('sess-A', [stale])
  app.handleFrame('queue', { sessionId: 'sess-A', items: [] })
  const keptStale = (app.state.queues.get('sess-A') || []).length
  check('T22 超时的占位会被清掉', keptStale === 0, String(keptStale))

  app.state.queues.set('sess-A', [{ ...fresh, at: Date.now() }])
  app.handleFrame('queue', {
    sessionId: 'sess-A',
    items: [{ itemId: 'real-1', text: '刚发出的排队消息', at: Date.now() }],
  })
  const merged = app.state.queues.get('sess-A') || []
  check('T22 服务端认下后只留一条', merged.length === 1 && merged[0].itemId === 'real-1', JSON.stringify(merged))

  // 队列里有多条时按顺序显示，pager 的下标不能越界（用户 m06862 要求上下滑动切换）。
  app.state.queues.set('sess-A', [
    { itemId: 'q1', text: '第一条', at: Date.now() },
    { itemId: 'q2', text: '第二条', at: Date.now() },
  ])
  app.state.queueIndex = new Map([['sess-A', 5]])
  app.state.current = 'sess-A'
  app.handleFrame('queue', {
    sessionId: 'sess-A',
    items: [
      { itemId: 'q1', text: '第一条', at: Date.now() },
      { itemId: 'q2', text: '第二条', at: Date.now() },
    ],
  })
  const index = app.state.queueIndex.get('sess-A')
  check('T22 队列变短后下标被夹到范围内', index >= 0 && index <= 1, String(index))
}

console.log('\nT24 本地改动不被旧快照覆盖（用户 m08363：编辑/删除/插话看起来没生效）')
{
  reset()
  app.state.current = 'sess-A'
  app.state.queues.set('sess-A', [{ itemId: 'x1', text: '排队甲', at: Date.now() }])
  // 用户点了编辑：本地立刻变成新文本，同时打上 touch 标记。
  app.setQueueText('x1', '排队甲已编辑')
  app.touchQueue('sess-A', 'x1', { text: '排队甲已编辑' })
  const immediately = (app.state.queues.get('sess-A') || [])[0].text
  check('T24 编辑立刻反映到本地队列', immediately === '排队甲已编辑', immediately)

  // 服务端旧快照（改之前的文本）此刻才到：不能把本地新文本覆盖回去。
  app.handleFrame('queue', { sessionId: 'sess-A', items: [{ itemId: 'x1', text: '排队甲', at: Date.now() }] })
  const afterStale = (app.state.queues.get('sess-A') || [])[0].text
  check('T24 旧快照不覆盖刚编辑的文本', afterStale === '排队甲已编辑', afterStale)

  // touch 过期之后，服务端就是权威：新快照要能正常生效。
  app.state.queueTouched.get('sess-A').get('x1').at = Date.now() - 5000
  app.handleFrame('queue', { sessionId: 'sess-A', items: [{ itemId: 'x1', text: '服务端后来的文本', at: Date.now() }] })
  const afterExpire = (app.state.queues.get('sess-A') || [])[0].text
  check('T24 touch 过期后接受服务端新值', afterExpire === '服务端后来的文本', afterExpire)

  // 用户点了删除：旧快照里还有这条，也不能把它加回来。
  reset()
  app.state.current = 'sess-A'
  app.state.queues.set('sess-A', [{ itemId: 'y1', text: '要删掉的', at: Date.now() }])
  app.dropQueueRow('y1')
  app.touchQueue('sess-A', 'y1', { removed: true })
  check('T24 删除立刻从本地队列消失', (app.state.queues.get('sess-A') || []).length === 0, String((app.state.queues.get('sess-A') || []).length))
  app.handleFrame('queue', { sessionId: 'sess-A', items: [{ itemId: 'y1', text: '要删掉的', at: Date.now() }] })
  const afterRemove = (app.state.queues.get('sess-A') || []).length
  check('T24 旧快照不会让已删除的条目复活', afterRemove === 0, String(afterRemove))
}

// T26 本地文件引用只显示"文件名+后缀"（用户 m00129：手机端不要铺开一长串绝对路径）。
console.log('\nT26 文件引用渲染成文件名芯片')
{
  // 只看"用户眼睛能看到的字"：data-path 里保留完整路径是有意的（点击复制用）。
  const visible = (html) => String(html).replace(/<[^>]*>/g, '')
  const WINDOWS_PATH = new RegExp('D:' + '\\\\' + 'SDU')

  const html = app.mdInline('[app.js:952](<D:\\SDU\\IC\\HarnessProject\\guide-dog-peta\\dsh-mobile-remote\\web\\app.js#L952>)')
  check('T26 渲染成 file-chip', html.includes('class="file-chip"'), html)
  check('T26 只显示文件名+行号', visible(html).trim() === '▤app.js:952' || visible(html).trim() === 'app.js:952', visible(html))
  check('T26 可见文字里没有绝对路径', !WINDOWS_PATH.test(visible(html)) && !visible(html).includes('HarnessProject'), visible(html))
  check('T26 完整路径藏在 data-path', html.includes('data-path="D:\\SDU\\IC\\HarnessProject') && html.includes(':952"'), html)

  const styled = app.mdInline('[style.css:545](<D:\\SDU\\IC\\HarnessProject\\guide-dog-peta\\dsh-mobile-remote\\web\\style.css#L545>)')
  check('T26 第二个文件同样只留文件名', visible(styled).includes('style.css:545') && !visible(styled).includes('guide-dog-peta'), visible(styled))

  // 用户 m00358：行内代码里的纯路径必须原样保留——有时候就是要输出完整路径，
  // 不能一律改成芯片，否则用户想复制/查看真实路径反而看不到了。
  const bare = app.mdInline('看 `D:\\SDU\\IC\\HarnessProject\\guide-dog-peta\\dsh-mobile-remote\\lib\\index.js:41` 这行')
  check('T26 行内代码里的纯路径保持原样', bare.includes('<code>D:\\SDU\\IC\\HarnessProject') && bare.includes('index.js:41</code>') && !bare.includes('file-chip'), bare)

  // 双反引号代码段（`` `x` ``）里的单反引号是字面量：不能把外层 `` 当空 code 段，
  // 否则反引号会当正文漏到屏幕上（手机上真的这样显示过）。
  const double = app.mdInline('（`` `D:\\tmp\\a.js:1` ``）')
  check('T26 双反引号代码段不漏反引号', double.includes('<code>') && !double.includes('``'), double)
  check('T26 双反引号里的内容保持原样', double.includes('D:\\tmp\\a.js:1') && !double.includes('file-chip'), double)

  const code = app.mdInline('用 `npm run build` 构建')
  check('T26 普通行内代码不受影响', code.includes('<code>npm run build</code>'), code)

  const link = app.mdInline('见 [文档](https://example.com/doc) 说明')
  check('T26 外链仍是 a 标签', link.includes('href="https://example.com/doc"') && link.includes('文档'), link)

  const md = app.renderMarkdown('**改这里**\n\n[app.js:952](<D:\\SDU\\IC\\HarnessProject\\guide-dog-peta\\dsh-mobile-remote\\web\\app.js#L952>)\n')
  check('T26 整段 Markdown 里同样生效', md.includes('class="file-chip"') && !WINDOWS_PATH.test(visible(md)), visible(md))
  check('T26 加粗等其他语法没被破坏', md.includes('<strong>改这里</strong>'), md.slice(0, 200))
}

// T27 一级展开必须发生在标题"下方"（用户 m00261）：
//   之前过程行排在「已完成 / 已思考」上面，点开一级时内容把标题顶下去一大截，
//   标题跑到屏幕外，想收起还得往下翻回去找。现在标题固定在本轮第一位，内容往下长。
console.log('\nT27 一级展开在标题下方，标题原地不动')
{
  reset()
  app.handleFrame('event', { type: 'turn/start', seq: 40, time: 4000, sessionId: 'sess-A', data: {} })
  app.handleFrame('event', {
    type: 'assistant/message', seq: 41, time: 4100, sessionId: 'sess-A',
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看看目录再说' }] } },
  })
  app.handleFrame('event', {
    type: 'tool/call', seq: 42, time: 4200, sessionId: 'sess-A',
    data: { name: 'pwsh', arguments: '{"command":"dir"}', summary: { kind: 'cmd', verb: '运行命令', target: 'dir' } },
  })
  app.handleFrame('event', asstEv(43, '最终回答'))
  app.handleFrame('event', { type: 'turn/end', seq: 44, time: 8000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })

  const box = document.getElementById('transcript')
  // 顺序断言只看"节点身份序列"：一级展开会给标题加 .open（显示状态），不算顺序变化。
  const order = () => box.children.map((node) => node.uid).join(',')
  const summary = box.children.find((node) => node.className && node.className.includes('turn-summary'))
  const answerNode = box.children.find((node) => node.classList && node.classList.contains('msg') && node.textContent.includes('最终回答'))
  const summaryIndex = box.children.indexOf(summary)
  const firstEv = box.children.findIndex((node) => node.classList && node.classList.contains('ev-wrap'))
  check('T27 标题排在本轮最前（前面只有 turn-mark）', summaryIndex >= 0 && box.children.slice(0, summaryIndex).every((node) => node.classList.contains('turn-mark')),
    JSON.stringify(box.children.map((node) => node.className)))

  const foldedOrder = order()
  if (summary && typeof summary.onclick === 'function') summary.onclick()
  const openedOrder = order()
  check('T27 展开不改变节点顺序（只切显示状态）', openedOrder === foldedOrder, openedOrder)
  check('T27 展开后标题仍在最前', box.children.indexOf(summary) === summaryIndex, JSON.stringify(box.children.map((node) => node.className)))
  check('T27 过程行紧跟标题向下排列', firstEv === summaryIndex + 1, String(firstEv) + ' vs ' + String(summaryIndex))
  check('T27 回答气泡仍在过程行之后', box.children.indexOf(answerNode) > firstEv, JSON.stringify(box.children.map((node) => node.className)))

  if (summary && typeof summary.onclick === 'function') summary.onclick()
  check('T27 收起后顺序依旧不变', order() === foldedOrder, order())
}

// T28/T29/T30 手机端「排队 / 插话」支持图片（用户 m00532）：
//   以前纯图片消息（用户直接贴图不写字）在手机上是隐形的：服务端把没有正文的消息
//   整条丢掉、客户端只拿 text、排队行只能显示文字。三条用例分别盯住三个断点。
console.log('\nT28 纯图片插话在手机上要有气泡')
{
  reset()
  app.handleFrame('steer', { sessionId: 'sess-A', id: 'img-msg-1', text: '', imageCount: 2, at: Date.now() })
  const nodes = document.getElementById('transcript').children
  const bubble = nodes.find((node) => node.classList && node.classList.contains('msg'))
  check('T28 纯图片插话也画出气泡', Boolean(bubble), JSON.stringify(nodes.map((node) => node.className)))
  check('T28 气泡里标出图片张数', Boolean(bubble) && bubble.textContent.includes('插话图片 2 张'), bubble && bubble.textContent)
  reset()
  app.handleFrame('steer', { sessionId: 'sess-A', id: 'msg-img-2', text: '看图', imageCount: 1, at: Date.now() })
  const withText = document.getElementById('transcript').children.find((node) => node.classList && node.classList.contains('msg'))
  check('T28 带文字带图：文字和图块都在', Boolean(withText) && withText.textContent.includes('看图') && withText.textContent.includes('插话图片 1 张'), withText && withText.textContent)
}

console.log('\nT29 排队行要标出 🖼 张数（带图的也能编辑，但按钮要标明代价）')
{
  const row = app.rowForItem({ itemId: 'q1', text: '', imageCount: 2, at: Date.now() })
  check('T29 纯图片排队行有文字兜底', row.textContent.includes('图片 2 张'), row.textContent)
  check('T29 排队行标出 🖼 2', row.textContent.includes('🖼 2'), row.textContent)
  const buttons = row.children.filter((node) => typeof node.onclick === 'function')
  check('T29 带图的排队行也有编辑按钮', row.textContent.includes('✎'), row.textContent)
  const editBtn = buttons.find((node) => node.textContent === '✎')
  check('T29 编辑按钮标明会丢图', Boolean(editBtn) && String(editBtn.title).includes('丢失图片'), editBtn && editBtn.title)
  check('T29 删除/插话按钮还在', row.textContent.includes('🗑') && row.textContent.includes('↑'), row.textContent + ' | buttons=' + buttons.length)
  const plain = app.rowForItem({ itemId: 'q2', text: '普通排队', imageCount: 0, at: Date.now() })
  check('T29 没图的排队行照旧可以编辑', plain.textContent.includes('✎'), plain.textContent)
  const plainBtn = plain.children.find((node) => node.textContent === '✎')
  check('T29 没图时标题不提丢图', Boolean(plainBtn) && !String(plainBtn.title).includes('丢失图片'), plainBtn && plainBtn.title)
}

console.log('\nT30 运行中发图片：排队占位行要带 imageCount')
{
  reset()
  app.state.current = 'sess-A'
  app.state.turnOpen.set('sess-A', true)
  app.state.attachments = [{ data: 'AAAA', mediaType: 'image/png', name: 'a.png', url: '' }]
  await app.send('auto')
  const sent = fetchBodies.filter((row) => row.url.includes('/api/prompt')).pop()
  const body = (sent && sent.body) || {}
  check('T30 运行中发图片走的是 queue 模式（不是插话）', body.mode === 'queue', JSON.stringify(body))
  check('T30 图片跟着排队消息一起发出去', Array.isArray(body.images) && body.images.length === 1, JSON.stringify(body.images))
  check('T30 纯图片消息允许没有正文', body.text === '', JSON.stringify(body.text))
  check('T30 发送成功后待发送图片被清空', app.state.attachments.length === 0, String(app.state.attachments.length))
  app.state.turnOpen.delete('sess-A')
  app.state.attachments = []
  app.state.queues = new Map()
}

console.log('\nT31 弹键盘：垫出被输入法盖住的高度，只对原本贴底的用户回底')
{
  reset()
  const box = document.getElementById('transcript')
  const area = document.getElementById('composer')
  const fire = (node, name) => (node.listeners.get(name) || []).forEach((fn) => fn({ type: name }))
  windowStub.innerHeight = 800
  windowStub.visualViewport.height = 800
  windowStub.visualViewport.offsetTop = 0

  check('T31 键盘没弹出时不垫底', app.keyboardInset() === 0, String(app.keyboardInset()))
  app.applyKeyboardInset()
  check('T31 没键盘时 --kb-h 为 0px', document.documentElement.style.getPropertyValue('--kb-h') === '0px', document.documentElement.style.getPropertyValue('--kb-h'))

  windowStub.visualViewport.height = 500
  check('T31 键盘压掉 300px 时算出 300', app.keyboardInset() === 300, String(app.keyboardInset()))

  box.scrollHeight = 3000
  box.clientHeight = 500
  box.scrollTop = 2400
  app.state.keyboardPinned = true
  app.applyKeyboardInset()
  check('T31 --kb-h 垫上键盘高度', document.documentElement.style.getPropertyValue('--kb-h') === '300px', document.documentElement.style.getPropertyValue('--kb-h'))
  check('T31 贴底时重新滚到最下面', box.scrollTop === 3000, String(box.scrollTop))

  box.scrollTop = 200
  app.state.keyboardPinned = false
  app.state.pinBottom = false
  app.applyKeyboardInset()
  check('T31 没贴底时一动不动（不抢滚动）', box.scrollTop === 200, String(box.scrollTop))

  windowStub.visualViewport.height = 760
  check('T31 小于 80px 的差值当地址栏噪音忽略', app.keyboardInset() === 0, String(app.keyboardInset()))

  windowStub.visualViewport.height = 500
  windowStub.visualViewport.offsetTop = 100
  check('T31 视口整体上移时扣掉 offsetTop', app.keyboardInset() === 200, String(app.keyboardInset()))
  windowStub.visualViewport.offsetTop = 0
  windowStub.visualViewport.height = 800

  // 关键：判断"点之前是否贴底"必须用 pointerdown 那一刻的状态。
  // 键盘引起的布局抖动会改滚动位置，focus 里再量就已经是错的了。
  box.scrollHeight = 3000
  box.clientHeight = 500
  box.scrollTop = 2400
  app.state.keyboardPinned = false
  fire(area, 'pointerdown')
  box.scrollTop = 0
  fire(area, 'focus')
  check('T31 用 pointerdown 那一刻的贴底状态决定回底', app.state.keyboardPinned === true, String(app.state.keyboardPinned))

  app.state.keyboardPinned = false
  fire(area, 'pointerdown')
  fire(area, 'focus')
  check('T31 翻历史时点输入框不夺回滚动', app.state.keyboardPinned === false, String(app.state.keyboardPinned))

  fire(area, 'blur')
  check('T31 收起键盘后垫底清零', document.documentElement.style.getPropertyValue('--kb-h') === '0px', document.documentElement.style.getPropertyValue('--kb-h'))
  check('T31 收起键盘后不再自动回底', app.state.keyboardPinned === false, String(app.state.keyboardPinned))
  app.state.keyboardPinned = false
  app.state.bottomBeforeComposer = null
}

console.log('\nT32 壳层：隐藏滚动条 + 键盘不覆盖布局')
{
  const web = dirname(sourcePath)
  const css = readFileSync(join(web, 'style.css'), 'utf8')
  const html = readFileSync(join(web, 'index.html'), 'utf8')
  check('T32 隐藏 webkit 滚动条（夸克那条带箭头的灰条）', css.includes('#app *::-webkit-scrollbar'), 'style.css 缺 #app *::-webkit-scrollbar')
  check('T32 关闭标准滚动条宽度', css.includes('scrollbar-width: none'), 'style.css 缺 scrollbar-width')
  check('T32 .view 用 --kb-h 垫底', css.includes('padding-bottom: var(--kb-h, 0px)'), 'style.css 缺 --kb-h 垫底')
  check('T32 viewport 声明 interactive-widget', html.includes('interactive-widget=resizes-content'), 'index.html 缺 interactive-widget')
}

console.log('\nT33 点带图排队行的编辑：先弹确认，取消就不进编辑态')
{
  reset()
  app.state.current = 'sess-A'
  app.state.editingQueue = ''
  const appEl = document.getElementById('app')
  const row = app.rowForItem({ itemId: 'q-img', text: '', imageCount: 2, at: Date.now() })
  const editBtn = row.children.find((node) => node.textContent === '✎')
  const findSheet = () => appEl.children.find((node) => node.classList && node.classList.contains('confirm'))

  editBtn.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sheet = findSheet()
  check('T33 弹出了确认层', Boolean(sheet), JSON.stringify(appEl.children.map((node) => node.className)))
  check('T33 提示里带图片张数', Boolean(sheet) && sheet.textContent.includes('2 张图片'), sheet && sheet.textContent)
  check('T33 提示说明图片会丢', Boolean(sheet) && sheet.textContent.includes('丢掉'), sheet && sheet.textContent)

  const buttons = sheet ? sheet.querySelectorAll('button') : []
  const cancelBtn = buttons.find((node) => node.textContent === '取消')
  check('T33 有取消按钮', Boolean(cancelBtn), buttons.map((node) => node.textContent).join('|'))
  cancelBtn.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('T33 取消后不进编辑态', app.state.editingQueue === '', String(app.state.editingQueue))
  check('T33 取消后确认层收起', !findSheet())

  const row2 = app.rowForItem({ itemId: 'q-img', text: '', imageCount: 2, at: Date.now() })
  const editBtn2 = row2.children.find((node) => node.textContent === '✎')
  editBtn2.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sheet2 = findSheet()
  const okBtn = sheet2 ? sheet2.querySelectorAll('button').find((node) => node.textContent === '继续编辑') : null
  check('T33 有"继续编辑"按钮', Boolean(okBtn), sheet2 ? sheet2.textContent : 'no-sheet')
  okBtn.onclick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('T33 确认后才进编辑态', app.state.editingQueue === 'q-img', String(app.state.editingQueue))

  // 编辑保存后本地也要把图片张数清零，否则排队行还挂着 🖼，用户以为图没丢。
  app.state.queues.set('sess-A', [{ itemId: 'q-img', text: '', imageCount: 2, at: Date.now() }])
  app.setQueueText('q-img', '改成一个字', 'sess-A', true)
  const after = (app.state.queues.get('sess-A') || [])[0] || {}
  check('T33 编辑后排队行的图片张数清零', after.imageCount === 0 && after.text === '改成一个字', JSON.stringify(after))

  app.state.editingQueue = ''
}

console.log('\nT34 流式期间还没正文：只显示「运行中…」')
{
  reset()
  app.state.current = 'sess-A'
  app.applyDelta({ sessionId: 'sess-A', text: '', reasoning: '正在想办法', streaming: true })
  const node = document.getElementById('transcript').children.find((n) => n.classList && n.classList.contains('streaming'))
  check('T34 有流式气泡', Boolean(node), JSON.stringify(document.getElementById('transcript').children.map((n) => n.className)))
  check('T34 占位文字是「运行中…」', Boolean(node) && node.textContent.includes('运行中…'), node && node.textContent)
  check('T34 没有旧的裸省略号占位', Boolean(node) && !/^\s*…\s*$/.test(node.textContent.replace('DSH', '').replace('✦ 思考', '')), node && node.textContent)
  check('T34 气泡标上 waiting（CSS 据此藏掉头像/思考摘要）', Boolean(node) && node.classList.contains('waiting'), node && node.className)
  const css = readFileSync(join(dirname(sourcePath), 'style.css'), 'utf8')
  check('T34 waiting 时藏掉 role 与思考摘要', css.includes('.msg.assistant.streaming.waiting .delta-think'), 'style.css 缺 waiting 规则')

  app.applyDelta({ sessionId: 'sess-A', text: '正文来了', streaming: true })
  const node2 = document.getElementById('transcript').children.find((n) => n.classList && n.classList.contains('streaming'))
  check('T34 正文到了就恢复正常气泡', Boolean(node2) && !node2.classList.contains('waiting'), node2 && node2.className)
  check('T34 正文到了不再显示运行中', Boolean(node2) && !node2.textContent.includes('运行中…'), node2 && node2.textContent)
  app.clearDelta()
}

/* T35 被换绑：服务端推 kicked 帧后，这台手机必须当场退回配对页并说明原因。
   之前的实现什么都不做，界面一直"重连中"，用户以为插件坏了。 */
{
  document.cookie = ''
  app.rememberDeviceCookie('dev123.abc')
  check('T35 记住设备 cookie', String(document.cookie).includes('mr_dev=dev123.abc'), String(document.cookie))

  localStorage.setItem('mr.token', 'dev123.abc')
  app.state.token = 'dev123.abc'
  app.handleFrame('kicked', { reason: 'replaced' })
  check('T35 kicked 后立刻清掉 token', app.state.token === '', app.state.token)
  check('T35 kicked 后清掉本地存储', localStorage.getItem('mr.token') === null, String(localStorage.getItem('mr.token')))
  check('T35 kicked 后回到配对页', document.getElementById('pair').classList.contains('active') || !document.getElementById('pair').classList.contains('hidden'), document.getElementById('pair').className)
  const kickedText = document.getElementById('pair-error').textContent || ''
  check('T35 配对页说明被替换的原因', kickedText.includes('新的配对'), kickedText)
}

/* T36 一轮还在跑的时候，后续事件不许打断用户正在做的事（用户 m01458）：
   ① 亲手点开的过程行不能被新事件收回去；
   ② 正在编辑的排队消息不能被队列快照重画掉（焦点/光标/已输入内容都还在）。 */
{
  // ① 展开一条过程行，然后来一条只带思考的 assistant/message
  app.state.current = 'sess-A'
  document.getElementById('transcript').children = []
  app.handleFrame('event', { type: 'turn/start', seq: 500, time: 5000, sessionId: 'sess-A', data: {} })
  app.handleFrame('event', {
    type: 'tool/call', seq: 501, time: 5100, sessionId: 'sess-A',
    data: { name: 'pwsh', arguments: '{"command":"dir"}', summary: { kind: 'cmd', verb: '运行命令', target: 'dir' } },
  })
  const liveWrap = document.getElementById('transcript').children.find((node) => node.classList && node.classList.contains('ev-wrap'))
  check('T36 拿到一条过程行', Boolean(liveWrap), JSON.stringify(document.getElementById('transcript').children.map((n) => n.className)))
  liveWrap.children[0].onclick()
  check('T36 点开后是展开态', liveWrap.classList.contains('open'), liveWrap.className)
  check('T36 点开被记为"用户自己打开"', liveWrap.dataset.userOpen === '1', String(liveWrap.dataset.userOpen))

  app.handleFrame('event', {
    type: 'assistant/message', seq: 502, time: 5200, sessionId: 'sess-A',
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '新跳出来的思考' }] } },
  })
  check('T36 新思考到达后，用户点开的行仍然展开', liveWrap.classList.contains('open'), liveWrap.className)
  check('T36 新思考到达后没有被收进折叠区', !liveWrap.classList.contains('ev-stowed'), liveWrap.className)

  // 对照组：没被用户点开过的行，正文落地时照旧自动收起（电脑版行为不变）
  app.handleFrame('event', {
    type: 'tool/call', seq: 503, time: 5300, sessionId: 'sess-A',
    data: { name: 'read', arguments: '{"file_path":"a.js"}', summary: { kind: 'read', verb: '读取', target: 'a.js' } },
  })
  const autoWrap = document.getElementById('transcript').children.find((node) => node.classList && node.classList.contains('ev-wrap') && node !== liveWrap)
  if (autoWrap) autoWrap.classList.add('open')
  app.handleFrame('event', asstEv(504, '正文来了'))
  check('T36 自动展开的行正文落地后收起', Boolean(autoWrap) && !autoWrap.classList.contains('open'), autoWrap && autoWrap.className)

  // ② 正在编辑的排队消息：队列快照重发后，同一个输入框节点、同一份内容都还在
  app.handleFrame('queue', { sessionId: 'sess-A', items: [{ itemId: 'edit-keep-1', text: '待插话的话', at: Date.now() }] })
  app.state.editingQueue = 'edit-keep-1'
  app.renderQueue()
  const qbox = document.getElementById('queue')
  const editRow = qbox.children.find((node) => node.classList && node.classList.contains('editing'))
  check('T36 进入编辑态后有输入框', Boolean(editRow), JSON.stringify(qbox.children.map((n) => n.className)))
  const editArea = editRow && editRow.children[0]
  if (editArea) editArea.value = '我改了半截的话'

  app.handleFrame('queue', { sessionId: 'sess-A', items: [{ itemId: 'edit-keep-1', text: '待插话的话', at: Date.now() }] })
  const editRow2 = qbox.children.find((node) => node.classList && node.classList.contains('editing'))
  check('T36 队列快照重发后仍是同一个输入框节点', editRow2 === editRow, editRow2 === editRow ? 'same' : 'rebuilt')
  check('T36 已输入的内容没被清掉', Boolean(editRow2) && editRow2.children[0].value === '我改了半截的话', editRow2 && editRow2.children[0].value)
  app.state.editingQueue = ''
  app.renderQueue()
}

/* T37 上滑加载更早记录不能破坏折叠（用户 m01572）：
   ① 回填进来的历史过程行必须默认收起，不许裸着露出来；
   ② 「这一轮」的范围不许跨轮 —— 点历史那一轮不能连带展开新那一轮
      （原来的双向扫描会一路扫过上一行「已完成」，造成上下两侧同时动）。 */
{
  app.state.current = 'sess-A'
  const box = document.getElementById('transcript')
  box.children = []
  box.innerHTML = ''
  app.state.events = new Map()
  app.state.seen = new Set()
  app.state.turnStartedAt = new Map()
  app.state.turnSummaryDone = new Map()
  const wraps = () => box.children.filter((node) => node.classList && node.classList.contains('ev-wrap'))
  const summaries = () => box.children.filter((node) => node.classList && node.classList.contains('turn-summary'))
  const toolEv = (seq, verb, target) => ({
    type: 'tool/call', seq, time: seq, sessionId: 'sess-A',
    data: { name: 'pwsh', arguments: '{"command":"x"}', summary: { kind: 'cmd', verb, target } },
  })

  // 较新的那一轮，正常实时渲染
  app.handleFrame('event', { type: 'turn/start', seq: 600, time: 6000, sessionId: 'sess-A', data: {} })
  app.handleFrame('event', toolEv(601, '运行命令', '新轮的命令'))
  app.handleFrame('event', { type: 'turn/end', seq: 602, time: 6200, sessionId: 'sess-A', data: {} })
  check('T37 实时那一轮有「已完成」行', summaries().length === 1, JSON.stringify(summaries().length))
  check('T37 实时那一轮的过程行已收起', wraps().every((n) => n.classList.contains('ev-stowed')), JSON.stringify(wraps().map((n) => n.className)))

  // 再把更早的一轮当成"翻页结果"回填进去
  app.prependOlder([
    { type: 'turn/start', seq: 590, time: 5900, sessionId: 'sess-A', data: {} },
    toolEv(591, '读取', '旧轮甲'),
    toolEv(592, '编辑', '旧轮乙'),
    { type: 'turn/end', seq: 593, time: 5950, sessionId: 'sess-A', data: {} },
  ])
  const rows = summaries()
  check('T37 回填后有两行「已完成」', rows.length === 2, JSON.stringify(rows.map((n) => n.textContent)))
  check('T37 回填的历史进程行没有裸在外面', wraps().every((n) => n.classList.contains('ev-stowed')), JSON.stringify(wraps().map((n) => n.className)))
  check('T37 历史轮的「已完成」排在前面', rows[0].textContent.includes('已完成') && rows[1].textContent.includes('已完成'))

  const oldWraps = app.turnProcessNodes(rows[0])
  const newWraps = app.turnProcessNodes(rows[1])
  check('T37 历史轮只收集自己的两条过程行', oldWraps.length === 2, String(oldWraps.length))
  check('T37 新轮只收集自己的一条过程行', newWraps.length === 1, String(newWraps.length))

  rows[0].onclick()
  check('T37 展开历史轮时新轮不跟着展开', newWraps.every((n) => n.classList.contains('ev-stowed')), JSON.stringify(newWraps.map((n) => n.className)))
  check('T37 展开历史轮后它自己的行露出来', oldWraps.every((n) => !n.classList.contains('ev-stowed')), JSON.stringify(oldWraps.map((n) => n.className)))
  check('T37 展开过的历史轮被记为"用户自己打开"', rows[0].dataset.userOpen === '1', String(rows[0].dataset.userOpen))

  // 再翻一页：用户展开着的那一轮不许被归位逻辑收回去
  app.prependOlder([{ type: 'user/message', seq: 580, time: 5800, sessionId: 'sess-A', data: { role: 'user', content: [{ type: 'text', text: '更早的话' }] } }])
  check('T37 再翻页不收回用户展开的历史轮', oldWraps.every((n) => !n.classList.contains('ev-stowed')), JSON.stringify(oldWraps.map((n) => n.className)))
}

/* T38 长按发送键触发插话时短震一下（用户 m01631 / m01725：只要这一下，不要别的花样）。 */
{
  navigator.vibrateCalls = []
  const okVibrate = app.haptic()
  check('T38 触感调用成功', okVibrate === true, String(okVibrate))
  check('T38 单次短震（15ms）', navigator.vibrateCalls.length === 1 && navigator.vibrateCalls[0] === 15, JSON.stringify(navigator.vibrateCalls))
  check('T38 没有 Vibration API 时安静跳过（iOS）', source.includes("typeof nav.vibrate !== 'function'"))
  check('T38 长按路径确实调了触感', /longPressed = true\s*\n\s*haptic\(\)/.test(source))
  check('T38 别的入口没有加震动', (source.match(/haptic\(/g) || []).length === 2, String((source.match(/haptic\(/g) || []).length))
}

/* T39 真实形态的历史页（含 turn/start、思考、工具行、正文、turn/end）翻页后必须真的显示出来。 */
{
  reset()
  const box39 = document.getElementById('transcript')
  const seed = (seq) => [
    { type: 'turn/start', seq: seq, time: seq * 10, sessionId: 'sess-A', data: {} },
    { type: 'assistant/message', seq: seq + 1, time: seq * 10 + 5, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }] } } },
    { type: 'tool/call', seq: seq + 2, time: seq * 10 + 8, sessionId: 'sess-A', data: { name: 'pwsh', arguments: '{"command":"x"}', summary: { kind: 'cmd', verb: '运行命令', target: 'x' } } },
    { type: 'user/message', seq: seq + 3, time: seq * 10 + 9, sessionId: 'sess-A', data: { role: 'user', content: [{ type: 'text', text: '旧问题 ' + seq }] } },
    { type: 'assistant/message', seq: seq + 4, time: seq * 10 + 20, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text: '旧回答 ' + seq }] } } },
    { type: 'turn/end', seq: seq + 5, time: seq * 10 + 30, sessionId: 'sess-A', data: {} },
  ]
  for (const event of seed(100)) app.handleFrame('event', event)
  check('T39 先有一轮完整历史', timelineText().some((text) => text.includes('旧回答 100')), JSON.stringify(timelineText()))

  pageHandler = () => ({ ok: true, events: seed(90), latestSeq: 105, hasMore: false })
  let caught = null
  try {
    await app.loadOlder('sess-A')
  } catch (error) {
    caught = error
  }
  check('T39 翻页不抛错', caught === null, caught && (caught.message + ' | ' + (caught.stack || '').split('\n')[1]))
  const text39 = timelineText()
  check('T39 更早的用户消息显示出来了', text39.some((text) => text.includes('旧问题 90')), JSON.stringify(text39))
  check('T39 更早的回答显示出来了', text39.some((text) => text.includes('旧回答 90')), JSON.stringify(text39))
  check('T39 原来那一轮还在', text39.some((text) => text.includes('旧回答 100')), JSON.stringify(text39))
  check('T39 回填的过程行默认收起', box39.children.filter((node) => node.classList && node.classList.contains('ev-wrap')).every((node) => node.classList.contains('ev-stowed')), JSON.stringify(box39.children.map((node) => node.className)))
}

/* T40 上一次翻页半路失败（事件进了内存、没进 DOM）时，再滑一次必须把内容补回来。
   用户 m01785/m01792 的现象就是"有正在加载的提示，提示完什么也没显示"。 */
{
  const seed40 = (seq) => [
    { type: 'turn/start', seq: seq, time: seq * 10, sessionId: 'sess-A', data: {} },
    { type: 'user/message', seq: seq + 3, time: seq * 10 + 9, sessionId: 'sess-A', data: { role: 'user', content: [{ type: 'text', text: '旧问题 ' + seq }] } },
    { type: 'assistant/message', seq: seq + 4, time: seq * 10 + 20, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text: '旧回答 ' + seq }] } } },
  ]
  reset()
  const box40 = document.getElementById('transcript')
  for (const event of seed40(100)) app.handleFrame('event', event)
  pageHandler = () => ({ ok: true, events: seed40(90), latestSeq: 105, hasMore: true })
  await app.loadOlder('sess-A')
  check('T40 第一页正常插入', timelineText().some((text) => text.includes('旧回答 90')), JSON.stringify(timelineText()))

  // 模拟"插入阶段炸了"的残留状态：事件已经在内存里，DOM 里却没有。
  while (box40.children.length > 0) box40.children.pop()
  const eventsKept = app.state.events.size
  check('T40 残留时事件仍在内存', eventsKept > 3, String(eventsKept))

  // 同一页再翻一次：added 会是 0（都被当成"已知道"），必须靠 reflow 把内容补回来。
  // 门闩要求先滚离顶部（真实场景里用户就是滚上去再滑），这里直接放开。
  app.state.olderArmed.set('sess-A', true)
  let caught40 = null
  try {
    await app.loadOlder('sess-A')
  } catch (error) {
    caught40 = error
  }
  check('T40 再次翻页不抛错', caught40 === null, caught40 && caught40.message)
  const diag40 = {
    current: app.state.current,
    older: app.state.older.get('sess-A'),
    armed: app.state.olderArmed.get('sess-A'),
    loading: app.state.loadingOlder.size,
    done: app.state.olderDone.has('sess-A'),
    events: app.state.events.size,
    children: box40.children.length,
  }
  check('T40 门闩状态允许继续翻页', diag40.armed !== false && diag40.older !== false && diag40.loading === 0, JSON.stringify(diag40))
  const text40 = timelineText()
  check('T40 内容被补回时间线', text40.some((text) => text.includes('旧回答 90')) && text40.some((text) => text.includes('旧回答 100')), JSON.stringify(text40))
}

/* T42 服务端返回空页却说还有更早的（宿主分页边界）：不能记成"到底了"，必须把原因摆出来。 */
{
  reset()
  const box42 = document.getElementById('transcript')
  for (const event of [
    { type: 'turn/start', seq: 100, time: 1000, sessionId: 'sess-A', data: {} },
    { type: 'assistant/message', seq: 101, time: 1001, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text: '最新回答' }] } } },
  ]) app.handleFrame('event', event)
  pageHandler = () => ({ ok: true, events: [], latestSeq: 101, hasMore: true })
  app.state.olderArmed.set('sess-A', true)
  app.state.olderDone.delete('sess-A')
  await app.loadOlder('sess-A')
  const text42 = timelineText()
  check('T42 没取到时给出可见提示', text42.some((text) => text.includes('更早的记录没取到')), JSON.stringify(text42))
  check('T42 提示里带上现场数字', text42.some((text) => text.includes('本地最早 seq=100')), JSON.stringify(text42))
  check('T42 不把会话标成到底', app.state.olderDone.has('sess-A') === false)
  check('T42 下一次还能再翻', app.state.olderArmed.get('sess-A') === true)

  // 修好服务端之后同一会话必须能正常翻回来（不能因为出过一次错就永久失效）。
  pageHandler = () => ({
    ok: true,
    events: [
      { type: 'turn/start', seq: 90, time: 900, sessionId: 'sess-A', data: {} },
      { type: 'assistant/message', seq: 91, time: 901, sessionId: 'sess-A', data: { message: { role: 'assistant', content: [{ type: 'text', text: '更早的回答' }] } } },
    ],
    latestSeq: 101,
    hasMore: false,
  })
  await app.loadOlder('sess-A')
  check('T42 之前失败过的会话仍能翻出更早记录', timelineText().some((text) => text.includes('更早的回答')), JSON.stringify(timelineText()))
  check('T42 这次拿到内容后才标到底', app.state.olderDone.has('sess-A') === true)
  check('T42 到底了才出现全部记录提示', timelineText().some((text) => text.includes('已经是全部记录了')))
  void box42
}

/* T43 预取：翻完一页就把下一页提前取回来，下一次上滑直接命中缓存（宿主每页要回放整个会话，很慢）。 */
{
  reset()
  for (const seq of [95, 96, 97]) app.handleFrame('event', userEv(seq, `第 ${seq} 条`))
  app.state.olderArmed.set('sess-A', true)
  app.state.olderDone.delete('sess-A')
  const calls43 = []
  pageHandler = (target) => {
    calls43.push(target)
    const before = Number((target.match(/before=(\d+)/) || [])[1] || 0)
    return { ok: true, events: [userEv(before - 2, `第 ${before - 2} 条`)], latestSeq: 97, hasMore: true }
  }
  await app.loadOlder('sess-A')
  check('T43 第一页拿到了更早的记录', timelineText().some((text) => text.includes('第 93 条')), JSON.stringify(timelineText()))
  const pageCalls43 = () => calls43.filter((call) => call.includes('before=')).length
  check('T43 自动预取了下一页', calls43.some((call) => call.includes('before=93')), JSON.stringify(calls43.map((call) => (call.match(/before=(\d+)/) || [])[0])))
  const count93 = () => calls43.filter((call) => call.includes('before=93')).length
  const beforeSecond = count93()
  await new Promise((resolve) => setTimeout(resolve, 10))
  app.state.olderArmed.set('sess-A', true)
  await app.loadOlder('sess-A')
  check('T43 预取命中时不再重复请求这一页', count93() === beforeSecond, `before=93 calls ${beforeSecond} -> ${count93()}`)
  check('T43 预取的那一页真的插进来了', timelineText().some((text) => text.includes('第 91 条')), JSON.stringify(timelineText()))
  void pageCalls43
}

/* T41 单条事件渲染失败不能拖垮整页，也不能把这一页永久标成"已加载"。 */
{
  const source41 = readFileSync(sourcePath, 'utf8')
  check('T41 prependOlder 逐条兜住渲染异常', /for \(const event of ordered\) \{\s*\n\s*try \{\s*\n\s*appendEvent\(event, holder\)/.test(source41))
  check('T41 插入失败回滚内存里的事件', /for \(const event of ordered\) state\.events\.delete\(event\.seq\)/.test(source41))
  check('T41 loadOlder 失败会给提示而不是静默', /catch \(error\) \{\s*\n\s*\/\/ 翻页失败不能静默/.test(source41))
}

/* ------------------------------------------------------------ 未读蓝点 / 提醒气泡
 *
 * 规矩只有三条，但每条都对应一个真机上真会踩的场景：
 *   1) 我在看 A，B 跑完 → 弹气泡 + 列表点蓝点。
 *   2) 我就在看 B 且贴在底部 → 不点、不弹（我看得见）。
 *   3) 连上时的快照补点：断线/切后台期间跑完的会话，回来也要有标记。
 * 另外要防两个"不该点"：单纯的假运行状态（宿主重启把 running 丢了）、
 * 会话被归档/删掉之后蓝点变孤儿。
 */

// 这几个用例要控制"页面是不是开着""是不是贴底""看的哪个会话"，
// 所以先把这三个变量设成列表页的样子，用完再还原。
function enterListPage() {
  app.state.current = ''
  app.state.transport = 'on'
  document.hidden = false
}

function readListRow(sessionId) {
  // 直接把这一行画出来，绕开分组/排序（那两个有 T18/T20 覆盖）。
  const session = app.state.sessions.get(sessionId)
  if (!session) return null
  const row = app.sessionRow(session)
  return {
    hasUnread: row.classList.contains('has-unread'),
    hasDot: row.querySelectorAll('.unread-dot').length === 1,
    hasRunTag: row.querySelectorAll('.tag').some((node) => node.classList.contains('run')),
  }
}

const chipNodes = () => document.body.querySelectorAll('.notice-chip')
const newSession = (id, title) => ({ id, title, running: false, blank: false, updatedAt: 1, cwd: '' })

// 替身没有滚动：appendEvent 每落地一行都会 scrollBottom() 把 pinBottom 重置成 true。
// 想在「用户往上翻着历史」的状态下跑用例，就用这个把 pinBottom 焊住，
// 顺便把 scrollHeight 抬高让 nearBottom() 也为 false。返回解焊函数。
function holdPinned(value) {
  const box = document.getElementById('transcript')
  const desc = Object.getOwnPropertyDescriptor(app.state, 'pinBottom')
  const rawHeight = Object.getOwnPropertyDescriptor(box, 'scrollHeight')
  Object.defineProperty(app.state, 'pinBottom', { configurable: true, get: () => value, set: () => {} })
  if (value === false) Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 4000 })
  return () => {
    delete app.state.pinBottom
    if (desc) Object.defineProperty(app.state, 'pinBottom', desc)
    delete box.scrollHeight
    if (rawHeight) Object.defineProperty(box, 'scrollHeight', rawHeight)
  }
}

// 前面的用例把 state 改得七零八落，这里整体重置一次。
app.state.sessions = new Map()
app.state.latestSeq = new Map()
app.state.lastSeq = new Map()
app.state.unread = new Map()
app.state.cursors = {}
for (const [id, title] of [['sess-A', '正在看的'], ['sess-B', '另一个会话']]) {
  app.state.sessions.set(id, newSession(id, title))
}
// 替身里没有"页面刷新"这回事：上一个测试段挂到 body 上的气泡要手动摘掉，
// 气泡句柄（finishedChipNode / finishedChipTimer）也得一起清，否则新气泡会接管旧句柄、
// 旧的不透明度动画还会漏过来（连点几轮屏幕上就会积一摞）。
for (const stale of chipNodes()) stale.remove()
app.dismissFinishedChip()
enterListPage()

// T50 列表页：别的会话跑完 → 该行点蓝点，且蓝点占的是「运行中」那个位置。
app.handleFrame('event', { ...userEv(10, '跑起来'), sessionId: 'sess-B' })
app.handleFrame('event', { ...asstEv(11, '跑完了'), sessionId: 'sess-B' })
app.handleFrame('event', { ...{ type: 'turn/end', seq: 12, time: 12 }, sessionId: 'sess-B' })
const rowB = readListRow('sess-B')
check('T50 别的会话跑完，列表点蓝点', rowB && rowB.hasUnread === true && rowB.hasDot === true, JSON.stringify(rowB))
check('T50 跑完就不再显示「运行中」', rowB && rowB.hasRunTag === false, JSON.stringify(rowB))
  console.log('CHIPDUMP', JSON.stringify(chipNodes().map((n) => [n.textContent, n.className, n.dataset && n.dataset.sessionId])))
check('T50 在列表页时不弹气泡（标题栏已经能看见）', chipNodes().length === 0, `${chipNodes().length} chips`)

// T51 点进那个会话＝看过：蓝点消失。
app.markSeen('sess-B')
check('T51 点开会话后蓝点消失', readListRow('sess-B').hasUnread === false, JSON.stringify(readListRow('sess-B')))

// T52 正在看 A，B 又跑完一轮 → 弹气泡，气泡上是会话名，点它跳过去。
app.state.current = 'sess-A'
app.state.transport = 'on'
app.state.pinBottom = true
app.handleFrame('event', { ...{ type: 'turn/start', seq: 20, time: 20 }, sessionId: 'sess-B' })
app.handleFrame('event', { ...asstEv(21, '第二轮的答复'), sessionId: 'sess-B' })
app.handleFrame('event', { ...{ type: 'turn/end', seq: 22, time: 22 }, sessionId: 'sess-B' })
const chips52 = chipNodes()
check('T52 看 A 时 B 跑完要弹气泡', chips52.length === 1, `${chips52.length} chips`)
check('T52 气泡上写着是哪个会话跑完了', chips52[0] && chips52[0].textContent.includes('另一个会话'), chips52[0] ? chips52[0].textContent : 'none')
check('T52 同时对 B 点上了蓝点', readListRow('sess-B').hasUnread === true, JSON.stringify(readListRow('sess-B')))

// T53 点气泡 = 跳过去。这里不测 openChat 的完整加载（它有 await 网络），
//     只测"点了之后气泡被撤掉、蓝点被清掉"，跳转本身由 onclick 调 openChat 保证。
if (chips52[0]) {
  chips52[0].onclick()
  app.markSeen('sess-B')
}
check('T53 点气泡后气泡消失', chipNodes().length === 0, `${chipNodes().length} chips`)
check('T53 点气泡后蓝点也清掉', readListRow('sess-B').hasUnread === false, JSON.stringify(readListRow('sess-B')))

// T54 看着的就是那个会话、而且贴在底部 → 不点蓝点也不弹气泡（我看得见）。
app.state.sessions.set('sess-B', newSession('sess-B', '另一个会话'))
app.state.current = 'sess-B'
app.state.transport = 'on'
app.state.pinBottom = true
app.handleFrame('event', { ...{ type: 'turn/start', seq: 30, time: 30 }, sessionId: 'sess-B' })
app.handleFrame('event', { ...asstEv(31, '你正看着的回答'), sessionId: 'sess-B' })
app.handleFrame('event', { ...{ type: 'turn/end', seq: 32, time: 32 }, sessionId: 'sess-B' })
check('T54 正看着且贴底：不点蓝点', readListRow('sess-B').hasUnread === false, JSON.stringify(readListRow('sess-B')))
check('T54 正看着且贴底：不弹气泡', chipNodes().length === 0, `${chipNodes().length} chips`)

// T55 同一个会话，但我往上翻历史看得入神 → 算没看见，要提醒。
app.state.sessions.set('sess-B', newSession('sess-B', '另一个会话'))
app.state.current = 'sess-B'
// 上一轮（seq 32）已经点过蓝点；这里要验的是"翻着历史、新的一轮跑完"要不要再点一次，
// 所以先 markSeen 把上一轮的标记清掉，否则 hasUnread 恒为 true，断言就测不出东西。
app.markSeen('sess-B')
const unpin55 = holdPinned(false)
app.handleFrame('event', { ...{ type: 'turn/start', seq: 40, time: 40 }, sessionId: 'sess-B' })
app.handleFrame('event', { ...asstEv(41, '你没看到的回答'), sessionId: 'sess-B' })
app.handleFrame('event', { ...{ type: 'turn/end', seq: 42, time: 42 }, sessionId: 'sess-B' })
unpin55()
check('T55 翻历史时跑完也要点蓝点', readListRow('sess-B').hasUnread === true, JSON.stringify(readListRow('sess-B')))
// 同会话不弹"别的会话跑完了"气泡——那会让人以为切错了会话。
check('T55 不给自己正在看的会话弹气泡', chipNodes().length === 0, `${chipNodes().length} chips`)

// T56 假 idle：宿主重启把 running 丢了，一条新事件都没有 → 不该点蓝点。
app.state.sessions.set('sess-B', newSession('sess-B', '另一个会话'))
enterListPage()
app.markSeen('sess-B')
const cursorBefore = app.state.cursors['sess-B'] || 0
app.handleFrame('status', { sessionId: 'sess-B', status: 'idle' })
check('T56 没有新内容的 idle 不点蓝点', readListRow('sess-B').hasUnread === false, `cursor=${cursorBefore} unread=${readListRow('sess-B').hasUnread}`)

// T57 真跑完但走的是 status 帧（turn/end 漏收）→ 有未读内容撑着，仍然要点。
// latestSeq 要同时改成 45（游标 0 + 5）；T55 留下的 42 会让它判成"没有新内容"。
app.state.latestSeq.set('sess-B', (app.state.cursors['sess-B'] || 0) + 5)
app.handleFrame('status', { sessionId: 'sess-B', status: 'idle' })
check('T57 有未读内容时 idle 帧也能点蓝点', readListRow('sess-B').hasUnread === true, JSON.stringify(readListRow('sess-B')))

// T58 重连快照补点：断线期间跑完的会话，回来要有标记。
app.state.unread = new Map()
enterListPage()
// 快照里的 lastSeq 是服务端游标，和本地游标比才知道"断线期间它跑过没有"。
// 比较基线 state.lastSeq 必须清空：T55 留下的 42 会让 hello 的 noteLastSeq 先把它抬到 140，
// 后面 seedUnreadFromSnapshot 再拿同一个 140 去比，就变成"没新东西"了（这是顺序问题，不是逻辑问题）。
app.state.lastSeq = new Map()
app.state.latestSeq = new Map([['sess-A', 100]])
// hello 里服务端自己也会报 lastSeq（这次连上时它心里的游标）。这里刻意不给它 B：
// 那样客户端先记基线再补点，B 永远补不上——真实场景里"断线期间跑过的会话"，
// 服务端报的正是它比本地游标新，所以两个字段要分开喂，才能真的测到补点这条路径。
app.state.cursors = { 'sess-A': 100 }
app.handleFrame('hello', {
  serverTime: 1,
  status: { 'sess-A': 'idle', 'sess-B': 'idle' },
  lastSeq: { 'sess-A': 100 },
  latest: { 'sess-A': 100, 'sess-B': 140 },
  sessionsRev: 0,
})
  app.seedUnreadFromSnapshot({ 'sess-B': 140, 'sess-A': 100 })
check('T58 断线期间跑完的会话回来补点', readListRow('sess-B').hasUnread === true, JSON.stringify(readListRow('sess-B')))
check('T58 游标已经追上的会话不点', readListRow('sess-A').hasUnread === false, JSON.stringify(readListRow('sess-A')))

// T59 蓝点要能扛住整页刷新：状态是写 localStorage 的，不是只存在内存里。
const savedRaw = localStorage.getItem('mr.unread')
check('T59 未读状态落到 localStorage', typeof savedRaw === 'string' && savedRaw.includes('sess-B'), String(savedRaw))
app.state.unread = new Map()
app.loadUnread()
check('T59 重新加载后未读还在', readListRow('sess-B').hasUnread === true, JSON.stringify(readListRow('sess-B')))

// T60 会话被归档/删掉之后，蓝点不能变成孤儿（永远点不掉）。
app.state.sessions.delete('sess-B')
app.refreshState.call(null).catch(() => {})
app.state.sessions.delete('sess-B')
app.markSeen('sess-B')
check('T60 标记已读后不会留下孤儿记录', !app.state.unread.has('sess-B'), JSON.stringify(Array.from(app.state.unread.keys())))

// T61 提醒气泡必须会自己走：不点也不滑，6 秒后也要消失（悬空 DOM 越攒越多会挡屏幕）。
const chip = (() => {
  app.state.sessions.set('sess-X', newSession('sess-X', '第三个会话'))
  app.state.current = 'sess-A'
  app.showFinishedChip('sess-X')
  return chipNodes()[0]
})()
check('T61 气泡先挂上', Boolean(chip), `${chipNodes().length} chips`)
// 多等一点：淡出动画 400ms 之后才真正从 DOM 上摘掉。
await new Promise((resolve) => setTimeout(resolve, 6900))
check('T61 没人管的气泡自己消失', chipNodes().length === 0, `${chipNodes().length} chips`)

// T62 气泡是浮层，不能挤动时间线：它必须挂在 body 上，不能插进 #transcript。
// （T61 已经把那个气泡淡出摘掉了，这里现挂一个新的来验挂载位置。）
const chip2 = (() => {
  app.showFinishedChip('sess-X')
  return chipNodes()[0]
})()
check('T62 气泡挂在 body 上而不是时间线里', Boolean(chip2) && chip2.parent === document.body, chip2 ? String(chip2.parent && chip2.parent.tagName) : 'no chip')
check('T62 时间线里没有气泡节点', document.getElementById('transcript').querySelectorAll('.notice-chip').length === 0)
app.dismissFinishedChip()

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (expectBug) {
  console.log('（--expect-bug 模式：以上失败项即为已复现的 bug）')
  process.exit(0)
}
process.exit(failed === 0 ? 0 : 1)
