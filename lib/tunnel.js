// 自带隧道：不依赖任何外部二进制（frpc / ssh / ngrok 全都不需要）。
//
// 背景：以前要把本机的 127.0.0.1:7788 借到服务器的 9xxx 端口，用的是 frpc.exe
// （15 MB 的 Go 二进制）。问题不仅是体积——用户从 GitHub 装插件时那个 exe
// 常常根本没跟着下来，于是「端口申请到了，但服务器上没人监听」，
// 手机扫码只看到「网页拒绝了您的访问」，而且查不出原因。
//
// 现在的做法：这台机器主动连到服务器的隧道控制端口，服务器接纳之后从自己的
// 9xxx 端口开监听；手机连 9xxx 时，服务器通过控制通道告诉我们「来了第 N 条连接」，
// 我们再为它开一条数据 WebSocket，把字节原样喂给本机 7788，反之亦然。
// 全程只用 node:http / node:net / node:crypto，零外部依赖。
//
// 为什么是「控制 + 每条连接一条数据」而不是一条 WebSocket 全包：
// 手机浏览器在同一个 host 下会开多条并行 TCP（SSE 长连接、翻页、图片），
// 单条 WS 无法区分哪段字节属于哪条连接，会把 A 的响应写进 B。
// 分离之后职责清晰，也不会串流。
//
// 协议详见 deploy/vps/tunnel.py 顶部注释。

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 把 Buffer 编码成客户端 → 服务器的 WebSocket 帧（必须加掩码）。 */
function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length
  const mask = randomBytes(4)
  let header
  if (len < 126) {
    header = Buffer.alloc(6)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | len
    mask.copy(header, 2)
  } else if (len < 65536) {
    header = Buffer.alloc(8)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
    mask.copy(header, 4)
  } else {
    header = Buffer.alloc(14)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
    mask.copy(header, 10)
  }
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, masked])
}

/** 增量解析 WebSocket 帧。TCP 会把帧切碎或粘连，所以必须缓存。 */
function createFrameParser(onMessage) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (buf.length < 2) return
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (buf.length < offset + maskLen + len) return
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
      if (masked) {
        const mask = buf.subarray(offset, offset + 4)
        const copy = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i & 3]
        payload = copy
      } else {
        payload = Buffer.from(payload)
      }
      buf = buf.subarray(offset + maskLen + len)
      if (fin) onMessage(opcode, payload)
    }
  }
}

