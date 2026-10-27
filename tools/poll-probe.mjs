// 直接验证：长轮询能否被 queue 帧唤醒（最小复现，不依赖 smoke 的上下文）。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = require('../lib/index.js')

const handlers = new Map()
const ctx = {
  sessionController: {
    async list() { return { items: [] } },
    async projections() { return { kind: 'sequenced', asOfSeq: 0, values: {} } },
    async prompt() { return { accepted: true } },
    async cancel() { return { accepted: true } },
    async selectModel() { return { selected: true } },
    async modelCatalog() { return { default: null, routableProviders: [], groups: [], failures: [] } },
    async *follow() { yield { type: 'snapshot', cursor: 0, records: [], hasMore: false } },
    async page() { return { records: [], hasMore: false } },
    async inspect() { return { meta: {}, inheritedEventCount: 0, events: [] } },
    async updateQueue() { return { accepted: true } },
    async create() { return { sessionId: 'sess-1' } },
  },
  get(name) { return name === 'sessionController' ? this.sessionController : undefined },
  on(name, fn) { handlers.set(name, fn) },
  effect(fn) { const dispose = fn(); probe.dispose = dispose },
  logger: { info() {}, warn() {}, error() {} },
}

const probe = { dispose: null }
mod.apply(ctx, { host: '127.0.0.1', port: 7811, stateDir: new URL('./.probe-state/', import.meta.url).pathname.replace(/^\//, '') })

const base = 'http://127.0.0.1:7811'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(400)

const pc = await (await fetch(`${base}/api/paircode`)).json()
const paired = await (await fetch(`${base}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pc.code, name: 'probe' }),
})).json()
const token = paired.token
const auth = { authorization: `Bearer ${token}` }

const cursor = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url')
const started = Date.now()
const pollPromise = fetch(`${base}/api/poll?k=${encodeURIComponent(token)}&c=${encodeURIComponent(cursor)}`, { headers: auth })

await sleep(500)
const emit = handlers.get('session/event')
const started2 = Date.now()
const done = pollPromise.then(async (res) => ({ res, body: await res.json() }))
emit({ id: 'sess-1' }, {
  type: 'agent/inbox/spliced',
  seq: 7,
  data: { target: 'next-turn', start: 0, inserted: [{ id: 'm-1', role: 'user', content: [{ type: 'text', text: '排队探针' }] }] },
})

const { body } = await done
console.log('poll elapsed =', Date.now() - started2, 'ms')
console.log('frames =', JSON.stringify(body.frames?.map((f) => f.type)))
console.log('queueSync =', JSON.stringify(body.queueSync?.map((f) => f.payload)))
console.log('frames[0] =', JSON.stringify(body.frames?.[0]))
console.log('total elapsed =', Date.now() - started, 'ms')

probe.dispose?.()
process.exit(0)
