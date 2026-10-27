/* 真机链路：模拟手机常驻长轮询 + 电脑端排一条消息，验证 queue 帧能不能到手机。
 *
 * 复现用户反馈「排队队列消失了 / 电脑发排队消息手机不同步」：
 *  - 手机上发 -> 立刻消失（本地占位被清，服务端帧没到）
 *  - 电脑上发 -> 手机看不到（queue 帧丢失）
 * 这里只看服务端到手机这一段：帧里有没有 queue、items 内容对不对。
 *
 * 用法：node tools/queue-frames-live.mjs [--base http://127.0.0.1:7788]
 */
const BASE = (() => {
  const index = process.argv.indexOf('--base')
  return index >= 0 ? process.argv[index + 1] : 'http://127.0.0.1:7788'
})()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const out = (label, value) => console.log(label.padEnd(30), typeof value === 'string' ? value : JSON.stringify(value))

const paircode = await fetch(`${BASE}/api/paircode`).then((r) => r.json())
if (!paircode.ok) {
  console.error('paircode failed', paircode)
  process.exit(1)
}
const pair = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: paircode.code, name: 'queue-frames-probe' }),
}).then((r) => r.json())
const token = pair.token
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
out('paired', pair.deviceId)

const created = await fetch(`${BASE}/api/session`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({}),
}).then((r) => r.json())
const sessionId = created.sessionId
out('session', sessionId)
await fetch(`${BASE}/api/model`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
}).then((r) => r.json())
await fetch(`${BASE}/api/focus`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, focus: true }),
}).then((r) => r.json())

const cursor = {}
const seen = []
let polling = true
async function pump() {
  while (polling) {
    const param = encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString('base64url'))
    let data
    try {
      data = await fetch(`${BASE}/api/poll?k=${encodeURIComponent(token)}&c=${param}`, { headers: auth }).then((r) => r.json())
    } catch {
      await sleep(300)
      continue
    }
    const frames = [...(data.queueSync || []), ...(data.frames || [])]
    for (const frame of frames) {
      seen.push(frame)
      if (frame.type === 'event' && typeof frame.payload?.seq === 'number') {
        cursor[frame.payload.sessionId] = frame.payload.seq
      }
    }
    if (data.cursor) for (const [key, value] of Object.entries(data.cursor)) if (typeof value === 'number') cursor[key] = Math.max(cursor[key] || 0, value)
    await sleep(60)
  }
}
const pumpPromise = pump()

// 起一轮长任务
await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '请慢慢从 1 数到 120，每 10 个分行输出，不要停。' }),
}).then((r) => r.json())
await sleep(2000)
out('queue before', await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then((r) => r.json()))

// 模拟"电脑端"排一条：同一个 prompt 接口，mode=queue
const mark = seen.length
const queued = await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '电脑端排队的消息：收到请回复 DESKTOP-QUEUED', mode: 'queue' }),
}).then((r) => r.json())
out('desktop queue prompt', queued)

await sleep(2500)
const queueFrames = seen.slice(mark).filter((frame) => frame.type === 'queue')
out('queue frames after', queueFrames.length)
const last = queueFrames[queueFrames.length - 1]
out('last queue items', last ? (last.payload.items || []).map((row) => row.text) : null)
const hasDesktop = queueFrames.some((frame) => (frame.payload.items || []).some((row) => String(row.text).includes('DESKTOP-QUEUED')))
out('desktop queue visible to phone', hasDesktop)

polling = false
await pumpPromise.catch(() => {})
await fetch(`${BASE}/api/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).then((r) => r.json())
await fetch(`${BASE}/api/devices/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: pair.deviceId }),
}).then((r) => r.json())
out('result', hasDesktop ? 'DESKTOP_QUEUE_SYNC_OK' : 'DESKTOP_QUEUE_SYNC_FAIL')
process.exit(hasDesktop ? 0 : 1)
