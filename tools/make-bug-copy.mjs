// 造一份"把修复退回去"的副本来做反向对照——证明测试真的能咬住问题。
//
// 安全约束（曾经的事故）：之前手写的一次性脚本把 argv 顺序搞错，用 writeFileSync
// 直接把源文件覆盖成了 507 字节，整个 web/app.js 丢掉。所以这个脚本：
//   1) 必须有显式 --out，绝不允许落到 --src 上；
//   2) 写入前断言两个绝对路径不同；
//   3) 只读源文件、只写目标文件，不做任何 in-place 修改。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
function pick(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : ''
}

const src = pick('src')
const out = pick('out')
if (!src || !out) {
  console.error('usage: node make-bug-copy.mjs --src <file> --out <file>')
  process.exit(2)
}

const srcAbs = resolve(src)
const outAbs = resolve(out)
if (srcAbs === outAbs) {
  console.error(`refusing to overwrite source file: ${srcAbs}`)
  process.exit(3)
}

let code = readFileSync(srcAbs, 'utf8')
let applied = 0

function revert(from, to, label) {
  if (!code.includes(from)) {
    console.error(`skip (pattern not found): ${label}`)
    return
  }
  code = code.replace(from, to)
  applied += 1
}

// 1) 过程行类名退回到没有样式的 `ev`
revert('row.className = `ev-row ${className}`.trim()', 'row.className = `ev ${className}`.trim()', 'ev-row -> ev')

// 2) 思考重新塞回气泡内部
revert(
  "      // 交给 appendReasoningRows()\n      continue",
  "      node.appendChild(expandable(eventRow({ icon: '⊗', verb: '思考', target: clip(block.text, 24) }), block.text))",
  'reasoning back inside bubble',
)

writeFileSync(outAbs, code, 'utf8')
console.log(`wrote ${outAbs} (${code.length} bytes, ${applied} revert(s) applied)`)
