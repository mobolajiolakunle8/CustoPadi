// CustoPadi offline helper. Lets the app open even without internet.
// Business records are NOT kept here. Firebase keeps those safe and in sync.
const CACHE = 'custopadi-v2';
const FB = 'https://www.gstatic.com/firebasejs/13.1.0/';
const CORE = [
  './', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  FB + 'firebase-app.js', FB + 'firebase-auth.js', FB + 'firebase-firestore.js',
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];
// Only these outside sites are saved for offline use (app code, styles, fonts, icons).
// Firebase logins, records and analytics always go straight to the internet.
const STATIC_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app page: use the internet first, the saved copy when offline.
  if (req.mode === 'navigate') {
    if (url.origin !== location.origin || url.pathname.startsWith('/__/')) return;
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && /\/(index\.html)?$/.test(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  const sameOrigin = url.origin === location.origin && !url.pathname.startsWith('/__/');
  const staticFile = STATIC_HOSTS.includes(url.host) && (url.host !== 'www.gstatic.com' || url.pathname.startsWith('/firebasejs/'));
  if (!sameOrigin && !staticFile) return;

  // App files: use the saved copy right away, refresh it in the background.
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
