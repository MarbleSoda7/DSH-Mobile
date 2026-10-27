import fs from 'node:fs'
const dir = 'C:/Users/29113/.dsh/sessions'
const want = process.argv[2]
function walk(p, out = []) { for (const e of fs.readdirSync(p, {withFileTypes:true})) { const f = p + '/' + e.name; if (e.isDirectory()) walk(f, out); else if (e.name.endsWith('.jsonl.zstd')) out.push(f) } return out }
const files = walk(dir).filter(f => f.includes(want))
console.log(files)
