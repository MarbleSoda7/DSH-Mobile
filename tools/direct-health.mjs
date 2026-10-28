// 从本机直接打一条 HTTP 请求到插件（绕过隧道），确认插件本身没问题。
import { request } from 'node:http'

const req = request({ host: '127.0.0.1', port: 7788, path: '/api/health', method: 'GET' }, (res) => {
  console.log('[direct] status', res.statusCode, res.headers)
  let body = ''
  res.on('data', (c) => (body += c))
  res.on('end', () => console.log('[direct] body', body))
})
req.on('error', (e) => console.log('[direct] error', e.message))
req.end()
