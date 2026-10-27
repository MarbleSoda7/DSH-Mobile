// 手机端全链路模拟（经 Cloudflare 隧道，等价于手机浏览器会走的路径）
// 用法：node tools/phone-sim.mjs [sessionId]
// 说明：配对码通过本机回环获取（等价于电脑屏幕上的二维码），
//      其余请求全部打隧道公网地址，模拟手机的网络位置。

const LOCAL = 'http://127.0.0.1:7788'
const TUNNEL = (process.env.TUNNEL_URL || '').trim()

const log = (...args) => console.log(...args)
let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function main() {
  if (!TUNNEL) throw new Error('need TUNNEL_URL')
  const base = TUNNEL.replace(/\/+$/, '')

  // 1) 隧道上的健康检查
  const t0 = Date.now()
  const health = await (await fetch(`${base}/api/health`)).json()
  check('tunnel /api/health', health.ok === true, `${Date.now() - t0}ms devices=${health.devices}`)

  // 2) 电脑侧取配对码（模拟屏幕上的二维码参数）
  const pc = await (await fetch(`${LOCAL}/api/paircode`)).json()
  check('local /api/paircode', pc.ok === true && typeof pc.code === 'string', pc.code ? 'code=' + pc.code.slice(0, 6) + '…' : '')
  check('paircode url points at tunnel', String(pc.url).startsWith(base), pc.url)

  // 3) 手机侧配对（经隧道）
  const paired = await (await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pc.code, name: 'sim-phone' })
  })).json()
  check('tunnel /api/pair', paired.ok === true && typeof paired.token === 'string', 'deviceId=' + String(paired.deviceId).slice(0, 8))
  const auth = { authorization: `Bearer ${paired.token}` }

  // 4) 会话列表
  const state = await (await fetch(`${base}/api/state`, { headers: auth })).json()
  const sessions = state.sessions || []
  check('tunnel /api/state', Array.isArray(sessions) && sessions.length > 0, `sessions=${sessions.length}`)
  check('state has title+model', sessions.some((s) => s.title && s.model), JSON.stringify(sessions[0]?.model || null))

  // 5) 模型目录
  const cat = await (await fetch(`${base}/api/catalog`, { headers: auth })).json()
  const groups = cat.catalog?.groups || []
  check('tunnel /api/catalog', groups.length > 0, `providers=${groups.length}`)
  const efforts = groups.flatMap((g) => g.models || []).flatMap((m) => m.reasoning?.efforts || [])
  check('catalog exposes reasoning efforts', efforts.length > 0, `efforts=${efforts.length}`)

  // 6) 历史分页（经隧道）
  const target = process.argv[2] || sessions[0]?.id
  const page = await (await fetch(`${base}/api/session/${encodeURIComponent(target)}/page?limit=3`, { headers: auth })).json()
  const events = page.events || []
  check('tunnel /page', page.ok === true && events.length > 0, `events=${events.length} latestSeq=${page.latestSeq}`)
  const types = [...new Set(events.map((e) => e.type))]
  check('page has no debug noise', !types.some((t) => t.startsWith('session-log') || t === 'step/start'), types.join(','))

  // 7) 建立实时通道
  const focusRes = await (await fetch(`${base}/api/focus`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: target, focus: true })
  })).json()
  check('tunnel /api/focus', focusRes.ok === true)

  const cursor = encodeURIComponent(Buffer.from(JSON.stringify({ [target]: page.latestSeq || 0 })).toString('base64url'))
  const t1 = Date.now()
  const pollRes = await fetch(`${base}/api/poll?c=${cursor}`, { headers: auth })
  const poll = await pollRes.json()
  check('tunnel /api/poll', poll.ok === true, `${Date.now() - t1}ms frames=${(poll.frames || []).length}`)
  check('poll returns cursor', !!poll.cursor, JSON.stringify(poll.cursor || {}))
  const returned = Number(poll.cursor?.[target] ?? -1)
  check('cursor never moves backwards', returned >= (page.latestSeq || 0), `client=${page.latestSeq} server=${returned}`)

  // 8) 撤销这台模拟设备
  const revoked = await (await fetch(`${LOCAL}/api/devices/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: paired.deviceId })
  })).json()
  check('revoke sim device', revoked.ok === true)

  log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('sim error:', err.message)
  process.exit(1)
})
