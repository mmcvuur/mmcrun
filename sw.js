const CACHE_NAME = 'mmcrun-v15';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/dashboard',
  '/dashboard.html',
  '/coach',
  '/coach.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/vendor/uPlot.iife.min.js',
  '/vendor/uPlot.min.css',
  '/fonts/JetBrainsMono[wght].woff2',
  '/fonts/JetBrainsMono-Regular.woff2',
  '/fonts/JetBrainsMono-Medium.woff2',
  '/fonts/JetBrainsMono-SemiBold.woff2',
  '/fonts/JetBrainsMono-Bold.woff2',
  '/fonts/JetBrainsMono-ExtraBold.woff2',
  '/icons/favicon.ico',
  '/icons/favicon-16x16.png',
  '/icons/favicon-32x32.png',
  '/icons/apple-touch-icon.png',
  '/icons/android-chrome-192x192.png',
  '/icons/android-chrome-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Network-first for API requests with offline cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for fonts & icons (immutable assets)
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Network-first with cache fallback for app shell files
  event.respondWith(
    fetch(request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then(res => res || caches.match('/index.html')))
  );
});
