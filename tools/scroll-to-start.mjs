// 一次性验证：拿一个长历史会话，从尾部一路 before 翻到最老一条，确认能到底。
import http from 'node:http'

const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'

function get(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const code = await get(`${BASE}/api/paircode`)
const pair = await get(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ code: code.json.code, name: 'scroll-probe' }))
const auth = { authorization: `Bearer ${pair.json.token}` }

const state = await get(`${BASE}/api/state`, { headers: auth })
const session = state.json.sessions[0]

let seqs = []
let hasMore = true
let oldest = null
let rounds = 0
const first = await get(`${BASE}/api/session/${encodeURIComponent(session.id)}/page?limit=12`, { headers: auth })
seqs = first.json.events.map((event) => event.seq)
hasMore = first.json.hasMore === true
oldest = Math.min(...seqs)

while (hasMore && rounds < 300) {
  rounds += 1
  const page = await get(`${BASE}/api/session/${encodeURIComponent(session.id)}/page?limit=12&before=${oldest}`, { headers: auth })
  if (page.status !== 200) { console.log(`FAIL status=${page.status}`); break }
  const fresh = (page.json.events || []).filter((event) => event.seq < oldest)
  if (fresh.length === 0) { console.log(`stuck at oldest=${oldest}`); break }
  seqs = seqs.concat(fresh.map((event) => event.seq))
  oldest = Math.min(...fresh.map((event) => event.seq))
  hasMore = page.json.hasMore === true
}

const unique = new Set(seqs)
console.log(`session=${session.id.slice(0, 14)} rounds=${rounds} events=${seqs.length} unique=${unique.size} oldest=${oldest} hasMore=${hasMore}`)
await get(`${BASE}/api/devices/revoke`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' } }, JSON.stringify({ id: pair.json.deviceId }))
