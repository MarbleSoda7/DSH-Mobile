// 验归档过滤：/api/state 不该把电脑上已归档的会话发给手机。
import http from 'node:http'

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
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
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

const code = await request('GET', '/api/paircode')
if (code.status !== 200) throw new Error(`paircode ${code.status}`)
const paired = await request('POST', '/api/pair', { body: { code: code.json.code, name: 'archive-probe' } })
if (paired.status !== 200) throw new Error(`pair ${paired.status} ${paired.text}`)
const token = paired.json.token

const state = await request('GET', '/api/state', { token })
if (state.status !== 200) throw new Error(`state ${state.status}`)
const { sessions, hiddenBlank, hiddenArchived } = state.json
let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${extra ? ' -> ' + extra : ''}`)
  if (!ok) failed += 1
}
check(Array.isArray(sessions), 'sessions 是数组')
check(typeof hiddenArchived === 'number', '返回 hiddenArchived 字段', String(hiddenArchived))
check(typeof hiddenBlank === 'number', '返回 hiddenBlank 字段', String(hiddenBlank))
check(sessions.every((row) => row.id), '每个会话都有 id')
check(sessions.every((row) => row.blank !== true), '列表里没有空白会话')

// 归档集合是 registry 全局的，若宿主里有归档会话，列表里就不该出现它们。
const registryArchived = process.env.MR_ARCHIVED ? process.env.MR_ARCHIVED.split(',') : []
if (registryArchived.length > 0) {
  const leaked = sessions.filter((row) => registryArchived.includes(row.id))
  check(leaked.length === 0, '归档会话没有出现在列表里', leaked.map((r) => r.id).join(','))
} else {
  console.log('  skip 未提供 MR_ARCHIVED，跳过"归档不泄漏"断言')
}

await request('POST', '/api/devices/revoke', { token, body: { id: paired.json.deviceId } })
console.log(`\n${failed === 0 ? 'ARCHIVE_STATE_OK' : 'ARCHIVE_STATE_FAILED'} sessions=${sessions.length} hiddenArchived=${hiddenArchived}`)
process.exit(failed === 0 ? 0 : 1)
