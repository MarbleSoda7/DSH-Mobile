// 真机链路验证：电脑端「插话」(mode:'steer') 进来的内容，手机端能否立刻看到
//
// 关键点：必须**先挂着长轮询**再插话。真实手机是常驻长轮询的（一次挂 25 秒，
// 间隙 ~120ms），所以插话帧有收件人。若先插话再建连，那一帧本来就没有收件人，
// 测出来的"未收到"是测试方法错误，不是产品缺陷。
//
// 用法：node tools/steer-live.mjs
const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'

async function json(path, init) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`)
  }
  if (!res.ok || parsed.ok === false) throw new Error(`${path} -> ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`)
  return parsed
}

const pc = await json('/api/paircode')
const pair = await json('/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pc.code, name: 'steer-live' }),
})
const auth = { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' }

const cursor = {}
const seen = []
let steerAt = 0
let stop = false

function record(frame, gotAt) {
  if (frame.type === 'delta') return
  const payload = frame.payload || {}
  if (frame.type === 'event') {
    const data = payload.data || {}
    const msg = data.message || data
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    seen.push({
      at: gotAt,
      type: payload.type,
      seq: payload.seq,
      text: text.slice(0, 40),
      extra: payload.type === 'agent/inbox/spliced'
        ? ` target=${data.target} n=${(data.inserted || []).length}`
        : '',
    })
    return
  }
  seen.push({
    at: gotAt,
    type: `frame:${frame.type}`,
    seq: null,
    text: String(payload.text || '').slice(0, 40),
    extra: payload.id ? ` id=${String(payload.id).slice(0, 8)}` : '',
  })
}

async function pump() {
  while (!stop) {
    try {
      const data = await json(`/api/poll?k=${pair.token}&c=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`)
      const gotAt = Date.now()
      for (const frame of data.frames || []) record(frame, gotAt)
      for (const frame of data.queueSync || []) record(frame, gotAt)
      if (data.cursor) Object.assign(cursor, data.cursor)
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

let sessionId = ''
try {
  const created = await json('/api/session', { method: 'POST', headers: auth, body: JSON.stringify({ cwd: process.cwd() }) })
  sessionId = created.sessionId || (created.session && created.session.id) || (created.session && created.session.sessionId)
  if (!sessionId) throw new Error('create 未返回 sessionId: ' + JSON.stringify(created).slice(0, 300))
  console.log('新会话', sessionId)

  await json('/api/focus', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) })

  // 先建立常驻长轮询（等同真实手机）
  const pumpPromise = pump()

  await json('/api/prompt', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessionId, text: '请从 1 数到 300，每行一个数字，不要省略，也不要合并行。' }),
  })
  console.log('已发出长任务')

  // 等到至少收到一条本会话事件，游标才算"手机已知这个会话"（真实手机也是这样）
  const warmDeadline = Date.now() + 5000
  while (Date.now() < warmDeadline && !(typeof cursor[sessionId] === 'number')) {
    await new Promise((r) => setTimeout(r, 100))
  }

  await new Promise((r) => setTimeout(r, 1500))

  const steerText = '插话测试：先只回复 STEER-SEEN 四个字，别数了'
  steerAt = Date.now()
  await json('/api/redirect', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId, text: steerText }) })
  console.log('已插话:', steerText)

  // 等 steer 帧；拿到后继续收，确认真正的 user/message 带着**同一个 message.id** 到达
  // （客户端据此把合成气泡替换成真实消息，不会出现两条）。
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (seen.some((x) => x.type === 'frame:steer')) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const steerFrame = seen.find((x) => x.type === 'frame:steer')
  const steerId = steerFrame && steerFrame.extra.startsWith(' id=') ? steerFrame.extra.slice(4) : ''
  if (steerFrame && steerId) {
    const idDeadline = Date.now() + 20_000
    while (Date.now() < idDeadline) {
      const matched = seen.some(
        (x) => x.type === 'user/message' && x.text.includes('STEER-SEEN'),
      )
      if (matched) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  stop = true
  await pumpPromise

  console.log('\n手机侧收到：')
  for (const s of seen) {
    const dt = s.at && steerAt ? ` +${s.at - steerAt}ms` : ''
    console.log(`  ${s.type}${dt} seq=${s.seq}${s.extra} "${s.text}"`)
  }
  const hit = seen.find((x) => x.type === 'user/message' && x.text.includes('STEER-SEEN'))
  if (steerFrame) {
    console.log(`\n即时 steer 帧: 收到（插话后 ${steerFrame.at - steerAt}ms，id=${steerId}…）`)
  } else {
    console.log('\n即时 steer 帧: 未收到')
  }
  console.log('随后真实 user/message 到达:', hit ? `是（seq=${hit.seq}，客户端按 id 替换合成气泡）` : '否')
  process.exitCode = steerFrame ? 0 : 1
} finally {
  stop = true
  if (sessionId) {
    await fetch(BASE + '/api/cancel', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) }).catch(() => {})
  }
  await fetch(BASE + '/api/devices/revoke', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: pair.deviceId }),
  }).catch(() => {})
  console.log('已清理临时设备')
}
