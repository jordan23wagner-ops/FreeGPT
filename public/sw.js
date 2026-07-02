// Chatwillow service worker.
//
// Strategy (deliberately conservative — a chat app needs the network anyway):
//   - Navigations (the HTML document): NETWORK-FIRST. This guarantees a new deploy
//     loads immediately when online; the cached copy is only an offline fallback.
//   - Hashed static assets (/assets/index-<hash>.js etc.): CACHE-FIRST. Vite changes
//     the hash on every build, so a cached asset is immutable and safe to keep.
//   - API calls + non-GET: never touched.
//
// The previous version was cache-first for *everything*, including index.html. After a
// deploy the cached HTML pointed at old asset hashes that 404'd, and the fetch handler
// returned index.html in their place — so the browser got HTML where it expected JS and
// rendered a blank page. Bumping CACHE_NAME below purges that poisoned cache on activate.

const CACHE_NAME = 'chatwillow-v1'

self.addEventListener('install', () => {
  // Take over as soon as possible so fixes reach users without a manual unregister.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request

  // Leave API calls and non-GET requests entirely to the network.
  if (req.method !== 'GET' || req.url.includes('/api/')) return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Page loads: network-first, fall back to the last good HTML when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((c) => c.put('/index.html', copy))
          return res
        })
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  // Static assets: serve from cache if present, otherwise fetch and cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((c) => c.put(req, copy))
        }
        return res
      })
    })
  )
})
