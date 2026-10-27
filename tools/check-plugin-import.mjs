/* 快速自检：插件模块图能不能加载（新的 lib/queue-state.js 解析得到）、apply 在不在。 */
const mod = await import('../lib/index.js')
console.log('EXPORTS', Object.keys(mod).join(','), 'APPLY', typeof mod.apply)
const q = await import('../lib/queue-state.js')
const state = q.createQueueState({ textOf: (m) => m.content[0].text })
state.applySpliced('a', { target: 'next-turn', start: 0, inserted: [{ id: 'x', content: [{ type: 'text', text: 'hi' }] }] })
console.log('SMOKE', JSON.stringify(state.list('a')))
console.log('PLUGIN_IMPORT_OK')
