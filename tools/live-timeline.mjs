// 真机链路实测：模拟手机（配对 → 新会话 → 发送 → 长轮询收事件 → 撤销）。
// 用法：node tools/live-timeline.mjs [base]

const base = process.argv[2] || 'http://127.0.0.1:7788'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(path, options = {}, token) {
  const headers = { ...(options.headers || {}) }
  if (token) headers.authorization = `Bearer ${token}`
  if (options.body) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, { ...options, headers })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, json, text }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : ' -> ' + detail))
}

const health = await call('/api/health')
console.log(`宿主 rev=${health.json?.rev}`)

// 1) 扫码换 token
const code = await call('/api/paircode')
if (code.status !== 200) {
  console.error('拿不到配对码（插件没在跑？）: ' + code.text.slice(0, 200))
  process.exit(1)
}
const paired = await call('/api/pair', { method: 'POST', body: JSON.stringify({ code: code.json.code, name: 'live-timeline' }) })
check('配对拿到 token', paired.status === 200 && Boolean(paired.json?.token), paired.text.slice(0, 200))
const token = paired.json.token
const deviceId = paired.json.deviceId

try {
  // 2) 建一个干净会话
  const created = await call('/api/session', { method: 'POST', body: JSON.stringify({}) }, token)
  const sessionId = created.json?.sessionId || created.json?.session?.sessionId
  check('新建会话', created.status === 200 && Boolean(sessionId), created.text.slice(0, 240))
  if (!sessionId) throw new Error('没有 sessionId')

  // 3) 聚焦 + 发送
  await call('/api/focus', { method: 'POST', body: JSON.stringify({ sessionId }) }, token)
  const cursor = { [sessionId]: 0 }
  const sent = await call('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, text: '请只回复两个字母：OK', mode: 'queue' }) }, token)
  check('发送消息被接受', sent.status === 200 && sent.json?.ok === true, sent.text.slice(0, 240))

  // 4) 长轮询收事件（最多 45 秒）
  const seen = new Map()
  let turns = 0
  let ended = false
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && !ended) {
    const url = '/api/poll?k=' + encodeURIComponent(token) + '&c=' + Buffer.from(JSON.stringify(cursor)).toString('base64url')
    const polled = await call(url)
    if (polled.status === 401) {
      check('长轮询认证', false, '401')
      break
    }
    for (const frame of polled.json?.frames || []) {
      if (frame.type === 'event') {
        const event = frame.payload
        if (event.sessionId !== sessionId) continue
        seen.set(event.type, (seen.get(event.type) || 0) + 1)
        if (typeof event.seq === 'number') cursor[sessionId] = Math.max(cursor[sessionId] || 0, event.seq)
        if (event.type === 'turn/start') turns += 1
        if (event.type === 'turn/end') ended = true
      }
      if (frame.type === 'delta' && frame.payload.sessionId === sessionId) seen.set('delta', (seen.get('delta') || 0) + 1)
    }
  }

  check('收到 user/message 回显', (seen.get('user/message') || 0) >= 1, JSON.stringify([...seen]))
  check('收到本轮结束 turn/end', ended, JSON.stringify([...seen]))
  check('收到流式 delta 或正文', (seen.get('delta') || 0) + (seen.get('assistant/message') || 0) > 0, JSON.stringify([...seen]))

  // 5) 历史里"我"发的消息必须能按需拉到（扁平 content 结构）
  const page = await call(`/api/session/${sessionId}/page?limit=8`, {}, token)
  const mine = (page.json?.events || []).filter((event) => event.type === 'user/message')
  check('历史分页含我发的消息', mine.length >= 1, JSON.stringify(page.json?.events?.map((event) => event.type)))
  check('历史消息带文本内容', mine.length > 0 && Array.isArray(mine[0].data?.content) && mine[0].data.content.some((block) => block.type === 'text' && block.text), JSON.stringify(mine[0]?.data)?.slice(0, 200))

  // 6) 首连只同步列表：新游标（空）连接 SSE 时不该收到历史事件
  // 用流式读取拿首批数据：fetch().text() 会在 abort 时整体丢弃，测不出"有没有回放"。
  const controller = new AbortController()
  const sse = await fetch(base + '/api/events?k=' + encodeURIComponent(token) + '&c=' + Buffer.from('{}').toString('base64url'), { signal: controller.signal })
  let body = ''
  if (sse.body) {
    const reader = sse.body.getReader()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        body += Buffer.from(value).toString('utf8')
        if (body.includes('\n\n') && body.split('\n\n').length > 3) break
      }
    } catch {}
    clearTimeout(timer)
  }
  controller.abort()
  const eventFrames = (body.match(/^event: event$/gm) || []).length
  check('首连不回放历史事件', eventFrames === 0, `event frames=${eventFrames}`)
  check('首连仍收到 hello', body.includes('event: hello'), body.slice(0, 120))
} catch (error) {
  check('链路异常', false, String(error && error.message))
} finally {
  // 7) 撤销测试设备，不污染设备表
  const revoked = await call('/api/devices/revoke', { method: 'POST', body: JSON.stringify({ id: deviceId }) }, token)
  check('撤销测试设备', revoked.status === 200, revoked.text.slice(0, 120))
}

const failed = results.filter((item) => !item.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
