// 从服务器回环地址过一遍隧道，并把原始响应头打全（含 status line 之外的一切）。
import { readFileSync } from 'node:fs'
import { createTunnel } from '../lib/tunnel.js'
import { request as httpRequest } from 'node:http'

const idFile = 'C:/Users/29113/.dsh/dsh-mobile-remote/identity.json'
const id = JSON.parse(readFileSync(idFile, 'utf8'))

// 本机隧道：把公网 9000 连到 7788，再在服务器上用 curl 打
const tunnel = createTunnel({ log: (...a) => console.log('[tunnel]', ...a) })
tunnel.start({
  host: id.serverHost,
  port: id.serverPort || 7789,
  path: '/tunnel',
  dataPath: '/tunnel-data',
  token: id.token,
  publicPort: id.port,
  localPort: 7788,
})

// 等服务端就绪后，从本机 9000 打一条（本机连 9000 也走服务器，能验证整条链路）
setTimeout(() => {
  console.log('[probe] state', tunnel.status)
  const req = httpRequest(
    { host: '8.152.5.127', port: 9000, path: '/api/health', method: 'GET', timeout: 10000 },
    (res) => {
      console.log('[probe] status', res.statusCode, JSON.stringify(res.headers))
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        console.log('[probe] body', body)
        tunnel.stop()
        process.exit(0)
      })
    },
  )
  req.on('error', (e) => {
    console.log('[probe] error', e.message)
    tunnel.stop()
    process.exit(1)
  })
  req.end()
}, 6000)

setTimeout(() => process.exit(2), 30000)
