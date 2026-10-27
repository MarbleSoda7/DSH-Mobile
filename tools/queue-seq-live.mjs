/* 真机链路：观察「手机发排队消息」之后，服务端连续推给手机的 queue 帧序列。
 *
 * 用户反馈（m07884）：手机发排队消息会立刻消失、被吞掉，电脑也不同步。
 * 这里只关心一件事：从手机发出那一刻起，手机收到的 queue 帧里 items 长什么样、
 * 什么时候变成空。空一帧就足以让客户端把刚插进去的占位行抹掉。
 *
 * 用法：node tools/queue-seq-live.mjs [--base http://127.0.0.1:7788]
 */
const BASE = (() => {
  const index = process.argv.indexOf('--base')
  return index >= 0 ? process.argv[index + 1] : 'http://127.0.0.1:7788'
})()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const out = (label, value) => console.log(String(label).padEnd(26), typeof value === 'string' ? value : JSON.stringify(value))
const stamp = () => `${String(Date.now() % 100000).padStart(5, '0')}ms`

const paircode = await fetch(`${BASE}/api/paircode`).then((r) => r.json())
const pair = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: paircode.code, name: 'queue-seq-probe' }),
}).then((r) => r.json())
const token = pair.token
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const created = await fetch(`${BASE}/api/session`, { method: 'POST', headers: auth, body: '{}' }).then((r) => r.json())
const sessionId = created.sessionId
await fetch(`${BASE}/api/model`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
})
await fetch(`${BASE}/api/focus`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, focus: true }),
})

const cursor = {}
const log = []
let polling = true
async function pump() {
  while (polling) {
    const param = encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString('base64url'))
    let data
    try {
      data = await fetch(`${BASE}/api/poll?k=${encodeURIComponent(token)}&c=${param}`, { headers: auth }).then((r) => r.json())
    } catch {
      await sleep(200)
      continue
    }
    for (const frame of [...(data.queueSync || []), ...(data.frames || [])]) {
      if (frame.type === 'queue') {
        // queueSync 是**所有**有队列的会话的快照，不过滤 sessionId 会把别的会话的
        // 空队列当成"我这条被吞了"，得出完全相反的结论。
        if (frame.payload?.sessionId !== sessionId) continue
        log.push({ at: Date.now(), texts: (frame.payload.items || []).map((row) => row.text) })
      }
      if (frame.type === 'event' && typeof frame.payload?.seq === 'number') {
        if (frame.payload.sessionId === sessionId) {
          const data = frame.payload.data || {}
          const message = data.message || data
          const text = (message?.content || [])
            .filter((block) => block?.type === 'text')
            .map((block) => block.text)
            .join(' ')
          if (frame.payload.type === 'user/message' || frame.payload.type === 'turn/end') {
            log.push({ at: Date.now(), kind: frame.payload.type, seq: frame.payload.seq, text })
          }
        }
        cursor[frame.payload.sessionId] = frame.payload.seq
      }
    }
    if (data.cursor) for (const [key, value] of Object.entries(data.cursor)) if (typeof value === 'number') cursor[key] = Math.max(cursor[key] || 0, value)
    await sleep(80)
  }
}
const pumpPromise = pump()

await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '请慢慢从 1 数到 150，每 10 个分行输出，中途不要停。' }),
})
await sleep(2500)

const mark = Date.now()
out('queue send at', stamp())
await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '手机排队：收到请回复 PHONE-QUEUED', mode: 'queue' }),
})

await sleep(6000)
const after = log.filter((entry) => entry.at >= mark)
out('queue frames after send', after.filter((entry) => 'texts' in entry).length)
for (const entry of after.slice(0, 16)) {
  if ('texts' in entry) out(`  +${entry.at - mark}ms queue`, entry.texts)
  else out(`  +${entry.at - mark}ms ${entry.kind}#${entry.seq}`, entry.text)
}
const vanished = after.some((entry) => 'texts' in entry && entry.texts.length === 0)
out('ever pushed empty queue', vanished)
out('user/message seen', after.some((entry) => entry.kind === 'user/message' && String(entry.text).includes('PHONE-QUEUED')))
out('final GET /api/queue', await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then((r) => r.json()))

polling = false
await pumpPromise.catch(() => {})
await fetch(`${BASE}/api/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) })
await fetch(`${BASE}/api/devices/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: pair.deviceId }),
})
out('result', vanished ? 'EMPTY_QUEUE_PUSHED' : 'QUEUE_STABLE')
