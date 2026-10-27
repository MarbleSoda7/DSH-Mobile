// 公网 IP 直连验收：确认手机经 http://8.152.5.127:7788 能拿外壳、
// 能收实时事件（长轮询 + SSE 两条通道），并且 /admin 不对公网开放。
const BASE = process.env.MR_BASE || 'http://8.152.5.127:7788'
const PAIR_BASE = process.env.MR_PAIR_BASE || 'http://127.0.0.1:7788'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' :: ' + detail : ''}`)
}

async function json(url, options = {}, body = null) {
  const response = await fetch(url, { ...options, body })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: response.status, json: parsed, text }
}

// 1) 公网外壳
const home = await fetch(`${BASE}/`)
const homeText = await home.text()
check('公网首页 200', home.status === 200, `status=${home.status} bytes=${homeText.length}`)
check('外壳引用带版本号（缓存穿透）', /app\.js\?v=/.test(homeText))
check('外壳引用的样式也在', /style\.css\?v=/.test(homeText))

// 2) 公网不应暴露配对页
const admin = await fetch(`${BASE}/admin`)
check('公网 /admin 被拒绝（403）', admin.status === 403, `status=${admin.status}`)
const paircode = await fetch(`${BASE}/api/paircode`)
check('公网 /api/paircode 被拒绝（403）', paircode.status === 403, `status=${paircode.status}`)

// 3) 本机配对拿 token
const code = await json(`${PAIR_BASE}/api/paircode`)
const pair = await json(`${PAIR_BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ code: code.json.code, name: 'public-probe' }))
check('本机配对成功', pair.status === 200 && !!pair.json?.token)
const auth = { authorization: `Bearer ${pair.json.token}` }

// 4) 公网带上 token 能读业务数据
const state = await json(`${BASE}/api/state`, { headers: auth })
check('公网 /api/state 200 且有会话', state.status === 200 && (state.json?.sessions || []).length > 0, `status=${state.status} count=${state.json?.sessions?.length}`)

// 5) 公网长轮询：先拿一次游标，再挂一个空轮询，确认能挂住并返回 frames 字段
const first = await json(`${BASE}/api/poll?c=`, { headers: auth })
check('公网长轮询 200 且带 frames', first.status === 200 && Array.isArray(first.json?.frames), `status=${first.status} frames=${first.json?.frames?.length}`)
const cursor = encodeURIComponent(Buffer.from(JSON.stringify(first.json?.cursor || {})).toString('base64url'))
const startedAt = Date.now()
const hold = await json(`${BASE}/api/poll?c=${cursor}`, { headers: auth })
const heldMs = Date.now() - startedAt
check('公网长轮询能挂住（>3s）或立刻有数据', hold.status === 200 && (heldMs > 3000 || (hold.json?.frames || []).length > 0), `held=${heldMs}ms frames=${hold.json?.frames?.length}`)

// 6) 公网 SSE：明文直连没有 Cloudflare 缓冲，应该能收到 hello 首帧
const sseAbort = new AbortController()
let sseHead = ''
try {
  const response = await fetch(`${BASE}/api/events?${new URLSearchParams({ k: pair.json.token, c: cursor })}`, { signal: sseAbort.signal })
  check('公网 SSE 200', response.status === 200, `status=${response.status} type=${response.headers.get('content-type')}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !sseHead.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    sseHead += decoder.decode(value, { stream: true })
  }
} catch (error) {
  if (error.name !== 'AbortError') check('公网 SSE 200', false, String(error.message))
} finally {
  sseAbort.abort()
}
check('公网 SSE 收到 hello 首帧', sseHead.includes('event: hello'), JSON.stringify(sseHead.slice(0, 120)))

// 7) 公网附件路由需要认证（不能匿名拉图）
const anonAttachment = await fetch(`${BASE}/api/attachment/${'a'.repeat(64)}`)
check('公网 /api/attachment 未认证被拒（401）', anonAttachment.status === 401, `status=${anonAttachment.status}`)

await json(`${BASE}/api/devices/revoke`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' } }, JSON.stringify({ id: pair.json.deviceId }))

const failed = results.filter((row) => !row.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
