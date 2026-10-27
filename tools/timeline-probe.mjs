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
    child.parent = this
    this.children.push(child)
    return child
  }
  insertBefore(child, ref) {
    const index = this.children.indexOf(ref)
    child.parent = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
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
// page 的返回内容可被用例改写（T11 翻页需要真返回更早的事件）。
let pageHandler = () => ({ ok: true, events: [], latestSeq: 0, hasMore: false })
const fetchStub = async (url) => {
  const target = String(url)
  fetchCalls.push(target)
  const json = target.includes('/api/state')
    ? { ok: true, sessions: [], hiddenBlank: 0, defaultModel: null }
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

/* ------------------------------------------------------------------ 载入脚本 */

const source = readFileSync(sourcePath, 'utf8')
const factory = new Function(
  'window', 'document', 'navigator', 'localStorage', 'indexedDB', 'IDBKeyRange', 'EventSource', 'fetch', 'location', 'console',
  source + '\nreturn { state, handleFrame, reflow, appendEvent, openChat, settlePending, pendingPush, applyDelta, clearDelta, closeTransport, loadQueue, loadOlder }',
)
const app = factory(windowStub, document, navigator, localStorage, indexedDB, IDBKeyRange, EventSource, fetchStub, locationStub, console)

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
const last = box.children[box.children.length - 1]
const summaryText = last ? last.textContent.replace(/\s+/g, ' ').trim() : ''
check('T6 一轮结束有「已完成，用时」汇总行', /已完成，用时 1 分 5 秒/.test(summaryText), summaryText)

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

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (expectBug) {
  console.log('（--expect-bug 模式：以上失败项即为已复现的 bug）')
  process.exit(0)
}
process.exit(failed === 0 ? 0 : 1)
