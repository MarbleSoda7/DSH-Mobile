const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788'
const j = async (p, i) => { const r = await fetch(BASE + p, i); const t = await r.text(); let v; try { v = JSON.parse(t) } catch { throw new Error(p + ' ' + r.status + ' ' + t.slice(0,200)) } if (!r.ok || v.ok === false) throw new Error(p + ' ' + JSON.stringify(v).slice(0,200)); return v }
const pc = await j('/api/paircode')
const pair = await j('/api/pair', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code: pc.code, name:'steer-dump' }) })
const auth = { authorization:'Bearer '+pair.token, 'content-type':'application/json' }
const created = await j('/api/session', { method:'POST', headers: auth, body: JSON.stringify({ cwd: process.cwd() }) })
const sid = created.sessionId
await j('/api/focus', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid }) })
await j('/api/prompt', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid, text:'请从 1 数到 300，每行一个数字。' }) })
await new Promise(r=>setTimeout(r,2000))
const at = Date.now()
await j('/api/redirect', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid, text:'插话DUMP：只回复 OK' }) })
const cursor = {}
const end = Date.now()+9000
while (Date.now() < end) {
  const data = await j('/api/poll?k='+pair.token+'&c='+Buffer.from(JSON.stringify(cursor)).toString('base64url'))
  const got = Date.now()-at
  for (const f of data.frames||[]) {
    if (f.type === 'event') {
      const e = f.payload, dd = e.data||{}
      if (['delta'].includes(f.type)) continue
      let extra = ''
      if (e.type === 'agent/inbox/spliced') extra = ` target=${dd.target} start=${dd.start} removed=${dd.removedCount} inserted=${(dd.inserted||[]).length}`
      if (e.type === 'user/message') { const m = dd.message||dd; extra = ` text="${(m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(' ').slice(0,30)}"` }
      console.log(`+${got}ms ${e.type} seq=${e.seq}${extra}`)
    } else if (f.type !== 'delta') {
      console.log(`+${got}ms FRAME ${f.type} ${JSON.stringify(f.payload).slice(0,120)}`)
    }
  }
  if (data.cursor) Object.assign(cursor, data.cursor)
}
await fetch(BASE+'/api/cancel',{method:'POST',headers:auth,body:JSON.stringify({sessionId:sid})}).catch(()=>{})
await fetch(BASE+'/api/devices/revoke',{method:'POST',headers:auth,body:JSON.stringify({id:pair.deviceId})}).catch(()=>{})
