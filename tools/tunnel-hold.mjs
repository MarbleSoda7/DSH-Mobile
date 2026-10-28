// 常驻隧道：连真实服务器并把本机 7788 挂到公网端口，用来手工验证整条链路。
// 用法：node tools/tunnel-hold.mjs [秒数]   不给秒数就一直挂着。
import { readFileSync } from 'node:fs'
import { createTunnel } from '../lib/tunnel.js'

const idFile = 'C:/Users/29113/.dsh/dsh-mobile-remote/identity.json'
const id = JSON.parse(readFileSync(idFile, 'utf8'))
const holdMs = (Number(process.argv[2]) || 0) * 1000

const tunnel = createTunnel({ log: (...a) => console.log('[tunnel]', ...a) })
tunnel.start({
  host: id.serverHost || '8.152.5.127',
  port: id.serverPort || 7789,
  path: '/tunnel',
  dataPath: '/tunnel-data',
  token: id.token,
  publicPort: id.port,
  localPort: 7788,
})

console.log('[hold] 公网地址 http://8.152.5.127:' + id.port)

const finish = () => {
  console.log('[hold] status:', tunnel.status)
  tunnel.stop()
  process.exit(0)
}
if (holdMs > 0) setTimeout(finish, holdMs)
process.on('SIGINT', finish)
