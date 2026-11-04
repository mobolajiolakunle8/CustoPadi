// Cache public app files only. CustoPadi has no Firebase or other backend:
// all accounts and customer records stay in the browser's local storage.
const VERSION = 'CP-SYNC-5';
const CACHE = 'custopadi-sync-5';
const ROOT = new URL('./', self.location.href);
const PAGE = new URL('index.html', ROOT).href;
const STATIC_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const LOCAL_FILES = new Set(['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'logo.png', 'logo.svg', 'logo.webp', 'logo.jpg', 'logo.jpeg']);
const SDK = 'https://www.gstatic.com/firebasejs/13.1.0/';

function isAppPage(url) {
  return url.origin === ROOT.origin && (url.pathname === ROOT.pathname || url.pathname === new URL(PAGE).pathname);
}
function isStaticAsset(url) {
  if (url.origin === ROOT.origin && url.pathname.startsWith(ROOT.pathname)) {
    return LOCAL_FILES.has(url.pathname.slice(ROOT.pathname.length));
  }
  return STATIC_HOSTS.has(url.hostname) || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
}
async function fetchWithTimeout(request, milliseconds = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  try { return await fetch(request, { signal: controller.signal, cache: 'no-store' }); }
  finally { clearTimeout(timeout); }
}
async function savePublicFile(cache, request, response) {
  if (response && (response.ok || response.type === 'opaque')) {
    try { await cache.put(request, response.clone()); } catch (error) { /* A full cache must not break a live response. */ }
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const page = await fetchWithTimeout(PAGE);
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('App page unavailable');
    await cache.put(PAGE, page);
    const optional = [
      ...Array.from(LOCAL_FILES).filter(name => !name.startsWith('logo.')).map(name => new URL(name, ROOT).href),
      'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
      SDK + 'firebase-app.js', SDK + 'firebase-auth.js', SDK + 'firebase-database.js'
    ];
    await Promise.all(optional.map(async url => {
      try { await savePublicFile(cache, url, await fetchWithTimeout(url)); } catch (error) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only retire CustoPadi asset caches, not other caches, IndexedDB, or localStorage.
    await Promise.all(keys.filter(key => key.startsWith('custopadi-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach(client => client.postMessage({ type: 'CUSTOPADI_UPDATED', version: VERSION }));
  })());
});

async function loadPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(request);
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      await savePublicFile(cache, PAGE, response);
      return response;
    }
    return (await cache.match(PAGE)) || response;
  } catch (error) {
    return (await cache.match(PAGE)) || new Response('CustoPadi is not available offline yet. Reconnect and refresh.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isAppPage(url) && (request.mode === 'navigate' || request.destination === 'document')) {
    event.respondWith(loadPage(request));
    return;
  }
  // Identity Toolkit, Secure Token, the Realtime Database endpoint, and analytics use
  // the real network; only the Firebase SDK code files are cached.
  if (!isStaticAsset(url)) return;
  const refresh = caches.open(CACHE).then(async cache => {
    try {
      const response = await fetchWithTimeout(request);
      await savePublicFile(cache, request, response);
      return response;
    } catch (error) {
      return (await cache.match(request)) || new Response('', { status: 503, statusText: 'Offline' });
    }
  });
  event.waitUntil(refresh.then(() => {}).catch(() => {}));
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) || refresh));
});
