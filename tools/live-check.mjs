// 真机前的"线上自检"：直连已经跑在宿主进程里的插件，验证它真的能看到你电脑上的会话。
// 用法：node tools/live-check.mjs    （结束时会自动撤销这个自检设备）
const BASE = process.env.MR_BASE || 'http://127.0.0.1:7788';

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data, size: text.length };
}

const pc = await j('/api/paircode');
if (!pc.data.ok) { console.log('paircode 失败（可能不在回环地址）:', pc); process.exit(1); }
console.log('配对码:', pc.data.code.slice(0, 8) + '…', ' 对外地址:', pc.data.origin);

const paired = await j('/api/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pc.data.code, name: 'live-check（自检用）' }),
});
if (!paired.data.ok) { console.log('配对失败:', paired); process.exit(1); }
const { deviceId, token } = paired.data;
const auth = { authorization: 'Bearer ' + token };
console.log('配对成功 deviceId=', deviceId.slice(0, 8) + '…');

const st = await j('/api/state', { headers: auth });
const sessions = st.data.sessions || [];
console.log('GET /api/state →', st.status, '会话数:', sessions.length, '大小:', Math.round(st.size / 1024) + 'KB');

for (const s of sessions.slice(0, 6)) {
  const m = s.model ? `${s.model.provider}/${s.model.model}/${s.model.reasoningEffort ?? '-'}` : 'no-model';
  console.log(`  · …${s.id.slice(-8)} [${s.running ? 'RUN ' : 'idle'}] ${m}  ${String(s.title || '').slice(0, 42)}`);
}
if (!sessions.length) console.log('  （空列表：若你电脑上确实有会话，说明 list() 过滤或投影有问题）');

const cat = await j('/api/catalog', { headers: auth });
console.log('GET /api/catalog →', cat.status, 'provider 组:', cat.data.catalog?.groups?.length ?? cat.data.catalog?.providers?.length ?? '?');

const first = sessions.find((s) => s.running) || sessions[0];
if (first) {
  const page = await j(`/api/session/${encodeURIComponent(first.id)}/page?limit=5`, { headers: auth });
  const evs = page.data.events || [];
  console.log(`GET /page(…${first.id.slice(-8)}) →`, page.status, '事件数:', evs.length, '大小:', Math.round(page.size / 1024) + 'KB', 'hasMore:', page.data.hasMore, 'latestSeq:', page.data.latestSeq);
  if (page.status !== 200) console.log('  page 失败正文:', JSON.stringify(page.data).slice(0, 400));
  console.log('  事件类型:', evs.map((e) => e.type).join(',') || '(空)');
  const withText = evs.filter((e) => e.type === 'assistant/message' || e.type === 'user/message');
  if (withText.length) console.log('  末条文本键:', Object.keys(withText[withText.length - 1].data || {}).join(','));
}

const usage = await j('/api/usage', { headers: auth });
console.log('GET /api/usage →', usage.status, JSON.stringify(usage.data.usage));

const rev = await j('/api/devices/revoke', {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ id: deviceId }),
});
console.log('撤销自检设备 →', rev.status, JSON.stringify(rev.data));
