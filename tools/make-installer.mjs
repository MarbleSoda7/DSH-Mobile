#!/usr/bin/env node
/**
 * 把整个插件打成**一个自解压 .exe**：双击即装。
 *
 * 不需要 git、不需要 pnpm、不需要管理员、不需要 7-Zip。
 *
 * 流程：
 *   1. 把要发布的文件收进 dist/staging
 *   2. 用 node 内置能力之外的方式压成 zip —— 这里调 PowerShell 的
 *      System.IO.Compression，避免给开发机加依赖
 *   3. 用 Windows 自带的 csc.exe 编译 tools/installer/Bootstrap.cs，
 *      并把 zip 作为嵌入资源塞进去
 *
 * 用法：
 *   node tools/make-installer.mjs
 *   node tools/make-installer.mjs --no-zip     # 只准备 staging，不编译
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGING = join(DIST, 'staging')
const INSTALLER = join(ROOT, 'tools', 'installer')

/** 发布进安装包的东西。别用通配：多带一个测试文件就多一层解释成本。 */
const INCLUDE = [
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'INSTALL.md',
  'LICENSE',
  'lib',
  'web',
  'locale',
  'deploy/pc',
]

/** 开发过程中的临时产物，无论出现在哪层都别进包。 */
const DENY = [/\.broken-/i, /\.bak$/i, /\.before-turn-summary$/i, /app\.next\.js$/i, /\.probe\.mjs$/i, /__pycache__/, /\.pyc$/i, /\.log$/i]

function walk(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  const st = statSync(abs)
  if (st.isFile()) return [rel]
  return readdirSync(abs).flatMap((name) => walk(join(rel, name)))
}

function findCsc() {
  const bases = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319',
  ]
  for (const base of bases) {
    const p = join(base, 'csc.exe')
    if (existsSync(p)) return p
  }
  throw new Error('找不到 csc.exe（.NET Framework 4 自带）。')
}

function ps(script) {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'inherit',
  })
}

function main() {
  const noZip = process.argv.includes('--no-zip')

  rmSync(STAGING, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })

  const files = INCLUDE.flatMap(walk).filter((rel) => !DENY.some((re) => re.test(rel)))
  if (!files.length) throw new Error('没有可打包的文件')

  let total = 0
  for (const rel of files) {
    const to = join(STAGING, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(ROOT, rel), to)
    total += statSync(to).size
  }

  for (const name of ['install.cmd', 'Install-DshMobile.ps1']) {
    copyFileSync(join(INSTALLER, name), join(STAGING, name))
  }

  console.log(`收集 ${files.length} 个文件，共 ${(total / 1048576).toFixed(1)} MB`)

  // frpc.exe 是隧道的前提，缺了它「即插即用」就是空话，所以这里硬性拦住。
  const frpc = join(STAGING, 'deploy', 'pc', 'frpc.exe')
  if (!existsSync(frpc) || statSync(frpc).size < 1_000_000) {
    throw new Error(`deploy/pc/frpc.exe 缺失或异常（${existsSync(frpc) ? statSync(frpc).size : 0} 字节）`)
  }

  if (noZip) {
    console.log('--no-zip：staging 已就绪，停在压缩之前')
    return
  }

  const zip = join(DIST, 'payload.zip')
  rmSync(zip, { force: true })
  // 第四个参数必须是 $false：默认会把 'staging' 这层目录名也打进压缩包，
  // 解出来变成 staging\install.cmd，引导器在包根目录找不到它。
  ps(
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[IO.Compression.ZipFile]::CreateFromDirectory('${STAGING}', '${zip}', ` +
      `[IO.Compression.CompressionLevel]::Optimal, $false)`,
  )
  console.log(`zip 压缩后 ${(statSync(zip).size / 1048576).toFixed(1)} MB`)

  const out = join(DIST, 'DSH-Mobile-Setup.exe')
  rmSync(out, { force: true })
  execFileSync(
    findCsc(),
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      `/out:${out}`,
      `/resource:${zip},DSHMOBILE.ZIP`,
      '/reference:System.IO.Compression.dll',
      '/reference:System.IO.Compression.FileSystem.dll',
      join(INSTALLER, 'Bootstrap.cs'),
    ],
    { stdio: 'inherit' },
  )
  console.log(`已生成 ${relative(ROOT, out)}（${(statSync(out).size / 1048576).toFixed(1)} MB）`)
}

main()
