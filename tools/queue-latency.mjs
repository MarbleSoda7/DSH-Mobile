// 排队操作（删除 / 编辑 / 插话）的端到端延迟测量。
//
// 用户的抱怨是"点了之后手机上看不出变化，其实已经改好了"。这需要区分两段延迟：
//   A. 服务端处理 + 宿主 updateQueue 往返（HTTP 请求到响应）
//   B. 队列变化推到手机上（长轮询被唤醒或下一次轮询带回 queue 帧）
// 只有把两段分开量，才知道该优化哪一段。
//
// 用法：
//   node tools/queue-latency.mjs            # 打本机 127.0.0.1:7788
//   MR_BASE=http://8.152.5.127:7788 node tools/queue-latency.mjs
//
// 需要一个"正在跑一轮"的会话来排队；脚本会自己建会话、发长任务。

const PAIR_BASE = process.env.MR_PAIR_BASE || 'http://127.0.0.1:7788'
const BASE = process.env.MR_BASE || PAIR_BASE

const json = async (res) => {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: text.slice(0, 200) }
  }
}

const pair = async () => {
  const code = await json(await fetch(`${PAIR_BASE}/api/paircode`))
  if (!code.ok) throw new Error(`paircode failed: ${JSON.stringify(code).slice(0, 160)}`)
  const paired = await json(await fetch(`${PAIR_BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.code, name: 'latency-probe' }),
  }))
  if (!paired.ok) throw new Error(`pair failed: ${JSON.stringify(paired).slice(0, 160)}`)
  return { token: paired.token, deviceId: paired.deviceId }
}

const auth = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

const main = async () => {
  const { token, deviceId } = await pair()
  const api = async (path, options = {}) => json(await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...auth(token), ...(options.headers || {}) },
  }))
  const revoke = async () => {
    await fetch(`${BASE}/api/devices/revoke`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ id: deviceId }),
    }).catch(() => {})
  }

  const created = await api('/api/session', { method: 'POST', body: JSON.stringify({}) })
  if (!created.ok) {
    console.log('CREATE_FAIL', JSON.stringify(created).slice(0, 200))
    await revoke()
    process.exit(1)
  }
  const sessionId = created.sessionId || created.id || created.session?.id
  await api('/api/model', { method: 'POST', body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }) })
  await api('/api/focus', { method: 'POST', body: JSON.stringify({ sessionId }) })

  // 常驻长轮询：记录每条 queue 帧到达的时刻
  const queueFrames = []
  let cursor = {}
  let polling = true
  const pump = async () => {
    while (polling) {
      try {
        const res = await fetch(`${BASE}/api/poll?k=${encodeURIComponent(token)}&c=${encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString('base64url'))}`, { cache: 'no-store' })
        if (!res.ok) break
        const data = await res.json()
        const at = Date.now()
        for (const frame of [...(data.queueSync || []), ...(data.frames || [])]) {
          if (frame.type === 'queue' && frame.payload?.sessionId === sessionId) {
            queueFrames.push({ at, items: frame.payload.items.map((row) => row.text) })
          }
          if (frame.type === 'event' && typeof frame.payload?.seq === 'number') {
            cursor[frame.payload.sessionId] = Math.max(cursor[frame.payload.sessionId] || 0, frame.payload.seq)
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }
  const pumpTask = pump()

  // 起一轮长任务，制造"运行中"以便排队
  await api('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, mode: 'queue', text: '请从 1 数到 150，每行一个数字。' }) })
  await new Promise((r) => setTimeout(r, 1500))

  const measure = async (label, action) => {
    const sentAt = Date.now()
    const result = await action(sentAt)
    return { label, sentAt, result }
  }

  // 1) 排队一条，量 HTTP 往返
  const t1 = Date.now()
  const queued = await api('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, mode: 'queue', text: '排队 A：收到请回复 A-OK' }) })
  const queueHttpMs = Date.now() - t1
  await new Promise((r) => setTimeout(r, 1200))

  const state = await api(`/api/queue?sessionId=${encodeURIComponent(sessionId)}`)
  const items = state.items || []
  console.log(`queue add http=${queueHttpMs}ms items=${items.length}`)
  if (items.length === 0) {
    console.log('NO_QUEUE_ITEM（这一轮可能已结束，无法测排队操作）')
    polling = false
    await pumpTask.catch(() => {})
    await revoke()
    process.exit(1)
  }
  const target = items[0]

  // 注意：不能"发完请求立刻算反射延迟" —— 那时帧还没到，必然测成"未收到"。
  // 正确做法：记下 sentAt，等一段足够长的时间，再回头找 sentAt 之后的第一个 queue 帧。
  const settle = (sentAt) => {
    const after = queueFrames.filter((frame) => frame.at >= sentAt)
    return after.length > 0 ? after[0].at - sentAt : -1
  }
  const report = (label, sentAt, httpMs) => {
    const reflectMs = settle(sentAt)
    console.log(`${label} http=${httpMs}ms reflect=${reflectMs === -1 ? '（未收到 queue 帧）' : reflectMs + 'ms'}`)
    return { label, httpMs, reflectMs }
  }

  const out = []
  // 2) 编辑
  const sentEdit = Date.now()
  const edited = await api('/api/queue', { method: 'POST', body: JSON.stringify({ sessionId, itemId: target.itemId, action: 'edit', text: '排队 A（已编辑）' }) })
  const editHttp = Date.now() - sentEdit
  if (!edited.ok) console.log('  edit failed:', JSON.stringify(edited).slice(0, 160))
  await new Promise((r) => setTimeout(r, 1200))
  out.push(report('edit', sentEdit, editHttp))

  // 3) 插话（steer）
  const sentSteer = Date.now()
  const steered = await api('/api/queue', { method: 'POST', body: JSON.stringify({ sessionId, itemId: target.itemId, action: 'steer' }) })
  const steerHttp = Date.now() - sentSteer
  if (!steered.ok) console.log('  steer failed:', JSON.stringify(steered).slice(0, 160))
  await new Promise((r) => setTimeout(r, 1500))
  out.push(report('steer', sentSteer, steerHttp))

  polling = false
  await pumpTask.catch(() => {})
  await api('/api/cancel', { method: 'POST', body: JSON.stringify({ sessionId }) }).catch(() => {})
  await revoke()

  const worst = Math.max(...out.map((row) => (row.reflectMs < 0 ? 99999 : row.reflectMs)))
  const httpWorst = Math.max(...out.map((row) => row.httpMs))
  console.log(`WORST http=${httpWorst}ms reflect=${worst === 99999 ? 'N/A' : worst + 'ms'}`)
  console.log(worst < 3000 && httpWorst < 2000 ? 'QUEUE_LATENCY_OK' : 'QUEUE_LATENCY_SLOW')
}

main().catch((error) => {
  console.log('ERROR', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
