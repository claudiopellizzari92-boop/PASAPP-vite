const CACHE = 'porta-al-sole-v1';

const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/customcolor_text-logoname_transparent_background.png',
  '/customcolor_icon_transparent_background.png',
];

// Install - cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - API calls: network first, fall back to cache
// - Static assets: cache first, fall back to network
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls - network first
  if (url.pathname.startsWith('/api/') || url.hostname.includes('onrender.com') || url.hostname.includes('supabase')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Cache successful GET responses
          if (e.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets - cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
