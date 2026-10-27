/* 协议冒烟测试：不需要真实 DSH，用假 ctx 驱动插件，验证 HTTP / SSE / 问答接管全链路。
 * 运行：node tools/smoke.mjs
 */
import http from 'node:http'

const PORT = 7799
const BASE = `http://127.0.0.1:${PORT}`

const calls = { prompt: [], cancel: [], selectModel: [] }
const handlers = new Map()
const emitted = []
let questionHandler = null

const sampleEvents = [
  { type: 'user/message', seq: 1, time: Date.now(), data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } } },
  {
    type: 'assistant/message',
    seq: 2,
    time: Date.now(),
    data: {
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想想' }, { type: 'text', text: '在的' }] },
      stream: [{ huge: 'x'.repeat(1000) }],
    },
  },
]

const fakeController = {
  async list() {
    return {
      items: [
        {
          sessionId: 'sess-1',
          updatedAt: Date.now(),
          running: false,
          blank: false,
          cwd: 'D:\\workspace\\demo',
          projections: {
            kind: 'sequenced',
            asOfSeq: 2,
            values: {
              title: '测试会话',
              agentPreset: 'ptc',
              modelSelection: { next: { provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
            },
          },
        },
      ],
    }
  },
  async projections() {
    return { kind: 'sequenced', asOfSeq: 2, values: { title: '测试会话' } }
  },
  async page() {
    return { records: sampleEvents.map((event) => ({ type: 'event', event })), hasMore: false }
  },
  async *follow(request) {
    const cursor = sampleEvents[sampleEvents.length - 1]?.seq ?? 0
    yield {
      type: 'snapshot',
      header: { version: 4, id: request.address.sessionId, createdAt: 0, isSeeded: false },
      cursor,
      records: sampleEvents.map((event) => ({ type: 'event', event })),
      hasMore: false,
    }
  },
  async prompt(request) {
    calls.prompt.push(request)
    return { accepted: true }
  },
  cancel(request) {
    calls.cancel.push(request)
    return { accepted: true }
  },
  async selectModel(request) {
    calls.selectModel.push(request)
    return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
  },
  async modelCatalog() {
    return {
      default: { provider: 'ds', model: 'deepseek-v4.1-flash' },
      groups: [
        {
          id: 'ds',
          name: 'DeepSeek 账号',
          models: [
            { id: 'deepseek-v4-pro', name: 'V4 Pro', reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } },
            { id: 'deepseek-v4.1-flash', name: 'V4.1 Flash', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } },
          ],
        },
      ],
      failures: [],
    }
  },
  async inspect() {
    return { events: sampleEvents }
  },
}

const fakeRegistry = { archivedSessionIds: [] }

const ctx = {
  sessionController: fakeController,
  get(name) {
    if (name === 'sessionController') return fakeController
    if (name === 'workspaceRegistry') return fakeRegistry
    return undefined
  },
  on(name, listener) {
    handlers.set(name, listener)
    return () => handlers.delete(name)
  },
  effect(factory) {
    ctx._dispose = factory()
  },
  dispose() {},
}

const { apply } = await import('../lib/index.js')
apply(ctx, { host: '127.0.0.1', port: PORT, stateDir: 'D:\\SDU\\IC\\HarnessProject\\guide-dog-peta\\dsh-mobile-remote\\.smoke-state' })
await new Promise((resolve) => setTimeout(resolve, 600))

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

async function json(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function sseOpen(path, onEvent) {
  const url = new URL(`${BASE}${path}`)
  const req = http.get({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { accept: 'text/event-stream' } }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const payloadLine = /^data: (.+)$/m.exec(block)?.[1]
        if (name && payloadLine) {
          try {
            onEvent(name, JSON.parse(payloadLine))
          } catch {}
        }
        index = buffer.indexOf('\n\n')
      }
    })
    req.onClose = () => res.destroy()
  })
  return req
}

// 1) 静态与健康检查
const health = await json('/api/health')
check('GET /api/health', health.status === 200 && health.data.ok === true)

