/* 真机链路回归：手机连续发两条「排队」消息，两条都必须真的被执行。
 *
 * 用户报过的问题（m07884）：
 *   「排队队列消失了，手机发送排队信息会直接消失吞掉，电脑不同步」
 * 现象是第一条消息把一轮跑起来、第二条作为排队进 inbox，然后……就没有然后了。
 * 这个脚本不测 UI，只测宿主/服务端链路：
 *   1. 用回环权限配对一台临时设备；
 *   2. 把临时会话的模型固定成 ds/deepseek-v4.1-flash（凭据稳定，不会 AUTH 401 秒失败）；
 *   3. 发第一条（起一轮），1 秒后发第二条（必然进排队）；
 *   4. 轮询会话历史，直到看到第二条的**回复**。
 *
 * 用法：node tools/queue-e2e.mjs
 * 退出码 0 表示两条都被处理（QUEUE_PROCESSED_OK）。
 */

const LOOPBACK = process.env.MR_PAIR_BASE || 'http://127.0.0.1:7788'
const BASE = process.env.MR_BASE || LOOPBACK

async function call(path, options = {}) {
  const response = await fetch(BASE + path, options)
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

async function main() {
  const code = await call('/api/paircode')
  if (!code.body || !code.body.code) throw new Error('拿不到配对码：' + JSON.stringify(code.body))
  const pairResponse = await fetch(LOOPBACK + '/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.body.code, name: 'queue-e2e' }),
  })
  const pair = await pairResponse.json()
  if (!pair.token) throw new Error('配对失败：' + JSON.stringify(pair))

  const headers = { authorization: 'Bearer ' + pair.token, 'content-type': 'application/json' }
  const created = await call('/api/session', { method: 'POST', headers, body: JSON.stringify({}) })
  const sessionId = created.body.sessionId
  if (!sessionId) throw new Error('建会话失败：' + JSON.stringify(created.body))

  await call('/api/model', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, provider: 'ds', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
  })
  await call('/api/focus', { method: 'POST', headers, body: JSON.stringify({ sessionId }) })

  const started = Date.now()
  const log = (...args) => console.log(String(Date.now() - started).padStart(6) + 'ms', ...args)

  await call('/api/prompt', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, text: '只回复 READY', mode: 'queue' }),
  })
  log('first prompt sent')
  await new Promise((resolve) => setTimeout(resolve, 900))
  const second = await call('/api/prompt', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, text: '第二句：回复 SECOND-OK', mode: 'queue' }),
  })
  log('second prompt queued', second.status)

  let sawReply = false
  for (let i = 0; i < 45; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const page = await call('/api/session/' + encodeURIComponent(sessionId) + '/page?limit=12', { headers })
    const events = (page.body && page.body.events) || []
    const replies = events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => {
        const blocks = (event.data && event.data.message && event.data.message.content) || []
        return blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join(' ')
      })
    if (replies.some((text) => text.includes('SECOND-OK'))) {
      sawReply = true
      log('SECOND-OK 收到回复，用时约', i * 2, '秒')
      break
    }
    if (i % 5 === 0) {
      const users = events.filter((event) => event.type === 'user/message').length
      log('waiting', 'userMessages=' + users, 'replies=' + replies.length)
    }
  }

  log('RESULT', sawReply ? 'QUEUE_PROCESSED_OK' : 'QUEUE_SWALLOWED')
  await call('/api/devices/revoke', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: pair.deviceId }),
  })
  process.exit(sawReply ? 0 : 1)
}

main().catch((error) => {
  console.error('queue-e2e failed:', error && error.message)
  process.exit(1)
})
