// 单元级验证：summarizeToolCall 生成的"一行摘要"必须对齐电脑版语义
//   运行命令 → 显示命令的 description（人话），没有描述才退化成命令
//   编辑/写入 → 路径 + 体积 + 增删行数
//   认不出的工具 → 用工具名当动作词，绝不再出现"工具调用"
// 用法：node tools/probe-summary.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const libPath = join(here, '..', 'lib', 'index.js')

// lib/index.js 有相对 import，不能直接当 data: URL 加载；
// 这里只截取"纯函数段"（clipText … trimBlocks 之前），写成临时模块再 import。
const source = readFileSync(libPath, 'utf8')
const start = source.indexOf('function clipText(')
const end = source.indexOf('function trimBlocks(')
if (start < 0 || end <= start) {
  console.error('无法从 lib/index.js 截取纯函数段（clipText … trimBlocks）')
  process.exit(1)
}
const slice = source.slice(start, end)
const dir = mkdtempSync(join(tmpdir(), 'dsh-mr-summary-'))
const modPath = join(dir, 'summary-slice.mjs')
writeFileSync(modPath, `${slice}\nexport { summarizeToolCall, TOOL_VERBS }\n`, 'utf8')
const { summarizeToolCall, TOOL_VERBS } = await import(pathToFileURL(modPath).href)

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''))
  }
}

// 1) pwsh 有 description：显示描述，不显示命令本身
const cmdWithDesc = summarizeToolCall('pwsh', JSON.stringify({ command: 'Select-String -Path app.js -Pattern x', description: 'Find literal tool-call labels' }))
check('pwsh 优先显示 description', cmdWithDesc.verb === '运行命令' && cmdWithDesc.target === 'Find literal tool-call labels', JSON.stringify(cmdWithDesc))

// 2) pwsh 没有 description：退化成命令
const cmdNoDesc = summarizeToolCall('pwsh', JSON.stringify({ command: 'Get-ChildItem -Recurse' }))
check('pwsh 无 description 时退化成命令', cmdNoDesc.target === 'Get-ChildItem -Recurse', JSON.stringify(cmdNoDesc))

// 3) edit：路径 + 体积 + 增删行数
const newBody = Array.from({ length: 34 }, (_, i) => `line ${i}`).join('\n')
const oldBody = Array.from({ length: 5 }, (_, i) => `old ${i}`).join('\n')
const edited = summarizeToolCall('edit', JSON.stringify({ file_path: 'web\\app.js', new_string: newBody, old_string: oldBody }))
check('edit 显示路径', edited.verb === '编辑' && edited.target === 'web\\app.js', JSON.stringify(edited))
check('edit 显示体积与增删行数', /^\d+(B|KB|MB) \+\d+ -\d+$/.test(edited.extra), JSON.stringify(edited))

// 4) 认不出的工具：动作词用工具名，不能是"工具调用"
const unknown = summarizeToolCall('some_new_tool', JSON.stringify({ query: 'hello' }))
check('未知工具不用「工具调用」占位', unknown.verb === 'some_new_tool' && !/工具调用/.test(JSON.stringify(unknown)), JSON.stringify(unknown))

// 5) read：路径
const readOne = summarizeToolCall('read', JSON.stringify({ file_path: 'a\\b.js' }))
check('read 显示路径', readOne.verb === '读取' && readOne.target === 'a\\b.js', JSON.stringify(readOne))

// 6) 词表里不能残留"工具调用"
check('TOOL_VERBS 不含「工具调用」', !Object.values(TOOL_VERBS).some((v) => v === '工具调用'))

// 7) compress：不能把参数键名 content 当目标
const comp = summarizeToolCall('compress', JSON.stringify({ content: [{ startId: 'm1', endId: 'm2', summary: 'x' }, { startId: 'm3', endId: 'm4', summary: 'y' }] }))
check('compress 显示段数而不是键名', comp.verb === '压缩上下文' && comp.target === '2 段上下文', JSON.stringify(comp))

// 8) 未知工具 + 数组参数：显示"N 项"，不显示裸键名
const arrArgs = summarizeToolCall('some_new_tool', JSON.stringify({ ranges: [1, 2, 3] }))
check('未知工具数组参数显示项数', arrArgs.target === 'ranges · 3 项', JSON.stringify(arrArgs))

// 9) 未知工具 + 空参数：至少显示工具名
const emptyArgs = summarizeToolCall('some_new_tool', '{}')
check('空参数时退化到工具名', emptyArgs.target === 'some_new_tool', JSON.stringify(emptyArgs))

// 10) 子调用最常出现的几个工具必须有中文动作词（否则手机会显示英文工具名）
const subVerbs = {
  acp_status: '查看上下文用量',
  list_agents: '查看队友',
  send_message: '发消息给队友',
  job_output: '读取后台任务',
  terminal_send: '终端输入',
  read_image: '查看图片',
}
for (const [tool, expected] of Object.entries(subVerbs)) {
  const got = summarizeToolCall(tool, '{}')
  check(`子调用动作词 ${tool}`, got.verb === expected, JSON.stringify(got))
}

// 11) 子调用的 acp_status 只有参数没有描述时，目标不能是空串
const acp = summarizeToolCall('acp_status', '{}')
check('acp_status 有非空目标', acp.target.length > 0, JSON.stringify(acp))

rmSync(dir, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
