/* 反向对照的跑法：把 smoke.mjs 复制一份、只改它 import 的插件路径，
 * 指向"故意改坏"的副本，然后跑那份副本。
 *
 * 为什么需要它：正向全绿只能证明"当前代码能过"，不能证明这些断言真的
 * 能咬住问题。必须让坏版本失败，测试才算有效（之前踩过空转的坑）。
 *
 * 安全约束：绝不覆盖输入文件，输出路径必须与所有输入不同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const readFlag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

const smokePath = path.resolve(readFlag('--smoke') || 'tools/smoke.mjs')
const indexPath = path.resolve(readFlag('--index') || 'lib/index.js')
const outPath = path.resolve(readFlag('--out') || '')

if (!outPath) {
  console.error('usage: node tools/make-smoke-copy.mjs --index <plugin-entry> --out <copy-of-smoke.mjs>')
  process.exit(1)
}
if (outPath === smokePath || outPath === indexPath) {
  console.error('refuse: --out must differ from --smoke and --index')
  process.exit(1)
}

const source = fs.readFileSync(smokePath, 'utf8')
const marker = "await import('../lib/index.js')"
if (!source.includes(marker)) {
  console.error('pattern not found: ' + marker)
  process.exit(1)
}

// 跨盘符时 path.relative 会返回绝对路径（D:\... vs C:\...），拼进 import 就废了。
// 统一用 file:// URL，任何位置都能正确解析。
const specifier = pathToFileURL(indexPath).href
const patched = source.replace(marker, `await import(${JSON.stringify(specifier)})`)
fs.writeFileSync(outPath, patched, 'utf8')
console.log('wrote', outPath, '->', specifier)
