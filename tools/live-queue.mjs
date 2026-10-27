// 对真实宿主上的插件做一次「排队消息」链路验证：
// 开新会话（换成能用的模型）-> 起一个长任务 -> 立刻排第二条 -> 查 /api/queue 与长轮询帧。
const BASE = process.env.BASE || 'http://127.0.0.1:7788'

const out = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`${label.padEnd(34)} ${text && text.length > 400 ? text.slice(0, 400) + '…' : text}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const res = await fetch(`${BASE}/api/paircode`)
const pair = await res.json()
const code = pair.code
const j = (r) => r.json()

const paired = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, name: 'queue-live-test' }),
}).then(j)
if (!paired.ok) throw new Error(`pair failed: ${JSON.stringify(paired)}`)
const token = paired.token
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const created = await fetch(`${BASE}/api/session`, { method: 'POST', headers: auth, body: '{}' }).then(j)
out('create session', created)
if (!created.ok) throw new Error('create failed')
const sessionId = created.sessionId

const sel = await fetch(`${BASE}/api/model`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
}).then(j)
out('select model', sel)

const focus = await fetch(`${BASE}/api/focus`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).then(j)
out('focus', focus)

const p1 = await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '请慢慢数到 200，每数 20 个汇报一次，中间不要停。' }),
}).then(j)
out('prompt #1', p1)

await sleep(1800)
const p2 = await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '排队消息测试：收到请回复 QUEUED', mode: 'queue' }),
}).then(j)
out('prompt #2 (queue)', p2)

const q = await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then(j)
out('GET /api/queue', q)

const poll = await fetch(`${BASE}/api/poll?k=${token}&c=`, { headers: auth }).then(j)
out('poll frame types', (poll.frames || []).map((f) => f.type).join(','))
const queueFrames = (poll.frames || []).filter((f) => f.type === 'queue')
out('queue frames in poll', queueFrames.length)

await sleep(2500)
const q2 = await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then(j)
out('queue after 2.5s', q2)

const state = await fetch(`${BASE}/api/state`, { headers: auth }).then(j)
const row = (state.sessions || []).find((s) => s.id === sessionId)
out('session running/blank', row && { running: row.running, blank: row.blank, title: row.title })

await fetch(`${BASE}/api/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).then(j)
await fetch(`${BASE}/api/devices/revoke`, { method: 'POST', headers: auth, body: JSON.stringify({ id: paired.deviceId }) }).then(j)
out('done', { sessionId, deviceRevoked: paired.deviceId })
