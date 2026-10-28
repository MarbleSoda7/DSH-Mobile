// 裸 TCP 假服务：把隧道送来的原始字节一字节不差地打出来，不做 HTTP 解析。
import { createServer } from 'node:net'

const srv = createServer((sock) => {
  console.log('[raw] ---- new connection ----')
  sock.on('data', (buf) => {
    console.log('[raw] receive', buf.length, 'bytes:')
    console.log(JSON.stringify(buf.toString('latin1')))
    // 原样回一个最小响应，证明回程通路也通
    if (buf.toString('latin1').includes('\r\n\r\n')) {
      const body = '{"ok":true}'
      sock.write(
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ' +
          body.length +
          '\r\nconnection: close\r\n\r\n' +
          body,
      )
    }
  })
  sock.on('error', (e) => console.log('[raw] error', e.message))
  sock.on('close', () => console.log('[raw] closed'))
})
srv.listen(7797, '127.0.0.1', () => console.log('[raw] listening 7797'))
