/* 排队框回归测试：把宿主真实会发出的两类事件按顺序喂给 lib/queue-state.js，
 * 断言手机上看到的排队列表符合"next-turn 才显示、next-step（插话）不显示"。
 *
 * 为什么要单独测：宿主对一次"插话"会连发 4 个事件
 *   spliced(next-turn, removedCount:1) → discarded(A) → spliced(next-step, inserted:[A]) → inserted(A)
 * 最后那个 `inserted` **不带 target**。旧实现见到它就 push 回列表，
 * 于是插话后那条消息又挂回排队框（用户实测），再点编辑/删除/插话就报
 * "queued item is no longer pending"。
 *
 * 用法：node tools/check-queue-steer.mjs
 */
import { createQueueState } from '../lib/queue-state.js'

const textOf = (message) => {
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  return block && block.type === 'text' ? block.text : ''
}

const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] })

let failed = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log(`ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}\n  actual   ${a}\n  expected ${b}`)
}

const texts = (state, sid) => state.list(sid).map((row) => row.text)

/** 宿主 agent.inbox.mutate() 的事件顺序：先 append spliced，再 dispatch discarded/inserted。 */
const hostMutation = (state, sid, spliced, { removed = [], inserted = [] } = {}) => {
  state.applySpliced(sid, spliced)
  for (const m of removed) state.gone(sid, m.id)
  for (const m of inserted) state.inserted(sid, m)
}

/* ---- 1. 发一条排队消息：next-turn 插入 ---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '排队的消息')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })
  check('1 排队消息显示为一行', texts(state, 'S'), ['排队的消息'])
}

/* ---- 2. 插话：消息进 next-step，必须从排队框消失（本 bug 的主场景）---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '排队的消息')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })

  // agent.inbox.remove(A) → 再 agent.steer(A)（见宿主 dsh-agent-loop：steer = send(next-step)）
  state.applySpliced('S', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  state.gone('S', A.id)
  state.applySpliced('S', { target: 'next-step', start: 0, inserted: [A] })
  state.inserted('S', A) // 关键：不带 target 的身份事件

  check('2 插话后排队框为空', texts(state, 'S'), [])

  // 下一步边界 claim 掉 next-step（宿主 claimed 事件）
  state.applySpliced('S', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  state.gone('S', A.id)
  check('3 claim 之后仍然为空', texts(state, 'S'), [])
}

/* ---- 3. 两条排队 + 只插话第二条，第一条必须留着 ---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '第一条')
  const B = message('B', '第二条')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })
  hostMutation(state, 'S', { target: 'next-turn', start: 1, inserted: [B] }, { inserted: [B] })
  check('4 两条排队消息', texts(state, 'S'), ['第一条', '第二条'])

  state.applySpliced('S', { target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' })
  state.gone('S', B.id)
  state.applySpliced('S', { target: 'next-step', start: 0, inserted: [B] })
  state.inserted('S', B)
  check('5 只插话第二条后剩下第一条', texts(state, 'S'), ['第一条'])

  // 新一轮开始，next-turn 的 A 被 claim
  state.applySpliced('S', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  state.gone('S', A.id)
  check('6 新一轮消费掉 A 后队列为空', texts(state, 'S'), [])
}

/* ---- 4. 编辑：同一 id 替换，不能变成两行 ---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '改之前')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })
  const A2 = message('A', '改之后')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, removedCount: 1, inserted: [A2] }, { removed: [A], inserted: [A2] })
  check('7 编辑后仍是一行且正文更新', texts(state, 'S'), ['改之后'])
}

/* ---- 5. 漏掉 spliced 时，身份事件也能补上一行（不能变成"永远不显示"）---- */
{
  const state = createQueueState({ textOf })
  state.inserted('S', message('C', '只有身份事件'))
  check('8 漏 spliced 时身份事件仍能补行', texts(state, 'S'), ['只有身份事件'])
}

/* ---- 6. 从没见过的 next-step 插入（后台通知/团队消息）不显示 ---- */
{
  const state = createQueueState({ textOf })
  const N = message('N', '后台任务通知')
  state.applySpliced('S', { target: 'next-step', start: 0, inserted: [N] })
  state.inserted('S', N)
  check('9 next-step 的后台通知不进排队框', texts(state, 'S'), [])
}

