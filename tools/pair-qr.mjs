// 生成一张可直接扫的配对二维码 PNG（不依赖浏览器页面，排障/兜底用）
// 用法：node tools/pair-qr.mjs   → 写出 pair-qr.png，并打印配对码与有效期
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'pair-qr.png')
const LOCAL = 'http://127.0.0.1:7788'

const profileDir = process.env.DSH_PROFILE_DIR || 'C:/Users/29113/.dsh/profiles/desktop'
const qrcode = createRequire(join(profileDir, 'node_modules', 'entry.js'))('qrcode')

const info = await (await fetch(`${LOCAL}/api/paircode`)).json()
if (!info.ok) {
  console.error('paircode failed:', info.error)
  process.exit(1)
}

const png = await qrcode.toBuffer(info.url, { type: 'png', width: 720, margin: 1, errorCorrectionLevel: 'M' })
writeFileSync(OUT, png)

const left = Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000))
console.log(`二维码图片: ${OUT}  (${png.length} 字节)`)
console.log(`配对码    : ${info.code}`)
console.log(`地址      : ${info.url}`)
console.log(`有效期    : 约 ${Math.round(left / 60)} 分钟（${left} 秒）`)
