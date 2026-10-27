// 验证 /api/dev/reload：apply → 重载 → 仍然对外服务。
// 目的：确认"改完服务端代码不必重启 DSH"这条后路真的可用。
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'mobile-reload-'))
const handlers = new Map()
const logs = []

const controller = {
  async list() {
    return { items: [] }
  },
  async projections() {
    return { kind: 'sequenced', asOfSeq: 0, values: {} }
  },
}

const ctx = {
  on(name, handler) {
    handlers.set(name, handler)
    return () => {}
  },
  effect() {
    return () => {}
  },
  get(name) {
    if (name === 'sessionController') return controller
    return undefined
  },
  sessionController: controller,
}

const originalLog = console.log
console.log = (...args) => {
  logs.push(args.join(' '))
  originalLog(...args)
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
await mod.apply(ctx, { host: '127.0.0.1', port: 7803, stateDir, publicOrigin: 'http://127.0.0.1:7803' })
await new Promise((resolve) => setTimeout(resolve, 400))

const health = async () => {
  const response = await fetch('http://127.0.0.1:7803/api/health')
  return response.json()
}

const before = await health()
console.log('[probe] before reload rev=' + before.rev)

const reload = await fetch('http://127.0.0.1:7803/api/dev/reload', { method: 'POST' })
console.log('[probe] reload status=' + reload.status)
await new Promise((resolve) => setTimeout(resolve, 1200))

let after = null
for (let i = 0; i < 10; i += 1) {
  try {
    after = await health()
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}
console.log('[probe] after reload rev=' + (after?.rev || 'none') + ' ok=' + String(after?.ok))
console.log('[probe] reload log seen=' + String(logs.some((line) => line.includes('reloaded from'))))

const second = await fetch('http://127.0.0.1:7803/api/dev/reload', { method: 'POST' })
console.log('[probe] second reload status=' + second.status)
await new Promise((resolve) => setTimeout(resolve, 1200))
let third = null
for (let i = 0; i < 10; i += 1) {
  try {
    third = await health()
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}
console.log('[probe] after second reload ok=' + String(third?.ok))

// 自动重载：碰一下文件 mtime，2 秒轮询应当自己重载一次。
const selfPath = new URL('../lib/index.js', import.meta.url)
const now = new Date()
utimesSync(selfPath, now, now)
console.log('[probe] touched file, waiting for auto reload')
await new Promise((resolve) => setTimeout(resolve, 3500))
let fourth = null
for (let i = 0; i < 10; i += 1) {
  try {
    fourth = await health()
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}
console.log('[probe] after auto reload ok=' + String(fourth?.ok))
console.log('[probe] auto reload seen=' + String(logs.some((line) => line.includes('detected change'))))

console.log = originalLog
try {
  rmSync(stateDir, { recursive: true, force: true })
} catch {}
process.exit(0)
