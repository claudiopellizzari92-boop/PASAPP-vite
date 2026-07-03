const CACHE = 'porta-al-sole-v2';

// Solo íconos y manifest — recursos que NO cambian de nombre entre deploys.
// OJO: no cacheamos '/' ni '/index.html' aquí a propósito (van por red primero).
const STATIC = [
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/customcolor_text-logoname_transparent_background.png',
  '/customcolor_icon_transparent_background.png',
];

// Install - cachear íconos, tolerante a que falte alguno
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(STATIC.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

// Activate - borrar cachés viejos y tomar control de inmediato
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo manejamos GET; el resto va directo a la red
  if (req.method !== 'GET') return;

  // 1) API - siempre a la red (sin cachear, para no servir datos viejos)
  if (url.pathname.startsWith('/api/') || url.hostname.includes('onrender.com') || url.hostname.includes('supabase')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Solo cacheamos cosas de nuestro propio origen
  const sameOrigin = url.origin === self.location.origin;

  // 2) Navegación / HTML - NETWORK FIRST.
  //    Esto es lo que arregla la pantalla negra: el index.html siempre
  //    se pide fresco, así apunta a los JS nuevos del último deploy.
  //    Si no hay red, caemos al index.html cacheado (modo offline).
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put('/index.html', clone));
          return res;
        })
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  // 3) Assets con hash de Vite (/assets/*.js, *.css) - CACHE FIRST.
  //    Su nombre cambia cuando cambia el contenido, así que es seguro
  //    cachearlos para siempre. Si no está en caché, se busca en red.
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // 4) Todo lo demás (dominios externos): red directa
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
