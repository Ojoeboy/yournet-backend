// YourNet Control - rotating background + glass effect for standalone
// pages (license.html, license-admin.html, owner-login.html) that aren't
// part of the tenant admin shell (see shell.js for that version, which
// uses the authenticated per-tenant background instead of this public one).
//
// Include this after the page's own <style> block, with a `.card` element
// already in the DOM - it fetches the platform's rotating photo list and,
// if any come back, starts cycling the body background and adds a
// `yn-glass` class to <body> so a `body.yn-glass .card{...}` rule (defined
// per-page, since each page's card styling differs slightly) can turn the
// card glassy. Without photos, nothing changes - plain background stays.
(function () {
  function setBodyBackground(url) {
    document.body.style.backgroundImage =
      `linear-gradient(rgba(8,15,18,0.55),rgba(8,15,18,0.65)), url("${url}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.transition = 'background-image 1.2s ease-in-out';
  }

  function startRotation(urls) {
    document.body.classList.add('yn-glass');
    let i = 0;
    setBodyBackground(urls[i]);
    setInterval(() => {
      i = (i + 1) % urls.length;
      const preload = new Image();
      preload.onload = () => setBodyBackground(urls[i]);
      preload.onerror = () => {}; // skip a broken URL, keep the current one
      preload.src = urls[i];
    }, 2 * 60 * 1000);
  }

  fetch('/api/public/rotating-backgrounds')
    .then((res) => (res.ok ? res.json() : { backgrounds: [] }))
    .then(({ backgrounds }) => {
      if (backgrounds && backgrounds.length) startRotation(backgrounds);
    })
    .catch(() => {}); // keep the plain background - cosmetic only
})();
