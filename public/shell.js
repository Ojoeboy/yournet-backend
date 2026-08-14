// YourNet Control - shared sidebar nav. Include after shell.css, and put
// <div id="app-sidebar"></div> as the first child of a .app-shell wrapper.
// Each page passes its own key (matching NAV_ITEMS below) as
// window.YOURNET_ACTIVE_NAV before this script runs, so the right item
// gets highlighted.
(function () {
  // "primary: true" items appear in the mobile bottom bar. Everything
  // (primary and secondary alike) also appears in the slide-out drawer,
  // opened via the bottom bar's "More" button, so nothing is ever only
  // reachable one way.
  // Help links are plain external contacts (email/WhatsApp/phone), not
  // in-app pages - update HELP_CONTACT below with the real details before
  // shipping; nothing else needs to change.
  const HELP_CONTACT = {
    email: 'support@example.com',
    whatsappNumber: '233000000000', // digits only, country code, no leading +
    phoneNumber: '+233000000000',
  };

  // "section" groups items in the desktop vertical sidebar only (see
  // buildNavGroups/render below). It has no effect on the mobile bottom
  // bar or drawer, which both stay flat lists - grouping is a desktop-only
  // visual affordance, not a change to what pages exist or how they load.
  const NAV_ITEMS = [
    { key: 'dashboard', href: '/dashboard.html', icon: '\u25C9', label: 'Dashboard', primary: true, section: null },
    { key: 'setup', href: '/admin', icon: '\u2699', label: 'Setup', primary: false, section: 'Operations/Network' },
    { key: 'agents', href: '/agents', icon: '\u25A4', label: 'Agents', primary: true, section: 'Operations/Network' },
    { key: 'pppoe', href: '/pppoe', icon: '\u21C4', label: 'PPPoE', primary: false, section: 'Operations/Network' },
    { key: 'vouchers', href: '/print.html', icon: '\u2637', label: 'Vouchers', primary: true, section: 'Finance' },
    { key: 'billing', href: '/billing.html', icon: '\u26A1', label: 'Billing', primary: true, section: 'Finance' },
    {
      key: 'plan-overview', href: '/plan-overview.html', icon: '\u2756', label: 'Overview of Plan',
      primary: false, section: 'Plan',
    },
    {
      key: 'help-email', href: `mailto:${HELP_CONTACT.email}`, icon: '\u2709', label: 'Email',
      primary: false, section: 'Help', external: true,
    },
    {
      key: 'help-whatsapp', href: `https://wa.me/${HELP_CONTACT.whatsappNumber}`, icon: '\u{1F4AC}',
      label: 'WhatsApp', primary: false, section: 'Help', external: true,
    },
    {
      key: 'help-phone', href: `tel:${HELP_CONTACT.phoneNumber}`, icon: '\u260E', label: 'Call',
      primary: false, section: 'Help', external: true,
    },
  ];

  // Groups NAV_ITEMS into { label, items } clusters for the desktop
  // sidebar, preserving first-appearance order of both items and
  // sections. Items with section:null render standalone, with no header.
  function buildNavGroups(items) {
    const groups = [];
    const bySection = new Map();
    items.forEach((item) => {
      const key = item.section || null;
      if (key === null) {
        groups.push({ label: null, items: [item] });
        return;
      }
      if (!bySection.has(key)) {
        const group = { label: key, items: [] };
        bySection.set(key, group);
        groups.push(group);
      }
      bySection.get(key).items.push(item);
    });
    return groups;
  }

  function navLinkHtml(item, active) {
    const isActive = !item.external && item.key === active;
    const extraAttrs = item.external ? ' target="_blank" rel="noopener"' : '';
    return `
      <a href="${item.href}" class="${isActive ? 'active' : ''}"${extraAttrs}>
        <span class="ico">${item.icon}</span><span>${item.label}</span>
      </a>
    `;
  }

  // Sidebar mode persists across pages/sessions via localStorage. Desktop
  // only - the mobile layout already replaces the vertical sidebar
  // entirely with the bottom bar + drawer (see @media rule in shell.css),
  // so this has no effect below the 760px breakpoint.
  //
  // "pinned" (default, i.e. nothing saved yet) is the classic always-
  // expanded 220px rail - unchanged from before this feature existed.
  // "auto" rests as a 64px icon strip and expands to 220px, as a pure
  // overlay, only while hovered/focused (pure CSS, see .app-sidebar.auto
  // in shell.css) - the toggle button becomes a "pin open" action while
  // in this mode. Reuses the pre-existing key/values so anyone who'd
  // already collapsed the sidebar lands in "auto" (hover-to-peek) rather
  // than losing their compact preference.
  const COLLAPSE_KEY = 'yn_sidebar_collapsed';
  function isAutoMode() {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  }
  function applyMode(sidebarEl, spacerEl, auto) {
    sidebarEl.classList.toggle('auto', auto);
    spacerEl.classList.toggle('auto', auto);
    if (!auto) closeAutoSidebar(sidebarEl); // switching to pinned - drop any leftover .open state
    const btn = document.getElementById('yn-collapse-toggle');
    if (btn) btn.setAttribute('aria-label', auto ? 'Pin sidebar open' : 'Switch to auto-hide sidebar');
  }
  function setAutoMode(sidebarEl, spacerEl, auto) {
    localStorage.setItem(COLLAPSE_KEY, auto ? '1' : '0');
    applyMode(sidebarEl, spacerEl, auto);
  }

  // Auto mode's open/closed state - separate from the pinned/auto mode
  // itself. Rests closed (slim hamburger-only rail); opens on a hamburger
  // click, closes when the pointer leaves the sidebar or a click lands
  // outside it (the latter covers touch/keyboard, which never fire
  // mouseleave). Clicking a nav link inside navigates to a new page, which
  // naturally resets this on load, so no explicit "close on nav" needed.
  function openAutoSidebar(sidebarEl) {
    sidebarEl.classList.add('open');
    const btn = document.getElementById('yn-sidebar-hamburger');
    if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-label', 'Close sidebar'); }
  }
  function closeAutoSidebar(sidebarEl) {
    sidebarEl.classList.remove('open');
    const btn = document.getElementById('yn-sidebar-hamburger');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Open sidebar'); }
  }
  function wireAutoSidebarHamburger(sidebarEl) {
    const hamburger = document.getElementById('yn-sidebar-hamburger');
    if (!hamburger || hamburger.dataset.wired) return;
    hamburger.dataset.wired = '1';
    hamburger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sidebarEl.classList.contains('open')) closeAutoSidebar(sidebarEl);
      else openAutoSidebar(sidebarEl);
    });
    sidebarEl.addEventListener('mouseleave', () => {
      if (sidebarEl.classList.contains('auto')) closeAutoSidebar(sidebarEl);
    });
    document.addEventListener('click', (e) => {
      if (!sidebarEl.classList.contains('auto') || !sidebarEl.classList.contains('open')) return;
      if (!sidebarEl.contains(e.target)) closeAutoSidebar(sidebarEl);
    });
  }

  function render() {
    const el = document.getElementById('app-sidebar');
    if (!el) return;
    el.classList.add('app-sidebar'); // #app-sidebar carries the id shell.js hooks into; the CSS lives on this class
    const active = window.YOURNET_ACTIVE_NAV || '';
    const primaryItems = NAV_ITEMS.filter((i) => i.primary);
    const secondaryActive = NAV_ITEMS.some((i) => !i.primary && i.key === active);
    const logoutHtml = `<a href="#" class="logout-btn" title="Log out" onclick="localStorage.removeItem('yournet_token');window.location.href='/login';return false;"><span class="ico">\u23FB</span><span>Log out</span></a>`;
    const collapseBtnHtml = `
      <button type="button" class="sidebar-collapse-btn" id="yn-collapse-toggle" aria-label="Collapse sidebar">
        <span class="ico">\u276E</span>
      </button>
    `;
    // Hidden until beforeinstallprompt actually fires (see wireInstallPrompt) -
    // most browsers/OSes never fire it, so this stays hidden there by design.
    const installBtnHtml = `
      <button type="button" class="install-app-btn" id="yn-install-btn" aria-label="Install app" style="display:none">
        <span class="ico">\u2B07</span><span>Install app</span>
      </button>
    `;

    el.innerHTML = `
      <button type="button" class="yn-sidebar-hamburger" id="yn-sidebar-hamburger" aria-label="Open sidebar" aria-expanded="false">
        <span class="yn-bar"></span><span class="yn-bar"></span><span class="yn-bar"></span><span class="yn-bar"></span>
      </button>
      <div class="app-topbar">
        <div class="app-topbar-side"></div>
        <div class="app-brand"><img src="/img/logo-icon.png" alt="" class="brand-logo-icon"> <span class="brand-label">YourNet Control</span></div>
        <div class="app-topbar-side right">${installBtnHtml}</div>
        ${collapseBtnHtml}
      </div>
      <nav class="app-nav">
        ${buildNavGroups(NAV_ITEMS).map((group) => `
          <div class="app-nav-group${group.label === 'Help' ? ' app-nav-group--help' : ''}">
            ${group.label ? `<div class="app-nav-section-label">${group.label}</div>` : ''}
            ${group.items.map((item) => navLinkHtml(item, active)).join('')}
          </div>
        `).join('')}
      </nav>

      <nav class="app-bottom-nav">
        ${primaryItems.map((item) => navLinkHtml(item, active)).join('')}
        <button type="button" class="more-btn ${secondaryActive ? 'active' : ''}" id="yn-drawer-open" aria-label="More">
          <span class="ico">\u2261</span><span>More</span>
        </button>
      </nav>

      <div class="app-drawer-backdrop" id="yn-drawer-backdrop"></div>
      <div class="app-drawer" id="yn-drawer">
        <div class="app-drawer-header">
          <div class="app-brand"><img src="/img/logo-icon.png" alt="" class="brand-logo-icon"> YourNet Control</div>
          <button type="button" class="app-drawer-close" id="yn-drawer-close" aria-label="Close menu">&times;</button>
        </div>
        <nav class="app-drawer-nav">
          ${NAV_ITEMS.map((item) => navLinkHtml(item, active)).join('')}
        </nav>
        <div class="app-drawer-footer">${installBtnHtml.replace('id="yn-install-btn"', 'id="yn-install-btn-drawer"')}${logoutHtml}</div>
      </div>
    `;

    const drawer = document.getElementById('yn-drawer');
    const backdrop = document.getElementById('yn-drawer-backdrop');
    const openBtn = document.getElementById('yn-drawer-open');
    const closeBtn = document.getElementById('yn-drawer-close');

    function openDrawer() {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      document.body.classList.add('yn-drawer-locked');
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      document.body.classList.remove('yn-drawer-locked');
    }
    if (openBtn) openBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);

    // Spacer reserves #app-sidebar's resting width in the flex row, since
    // the sidebar itself is position:fixed (so hover-expanding it never
    // shifts .app-main - see shell.css). Created once, reused on re-render.
    let spacer = el.nextElementSibling;
    if (!spacer || !spacer.classList.contains('app-sidebar-spacer')) {
      spacer = document.createElement('div');
      spacer.className = 'app-sidebar-spacer';
      el.insertAdjacentElement('afterend', spacer);
    }

    const collapseBtn = document.getElementById('yn-collapse-toggle');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => setAutoMode(el, spacer, !el.classList.contains('auto')));
    }
    // Apply saved mode now that the sidebar markup exists.
    applyMode(el, spacer, isAutoMode());
    wireAutoSidebarHamburger(el);

    document.querySelectorAll('.install-app-btn').forEach((installBtn) => {
      // If beforeinstallprompt already fired earlier in this page's life
      // (unlikely this early, but re-render() can run more than once),
      // reveal the button immediately instead of waiting on a second event.
      if (deferredInstallPrompt) installBtn.style.display = '';
      installBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        document.querySelectorAll('.install-app-btn').forEach((btn) => { btn.style.display = 'none'; });
      });
    });
  }

  // Round profile button - lives in the same top-right corner as the page's
  // language switcher (#yournetLangSwitcherContainer), not the sidebar. Its
  // round face shows the tenant's uploaded business logo (falls back to a
  // plain person glyph until one's on file). Click opens a dropdown showing
  // business name / admin's full name / country - fetched fresh from
  // /api/dashboard/account-info every time it's opened, so saving changes on
  // the Account tab (admin.html) is reflected the next time it's opened,
  // with no page reload needed. Log out is always the last item.
  function renderTopRightProfile() {
    if (document.getElementById('yn-profile-wrap')) return; // idempotent
    const main = document.querySelector('.app-main');
    if (!main) return;
    let container = document.getElementById('yournetLangSwitcherContainer');
    if (!container) {
      // Pages without an i18n switcher (e.g. plan-overview.html) still get
      // the same top-right corner spot, just without a language dropdown
      // sharing it.
      container = document.createElement('div');
      container.id = 'yournetLangSwitcherContainer';
      container.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:10px';
      main.insertBefore(container, main.firstChild);
    }
    const wrap = document.createElement('div');
    wrap.className = 'yn-profile-wrap';
    wrap.id = 'yn-profile-wrap';
    wrap.innerHTML = `
      <button type="button" class="yn-profile-btn" aria-label="Profile" aria-haspopup="true" aria-expanded="false">\u{1F464}</button>
      <div class="yn-profile-menu" role="menu">
        <div class="yn-profile-info" id="yn-profile-info">
          <div class="yn-profile-row">
            <div class="yn-profile-row-label">Business name</div>
            <div class="yn-profile-row-value" id="yn-profile-business">\u2014</div>
          </div>
          <div class="yn-profile-row">
            <div class="yn-profile-row-label">Admin's full name</div>
            <div class="yn-profile-row-value" id="yn-profile-admin">\u2014</div>
          </div>
          <div class="yn-profile-row">
            <div class="yn-profile-row-label">Country</div>
            <div class="yn-profile-row-value" id="yn-profile-country">\u2014</div>
          </div>
        </div>
        <button type="button" class="yn-profile-menu-item yn-danger" onclick="localStorage.removeItem('yournet_token');window.location.href='/login';return false;">Log out</button>
      </div>
    `;
    // Inserted first so a language <select> added afterwards (by
    // i18n-loader.js, which runs after shell.js on DOMContentLoaded) lands
    // to its right - same corner, profile button first.
    container.insertBefore(wrap, container.firstChild);
    wireProfileControls();
    loadProfileLogo();
  }

  // Swaps the round profile button's default person icon for the tenant's
  // uploaded logo, if any. Runs once per page load; admin.html's Account
  // tab calls window.yournetRefreshProfileLogo() after an upload/removal so
  // the button updates immediately without a full page reload.
  async function loadProfileLogo() {
    try {
      const token = localStorage.getItem('yournet_token');
      if (!token) return;
      const res = await fetch('/api/dashboard/account-info', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return;
      const info = await res.json();
      applyProfileLogo(info.logoUrl || null);
    } catch (err) {
      // Non-critical - buttons keep the default person icon.
    }
  }

  function applyProfileLogo(logoUrl) {
    document.querySelectorAll('.yn-profile-btn').forEach((btn) => {
      if (logoUrl) {
        btn.innerHTML = `<img src="${logoUrl}" alt="" class="yn-profile-btn-img">`;
      } else {
        btn.textContent = '\u{1F464}';
      }
    });
  }
  window.yournetRefreshProfileLogo = loadProfileLogo;

  // Fetches business name / admin's full name / country fresh from the
  // server and fills the dropdown - called every time it's opened, so it
  // can never show stale info left over from a previous session or an edit
  // made on the Account tab.
  async function loadProfileInfo() {
    const businessEl = document.getElementById('yn-profile-business');
    const adminEl = document.getElementById('yn-profile-admin');
    const countryEl = document.getElementById('yn-profile-country');
    if (!businessEl) return;
    try {
      const token = localStorage.getItem('yournet_token');
      const res = await fetch('/api/dashboard/account-info', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      const info = await res.json();
      if (!res.ok) throw new Error(info.error || 'Could not load profile');
      businessEl.textContent = info.businessName || '\u2014';
      adminEl.textContent = info.adminFullName || '\u2014';
      countryEl.textContent = info.country || '\u2014';
    } catch (err) {
      businessEl.textContent = adminEl.textContent = countryEl.textContent = '\u2014';
    }
  }
  // admin.html's Account tab calls this after a successful save, so the
  // dropdown reflects the new business name/admin name/country right away
  // if it happens to be open - no reload, no need to reopen it first.
  window.yournetRefreshProfileInfo = loadProfileInfo;

  // Profile button - toggles the dropdown open/closed and loads fresh
  // account info each time it opens. Log out reuses the same logic as the
  // drawer's logoutHtml.
  function wireProfileControls() {
    const wrap = document.getElementById('yn-profile-wrap');
    if (!wrap) return;
    const btn = wrap.querySelector('.yn-profile-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrap.classList.contains('open');
      if (!isOpen) {
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        loadProfileInfo();
      } else {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    if (!document.body.dataset.ynProfileOutsideWired) {
      document.body.dataset.ynProfileOutsideWired = '1';
      document.addEventListener('click', () => {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });
    }
  }

  // Centered page header (logo + title): wraps whatever <h1> the page
  // already has - and its immediately-following .sub subtitle, if any -
  // in a centered .page-header block with the YourNet logo above it.
  // Runs once per load; skips pages with no <h1> in .app-main (e.g. the
  // logged-out placeholder dashboard.html swaps in) and is idempotent so
  // a page that calls render() again (rare) won't double-wrap.
  function renderPageHeader() {
    const main = document.querySelector('.app-main');
    if (!main) return;
    const h1 = main.querySelector('h1');
    if (!h1 || h1.closest('.page-header')) return;
    const header = document.createElement('div');
    header.className = 'page-header';
    const logo = document.createElement('img');
    logo.src = '/img/logo-icon.png';
    logo.alt = '';
    logo.className = 'page-header-logo';
    header.appendChild(logo);
    h1.parentNode.insertBefore(header, h1);
    header.appendChild(h1);
    const next = header.nextElementSibling;
    if (next && next.classList.contains('sub')) header.appendChild(next);
  }

  // Favicon/app-icon links - injected here rather than duplicated in every
  // page's <head> so every page that includes shell.js picks them up
  // automatically, including ones added later.
  function ensureFavicon() {
    if (document.getElementById('yn-favicon-32')) return;
    const links = [
      { id: 'yn-favicon-32', rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
      { id: 'yn-favicon-16', rel: 'icon', type: 'image/png', sizes: '16x16', href: '/icons/favicon-16.png' },
      { id: 'yn-apple-touch', rel: 'apple-touch-icon', href: '/icons/icon-192.png' },
    ];
    links.forEach((attrs) => {
      const link = document.createElement('link');
      Object.keys(attrs).forEach((k) => { if (k !== 'id') link.setAttribute(k, attrs[k]); });
      link.id = attrs.id;
      document.head.appendChild(link);
    });
  }

  // PWA install ("Add to Home Screen") for the admin app shell. Static
  // YourNet branding (manifest.json/sw.js at the root), separate from the
  // per-site tenant-branded portal PWA (/p/:siteId/manifest.json + sw.js,
  // rendered dynamically in portalRenderer.js) - this one is for the owner/
  // agent logging into their own dashboard, not the WiFi customer.
  function ensurePwaMeta() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = '/manifest.json';
      document.head.appendChild(link);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = '#0d1a1e';
      document.head.appendChild(meta);
    }
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const meta = document.createElement('meta');
      meta.name = 'apple-mobile-web-app-capable';
      meta.content = 'yes';
      document.head.appendChild(meta);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      const link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      link.href = '/icons/icon-192.png';
      document.head.appendChild(link);
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Chrome/Android/Edge fire beforeinstallprompt when the page qualifies
  // (manifest + sw + served over https) and the browser hasn't already
  // decided the user dismissed it too recently. Safari/iOS never fires
  // this - there's no programmatic install prompt there, so the button
  // simply never appears and Add to Home Screen stays a manual Share-sheet
  // action on iOS, same as everywhere else on the web.
  let deferredInstallPrompt = null;
  function wireInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      document.querySelectorAll('.install-app-btn').forEach((btn) => { btn.style.display = ''; });
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      document.querySelectorAll('.install-app-btn').forEach((btn) => { btn.style.display = 'none'; });
    });
  }

  // Connectivity mesh background - ported from the Bitnet captive-portal
  // design (uploaded by Ojoe) so the admin/dashboard/billing/vouchers pages
  // share the same "network mesh" visual identity as the client-facing
  // portal, just recolored to the app shell's teal instead of Bitnet's cyan.
  function renderMeshBg() {
    if (document.getElementById('yn-mesh-bg')) return; // don't double-inject
    const wrap = document.createElement('div');
    wrap.id = 'yn-mesh-bg';
    wrap.className = 'mesh-bg';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = '<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice"><g id="yn-mesh-group"></g></svg>';
    document.body.insertBefore(wrap, document.body.firstChild);

    const g = wrap.querySelector('#yn-mesh-group');
    const W = 1000, H = 700, count = 26, maxDist = 140;
    const pts = [];
    for (let i = 0; i < count; i++) {
      pts.push({ x: Math.random() * W, y: Math.random() * H });
    }
    let linesSVG = '';
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        if (Math.sqrt(dx * dx + dy * dy) < maxDist) {
          linesSVG += `<line class="mesh-line" x1="${pts[i].x}" y1="${pts[i].y}" x2="${pts[j].x}" y2="${pts[j].y}"/>`;
        }
      }
    }
    let nodesSVG = '';
    pts.forEach((p) => {
      nodesSVG += `<circle class="mesh-node" cx="${p.x}" cy="${p.y}" r="2.2"/>`;
    });
    g.innerHTML = linesSVG + nodesSVG;
  }

  // Optional rotating-photo background, in place of the SVG mesh, for
  // tenants who turned this on (Account tab in /admin). Off by default -
  // most pages using shell.js aren't logged in yet (or the toggle fetch
  // fails), so silently doing nothing here is the correct default.
  // Overlay is intentionally light (not the near-opaque scrim this used to
  // have) so the photo actually shows through the glass panels - see the
  // body.yn-glass rules in shell.css, which is what keeps text readable
  // instead of the overlay having to do all the work.
  function setAppBackground(url) {
    document.body.style.backgroundImage =
      `linear-gradient(rgba(13,26,30,.45),rgba(13,26,30,.55)), url("${url}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.transition = 'background-image 1.2s ease-in-out';
  }

  function startAdminBackgroundRotation(urls) {
    const meshBg = document.getElementById('yn-mesh-bg');
    if (meshBg) meshBg.remove(); // photos replace the mesh, not layer under it
    document.body.classList.add('yn-glass');

    let i = 0;
    setAppBackground(urls[i]);
    setInterval(() => {
      i = (i + 1) % urls.length;
      const preload = new Image();
      preload.onload = () => setAppBackground(urls[i]);
      preload.src = urls[i];
    }, 2 * 60 * 1000);
  }

  async function maybeStartRotatingBackground() {
    const token = localStorage.getItem('yournet_token');
    if (!token) return;
    try {
      const settingsRes = await fetch('/api/dashboard/background-settings', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!settingsRes.ok) return;
      const settings = await settingsRes.json();
      if (!settings.useRotatingBackgrounds) return;

      const bgRes = await fetch('/api/dashboard/rotating-backgrounds', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!bgRes.ok) return;
      const { backgrounds } = await bgRes.json();
      if (backgrounds && backgrounds.length) startAdminBackgroundRotation(backgrounds);
    } catch (err) {
      // Silently keep the default mesh background - this is a cosmetic
      // preference, never worth surfacing an error over.
    }
  }

  function init() {
    ensureFavicon();
    ensurePwaMeta();
    wireInstallPrompt();
    render();
    renderPageHeader();
    renderTopRightProfile();
    renderMeshBg();
    maybeStartRotatingBackground();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
