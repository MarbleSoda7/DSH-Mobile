/* 手机配对：DSH 界面左下侧边栏的手机按钮 + 二维码浮层。
 *
 * 这个文件由宿主半边注入到 DSH 的 index.html（见 lib/index.js 的 tapIndex 段），
 * 所以它跑在 DSH 页面里，和 DSH 自己同源，不用管跨域，也不依赖 React。
 *
 * 三条铁律：
 *  1. 只用原生 DOM。DSH 前端随时可能重渲染，不能挂到任何 React 组件上。
 *  2. 所有请求都打到 /mobile-pair/api/*（DSH 自己的源），绝不去碰 127.0.0.1:7788。
 *  3. 拿不到东西就静默重试，出错不许往宿主抛 —— 这是别人的页面。
 */
(() => {
  'use strict'

  const API = '/mobile-pair/api'
  const BTN_ID = 'dsh-mobile-pair-btn'
  const PANEL_ID = 'dsh-mobile-pair-panel'
  const STYLE_ID = 'dsh-mobile-pair-style'
  const POLL_MS = 3000

  // 侧边栏折叠（窄屏）时不要把按钮硬塞进去。
  let alive = true
  let observer = null
  let pollTimer = null
  let qrCode = ''
  let panelOpen = false
  let busy = false

  /* ------------------------------------------------------------ 小工具 */

  const el = (tag, props, children) => {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue
        if (key === 'style') node.setAttribute('style', value)
        else if (key === 'text') node.textContent = value
        else if (key === 'class') node.className = value
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value)
      }
    }
    for (const child of children || []) if (child) node.append(child)
    return node
  }

  const api = async (path, options) => {
    const response = await fetch(API + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
    })
    let data = null
    try {
      data = await response.json()
    } catch {}
    if (!response.ok) {
      const message = (data && data.error) || `HTTP ${response.status}`
      throw new Error(message)
    }
    return data || {}
  }

  const post = (path, body) =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

  /* ------------------------------------------------------------ 样式 */

  const CSS = `
#${BTN_ID} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; margin: 0 2px;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-text-secondary, #8a8f98);
  cursor: pointer; flex: 0 0 auto; position: relative;
  transition: background-color .15s ease, color .15s ease;
}
#${BTN_ID}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color: var(--dsw-alias-text-primary, #e6e8eb); }
#${BTN_ID} svg { width: 17px; height: 17px; display: block; }
#${BTN_ID} .dsh-mp-dot {
  position: absolute; top: 3px; right: 3px; width: 6px; height: 6px; border-radius: 50%;
  background: transparent; transition: background-color .2s ease;
}
#${BTN_ID}[data-state="on"] .dsh-mp-dot { background: #34c759; }
#${BTN_ID}[data-state="off"] .dsh-mp-dot { background: #ff9f0a; }

#${PANEL_ID} {
  position: fixed; inset: 0; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.42); backdrop-filter: blur(2px);
}
#${PANEL_ID} .dsh-mp-card {
  width: 328px; max-width: calc(100vw - 32px); box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1, #1e1f22);
  color: var(--dsw-alias-text-primary, #e6e8eb);
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.24));
  border-radius: 16px; padding: 18px 18px 14px;
  box-shadow: 0 18px 48px rgba(0,0,0,.42);
  font-size: 13px; line-height: 1.55;
}
#${PANEL_ID} .dsh-mp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
#${PANEL_ID} .dsh-mp-title { font-size: 14px; font-weight: 600; }
#${PANEL_ID} .dsh-mp-close {
  width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-text-secondary, #8a8f98); font-size: 17px; line-height: 1;
}
#${PANEL_ID} .dsh-mp-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
#${PANEL_ID} .dsh-mp-qr {
  width: 236px; height: 236px; margin: 0 auto 12px; padding: 10px; box-sizing: border-box;
  background: #fff; border-radius: 12px; display: flex; align-items: center; justify-content: center;
}
#${PANEL_ID} .dsh-mp-qr img { width: 100%; height: 100%; display: block; }
#${PANEL_ID} .dsh-mp-link {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  word-break: break-all; opacity: .72; margin-bottom: 10px; text-align: center;
}
#${PANEL_ID} .dsh-mp-status { display: flex; align-items: center; gap: 7px; font-size: 12px; margin-bottom: 4px; }
#${PANEL_ID} .dsh-mp-status i { width: 7px; height: 7px; border-radius: 50%; background: #8a8f98; flex: 0 0 auto; }
#${PANEL_ID} .dsh-mp-status[data-state="on"] i { background: #34c759; }
#${PANEL_ID} .dsh-mp-status[data-state="off"] i { background: #ff9f0a; }
#${PANEL_ID} .dsh-mp-hint { font-size: 12px; opacity: .6; margin-bottom: 10px; }
#${PANEL_ID} .dsh-mp-actions { display: flex; gap: 8px; justify-content: flex-end; }
#${PANEL_ID} .dsh-mp-btn {
  height: 30px; padding: 0 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28));
  background: transparent; color: inherit;
}
#${PANEL_ID} .dsh-mp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
#${PANEL_ID} .dsh-mp-btn[disabled] { opacity: .45; cursor: default; }
`

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return
    document.head.append(el('style', { id: STYLE_ID, text: CSS }))
  }

  /* ------------------------------------------------------------ 侧边栏插槽 */

  // 先找动作区（原生侧边栏是 footerActions，codex-ui 皮肤是 dcu-footer-actions），
  // 拿不到就退回整个 footer 区域，最差挂到 body 上，保证按钮一定出现。
  const findHost = () => {
    if (!document.body) return null
    const selectors = ['[class*="footerActions"]', '[class*="footer-actions"]', '[class*="footArea"]', '[class*="foot-area"]']
    for (const selector of selectors) {
      const node = document.querySelector(selector)
      if (node) return node
    }
    return null
  }

  const mount = () => {
    if (!alive) return
    const button = document.getElementById(BTN_ID)
    const host = findHost()
    if (!host) {
      if (!button) return
      button.remove()
      return
    }
    if (button && button.parentElement === host) return
    if (button) button.remove()
    host.append(makeButton())
  }

  const scheduleMount = () => {
    if (!alive) return
    // 用 rAF 合流：React 一次重渲染可能触发几十次 mutation。
    if (scheduleMount.pending) return
    scheduleMount.pending = true
    requestAnimationFrame(() => {
      scheduleMount.pending = false
      mount()
    })
  }

  const PHONE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/>' +
    '<path d="M10.6 18.6h2.8"/>' +
    '</svg>'

  const makeButton = () => {
    const button = el('button', {
      id: BTN_ID,
      type: 'button',
      title: '手机配对',
      'aria-label': '手机配对',
    })
    button.innerHTML = PHONE_ICON + '<span class="dsh-mp-dot"></span>'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openPanel()
    })
    return button
  }

  /* ------------------------------------------------------------ 浮层 */

  const closePanel = () => {
    panelOpen = false
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.remove()
    document.removeEventListener('keydown', onKeydown)
  }

  const onKeydown = (event) => {
    if (event.key === 'Escape') closePanel()
  }

  const openPanel = () => {
    ensureStyle()
    if (document.getElementById(PANEL_ID)) {
      closePanel()
      return
    }
    panelOpen = true

    const qrBox = el('div', { class: 'dsh-mp-qr' })
    const linkLine = el('div', { class: 'dsh-mp-link', text: '正在生成二维码…' })
    const statusDot = el('i')
    const statusText = el('span', { text: '连接中…' })
    const statusRow = el('div', { class: 'dsh-mp-status', 'data-state': '' }, [statusDot, statusText])
    const hintLine = el('div', { class: 'dsh-mp-hint', text: '' })
    const revokeBtn = el('button', { class: 'dsh-mp-btn', type: 'button', text: '撤销其他设备' })
    const refreshBtn = el('button', { class: 'dsh-mp-btn', type: 'button', text: '换一个二维码' })
    const closeBtn = el('button', { class: 'dsh-mp-btn', type: 'button', text: '关闭' })

    const setStatus = (state, text) => {
      statusRow.dataset.state = state || ''
      statusText.textContent = text
    }

    const paintDevices = (devices) => {
      const active = (devices || []).filter((row) => !row.revoked)
      if (active.length === 0) {
        setStatus('off', '当前没有已绑定的手机')
        hintLine.textContent = '用手机相机扫描上面的二维码即可绑定。'
        revokeBtn.disabled = true
        return
      }
      const latest = active.slice().sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0]
      const seen = latest.lastSeenAt ? new Date(latest.lastSeenAt) : null
      const when = seen ? `${seen.getHours()}:${String(seen.getMinutes()).padStart(2, '0')}` : ''
      setStatus('on', `已连接 ${active.length} 台${when ? ` · 最近 ${when}` : ''}`)
      hintLine.textContent = `${latest.name || '手机'} · 已配对，可以直接在手机上接管`
      revokeBtn.disabled = active.length < 2
    }

    const loadCode = async (force) => {
      if (busy) return
      busy = true
      refreshBtn.disabled = true
      try {
        // force 只用来表达「这是用户主动要的」，服务端每次都发新码，这里不需要参数。
        void force
        const data = await api('/code')
        qrCode = data.code || ''
        linkLine.textContent = data.url || ''
        qrBox.replaceChildren(
          el('img', {
            src: `${API}/qr.svg?t=${encodeURIComponent(qrCode)}&_=${Date.now()}`,
            alt: '手机配对二维码',
          }),
        )
      } catch (error) {
        linkLine.textContent = '二维码生成失败'
        qrBox.replaceChildren(el('div', { class: 'dsh-mp-hint', text: String(error.message || error) }))
      } finally {
        busy = false
        refreshBtn.disabled = false
      }
    }

    let wasEmpty = true

    const poll = async () => {
      if (!panelOpen) return
      let active = []
      try {
        const data = await api('/state')
        active = (data.devices || []).filter((row) => !row.revoked)
        paintDevices(data.devices)
      } catch (error) {
        setStatus('off', '连不上本机服务')
        hintLine.textContent = String(error.message || error)
        return
      }
      // 刚绑上一台就把二维码换掉：配对码是一次性的，留着会误导下一个人再扫一次。
      if (active.length > 0 && wasEmpty) loadCode(true)
      wasEmpty = active.length === 0
      if (active.length === 0) hintLine.textContent = '用手机相机扫描上面的二维码即可绑定。'
    }

    refreshBtn.addEventListener('click', () => {
      loadCode(true)
    })
    closeBtn.addEventListener('click', closePanel)
    revokeBtn.addEventListener('click', async () => {
      revokeBtn.disabled = true
      try {
        await post('/revoke', {})
      } catch (error) {
        hintLine.textContent = String(error.message || error)
      }
      revokeBtn.disabled = false
      poll()
    })

    const card = el('div', { class: 'dsh-mp-card' }, [
      el('div', { class: 'dsh-mp-head' }, [
        el('div', { class: 'dsh-mp-title', text: '手机配对' }),
        el('button', { class: 'dsh-mp-close', type: 'button', text: '×', onclick: closePanel, 'aria-label': '关闭' }),
      ]),
      qrBox,
      linkLine,
      statusRow,
      hintLine,
      el('div', { class: 'dsh-mp-actions' }, [revokeBtn, refreshBtn, closeBtn]),
    ])

    const panel = el('div', { id: PANEL_ID }, [card])
    panel.addEventListener('click', (event) => {
      if (event.target === panel) closePanel()
    })
    document.body.append(panel)
    document.addEventListener('keydown', onKeydown)

    loadCode(false)
    poll()
    pollTimer = setInterval(poll, POLL_MS)
  }

  /* ------------------------------------------------------------ 启动 */

  const boot = () => {
    ensureStyle()
    mount()
    observer = new MutationObserver(scheduleMount)
    observer.observe(document.body, { childList: true, subtree: true })
    setInterval(scheduleMount, 2000)
  }

  // 宿主热重载时会再注入一次：先把上一份的自己拆干净。
  const previous = window.__dshMobilePairPanel
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose()
    } catch {}
  }
  window.__dshMobilePairPanel = {
    dispose() {
      alive = false
      closePanel()
      if (observer) observer.disconnect()
      observer = null
      for (const node of document.querySelectorAll(`#${BTN_ID}, #${PANEL_ID}, #${STYLE_ID}`)) node.remove()
    },
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
