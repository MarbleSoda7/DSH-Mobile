/**
 * 内置二维码编码器（byte 模式，纠错等级 L/M/Q/H 全支持，版本 1-40 自动选）。
 *
 * 为什么自己写：早期版本的二维码依赖 profile 里恰好装了 `qrcode` 包，
 * 换一台电脑装插件就 501「qrcode 包不可用」，电脑端配页面直接空白。
 * 用户明确要求「能内置的依赖都内置」，所以这里只依赖 node 自带能力。
 *
 * 算法照 ISO/IEC 18004 实现，数据表来自公开的 QR 规范（格式信息、版本信息、
 * 纠错分块表、对齐图案位置表）。产出 SVG 或 PNG（PNG 用 zlib 自带压缩 + CRC32）。
 */

import { deflateSync } from 'node:zlib'

/** 纠错等级：ordinal 用于格式信息（L=1, M=0, Q=3, H=2） */
const ECC = {
  L: { ordinal: 1 },
  M: { ordinal: 0 },
  Q: { ordinal: 3 },
  H: { ordinal: 2 },
}

// 表按 L / M / Q / H 顺序排列，索引 0 是占位
const ECCL_INDEX = { L: 0, M: 1, Q: 2, H: 3 }

/** 每块纠错码字数 [ecl][version]（index 0 占位） */
const ECC_CODEWORDS_PER_BLOCK = [
  // L
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // M
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  // Q
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // H
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

/** 纠错块数 [ecl][version] */
const NUM_ERROR_CORRECTION_BLOCKS = [
  // L
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  // M
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  // Q
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  // H
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0
}

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

function numDataCodewords(version, ecl) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ECCL_INDEX[ecl]][version] * NUM_ERROR_CORRECTION_BLOCKS[ECCL_INDEX[ecl]][version]
  )
}

function alignmentPatternPositions(version) {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ---------------------------------------------------------------- Reed-Solomon

function reedSolomonComputeDivisor(degree) {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length)
  for (const b of data) {
    const factor = b ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor)
  }
  return result
}

function gfMultiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

// ---------------------------------------------------------------- bit stream

class BitBuffer {
  constructor() {
    this.bits = []
  }
  appendBits(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
  get length() {
    return this.bits.length
  }
}

// ---------------------------------------------------------------- segment (byte)

function makeBytesSegment(text) {
  const data = new TextEncoder().encode(text)
  return { mode: 4, charCount: data.length, data }
}

function segmentBitLength(seg, version) {
  const ccBits = version < 10 ? 8 : 16
  return 4 + ccBits + seg.data.length * 8
}

function totalBitsNeeded(segments, version) {
  let bits = 0
  for (const seg of segments) bits += segmentBitLength(seg, version)
  return bits
}

// ---------------------------------------------------------------- matrix

class QrMatrix {
  constructor(version, ecl, codewords) {
    this.version = version
    this.ecl = ecl
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
    this.drawFunctionPatterns()
    this.drawCodewords(codewords)
    // 固定掩码 0-7 里选罚分最低的
    let bestMask = 0
    let minPenalty = Infinity
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask)
      this.drawFormatBits(mask)
      const penalty = this.penalty()
      if (penalty < minPenalty) {
        minPenalty = penalty
        bestMask = mask
      }
      this.applyMask(mask) // xor 自身撤销
    }
    this.applyMask(bestMask)
    this.drawFormatBits(bestMask)
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark
    this.isFunction[y][x] = true
  }

  drawFunctionPatterns() {
    const size = this.size
    // 定时图案
    for (let i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }
    // 三个定位图案 + 分隔符
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)
    // 对齐图案
    const pos = alignmentPatternPositions(this.version)
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // 跳过与定位图案重叠的三个角
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        this.drawAlignment(pos[i], pos[j])
      }
    }
    // 版本信息（版本 >= 7）
    this.drawVersion()
    // 格式信息先占位，后面按掩码重画
    this.drawFormatBits(0)
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue
        this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  drawFormatBits(mask) {
    const data = (ECC[this.ecl].ordinal << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412

    // 左上角
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i))
    this.setFunctionModule(8, 7, getBit(bits, 6))
    this.setFunctionModule(8, 8, getBit(bits, 7))
    this.setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i))
    // 右上 / 左下
    const size = this.size
    for (let i = 0; i < 8; i++) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, size - 15 + i, getBit(bits, i))
    this.setFunctionModule(8, size - 8, true)
  }

  drawVersion() {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, bit)
      this.setFunctionModule(b, a, bit)
    }
  }

  drawCodewords(data) {
    const size = this.size
    let i = 0 // 已写入的位数
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue
        let invert = false
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
        }
        if (invert) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  penalty() {
    const size = this.size
    const m = this.modules
    let score = 0

    // 规则 1：同色连续 >= 5
    const runPenalty = (line) => {
      let total = 0
      let run = 1
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) {
          run++
        } else {
          if (run >= 5) total += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) total += 3 + (run - 5)
      return total
    }
    for (let y = 0; y < size; y++) score += runPenalty(m[y])
    for (let x = 0; x < size; x++) score += runPenalty(m.map((row) => row[x]))

    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x]
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3
      }
    }

    // 规则 3：1:1:3:1:1 类定位图案
    const pattern = [true, false, true, true, true, false, true]
    const hasPattern = (arr, start) => {
      for (let i = 0; i < 7; i++) if (arr[start + i] !== pattern[i]) return false
      const before = start - 4 >= 0 ? arr.slice(start - 4, start) : null
      const after = start + 11 <= arr.length ? arr.slice(start + 7, start + 11) : null
      const allLight = (seg) => seg !== null && seg.every((v) => v === false)
      return allLight(before) || allLight(after)
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x + 7 <= size; x++) if (hasPattern(m[y], x)) score += 40
    }
    for (let x = 0; x < size; x++) {
      const col = m.map((row) => row[x])
      for (let y = 0; y + 7 <= size; y++) if (hasPattern(col, y)) score += 40
    }

    // 规则 4：暗模块比例偏离 50%
    let dark = 0
    for (const row of m) for (const v of row) if (v) dark++
    const ratio = (dark * 100) / (size * size)
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10
    return score
  }
}