const adminRes = await fetch(`${BASE}/admin`)
const adminText = await adminRes.text()
check('GET /admin 返回配对页', adminRes.status === 200 && adminText.includes('配对二维码'))

const indexRes = await fetch(`${BASE}/`)
check('GET / 返回 PWA 外壳', indexRes.status === 200)

const appRes = await fetch(`${BASE}/app.js`)
check('GET /app.js', appRes.status === 200)

// 2) 配对
const pairCode = await json('/api/paircode')
check('GET /api/paircode', pairCode.status === 200 && typeof pairCode.data.code === 'string' && pairCode.data.url.includes('?t='))
const qr = await json(`/api/qr?text=${encodeURIComponent(pairCode.data.url)}`)
check('GET /api/qr 二维码', qr.status === 200 || qr.status === 501, `status=${qr.status}`)

const paired = await json('/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pairCode.data.code, name: '冒烟测试机' }),
})
check('POST /api/pair', paired.status === 200 && typeof paired.data.token === 'string')
const auth = { authorization: `Bearer ${paired.data.token}` }

const reused = await json('/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pairCode.data.code }),
})
check('配对码一次性', reused.status === 401)

const noAuth = await json('/api/state')
check('未带密钥返回 401', noAuth.status === 401)

// 3) 会话与历史
const stateRes = await json('/api/state', { headers: auth })
check('GET /api/state 会话标题', stateRes.data.sessions?.[0]?.title === '测试会话')
check('GET /api/state 模型投影', stateRes.data.sessions?.[0]?.model?.model === 'deepseek-v4.1-flash')

const page = await json('/api/session/sess-1/page?limit=60', { headers: auth })
check('GET /page 返回 2 条事件', page.data.events?.length === 2)
const assistant = page.data.events?.find((event) => event.type === 'assistant/message')
check('assistant/message 丢弃 stream', assistant?.data && !('stream' in assistant.data))
check('assistant/message 保留文本块', assistant?.data?.message?.content?.some((block) => block.type === 'text' && block.text === '在的'))

const catalog = await json('/api/catalog', { headers: auth })
check('GET /api/catalog', catalog.data.catalog?.groups?.length === 1)

// 4) SSE 增量
const received = []
const stream = sseOpen(`/api/events?k=${encodeURIComponent(paired.data.token)}&c=e30`, (name, payload) => received.push({ name, payload }))
await new Promise((resolve) => setTimeout(resolve, 300))
check('SSE hello 帧', received.some((item) => item.name === 'hello'))

const fire = handlers.get('session/event')
check('session/event 已订阅', typeof fire === 'function')
// 宿主历史里的 user/message 是扁平的：content/role 直接在 data 上（没有 data.message）。
// 手机端必须能读到它，否则"我"发的历史消息永远不显示。
fire({ id: 'sess-1' }, { type: 'user/message', seq: 8, time: Date.now(), data: { role: 'user', id: 'u-1', content: [{ type: 'text', text: '扁平结构的用户消息' }] } })
await new Promise((resolve) => setTimeout(resolve, 300))
const flatUser = received.find((item) => item.name === 'event' && item.payload.seq === 8)
check('扁平 user/message 原样下发', flatUser?.payload?.data?.content?.[0]?.text === '扁平结构的用户消息')
fire({ id: 'sess-1' }, { type: 'assistant/message', seq: 9, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: '增量' }] }, stream: [] } })
await new Promise((resolve) => setTimeout(resolve, 300))
const got = received.find((item) => item.name === 'event' && item.payload.seq === 9)
check('SSE 收到增量事件', Boolean(got))
check('增量事件带 sessionId', got?.payload?.sessionId === 'sess-1')

// 5) 流式 delta（只看 focused 会话）
await json('/api/focus', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1', focus: true }) })
const streamFn = handlers.get('agent/assistant-stream')
streamFn({ agent: { session: { id: 'sess-1' } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '流式片段' } } })
await new Promise((resolve) => setTimeout(resolve, 500))
const delta = received.find((item) => item.name === 'delta')
check('SSE 收到流式 delta', delta?.payload?.text === '流式片段')

