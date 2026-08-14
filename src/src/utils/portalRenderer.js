const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'public', 'portal.html');
// Cached once at boot - portal.html is a static file on disk, not something
// that changes per-request, so re-reading it from disk on every captive
// portal hit would be wasted I/O under load.
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const DEFAULTS = {
  businessName: 'YourNet WiFi',
  primaryColor: '#E8A33D',
  primaryColor2: '#FFC55A',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Renders the built-in portal template with a site's branding substituted
// in. If the site has portal_custom_html set, the caller should serve that
// directly instead of calling this at all - see routes using this module.
function renderPortal(site) {
  const businessName = site.portal_business_name || DEFAULTS.businessName;
  const primaryColor = site.portal_primary_color || DEFAULTS.primaryColor;
  // Flat single-color button when a tenant sets their own brand color -
  // simpler than trying to auto-generate a matching second gradient stop.
  const primaryColor2 = site.portal_primary_color || DEFAULTS.primaryColor2;

  const logoHtml = site.portal_logo_url
    ? `<img src="${escapeHtml(site.portal_logo_url)}" alt="" style="width:38px;height:38px;border-radius:10px;object-fit:cover">`
    : `<div class="box">${escapeHtml(businessName.trim().charAt(0).toUpperCase() || 'Y')}</div>`;

  const iconUrl = site.portal_logo_url || '/icons/icon-192.png';

  return TEMPLATE
    .split('{{PRIMARY_COLOR_2}}').join(escapeHtml(primaryColor2))
    .split('{{PRIMARY_COLOR}}').join(escapeHtml(primaryColor))
    .split('{{BUSINESS_NAME}}').join(escapeHtml(businessName))
    .split('{{LOGO_HTML}}').join(logoHtml)
    .split('{{ICON_URL}}').join(escapeHtml(iconUrl))
    .split('{{SITE_ID}}').join(escapeHtml(site.id));
}

function renderManifest(site) {
  const businessName = site.portal_business_name || DEFAULTS.businessName;
  const primaryColor = site.portal_primary_color || DEFAULTS.primaryColor;
  const icon = site.portal_logo_url || '/icons/icon-192.png';

  return {
    name: businessName,
    short_name: businessName.slice(0, 20),
    start_url: `/p/${site.id}`,
    scope: `/p/${site.id}`,
    display: 'standalone',
    background_color: '#080F12',
    theme_color: primaryColor,
    icons: [
      { src: icon, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: site.portal_logo_url || '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}

// Minimal offline-shell service worker: caches the portal page itself so
// reopening the installed app shows something instantly even with a weak
// or momentarily-absent connection to the router's portal server. It does
// NOT cache /redeem or /buy-voucher responses - those must always hit the
// network live, never served stale.
function renderServiceWorker(siteId) {
  const shellUrl = `/p/${siteId}`;
  const cacheName = `yournet-portal-${siteId}`;
  return `
const CACHE_NAME = '${cacheName}';
const SHELL_URL = '${shellUrl}';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL)).catch(() => {})
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
  // Never cache API calls (redemption, payment) - only the portal shell.
  if (event.request.method !== 'GET' || url.pathname !== SHELL_URL) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, res.clone())).catch(() => {});
        return res;
      })
      .catch(() => caches.match(SHELL_URL))
  );
});
`.trim();
}

module.exports = { renderPortal, renderManifest, renderServiceWorker };