// ---------------------------------------------------------------- encode

/**
 * @param {string} text 要编码的内容
 * @param {{ecl?: 'L'|'M'|'Q'|'H', minVersion?: number}} options
 * @returns {{size: number, modules: boolean[][]}}
 */
export function encode(text, options = {}) {
  const ecl = options.ecl || 'M'
  const minVersion = options.minVersion || 1
  const segments = [makeBytesSegment(text)]

  let version = 0
  for (let v = Math.max(1, minVersion); v <= 40; v++) {
    const capacityBits = numDataCodewords(v, ecl) * 8
    if (totalBitsNeeded(segments, v) <= capacityBits) {
      version = v
      break
    }
  }
  if (version === 0) throw new Error('内容过长，超出版本 40 的容量')

  // 组装 bit 流
  const buffer = new BitBuffer()
  for (const seg of segments) {
    buffer.appendBits(seg.mode, 4)
    buffer.appendBits(seg.charCount, version < 10 ? 8 : 16)
    for (const b of seg.data) buffer.appendBits(b, 8)
  }
  const capacityBits = numDataCodewords(version, ecl) * 8
  buffer.appendBits(0, Math.min(4, capacityBits - buffer.length))
  buffer.appendBits(0, (8 - (buffer.length % 8)) % 8)
  for (let pad = 0xec; buffer.length < capacityBits; pad ^= 0xec ^ 0x11) buffer.appendBits(pad, 8)

  // 转成字节
  const dataCodewords = new Uint8Array(buffer.length / 8)
  for (let i = 0; i < buffer.length; i++) {
    dataCodewords[i >>> 3] |= buffer.bits[i] << (7 - (i & 7))
  }

  const codewords = addEccAndInterleave(dataCodewords, version, ecl)
  return new QrMatrix(version, ecl, codewords)
}

function addEccAndInterleave(data, version, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ECCL_INDEX[ecl]][version]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ECCL_INDEX[ecl]][version]
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks = []
  const divisor = reedSolomonComputeDivisor(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = reedSolomonComputeRemainder(dat, divisor)
    const block = new Uint8Array(shortBlockLen + 1)
    block.set(dat)
    block.set(ecc, block.length - ecc.length)
    blocks.push(block)
  }

  const result = new Uint8Array(rawCodewords)
  let index = 0
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // 短块少一个字节，跳过占位
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result[index++] = blocks[j][i]
      }
    }
  }
  return result
}

// ---------------------------------------------------------------- 输出

/**
 * 生成 SVG 字符串。四色方块用 path 合并，体积小。
 * @param {string} text
 * @param {{ecl?: string, margin?: number, width?: number, dark?: string, light?: string}} options
 */
export function toSvg(text, options = {}) {
  const margin = options.margin === undefined ? 4 : options.margin
  const dark = options.dark || '#000000'
  const light = options.light || '#ffffff'
  const { size, modules } = encode(text, options)
  const dim = size + margin * 2

  let path = ''
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!modules[y][x]) {
        x++
        continue
      }
      let end = x
      while (end < size && modules[y][end]) end++
      path += `M${x + margin} ${y + margin}h${end - x}v1h-${end - x}z`
      x = end
    }
  }

  const widthAttr = options.width ? ` width="${options.width}" height="${options.width}"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"${widthAttr} shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    '</svg>'
  )
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 生成 PNG。不需要任何图像库：灰度 8bit + 无滤波 + zlib。
 * @param {string} text
 * @param {{ecl?: string, margin?: number, scale?: number, dark?: [number,number,number], light?: [number,number,number]}} options
 */
export function toPng(text, options = {}) {
  const margin = options.margin === undefined ? 4 : options.margin
  const scale = Math.max(1, Math.round(options.scale || 8))
  const { size, modules } = encode(text, options)
  const dim = (size + margin * 2) * scale
  const darkRgb = options.dark || [0, 0, 0]
  const lightRgb = options.light || [255, 255, 255]

  const raw = Buffer.alloc((dim * 3 + 1) * dim)
  let pos = 0
  for (let py = 0; py < dim; py++) {
    raw[pos++] = 0 // filter: none
    const my = Math.floor(py / scale) - margin
    for (let px = 0; px < dim; px++) {
      const mx = Math.floor(px / scale) - margin
      const isDark = my >= 0 && my < size && mx >= 0 && mx < size && modules[my][mx]
      const rgb = isDark ? darkRgb : lightRgb
      raw[pos++] = rgb[0]
      raw[pos++] = rgb[1]
      raw[pos++] = rgb[2]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
