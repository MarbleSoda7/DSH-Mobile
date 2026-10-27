// 校验「手机端上滑翻早期记录」依赖的分页链路：
//   page(无 before) => 尾部一页 + hasMore
//   page(before=最早 seq) => 更早一页 + hasMore
// 一直翻到 hasMore=false，确认能真正走到会话开头，且 seq 严格递减不重不漏。
import http from 'node:http'

const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'
// 配对码只允许回环生成（公网 /api/paircode 必须 403），所以测公网地址时
// 配对仍走本机，业务请求才打到 BASE。
const PAIR_BASE = process.env.MR_PAIR_BASE || 'http://127.0.0.1:7788'

function request(url, options = {}, body = null) {
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

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' :: ' + detail : ''}`)
}

const code = await request(`${PAIR_BASE}/api/paircode`)
check('拿到配对码', code.status === 200 && !!code.json?.code, `status=${code.status}`)
const pair = await request(`${PAIR_BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
}, JSON.stringify({ code: code.json.code, name: 'paging-probe' }))
check('配对成功', pair.status === 200 && !!pair.json?.token, `status=${pair.status}`)
const auth = { authorization: `Bearer ${pair.json.token}` }

const state = await request(`${BASE}/api/state`, { headers: auth })
const sessions = state.json?.sessions || []
check('会话列表非空', sessions.length > 0, `count=${sessions.length}`)

// 上滑翻页要做两件事都成立才算通过：
//  A) 大会话能一直往前翻，而且不重不漏（曾经这里是"只能看缓存"的死路）；
//  B) 真能翻到会话开头（hasMore 变成 false），不是永远"还有更多"。
// 找会话开头用一个较小的会话即可，不必把一万条事件全拉一遍。
async function walk(sid, maxRounds, limit = 12) {
  const first = await request(`${BASE}/api/session/${encodeURIComponent(sid)}/page?limit=${limit}`, { headers: auth })
  if (first.status !== 200) return { ok: false, reason: `status=${first.status}` }
  const firstEvents = first.json?.events || []
  if (firstEvents.length === 0) return { ok: false, reason: 'empty' }
  let seqs = firstEvents.map((event) => event.seq)
  let hasMore = first.json?.hasMore === true
  let oldest = Math.min(...seqs)
  let rounds = 0
  while (hasMore && rounds < maxRounds) {
    rounds += 1
    const page = await request(`${BASE}/api/session/${encodeURIComponent(sid)}/page?limit=${limit}&before=${oldest}`, { headers: auth })
    if (page.status !== 200) return { ok: false, reason: `page status=${page.status} ${page.text.slice(0, 100)}`, firstEvents, seqs }
    const events = page.json?.events || []
    const fresh = events.filter((event) => typeof event.seq === 'number' && event.seq < oldest)
    if (fresh.length === 0) return { ok: false, reason: 'no older events returned', firstEvents, seqs, hasMore }
    seqs = seqs.concat(fresh.map((event) => event.seq))
    oldest = Math.min(...fresh.map((event) => event.seq))
    hasMore = page.json?.hasMore === true
  }
  return { ok: true, firstEvents, seqs, hasMore, oldest, rounds }
}

// 不能拿 sessions[0] 当"大会话"：它常常是刚建的新会话（十几条、hasMore=false、
// 首条 seq 甚至是 0），这样断言"翻页能翻出更多"必然失败，属于测试自身的假设错了。
// 正确做法：先找一个首页 hasMore=true 的会话，那才是有历史可翻的。
let bigSid = null
for (const session of sessions.slice(0, 15)) {
  const probe = await request(`${BASE}/api/session/${encodeURIComponent(session.id)}/page?limit=4`, { headers: auth })
  if (probe.status === 200 && probe.json?.hasMore === true && (probe.json?.events || []).length > 0) {
    bigSid = session.id
    break
  }
}
check('找到有可翻历史的会话', !!bigSid, bigSid ? bigSid.slice(0, 16) : '前 15 个会话都是 hasMore=false')

const big = bigSid ? await walk(bigSid, 40) : { ok: false, reason: 'no big session' }
check('首页 200 且有事件', big.ok !== false && (big.firstEvents || []).length > 0, big.reason || '')
if (big.firstEvents) {
  const unique = Array.from(new Set(big.seqs))
  check('大会话连续翻页无重复', unique.length === big.seqs.length, `total=${big.seqs.length} unique=${unique.length}`)
  // seq 从 0 开始是合法的（会话第一条事件），所以判"非负"而不是"为正"。
  check('seq 全部为非负整数', big.seqs.every((seq) => Number.isInteger(seq) && seq >= 0))
  check('累计翻到的事件数明显多于首页', big.seqs.length > big.firstEvents.length, `total=${big.seqs.length} first=${big.firstEvents.length}`)
  const descending = big.seqs.slice(0, big.firstEvents.length)
  check('首页 seq 单调递增', descending.every((seq, index) => index === 0 || seq > descending[index - 1]))
}

// B) 找一个能在有限轮内翻到开头的会话
let reachedStart = null
for (const session of sessions.slice(0, 12)) {
  const result = await walk(session.id, 25, 20)
  if (result.ok && result.hasMore === false) { reachedStart = { session, result }; break }
}
check(
  '存在会话能真正翻到开头（hasMore=false）',
  !!reachedStart,
  reachedStart ? `session=${reachedStart.session.id.slice(0, 12)} rounds=${reachedStart.result.rounds} oldest=${reachedStart.result.oldest}` : '前 12 个会话都没翻到开头',
)

await request(`${BASE}/api/devices/revoke`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
}, JSON.stringify({ id: pair.json.deviceId }))

const failed = results.filter((row) => !row.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
