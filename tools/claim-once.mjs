// 让本机重新向服务器申请一次身份/端口，并把结果写回 identity.json。
// 只在服务器台账被清过、或端口需要重新分配时手动跑一次。
import { readFileSync, writeFileSync } from 'node:fs'

const idFile = 'C:/Users/29113/.dsh/dsh-mobile-remote/identity.json'
const id = JSON.parse(readFileSync(idFile, 'utf8'))
const apiBase = 'http://8.152.5.127:7789'

const res = await fetch(`${apiBase}/api/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId: id.deviceId, secret: id.secret, owner: '' }),
})
const data = await res.json()
console.log('[claim]', JSON.stringify(data))
if (!data.ok) process.exit(1)

const next = {
  ...id,
  deviceId: data.deviceId,
  secret: data.secret || id.secret,
  token: data.token,
  port: data.port,
  publicUrl: data.url,
  serverHost: '8.152.5.127',
  serverPort: 7789,
}
writeFileSync(idFile, JSON.stringify(next, null, 2))
console.log('[saved]', { port: next.port, url: next.publicUrl })
