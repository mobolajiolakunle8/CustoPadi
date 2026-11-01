// CustoPadi offline helper. Lets the app open even without internet.
// It must NOT touch Firebase's live connections (login, database, analytics).
const CACHE = 'custopadi-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
const CACHE_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

function cacheable(url) {
  if (url.origin === self.location.origin) return true;
  if (CACHE_HOSTS.includes(url.host)) return true;
  if (url.host === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) return true;
  return false; // firestore.googleapis.com, identitytoolkit, analytics, etc. go straight to the network
}

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

  // Pages: try the internet first, fall back to the saved copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (!cacheable(url)) return;

  // App files, fonts, styles, Firebase code: use saved copy, update in background.
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
