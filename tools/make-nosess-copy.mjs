// 生成 bug 副本：把 handleFrame 的 sessions 分支去掉，用来证明 T18 不是空转。
// 必须显式传 --src / --out，并在写入前断言两者解析路径不同（历史上踩过覆盖源文件的事故）。
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const read = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : ''
}
const src = read('src')
const out = read('out')
if (!src || !out) {
  console.error('usage: node make-nosess-copy.mjs --src <file> --out <file>')
  process.exit(2)
}
const srcAbs = path.resolve(src)
const outAbs = path.resolve(out)
if (srcAbs === outAbs) {
  console.error('refusing: --out resolves to --src')
  process.exit(2)
}
const source = fs.readFileSync(srcAbs, 'utf8')
const marker = "  if (type === 'sessions') {"
const start = source.indexOf(marker)
if (start < 0) {
  console.error('marker not found')
  process.exit(1)
}
const end = source.indexOf('\n  }\n', start)
if (end < 0) {
  console.error('block end not found')
  process.exit(1)
}
const patched = source.slice(0, start) + '  // (bug copy: sessions frame ignored)\n' + source.slice(end + 4)
fs.writeFileSync(outAbs, patched)
console.log(`wrote ${outAbs} (${patched.length} bytes, was ${source.length})`)
