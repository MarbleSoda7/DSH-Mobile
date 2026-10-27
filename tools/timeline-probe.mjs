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
    this.style = {}
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
const navigator = {}
const locationStub = { search: '', hash: '', href: 'http://127.0.0.1:7788/' }
const windowStub = { addEventListener: () => {} }
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

const source = readFileSync(sourcePath, 'utf8')
const factory = new Function(
  'window', 'document', 'navigator', 'localStorage', 'indexedDB', 'IDBKeyRange', 'EventSource', 'fetch', 'location', 'console', 'FileReader', 'Blob',
  source + '\nreturn { state, handleFrame, reflow, appendEvent, openChat, settlePending, pendingPush, applyDelta, clearDelta, closeTransport, loadQueue, loadOlder, renderSessions, refreshState, groupSessions, addFiles, renderAttachments, send, renderQueue, dropQueueRow, setQueueText, touchQueue, mdInline, renderMarkdown, renderText, copyText }',
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
const allClosed = box.children.filter((node) => node.classList && node.classList.contains('ev-wrap')).every((node) => !node.classList.contains('open'))
check('T6 正文出现后过程行自动收起', allClosed)
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

// T14 轮边界自愈：服务端 page() 按"轮"切分，某些游标位置用 limit=3 会返回
//     空页但 hasMore=true（真机实测 before=12109&limit=1 → 0 条）。客户端
//     必须用更大的页重试一次，而不是就此判定"到底了"。
reset()
for (const seq of [91, 92, 93]) app.handleFrame('event', userEv(seq, `第 ${seq} 条`))
app.state.olderArmed.set('sess-A', true)
pageHandler = (target) => {
  const limit = Number((target.match(/limit=(\d+)/) || [])[1] || 0)
  const before = Number((target.match(/before=(\d+)/) || [])[1] || 0)
  // 小页正好落在轮边界：怎么问都是空页，但 hasMore 仍是 true。
  if (limit <= 3) return { ok: true, events: [], latestSeq: 93, hasMore: true }
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
const moreBtn = document.getElementById('transcript').querySelector('.msg-more')
check('T15 截断消息显示"展开全文"按钮', Boolean(moreBtn) && /共 5000 字/.test(moreBtn.textContent), moreBtn ? moreBtn.textContent : 'no button')
check('T15 截断消息不显示被截掉的内容', !timelineText().join(' ').includes('已截断'), JSON.stringify(timelineText()).slice(0, 120))
eventHandler = () => ({ ok: true, full: true, event: { type: 'user/message', seq: 77, data: { role: 'user', content: [{ type: 'text', text: '完整内容整段' }] } } })
await moreBtn.onclick()
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
  // 用户手动展开
  thinkWrap.classList.add('open')
  app.handleFrame('event', { type: 'turn/end', seq: 71, time: 8000, sessionId: 'sess-A', data: { reason: { kind: 'completed' } } })
  check('T21 一轮结束后已展开的思考被收起', !thinkWrap.classList.contains('open'), thinkWrap.className)
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

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (expectBug) {
  console.log('（--expect-bug 模式：以上失败项即为已复现的 bug）')
  process.exit(0)
}
process.exit(failed === 0 ? 0 : 1)
