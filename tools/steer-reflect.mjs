// 量"电脑端插话 → 手机端看到气泡"的真实链路延迟。
// 关键：pump 必须常驻（手机就是这样），且严格记录每一帧的到达时刻。
const PAIR_BASE = process.env.MR_PAIR_BASE || 'http://127.0.0.1:7788'
const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'

async function main() {
  const codeData = await (await fetch(`${PAIR_BASE}/api/paircode`)).json()
  const paired = await (await fetch(`${PAIR_BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeData.code, name: 'steer-reflect' }),
  })).json()
  if (!paired.ok) throw new Error('pair failed ' + JSON.stringify(paired))
  const token = paired.token
  const deviceId = paired.deviceId

  const api = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    })
    return res.json()
  }

  const created = await api('/api/session', { method: 'POST', body: JSON.stringify({}) })
  const sessionId = created.sessionId
  await api('/api/model', { method: 'POST', body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningLow: true, reasoningEffort: 'low' }) })
  await api('/api/focus', { method: 'POST', body: JSON.stringify({ sessionId }) })

  let cursor = {}
  let polling = true
  const t0 = Date.now()
  const frames = []
  const label = (frame) => {
    if (frame.type === 'steer') return 'STEER ' + JSON.stringify(frame.payload.text)
    if (frame.type === 'queue') return 'queue ' + JSON.stringify(frame.payload.items.map((i) => i.text))
    if (frame.type === 'event') return 'event ' + frame.payload.type
    return frame.type
  }
  const pump = async () => {
    while (polling) {
      try {
        const url = `${BASE}/api/poll?k=${encodeURIComponent(token)}&c=${encodeURIComponent(Buffer.from(JSON.stringify(cursor)).toString('base64url'))}`
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) { frames.push({ at: Date.now() - t0, kind: 'HTTP_' + res.status }); break }
        const data = await res.json()
        const at = Date.now() - t0
        for (const frame of [...(data.queueSync || []), ...(data.frames || [])]) {
          if (frame.payload?.sessionId && frame.payload.sessionId !== sessionId) continue
          frames.push({ at, kind: label(frame) })
          if (frame.type === 'event' && typeof frame.payload?.seq === 'number') {
            cursor[frame.payload.sessionId] = Math.max(cursor[frame.payload.sessionId] || 0, frame.payload.seq)
          }
        }
      } catch (error) {
        frames.push({ at: Date.now() - t0, kind: 'ERR ' + error.message })
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }
  pump()

  await api('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, mode: 'queue', text: '请从 1 慢慢数到 200，每行一个数字，数完再停。' }) })
  await new Promise((r) => setTimeout(r, 2500))

  const tSteer = Date.now() - t0
  await api('/api/redirect', { method: 'POST', body: JSON.stringify({ sessionId, text: '插话：别数了，只回复 STEER-SEEN' }) })
  const httpDone = Date.now() - t0
  await new Promise((r) => setTimeout(r, 6000))

  polling = false
  await api('/api/cancel', { method: 'POST', body: JSON.stringify({ sessionId }) }).catch(() => {})
  await api('/api/devices/revoke', { method: 'POST', body: JSON.stringify({ id: deviceId }) }).catch(() => {})

  console.log('\nframes around the steer:')
  for (const f of frames) {
    if (f.at < tSteer - 4000) continue
    const mark = f.at >= tSteer ? ' <<< after steer' : ''
    console.log(`  ${String(f.at).padStart(6)}ms  ${f.kind}${mark}`)
  }
  const steerFrames = frames.filter((f) => f.kind.startsWith('STEER') && f.at >= tSteer)
  const userMsg = frames.find((f) => f.kind === 'event user/message' && f.at >= tSteer)
  console.log('\nsteer POST returned at   ' + httpDone + 'ms')
  console.log('steer bubble frame at    ' + (steerFrames[0] ? steerFrames[0].at + 'ms (+' + (steerFrames[0].at - tSteer) + 'ms)' : 'NOT RECEIVED'))
  console.log('real user/message at     ' + (userMsg ? userMsg.at + 'ms (+' + (userMsg.at - tSteer) + 'ms)' : 'not in window'))
  const ok = steerFrames.length > 0 && steerFrames[0].at - tSteer < 1500
  console.log(ok ? 'STEER_REFLECT_OK' : 'STEER_REFLECT_SLOW')
  process.exit(ok ? 0 : 1)
}

main().catch((error) => { console.error('FAILED', error); process.exit(2) })
