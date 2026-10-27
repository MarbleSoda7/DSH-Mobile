// 排查：电脑端「插话」进来的消息，手机端能不能看到（是否有对应事件）
// 用法：node tools/steer-audit.mjs <sessionId>
const BASE = 'http://127.0.0.1:7788'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('用法: node tools/steer-audit.mjs <sessionId>')
  process.exit(1)
}

async function json(path, init) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`)
  }
}

const pc = await json('/api/paircode')
const pair = await json('/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pc.code, name: 'steer-audit' }),
})
const headers = { authorization: `Bearer ${pair.token}` }

const page = await json(`/api/session/${sessionId}/page?limit=40`, { headers })
console.log(`会话 ${sessionId}，返回 ${page.events.length} 条事件\n`)

for (const ev of page.events) {
  const data = ev.data || {}
  if (ev.type === 'agent/inbox/spliced') {
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    console.log(`seq=${ev.seq} spliced target=${data.target} start=${data.start} removed=${data.removedCount ?? 0} inserted=${inserted.length} outcome=${data.outcome ?? '-'}`)
    for (const m of inserted) {
      const txt = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      console.log(`    ↳ id=${m.id} src=${m.source && m.source.kind} text="${txt.slice(0, 40)}"`)
    }
  } else if (ev.type === 'user/message') {
    const m = data.message || data
    const txt = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    console.log(`seq=${ev.seq} user/message src=${m.source && m.source.kind} rpc=${m.source && m.source.rpcId} id=${m.id} text="${txt.slice(0, 30)}"`)
  }
}

await json('/api/devices/revoke', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ id: pair.deviceId }),
})
console.log('\n已撤销临时设备')
