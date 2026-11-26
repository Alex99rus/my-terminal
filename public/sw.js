// Service worker — нужен, чтобы терминал можно было установить как приложение
// и чтобы он открывался быстро (файлы сайта берутся из памяти телефона).
// Данные бирж не кэшируем никогда — они всегда свежие.
const CACHE = 'my-terminal-v2'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return // биржи и прочее — напрямую
  if (url.pathname.includes('/help/') || url.pathname.includes('/locked/')) return // видеоинструкция — напрямую (так работает перемотка)

  // Страница: сначала из интернета (чтобы обновления приходили сразу), без связи — из памяти
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./')),
    )
    return
  }
  // Файлы сайта (у них в имени есть отпечаток, они не меняются): из памяти, иначе скачать и запомнить
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})

// Уведомления с сервера (сигнал о цене): приходят, даже когда терминал закрыт
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || '🔔 Оповещение', {
      body: d.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'alert-' + Date.now(),
      vibrate: [200, 100, 200],
      data: { url: d.url || './' },
    }),
  )
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const c = list[0]
      return c ? c.focus() : self.clients.openWindow(e.notification.data?.url || './')
    }),
  )
})
