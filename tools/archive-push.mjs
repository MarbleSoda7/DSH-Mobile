// 验证「会话集合版本号」这条通路：
//   /api/state 与 /api/poll 都必须带 sessionsRev（客户端靠它发现"列表/归档集合变了"）。
// 真正的归档动作只能在电脑端 UI 里点，所以"归档集合变化 → 广播"的逻辑放在
// tools/smoke.mjs 里用假 registry 断言（那边能直接改 archivedSessionIds）。
import http from 'node:http'
import zlib from 'node:zlib'

const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const raw = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf) : buf
          const text = raw.toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${extra ? ' -> ' + extra : ''}`)
  if (!ok) failed += 1
}

const code = await request('GET', '/api/paircode')
const paired = await request('POST', '/api/pair', { body: { code: code.json.code, name: 'archive-rev' } })
const token = paired.json.token

const state = await request('GET', '/api/state', { token })
check(state.status === 200, '/api/state 200', String(state.status))
check(typeof state.json?.sessionsRev === 'number', '/api/state 带 sessionsRev', String(state.json?.sessionsRev))
check(typeof state.json?.hiddenArchived === 'number', '/api/state 带 hiddenArchived', String(state.json?.hiddenArchived))

const poll = await request('GET', '/api/poll?c=', { token })
check(poll.status === 200, '/api/poll 200', String(poll.status))
check(typeof poll.json?.sessionsRev === 'number', '/api/poll 带 sessionsRev', String(poll.json?.sessionsRev))
check(
  (poll.json?.sessionsRev || 0) === (state.json?.sessionsRev || 0),
  '两个接口的 sessionsRev 一致',
  `${poll.json?.sessionsRev} vs ${state.json?.sessionsRev}`,
)

await request('POST', '/api/devices/revoke', { token, body: { id: paired.json.deviceId } })
console.log(`\n${failed === 0 ? 'SESSIONS_REV_OK' : 'SESSIONS_REV_FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
