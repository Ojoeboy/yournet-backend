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
    email: 'yournetcontrol@gmail.com',
    whatsappNumber: '233546539112', // digits only, country code, no leading +
    phoneNumber: '+233546539112',
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

  function render() {
    const el = document.getElementById('app-sidebar');
    if (!el) return;
    const active = window.YOURNET_ACTIVE_NAV || '';
    const primaryItems = NAV_ITEMS.filter((i) => i.primary);
    const secondaryActive = NAV_ITEMS.some((i) => !i.primary && i.key === active);
    const logoutHtml = `<a href="#" class="logout-btn" onclick="localStorage.removeItem('yournet_token');window.location.href='/login';return false;">Log out</a>`;

    el.innerHTML = `
      <div class="app-topbar">
        <div class="app-topbar-side"></div>
        <div class="app-brand"><img src="/img/logo-icon.png" alt="" class="brand-logo-icon"> YourNet Control</div>
        <div class="app-topbar-side right">${logoutHtml}</div>
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
        <div class="app-drawer-footer">${logoutHtml}</div>
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
    render();
    renderMeshBg();
    maybeStartRotatingBackground();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
