// YourNet Control - shared sidebar nav. Include after shell.css, and put
// <div id="app-sidebar"></div> as the first child of a .app-shell wrapper.
// Each page passes its own key (matching NAV_ITEMS below) as
// window.YOURNET_ACTIVE_NAV before this script runs, so the right item
// gets highlighted.
(function () {
  const NAV_ITEMS = [
    { key: 'dashboard', href: '/dashboard.html', icon: '\u25C9', label: 'Dashboard' },
    { key: 'setup', href: '/admin', icon: '\u2699', label: 'Setup' },
    { key: 'vouchers', href: '/print.html', icon: '\u2637', label: 'Vouchers' },
    { key: 'pppoe', href: '/pppoe', icon: '\u21C4', label: 'PPPoE' },
    { key: 'billing', href: '/billing.html', icon: '\u26A1', label: 'Billing' },
  ];

  function render() {
    const el = document.getElementById('app-sidebar');
    if (!el) return;
    const active = window.YOURNET_ACTIVE_NAV || '';

    el.innerHTML = `
      <div class="app-topbar">
        <div class="app-topbar-side"></div>
        <div class="app-brand"><span class="dot"></span> YourNet Control</div>
        <div class="app-topbar-side right">
          <a href="#" class="logout-btn" onclick="localStorage.removeItem('yournet_token');window.location.href='/admin';return false;">Log out</a>
        </div>
      </div>
      <nav class="app-nav">
        ${NAV_ITEMS.map((item) => `
          <a href="${item.href}" class="${item.key === active ? 'active' : ''}">
            <span class="ico">${item.icon}</span><span>${item.label}</span>
          </a>
        `).join('')}
      </nav>
    `;
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
