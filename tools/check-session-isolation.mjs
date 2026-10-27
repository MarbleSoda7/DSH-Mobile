/* 回归测试：手机端跨会话串话（m02338）
 * 在最小 DOM 垫片上直接跑真实 web/app.js，验证：
 *  A. 在会话 A 发的消息，切到会话 B 后不会出现在 B 的时间线里；
 *  B. 别的会话的 user/message 事件到达时必须认下对应乐观气泡（settle），不管当时看的是哪个会话；
 *  C. 同一会话内正常 settle，不出现重复气泡；
 *  D. 两个会话发同一段文字时，只撤掉对应会话的那条；
 *  E. 服务端事件永不到达的气泡会超时自净。
 * 用法：node tools/check-session-isolation.mjs
 * 反向验证（证明本测试能抓到串话）：
 *   APP_SRC=tools/fixtures/app-legacy-pending-leak.js node tools/check-session-isolation.mjs
 *   该 fixture 是修复前的实现：乐观事件不带 sessionId、reflow() 无条件重画 → 用例 A 必失败。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.on('unhandledRejection', () => {})

const HERE = dirname(fileURLToPath(import.meta.url))
// APP_SRC 可指向一份故意还原成旧实现的拷贝，用来证明这个测试真的能抓到串话。
const SRC = readFileSync(process.env.APP_SRC || join(HERE, '..', 'web', 'app.js'), 'utf8')

function makeNode(tag = 'div') {
  const classes = new Set()
  const node = {
    tagName: tag, children: [], className: '', style: {}, _html: '', _text: '',
    isConnected: true, scrollTop: 0, scrollHeight: 0, clientHeight: 480, value: '', dataset: {},
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force
        if (on) classes.add(name); else classes.delete(name)
        return on
      },
      contains: (name) => classes.has(name),
    },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child },
    remove() { this.isConnected = false },
    querySelector() { return makeNode() },
    querySelectorAll() { return [] },
    focus() {}, blur() {}, setAttribute() {}, getAttribute() { return null }, addEventListener() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 } },
  }
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null })
  // 真实 DOM 里给 innerHTML/textContent 赋值会丢掉子节点，垫片必须照做，
  // 否则 clearTranscript() 在测试里清不干净，会造出假的串话失败。
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html,
    set: (value) => { node._html = String(value); node.children = []; node._text = '' },
  })
  Object.defineProperty(node, 'textContent', {
    get: () => node._text,
    set: (value) => { node._text = String(value); node.children = []; node._html = '' },
  })
  return node
}

const nodes = new Map()
const nodeFor = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id) }
const transcript = nodeFor('transcript')
const composer = nodeFor('composer')

globalThis.document = {
  getElementById: (id) => nodeFor(id),
  createElement: (tag) => makeNode(tag),
  createTextNode: (text) => Object.assign(makeNode('#text'), { textContent: text }),
  body: makeNode('body'), documentElement: makeNode('html'),
  querySelector: () => makeNode(), querySelectorAll: () => [], addEventListener() {},
  visibilityState: 'visible', hidden: false,
}
globalThis.window = {
  addEventListener() {}, innerWidth: 420, innerHeight: 900,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { search: '', pathname: '/', href: 'http://127.0.0.1/' },
  history: { replaceState() {} },
}
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-test', onLine: true }, configurable: true, writable: true })
globalThis.location = globalThis.window.location
globalThis.history = globalThis.window.history
globalThis.localStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null },
  setItem(k, v) { this._v.set(k, String(v)) },
  removeItem(k) { this._v.delete(k) },
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

globalThis.fetch = async (url) => {
  const target = String(url)
  const body = target.includes('/page?')
    ? { ok: true, events: [], latestSeq: 0, hasMore: false }
    : target.includes('/api/queue') ? { ok: true, items: [] } : { ok: true }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), blob: async () => ({}) }
}
globalThis.EventSource = class { constructor() { this.readyState = 0 } addEventListener() {} close() {} }

const factory = new Function(SRC + ';return { state, send, openChat, reflow, handleFrame, settlePending, appendEvent, messageText }')
const T = factory()

const userText = (value) => ({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: value }] } } })
const flatten = (node, out = []) => {
  if (!node) return out
  if (node.innerHTML) out.push(String(node.innerHTML))
  if (node.textContent) out.push(String(node.textContent))
  for (const child of node.children || []) flatten(child, out)
  return out
}
const transcriptText = () => flatten({ innerHTML: '', children: transcript.children }).join('\n')
const resetAll = () => {
  transcript.children = []
  transcript.innerHTML = ''
  T.state.pending = []
  T.state.events = new Map()
  T.state.seen = new Set()
  T.state.queues = new Map()
  T.state.turnOpen = new Map()
  T.state.running = new Map()
  T.state.sessions = new Map()
  T.state.cursors = {}
  T.state.current = ''
  nodeFor('composer').value = ''
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log('  ok   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

async function caseA() {
  resetAll()
  T.state.sessions.set('A', { id: 'A', title: 'A' })
  T.state.sessions.set('B', { id: 'B', title: 'B' })
  T.state.current = 'A'
  composer.value = 'hello from A'
  await T.send()
  check('A: 发出后本会话可见', transcriptText().includes('hello from A'))
  check('A: 乐观气泡带会话归属', T.state.pending.length === 1 && T.state.pending[0].sessionId === 'A')
  await T.openChat('B')
  // 真实触发点：B 自己的历史/新事件到达后整条重画（openChat 的 idb 缓存分支、
  // loadLatest 的 changed 分支都会调 reflow）。测试里 idb 不可用，必须手动补这一下，
  // 否则 reflow 从没在 B 上跑过，测试就成了空转。
  T.state.events.set(1, { seq: 1, type: 'turn/start', sessionId: 'B', data: {} })
  T.reflow()
  check('A: 切到 B 后 B 的时间线不含 A 的消息', !transcriptText().includes('hello from A'), transcriptText().slice(0, 200))
  check('A: A 的气泡仍保留（切回 A 还能看到）', T.state.pending.filter((item) => item.sessionId === 'A').length === 1)
}

async function caseB() {
  resetAll()
  T.state.sessions.set('A', { id: 'A', title: 'A' })
  T.state.sessions.set('B', { id: 'B', title: 'B' })
  T.state.current = 'A'
  composer.value = 'sent then switched away'
  await T.send()
  await T.openChat('B')
  T.handleFrame('event', { sessionId: 'A', seq: 11, ...userText('sent then switched away') })
  check('B: 非当前会话的 user/message 认下了气泡', T.state.pending.length === 0, JSON.stringify(T.state.pending.map((p) => p.sessionId)))
  check('B: 提前 return 也不污染 B 的画面', !transcriptText().includes('sent then switched away'))
}

async function caseC() {
  resetAll()
  T.state.sessions.set('A', { id: 'A', title: 'A' })
  T.state.current = 'A'
  composer.value = 'once only'
  await T.send()
  T.handleFrame('event', { sessionId: 'A', seq: 12, ...userText('once only') })
  const count = transcriptText().split('once only').length - 1
  check('C: 同会话 settle 后只剩一条', count === 1 && T.state.pending.length === 0, 'count=' + count)
}

async function caseD() {
  resetAll()
  T.state.sessions.set('A', { id: 'A', title: 'A' })
  T.state.sessions.set('B', { id: 'B', title: 'B' })
  T.state.current = 'A'
  composer.value = 'dup'
  await T.send()
  await T.openChat('B')
  composer.value = 'dup'
  await T.send()
  check('D: B 也有自己的气泡', T.state.pending.some((item) => item.sessionId === 'B'))
  T.handleFrame('event', { sessionId: 'A', seq: 13, ...userText('dup') })
  const left = T.state.pending.map((item) => item.sessionId)
  check('D: 只撤掉 A 的那条，B 的还在', left.length === 1 && left[0] === 'B', JSON.stringify(left))
  check('D: B 的乐观气泡还在画面上', transcriptText().includes('dup'))
}

async function caseE() {
  resetAll()
  T.state.sessions.set('A', { id: 'A', title: 'A' })
  T.state.current = 'A'
  composer.value = 'ghost'
  await T.send()
  T.state.pending[0].at = Date.now() - 10 * 60 * 1000
  T.reflow()
  check('E: 超时未确认的气泡被清掉', T.state.pending.length === 0 && !transcriptText().includes('ghost'))
}

await caseA()
await caseB()
await caseC()
await caseD()
await caseE()

console.log(failures === 0 ? 'SESSION_ISOLATION_OK' : 'SESSION_ISOLATION_FAILED (' + failures + ')')
process.exit(failures === 0 ? 0 : 1)
