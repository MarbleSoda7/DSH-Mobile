/* 只缓存外壳；业务数据由页面自己写 IndexedDB，永远不走 SW 缓存。
 * v2：提版本强制换掉旧外壳；app.js/style.css 走 network-first——原来 stale-while-revalidate
 * 会先回旧的、再后台更新，手机上改完前端要刷两次才生效。
 * v4：恢复被误覆盖的 app.js 时一并提版本，确保所有已装 PWA 丢掉旧外壳。
 * v7：Markdown 视觉重做 + 过程行类名修正 + 翻页重试，同样必须丢掉旧 CSS。
 * v9：排队条改为单条 + 上下滑动切换；过程行/滚动容器修正。
 * v15：过程行改为两级折叠（「已完成」一级收起 → 点开露缩略 → 再点露全文）。
 * v16：本地文件引用渲染成"文件名+后缀"芯片（点击复制路径），不再铺开绝对路径。
 * v17：过程行挪到「已完成」标题下方——一级展开往下长，标题原地不动。
 * v18：行内代码里的纯路径保持原样（只把"链接形式"的文件引用渲染成芯片）。
 * v19：排队/插话支持发图片（纯图片消息不再被丢、排队行显示张数、长按发送键插话）。 */
const SHELL = 'dsh-mobile-shell-v22'
const FILES = ['/', '/index.html', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest']
// 入口资源必须"先要网络"：装成 PWA 后只靠缓存回退，永远看不到修复后的代码。
const NETWORK_FIRST = new Set(['/', '/index.html', '/app.js', '/style.css'])

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname === '/admin' || url.pathname === '/admin.html') return
  // sw.js 自己永远不能被缓存命中，否则旧 SW 永远换不掉。
  if (url.pathname === '/sw.js') {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => caches.match(request)))
    return
  }

  if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      }).catch(() => caches.match(request).then((hit) => hit || Response.error())),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      }).catch(() => hit || Response.error())
      return hit || network
    }),
  )
})
