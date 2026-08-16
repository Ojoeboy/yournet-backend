// YourNet Control - admin app shell service worker.
// Caches the static shell (CSS/JS/icons) plus the dashboard page itself, so
// reopening the installed app shows something instantly on a weak
// connection. Deliberately does NOT cache /api/* responses - those must
// always hit the network live, same rule the per-site portal sw.js follows.
//
// v5: was pure cache-first (serve the cached file forever, never re-check
// the network) for SHELL_FILES - including shell.js/shell.css, which is
// where nav/layout features actually live. That meant once a device had
// these cached, a later deploy that changed shell.js/shell.css NEVER
// reached it: the browser's own SW-update check only re-runs `install`
// when sw.js's OWN bytes change, not when the files IT LISTS change - so
// editing shell.js alone was invisible to already-installed users
// indefinitely (this is what caused the bottom nav to go missing on
// license-admin.html for an already-installed session, even though the
// current shell.js/shell.css on the server were correct). Switched to
// stale-while-revalidate: still serve the cached copy immediately (same
// instant-load-on-weak-connection behavior as before), but ALWAYS kick off
// a network fetch in the background to refresh the cache for next time -
// so a stale shell now self-heals within one extra reload instead of
// staying wrong forever. CACHE_NAME is bumped so anyone already stuck on
// the old cache-first entries gets a clean cutover on next activate,
// rather than stale-while-revalidate reading from an already-stale v4
// cache as its own "cached" baseline.
const CACHE_NAME = 'yournet-admin-shell-v5';
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

  event.respondWith(handleShellFetch(event));
});

async function handleShellFetch(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);

  // Always fire the network request, regardless of whether we have a
  // cached copy to answer with immediately - this is what actually fixes
  // the staleness bug. A successful response replaces whatever was
  // cached, so the NEXT visit (or this one, on a cache miss) gets the
  // current file instead of whatever was cached at `install` time.
  const networkFetch = fetch(event.request)
    .then((response) => {
      if (response && response.ok) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null); // offline - fall through to whatever's cached, if anything

  // Without this, returning `cached` below ends the fetch event as far as
  // the browser's concerned, and it's free to kill this worker before the
  // background networkFetch/cache.put above ever finishes - silently
  // undoing the whole point of this rewrite. waitUntil tells it to keep
  // this worker alive until that background refresh settles, even though
  // the response itself was already sent from cache.
  event.waitUntil(networkFetch);

  if (cached) return cached; // instant response, same as before - background refresh already in flight
  const fresh = await networkFetch;
  if (fresh) return fresh;
  // No cache AND no network (first-ever load, offline) - nothing left to serve.
  return new Response('Offline and not yet cached.', { status: 503, statusText: 'Offline' });
}
