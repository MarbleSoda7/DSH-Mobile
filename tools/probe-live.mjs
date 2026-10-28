// 用真实的 identity 连真实的公网服务器，确认内置隧道能不能打通。
import { readFileSync } from 'node:fs'
import { createTunnel } from '../lib/tunnel.js'

const idFile = 'C:/Users/29113/.dsh/dsh-mobile-remote/identity.json'
const id = JSON.parse(readFileSync(idFile, 'utf8'))
console.log('[probe] identity:', { port: id.port, serverHost: id.serverHost, token: id.token.slice(0, 8) + '...' })

const tunnel = createTunnel({ log: (...a) => console.log('[cli]', ...a) })
tunnel.start({
  host: id.serverHost || '8.152.5.127',
  port: id.serverPort || 7789,
  path: '/tunnel',
  dataPath: '/tunnel-data',
  token: id.token,
  publicPort: id.port,
  localPort: 7788,
})

await new Promise((r) => setTimeout(r, 5000))
console.log('[probe] status:', tunnel.status)
tunnel.stop()
process.exit(0)
