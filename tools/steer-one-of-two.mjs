// 复现「插话一条排队消息后，整条队列都消失了」。
//
// 场景：一轮正在跑 -> 连排两条 -> 只对第一条点「插话到本轮」
// 期望：第二条仍在排队框里
// 实测（这个脚本就是用来抓它的）：两条全没了
//
// 用法：node tools/steer-one-of-two.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:7788'

const out = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`${label.padEnd(30)} ${text && text.length > 300 ? text.slice(0, 300) + '…' : text}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (r) => r.json()

let failed = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log(`ok   ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}\n  actual   ${a}\n  expected ${b}`)
}

const pair = await fetch(`${BASE}/api/paircode`).then(j)
const paired = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pair.code, name: 'steer-one-of-two' }),
}).then(j)
if (!paired.ok) throw new Error(`pair failed: ${JSON.stringify(paired)}`)
const token = paired.token
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const created = await fetch(`${BASE}/api/session`, { method: 'POST', headers: auth, body: '{}' }).then(j)
if (!created.ok) throw new Error('create failed')
const sessionId = created.sessionId
await fetch(`${BASE}/api/model`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
}).then(j)
await fetch(`${BASE}/api/focus`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).then(j)

// 起一轮，让宿主处于 running
await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '请慢慢从 1 数到 200，每数 20 个汇报一次，中间不要停。' }),
}).then(j)
await sleep(1800)

const q1 = await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '排队一：先别数了，回复 ONE', mode: 'queue' }),
}).then(j)
const q2 = await fetch(`${BASE}/api/prompt`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sessionId, text: '排队二：然后回复 TWO', mode: 'queue' }),
}).then(j)
out('queue prompt 1', q1)
out('queue prompt 2', q2)

let list = await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then(j)
out('queue after both', (list.items || []).map((r) => r.text))
check('两条排队消息都在', (list.items || []).length, 2)

const first = (list.items || [])[0]
if (!first) {
  console.log('FAIL 没有排上队，后面的断言无意义')
  failed += 1
} else {
  const steer = await fetch(`${BASE}/api/queue`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessionId, itemId: first.itemId, action: 'steer' }),
  }).then(j)
  out('steer first', steer)

  await sleep(300)
  list = await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then(j)
  out('queue right after steer', (list.items || []).map((r) => r.text))
  check('插话一条后还剩一条', (list.items || []).length, 1)
  check('剩下的是第二条', (list.items || []).map((r) => r.text), ['排队二：然后回复 TWO'])

  // 再等一轮事件落地，看会不会被后续事件清空
  await sleep(4000)
  list = await fetch(`${BASE}/api/queue?sessionId=${sessionId}`, { headers: auth }).then(j)
  out('queue 4s later', (list.items || []).map((r) => r.text))
  check('4 秒后第二条仍在', (list.items || []).map((r) => r.text), ['排队二：然后回复 TWO'])
}

await fetch(`${BASE}/api/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).then(j)
await fetch(`${BASE}/api/devices/revoke`, { method: 'POST', headers: auth, body: JSON.stringify({ id: paired.deviceId }) }).then(j)

if (failed) {
  console.log(`\nSTEER_ONE_OF_TWO_FAILED (${failed})`)
  process.exit(1)
}
console.log('\nSTEER_ONE_OF_TWO_OK')