/* ---- 7. 宿主说这条已经不在队列（queue-not-found）→ drop 后为空 ---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '幽灵行')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })
  state.drop('S', A.id)
  check('10 drop 之后队列为空', texts(state, 'S'), [])
}

/* ---- 反向控制：旧实现（inserted 无条件 push）必须复现"悬空行"，证明本测试有效 ---- */
{
  const legacyInserted = (list, m) => {
    const next = list.filter((row) => row.itemId !== String(m.id))
    const text = textOf(m)
    if (text) next.push({ itemId: String(m.id), text, at: Date.now() })
    return next
  }
  let list = []
  const A = message('A', '排队的消息')
  list = legacyInserted(list, A)
  list = list.filter((row) => row.itemId !== 'A') // 插话：next-turn 移除
  list = legacyInserted(list, A) // next-step 的 inserted 身份事件
  check('11 CONTROL 旧实现插话后留下悬空行', list.map((row) => row.text), ['排队的消息'])
  if (list.length !== 1) {
    failed += 1
    console.log('FAIL 反向控制没有复现旧 bug —— 测试可能是空转的')
  }
}

/* ---- 8. 索引漂移：本地先摘掉一条后，宿主的 splice 不能连带删掉后一条 ---- */
{
  const state = createQueueState({ textOf })
  const A = message('A', '第一条')
  const B = message('B', '第二条')
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [A] }, { inserted: [A] })
  hostMutation(state, 'S', { target: 'next-turn', start: 1, inserted: [B] }, { inserted: [B] })

  // 手机点了 A 的「插话」：此时宿主的 spliced 还没到，我们只隐藏 A
  state.hide('S', A.id)
  check('12 隐藏后只剩第二条可见', texts(state, 'S'), ['第二条'])

  // 宿主随后发来 splice，start=0 removedCount=1（宿主侧索引）
  state.applySpliced('S', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  check('13 宿主 splice 到达后第二条仍在（索引未漂移）', texts(state, 'S'), ['第二条'])
  state.gone('S', A.id)
  check('14 gone 之后仍然只剩第二条', texts(state, 'S'), ['第二条'])
}

/* ---- 9. 反向控制：旧实现（本地先真删再 splice）必须复现整列消失 ---- */
{
  const legacy = [ { itemId: 'A', text: '第一条' }, { itemId: 'B', text: '第二条' } ]
  const afterLocalDrop = legacy.filter((row) => row.itemId !== 'A')
  const next = afterLocalDrop.slice()
  next.splice(0, 1) // 宿主 spliced: start=0, removedCount=1
  check('15 CONTROL 旧实现插话一条会把后一条也删掉', next.map((row) => row.text), [])
  if (next.length !== 0) {
    failed += 1
    console.log('FAIL 反向控制没有复现索引漂移 —— 测试可能是空转的')
  }
}

/* ---- 10. 纯图片消息（用户直接贴图不写字）：必须成为一行，且带上图片张数 ---- */
{
  const imageCountOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'image').length : 0)
  const state = createQueueState({ textOf, imageCountOf })
  const TEXT = message('T1', '配一张图')
  const ONLY = { id: 'I1', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }, { type: 'image', attachment: { attachmentId: 'a2' } }] }
  hostMutation(state, 'S', { target: 'next-turn', start: 0, inserted: [TEXT] }, { inserted: [TEXT] })
  hostMutation(state, 'S', { target: 'next-turn', start: 1, inserted: [ONLY] }, { inserted: [ONLY] })
  const rows = state.list('S')
  check('16 纯图片排队消息不会被丢掉', rows.map((row) => row.itemId), ['T1', 'I1'])
  check('17 纯图片行的正文为空、imageCount=2', rows[1] && { text: rows[1].text, imageCount: rows[1].imageCount }, { text: '', imageCount: 2 })
  check('18 带文字带图的 imageCount 也记下来', rows[0].imageCount, 0)
}

/* ---- 11. 真正空的消息（没字也没图）仍然不显示 ---- */
{
  const imageCountOf = () => 0
  const state = createQueueState({ textOf, imageCountOf })
  const EMPTY = { id: 'E1', role: 'user', content: [] }
  state.inserted('S', EMPTY)
  check('19 空消息依然不进排队框', state.list('S').length, 0)
}

/* ---- 12. spliced 重建后 imageCount 不丢 ---- */
{
  const imageCountOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'image').length : 0)
  const state = createQueueState({ textOf, imageCountOf })
  const ONLY = { id: 'I2', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a3' } }] }
  state.set('S', [{ itemId: 'I2', text: '', imageCount: 1, at: 1 }])
  state.applySpliced('S', { target: 'next-turn', start: 0, removedCount: 0, inserted: [ONLY] })
  const row = state.list('S').find((item) => item.itemId === 'I2')
  check('20 重建后 imageCount 保持 1', row && row.imageCount, 1)
}

if (failed) {
  console.log(`QUEUE_STATE_FAILED (${failed})`)
  process.exit(1)
}
console.log('QUEUE_STATE_OK')
