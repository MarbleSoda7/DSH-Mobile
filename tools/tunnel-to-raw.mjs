// Connect to the real server but point the data channel at 7797 (raw TCP fake),
// so we can see the exact bytes the tunnel delivers.
import { readFileSync } from 'node:fs'
import { createTunnel } from '../lib/tunnel.js'

const idFile = 'C:/Users/29113/.dsh/dsh-mobile-remote/identity.json'
const id = JSON.parse(readFileSync(idFile, 'utf8'))
const holdMs = (Number(process.argv[2]) || 60) * 1000

const tunnel = createTunnel({ log: (...a) => console.log('[tunnel]', ...a) })
tunnel.start({
  host: id.serverHost || '8.152.5.127',
  port: id.serverPort || 7789,
  path: '/tunnel',
  dataPath: '/tunnel-data',
  token: id.token,
  publicPort: id.port,
  localPort: 7797,
})

console.log('[hold] public http://8.152.5.127:' + id.port + ' -> local 7797 raw')
setTimeout(() => {
  console.log('[hold] status:', tunnel.status)
  tunnel.stop()
  process.exit(0)
}, holdMs)
process.on('SIGINT', () => process.exit(0))
