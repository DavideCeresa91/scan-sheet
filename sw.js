const PREFIX = 'scan-sheet:' + new URL(self.registration.scope).pathname + ':';
const CACHE = PREFIX + 'v1.0.0';
const FILES = ['./','./index.html','./style.css','./app.js','./storage.js','./transport.js',
  './manifest.webmanifest','./vendor/zxing-browser-0.2.1.min.js','./icons/icon.svg',
  './icons/icon-192.png','./icons/icon-512.png','./icons/maskable-512.png','./icons/apple-touch-icon.png'];
const urls = new Set(FILES.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  // Cache only app assets. Google requests and user records are never cached here.
  if (event.request.method !== 'GET' || !urls.has(event.request.url)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
