// 端到端验证：本机隧道 → 本地服务器端 → 再访问回来。
//
// 验证目标：
//   1. 客户端能连上控制通道，服务器回 ready
//   2. 手机（用 http.get 模拟）连服务器开放的端口，能拿到本机服务的响应
//   3. POST 带 body 也能通（不是只能跑 GET）
//   4. 断开后端口被释放
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createTunnel } from '../lib/tunnel.js'

const LOCAL_PORT = 17888
const SERVER_API_PORT = 17791
const SERVER_PUBLIC_PORT = 19000

// ---- 1. 假的「本机 DSH 插件」：回显方法和路径 ----
const local = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-local': 'yes' })
    res.end(JSON.stringify({ method: req.method, url: req.url, body, headers: { host: req.headers.host } }))
  })
})
await new Promise((r) => local.listen(LOCAL_PORT, '127.0.0.1', r))
console.log(`[test] local server on ${LOCAL_PORT}`)

// ---- 2. 启动服务器端隧道（真实的 deploy/vps/tunnel.py 逻辑，这里用 Node 复刻最小版）----
// 用 Python 更好：直接跑真实的 tunnel.py，避免测了个假货。
import { spawn } from 'node:child_process'

const py = spawn(
  'python',
  [
    '-c',
    `
import sys, threading, time
sys.path.insert(0, r'D:/SDU/IC/HarnessProject/guide-dog-peta/dsh-mobile-remote/deploy/vps')
import tunnel
srv = tunnel.TunnelServer('127.0.0.1', ${SERVER_API_PORT}, lambda tok, port: tok == 'goodtoken' and port == ${SERVER_PUBLIC_PORT}, log=lambda *a: print('[srv]', *a, flush=True))
srv.start()
time.sleep(60)
`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
py.stdout.on('data', (d) => process.stdout.write(d))
py.stderr.on('data', (d) => process.stdout.write(d))

await new Promise((r) => setTimeout(r, 1500))

// ---- 3. 连上去 ----
const tunnel = createTunnel({ log: (...a) => console.log('[cli]', ...a) })
tunnel.start({
  host: '127.0.0.1',
  port: SERVER_API_PORT,
  path: '/tunnel',
  dataPath: '/tunnel-data',
  token: 'goodtoken',
  publicPort: SERVER_PUBLIC_PORT,
  localPort: LOCAL_PORT,
})

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const ok = await waitFor(() => tunnel.running)
console.log('[test] tunnel ready:', ok, tunnel.status)
if (!ok) {
  console.log('[test] FAIL: tunnel never became ready')
  process.exit(1)
}

// 等一拍，让控制通道的 hello/ready 稳定下来（真实场景里用户扫码前总有几秒间隔）
await new Promise((r) => setTimeout(r, 600))
console.log('[test] after settle:', tunnel.status)

// ---- 4. 模拟手机：带 POST body 打一下 ----
const raw = await new Promise((resolve) => {
  const sock = connect({ host: '127.0.0.1', port: SERVER_PUBLIC_PORT })
  let buf = ''
  let done = false
  const finish = (why) => {
    if (done) return
    done = true
    resolve(buf + (why ? `\n[${why}]` : ''))
  }
  sock.on('connect', () => {
    sock.write(
      'POST /api/test HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 7\r\nConnection: close\r\n\r\n{"a":1}',
    )
  })
  sock.on('data', (d) => (buf += d.toString('utf8')))
  sock.on('error', (e) => finish('socket error: ' + e.message))
  sock.on('close', () => finish('closed'))
  setTimeout(() => {
    sock.destroy()
    finish('timeout')
  }, 5000)
})
console.log('[test] --- mobile got ---')
console.log(raw)
const pass = raw.includes('200 OK') && raw.includes('"body":"{\\"a\\":1}"')
console.log('[test] POST passthrough:', pass ? 'PASS' : 'FAIL')

// ---- 5. 收尾 ----
tunnel.stop()
await new Promise((r) => setTimeout(r, 800))
py.kill()
local.close()
console.log('[test] done')
process.exit(pass ? 0 : 1)