// 6) 排队消息：真源是 agent/inbox/spliced
const splice = (data) => fire({ id: 'sess-1' }, { type: 'agent/inbox/spliced', seq: 20, time: Date.now(), data })
splice({ target: 'next-turn', start: 0, inserted: [{ id: 'm-1', role: 'user', content: [{ type: 'text', text: '排队的消息' }] }] })
await new Promise((resolve) => setTimeout(resolve, 300))
const queueFrame = received.filter((item) => item.name === 'queue').pop()
check('SSE 收到 queue 帧', Boolean(queueFrame))
check('queue 帧带 1 条排队消息', queueFrame?.payload?.items?.length === 1)
check('排队消息文本正确', queueFrame?.payload?.items?.[0]?.text === '排队的消息')

splice({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
await new Promise((resolve) => setTimeout(resolve, 300))
const queueEmpty = received.filter((item) => item.name === 'queue').pop()
check('取出后队列清空', queueEmpty?.payload?.items?.length === 0)

splice({ target: 'next-turn', start: 0, inserted: [{ id: 'm-2', role: 'user', content: [{ type: 'text', text: '第二条' }] }] })
fire({ id: 'sess-1' }, { type: 'turn/start', seq: 22, time: Date.now(), data: { turn: 1 } })
await new Promise((resolve) => setTimeout(resolve, 300))
const queueAfterTurn = received.filter((item) => item.name === 'queue').pop()
// turn/start 本身**不能**清空队列：宿主要在下一轮才取走排队消息，取走时会再发一条
// `target:'next-turn', removedCount:N` 的 spliced 事件。早先在这里清空会让刚排上的
// 消息立刻从手机上消失（用户实测：排了 15 分钟一条都没显示）。
check('turn/start 不清空队列', queueAfterTurn?.payload?.items?.length === 1)

splice({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
await new Promise((resolve) => setTimeout(resolve, 300))
const queueAfterClaim = received.filter((item) => item.name === 'queue').pop()
check('宿主取走后 queue 帧清空', queueAfterClaim?.payload?.items?.length === 0)

// 6.1) 队列帧必须能经长轮询立刻下发（生产路径：Cloudflare 隧道下 SSE 不通）
// 先把游标推到当前尾部（第一次 poll 会立刻回放历史帧并返回游标）
const drained = await json('/api/poll?k=' + encodeURIComponent(paired.data.token), { headers: auth })
const cursor = Buffer.from(JSON.stringify(drained.data.cursor || {}), 'utf8')
  .toString('base64url')
const pollPromise = json(
  '/api/poll?k=' + encodeURIComponent(paired.data.token) + '&c=' + encodeURIComponent(cursor),
  { headers: auth },
)
await new Promise((resolve) => setTimeout(resolve, 450))
splice({ target: 'next-turn', start: 0, inserted: [{ id: 'm-3', role: 'user', content: [{ type: 'text', text: '长轮询里的排队消息' }] }] })
if (process.env.SMOKE_DEBUG) console.log('  [debug] sse queue frames =', JSON.stringify(received.filter((item) => item.name === 'queue').pop()?.payload || null))
const polled = await pollPromise
if (process.env.SMOKE_DEBUG) console.log('  [debug] poll frames =', JSON.stringify(polled.data.frames?.map((frame) => frame.type) || []), 'ms =', polled.ms)
// 队列帧可能出现在两处：frames（变化瞬间被它唤醒）或 queueSync（每次轮询都带的权威快照）。
// 两种都算通过 —— 关键是"手机侧一定拿得到当前队列"，而不是走哪条路。
const pollFrames = [...(polled.data.frames || []), ...(polled.data.queueSync || [])]
const pollQueue = pollFrames.find((frame) => frame.type === 'queue')
check('长轮询能拿到队列快照', Boolean(pollQueue))
const liveQueue = await json('/api/queue?sessionId=sess-1', { headers: auth })
check('队列真实状态正确', liveQueue.data.items?.[0]?.text === '长轮询里的排队消息')

// 7) 问答接管
questionHandler = handlers.get('user-questions/request')
check('user-questions/request 已订阅', typeof questionHandler === 'function')
let nextCalled = false
const answerPromise = questionHandler(
  {
    agent: { id: 'sess-1', session: { id: 'sess-1' } },
    questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
    signal: new AbortController().signal,
  },
  async () => {
    nextCalled = true
  },
)
await new Promise((resolve) => setTimeout(resolve, 300))
const questionFrame = received.find((item) => item.name === 'question')
check('SSE 推送问答', Boolean(questionFrame))
check('问答未被交回电脑端', nextCalled === false)

const answered = await json('/api/answer', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ id: questionFrame?.payload?.id, answers: [{ id: 'q1', selected: ['B'] }] }),
})
check('POST /api/answer', answered.status === 200 && answered.data.ok === true)
const resolved = await answerPromise
check('宿主拿到答案', resolved?.answers?.[0]?.selected?.[0] === 'B')

// 7) 发送 / 终止 / 切模型
const sent = await json('/api/prompt', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-1', text: '继续', mode: 'queue' }),
})
check('POST /api/prompt 入队', sent.status === 200 && calls.prompt[0]?.mode === 'queue' && calls.prompt[0]?.content?.[0]?.text === '继续')