/** 建立一条到服务器的 WebSocket 连接（标准 HTTP Upgrade）。 */
export function openSocket({ host, port, path, token, connId, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64')
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      // token 走 header 而不是 URL：URL 会进服务器访问日志。
      'x-dsh-token': token,
    }
    if (connId) headers['x-dsh-conn'] = String(connId)
    const req = httpRequest(
      { host, port, path, method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          if (body.length < 400) body += d.toString('utf8')
        })
        res.on('end', () => {
          reject(new Error(`隧道握手被拒：HTTP ${res.statusCode} ${body.slice(0, 200)}`))
        })
      },
    )
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        reject(new Error('隧道握手校验失败（Sec-WebSocket-Accept 不匹配）'))
        return
      }
      resolve({ socket, head: head || Buffer.alloc(0) })
    })
    req.on('timeout', () => req.destroy(new Error('隧道握手超时')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 隧道客户端：连上服务器 → 拿到端口 → 为每条入站连接开一条数据通道。
 *
 * cfg: { host, port, path, dataPath, token, localPort }
 */
export function createTunnel({ log = () => {} } = {}) {
  let stopped = true
  let cfg = null
  let control = null
  let retry = 2000
  let timer = null
  let state = 'off'
  let lastError = ''
  const dataConns = new Map()

  const setState = (next, error) => {
    if (state !== next) {
      state = next
      log(`隧道状态：${next}${error ? `（${error}）` : ''}`)
    }
    if (error) lastError = String(error)
  }

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const scheduleReconnect = (why) => {
    if (stopped) return
    setState('off', why)
    clearTimer()
    timer = setTimeout(connectOnce, retry)
    if (typeof timer.unref === 'function') timer.unref()
    retry = Math.min(Math.round(retry * 1.6), 30000)
  }

  /** 一条入站连接的数据通道：服务器 9xxx ↔ 本机 localPort。 */
  const openDataConn = async (connId) => {
    // 顺序很重要：先把数据通道（ws）建好、挂上监听，再去连本机服务。
    // 反过来做的话，本机服务可能在我们挂上 'data' 之前就把响应写出来，
    // 那一批字节直接被丢掉，手机侧只看到 ECONNRESET。
    let ws = null
    let local = null
    try {
      const opened = await openSocket({
        host: cfg.host,
        port: cfg.port,
        path: cfg.dataPath,
        token: cfg.token,
        connId,
      })
      ws = opened.socket

      local = netConnect({ host: '127.0.0.1', port: cfg.localPort })
      local.on('error', (error) => log(`[conn#${connId}] 本机服务连不上：`, error?.message || error))
      dataConns.set(connId, { ws, local })

      const parse = createFrameParser((opcode, payload) => {
        if (opcode === 0x2 || opcode === 0x0 || opcode === 0x1) {
          if (local && !local.destroyed) local.write(payload)
        } else if (opcode === 0x8) {
          if (local && !local.destroyed) local.end()
        }
      })
      // 先挂 ws 的监听，再让 local 流动：两个方向都不能漏字节。
      ws.on('data', parse)
      ws.on('error', (error) => log(`[conn#${connId}] 数据通道错误：`, error?.message || error))
      ws.on('close', () => {
        if (local && !local.destroyed) local.end()
        dataConns.delete(connId)
      })
      local.on('data', (chunk) => {
        if (ws && !ws.destroyed) ws.write(encodeFrame(chunk))
      })
      local.on('close', () => {
        if (ws && !ws.destroyed) {
          ws.write(encodeFrame(Buffer.alloc(0), 0x8))
          ws.end()
        }
        dataConns.delete(connId)
      })

      // 握手时服务器可能已经带回了 backlog 字节，现在 local 有了再补写。
      if (opened.head.length && !local.destroyed) local.write(opened.head)
    } catch (error) {
      log(`[conn#${connId}] 数据通道建立失败：`, error?.message || error)
      if (ws) ws.destroy()
      if (local && !local.destroyed) local.destroy()
      dataConns.delete(connId)
    }
  }

  const connectOnce = async () => {
    if (stopped || !cfg) return
    setState('connecting')
    let ws = null
    try {
      const opened = await openSocket({
        host: cfg.host,
        port: cfg.port,
        path: cfg.path,
        token: cfg.token,
      })
      if (stopped) {
        opened.socket.destroy()
        return
      }
      ws = opened.socket
      control = ws
      retry = 2000
      ws.write(
        encodeFrame(
          Buffer.from(JSON.stringify({ t: 'hello', token: cfg.token, port: cfg.publicPort || 0 })),
          0x1,
        ),
      )
      const parse = createFrameParser((opcode, payload) => {
        if (opcode === 0x1) {
          let msg = null
          try {
            msg = JSON.parse(payload.toString('utf8'))
          } catch {
            return
          }
          if (!msg) return
          if (msg.t === 'ready') {
            setState('on')
            log(`服务器已开放端口 ${msg.port}`)
          } else if (msg.t === 'error') {
            setState('off', msg.msg)
            log('服务器拒绝：', msg.msg)
          } else if (msg.t === 'open') {
            openDataConn(msg.id)
          } else if (msg.t === 'close') {
            const entry = dataConns.get(msg.id)
            if (entry) {
              if (!entry.local.destroyed) entry.local.end()
              try {
                entry.ws.destroy()
              } catch {}
              dataConns.delete(msg.id)
            }
          }
        } else if (opcode === 0x8) {
          ws.destroy()
        }
      })
      if (opened.head.length) parse(opened.head)
      ws.on('data', parse)
      ws.on('error', (error) => log('隧道错误：', error?.message || error))
      ws.on('close', () => {
        control = null
        for (const [id, entry] of dataConns) {
          try {
            if (!entry.local.destroyed) entry.local.end()
            entry.ws.destroy()
          } catch {}
          dataConns.delete(id)
        }
        scheduleReconnect('控制通道关闭')
      })
    } catch (error) {
      if (ws) {
        try {
          ws.destroy()
        } catch {}
      }
      scheduleReconnect(error?.message || '握手失败')
    }
  }

  return {
    /** 启动并保持连接。 */
    start(nextCfg) {
      cfg = nextCfg
      stopped = false
      retry = 2000
      clearTimer()
      connectOnce()
    },
    /** 停止，不再重连。 */
    stop() {
      stopped = true
      clearTimer()
      for (const [id, entry] of dataConns) {
        try {
          if (!entry.local.destroyed) entry.local.end()
          entry.ws.destroy()
        } catch {}
        dataConns.delete(id)
      }
      if (control) {
        try {
          control.destroy()
        } catch {}
        control = null
      }
      cfg = null
      setState('off')
    },
    get running() {
      return state === 'on'
    },
    get status() {
      return { state, error: lastError, conns: dataConns.size, port: cfg?.publicPort || 0 }
    },
  }
}
