const BASE = 'http://127.0.0.1:7788'
const j = async (p, i) => { const r = await fetch(BASE + p, i); const t = await r.text(); let v; try { v = JSON.parse(t) } catch { throw new Error(p + ' ' + r.status + ' ' + t.slice(0,200)) } if (!r.ok || v.ok === false) throw new Error(p + ' ' + JSON.stringify(v).slice(0,200)); return v }
const pc = await j('/api/paircode')
const pair = await j('/api/pair', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code: pc.code, name:'steer-raw' }) })
const auth = { authorization:'Bearer '+pair.token, 'content-type':'application/json' }
const created = await j('/api/session', { method:'POST', headers: auth, body: JSON.stringify({ cwd: process.cwd() }) })
const sid = created.sessionId
await j('/api/focus', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid }) })
await j('/api/prompt', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid, text:'请从 1 数到 300，每行一个数字。' }) })
await new Promise(r=>setTimeout(r,2000))
await j('/api/redirect', { method:'POST', headers: auth, body: JSON.stringify({ sessionId: sid, text:'插话RAW：只回复 OK' }) })
await new Promise(r=>setTimeout(r,5000))
const page = await j('/api/session/'+sid+'/page?limit=40', { headers: auth })
for (const ev of page.events || []) {
  if (ev.type === 'agent/inbox/spliced') {
    console.log('SEQ', ev.seq, JSON.stringify(ev.data).slice(0, 700))
  }
}
await fetch(BASE+'/api/cancel',{method:'POST',headers:auth,body:JSON.stringify({sessionId:sid})}).catch(()=>{})
await fetch(BASE+'/api/devices/revoke',{method:'POST',headers:auth,body:JSON.stringify({id:pair.deviceId})}).catch(()=>{})
