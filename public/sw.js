// YourNet Control - admin app shell service worker.
// Caches the static shell (CSS/JS/icons) plus the dashboard page itself, so
// reopening the installed app shows something instantly on a weak
// connection. Deliberately does NOT cache /api/* responses - those must
// always hit the network live, same rule the per-site portal sw.js follows.
const CACHE_NAME = 'yournet-admin-shell-v4';
const SHELL_FILES = [
  '/dashboard.html',
  '/shell.js',
  '/shell.css',
  '/fontsize.js',
  '/img/logo-icon.png',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only ever serve cached GETs for the known shell files - everything
  // else (API calls, other pages) always goes to the network.
  if (event.request.method !== 'GET' || !SHELL_FILES.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
