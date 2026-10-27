// Diagnostic only: measure whether Cloudflare quick tunnels forward a chunked
// response for different Content-Type values. Writes a line every 500 ms.
import { createServer } from 'node:http'

function stream(res, contentType) {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  let i = 0
  const timer = setInterval(() => {
    i += 1
    res.write(`chunk ${i} ${'x'.repeat(40)}\n`)
    if (i >= 40) {
      clearInterval(timer)
      res.end()
    }
  }, 500)
  timer.unref?.()
  res.on('close', () => clearInterval(timer))
}

createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/a')) return stream(res, 'text/event-stream; charset=utf-8')
  if (url.startsWith('/b')) return stream(res, 'application/octet-stream')
  if (url.startsWith('/c')) return stream(res, 'text/plain; charset=utf-8')
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('nope')
}).listen(7799, '127.0.0.1', () => console.log('probe listening on 127.0.0.1:7799'))
