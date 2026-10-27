// 验证：宿主注入的环境快照（runtime-context / time-context）不再下发给手机。
// 用法：node tools/verify-sysdrop.mjs [端口]
import http from 'node:http'

const port = Number(process.argv[2] || 7788)

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'content-type': 'application/json' }
    if (data) headers['content-length'] = Buffer.byteLength(data)
    if (token) headers.authorization = 'Bearer ' + token
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 20000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ code: res.statusCode, text, json })
      })
    })
    r.on('error', (e) => resolve({ code: 0, text: String(e.message) }))
    r.on('timeout', () => {
      r.destroy()
      resolve({ code: 0, text: 'timeout' })
    })
    if (data) r.write(data)
    r.end()
  })
}

function sourceKind(event) {
  const data = (event && event.data) || {}
  const message = data.message || data
  return (message && message.source && message.source.kind) || '-'
}

const health = await req('GET', '/api/health')
console.log('health:', health.text)

const paircode = await req('GET', '/api/paircode')
const code = (paircode.json && paircode.json.code) || ''
const pair = await req('POST', '/api/pair', { code, name: 'verify-sysdrop' })
const token = pair.json && pair.json.token
if (!token) {
  console.log('配对失败:', pair.text)
  process.exit(1)
}

const state = await req('GET', '/api/state', null, token)
const sessions = (state.json && state.json.sessions) || []
const target = sessions.find((s) => String(s.title || '').includes('测试')) || sessions[0]
console.log('会话:', target && target.id, target && target.title)

const page = await req('GET', `/api/session/${encodeURIComponent(target.id)}/page?limit=8`, null, token)
const events = (page.json && page.json.events) || []
const kinds = events.map((e) => `${e.seq}:${e.type}:${sourceKind(e)}`)
console.log('events:', kinds.join(', '))
const leaked = kinds.filter((k) => /runtime-context|time-context|environment-context/.test(k))
console.log(leaked.length === 0 ? 'PASS 环境快照未下发' : 'FAIL 仍有环境快照: ' + leaked.join(', '))

await req('POST', '/api/devices/revoke', { id: pair.json.deviceId }, token)
process.exit(leaked.length === 0 ? 0 : 1)
