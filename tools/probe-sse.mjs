// 端到端验证公网 SSE：先配对拿 token，再开 /api/events 看能否收到 hello。
import { request } from 'node:http'

const BASE = process.env.BASE || 'http://8.152.5.127:9000'
const LOCAL = 'http://127.0.0.1:7788'

const get = (url, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = request(url, opts, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end(opts.body || undefined)
  })

const main = async () => {
  const pc = await get(`${LOCAL}/api/paircode`)
  const code = JSON.parse(pc.body).code
  console.log('[probe] paircode ok')

  const pairBody = JSON.stringify({ code, name: 'e2e-probe' })
  const pair = await get(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(pairBody) },
    body: pairBody,
  })
  console.log('[probe] pair status', pair.status)
  if (pair.status !== 200) {
    console.log('[probe] pair body', pair.body)
    process.exit(1)
  }
  const token = JSON.parse(pair.body).token
  console.log('[probe] got token')

  // 开 SSE
  let got = false
  const req = request(
    { host: '8.152.5.127', port: 9000, path: `/api/events?k=${token}`, method: 'GET' },
    (res) => {
      console.log('[probe] sse status', res.statusCode)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        const head = chunk.slice(0, 200).replace(/\n/g, ' | ')
        console.log('[probe] sse chunk:', head)
        if (chunk.includes('hello')) {
          got = true
          res.destroy()
          console.log('[probe] RESULT: SSE hello OK')
          process.exit(0)
        }
      })
    },
  )
  req.on('error', (e) => console.log('[probe] sse error', e.message))
  req.end()

  setTimeout(() => {
    console.log(got ? '[probe] ok' : '[probe] RESULT: no hello in 15s')
    process.exit(got ? 0 : 1)
  }, 15000)
}

main().catch((e) => {
  console.log('[probe] fatal', e.message)
  process.exit(1)
})