const cancelled = await json('/api/cancel', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1' }) })
check('POST /api/cancel', cancelled.status === 200 && calls.cancel[0]?.sessionId === 'sess-1')

const switched = await json('/api/model', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'sess-1', provider: 'ds', model: 'deepseek-v4-pro', reasoningEffort: 'high' }),
})
check('POST /api/model', switched.status === 200 && calls.selectModel[0]?.reasoningEffort === 'high')

// 8) 审批只广播不接管
let approvalNext = false
const approvalHandler = handlers.get('approval/request')
const approvalReturn = approvalHandler({ session: { id: 'sess-1' }, toolName: 'shell', reason: 'rm -rf' }, async () => {
  approvalNext = true
  return { decision: 'deny' }
})
await approvalReturn
check('审批交回电脑端', approvalNext === true)

// 9) 嵌套子调用（run_code 里的 读取/搜索/查看子智能体）：手机端要和电脑端一样逐条显示，
//    所以这些事件不能被当噪声丢掉，且必须带 summarizeToolCall 生成的 summary。
fire({ id: 'sess-1' }, {
  type: 'tool/ptc-dispatch-start',
  seq: 120,
  time: Date.now(),
  data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'read', arguments: { file_path: 'D:/tmp/a.js' } },
})
await new Promise((resolve) => setTimeout(resolve, 300))
const subStart = received.find((item) => item.name === 'event' && item.payload.seq === 120)
if (process.env.SMOKE_DEBUG) console.log('DBG subStart =', JSON.stringify(subStart))
check('ptc-dispatch-start 不被丢弃', Boolean(subStart))
check('子调用带 summary', subStart?.payload?.data?.summary?.verb === '读取' && subStart?.payload?.data?.summary?.target === 'D:/tmp/a.js')

fire({ id: 'sess-1' }, {
  type: 'tool/ptc-dispatch',
  seq: 121,
  time: Date.now(),
  data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'read', arguments: { file_path: 'D:/tmp/a.js' }, isError: false, content: [{ type: 'text', text: 'file body' }] },
})
await new Promise((resolve) => setTimeout(resolve, 300))
const subEnd = received.find((item) => item.name === 'event' && item.payload.seq === 121)
check('ptc-dispatch 结算带内容', subEnd?.payload?.data?.message?.content?.[0]?.text === 'file body')
check('ptc-dispatch 保留 subCallId', subEnd?.payload?.data?.subCallId === 'sub-1')

stream.destroy()
console.log(`\n${passed} passed, ${failed} failed`)
ctx._dispose?.()
await new Promise((resolve) => setTimeout(resolve, 200))
process.exit(failed === 0 ? 0 : 1)
