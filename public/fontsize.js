// YourNet Control - floating font-size control. Include as a plain
// <script src="/fontsize.js"></script> near the end of <body> on any page -
// it's fully self-contained (injects its own CSS and markup), doesn't
// depend on shell.css/shell.js being present, and works the same on every
// page it's dropped into.
//
// WHY `zoom` AND NOT REM/ROOT-FONT-SIZE: every page in this app sets font
// sizes in fixed px, not rem, so scaling the root font-size would do
// nothing - none of the actual text is relative to it. CSS `zoom` scales
// the whole rendered page (text, spacing, icons, buttons) together, which
// is what "make everything on the page bigger/smaller" actually means
// here. `zoom` is now supported across Chrome/Edge, Safari 16.4+, and
// Firefox 126+ (2024), which by this app's usage patterns (business
// owners on phones and Windows laptops) covers effectively everyone.
(function () {
  const STORAGE_KEY = 'yournet_font_scale';
  const STEPS = [0.85, 0.9, 1, 1.1, 1.25, 1.4]; // 6 levels, 100% is the default
  const DEFAULT_INDEX = 2;

  function getStoredIndex() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw !== null ? Number(raw) : NaN;
    return STEPS[parsed] !== undefined ? parsed : DEFAULT_INDEX;
  }

  function applyScale(index) {
    document.documentElement.style.zoom = String(STEPS[index]);
    const label = document.getElementById('yn-fontsize-label');
    if (label) label.textContent = Math.round(STEPS[index] * 100) + '%';
    const minusBtn = document.getElementById('yn-fontsize-minus');
    const plusBtn = document.getElementById('yn-fontsize-plus');
    if (minusBtn) minusBtn.disabled = index === 0;
    if (plusBtn) plusBtn.disabled = index === STEPS.length - 1;
  }

  function setIndex(index) {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, index));
    localStorage.setItem(STORAGE_KEY, String(clamped));
    applyScale(clamped);
    return clamped;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #yn-fontsize-widget{
        position:fixed;right:16px;bottom:20px;z-index:9999;
        display:flex;align-items:center;gap:2px;
        background:rgba(19,34,40,.72);backdrop-filter:blur(14px) saturate(150%);
        -webkit-backdrop-filter:blur(14px) saturate(150%);
        border:1px solid rgba(255,255,255,.14);border-radius:999px;
        padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        opacity:0;transform:translateY(8px);
        animation:yn-fs-in .35s ease-out .15s forwards;
      }
      @keyframes yn-fs-in{to{opacity:1;transform:translateY(0)}}
      #yn-fontsize-widget button{
        width:30px;height:30px;border-radius:999px;border:none;cursor:pointer;
        background:transparent;color:#e8f0f1;font-size:13px;font-weight:700;
        display:flex;align-items:center;justify-content:center;
        transition:background .15s ease,color .15s ease,transform .1s ease;
      }
      #yn-fontsize-widget button:hover:not(:disabled){background:rgba(46,196,182,.22);color:#2ec4b6}
      #yn-fontsize-widget button:active:not(:disabled){transform:scale(.9)}
      #yn-fontsize-widget button:disabled{opacity:.3;cursor:default}
      #yn-fontsize-label{
        min-width:38px;text-align:center;font-size:11px;font-weight:600;
        color:#6b8a91;user-select:none;padding:0 2px;
      }
      @media (max-width:760px){
        #yn-fontsize-widget{bottom:84px;right:12px}
      }
      @media print{ #yn-fontsize-widget{display:none} }
    `;
    document.head.appendChild(style);
  }

  function injectWidget() {
    const wrap = document.createElement('div');
    wrap.id = 'yn-fontsize-widget';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Adjust text size');
    wrap.innerHTML = `
      <button id="yn-fontsize-minus" type="button" aria-label="Decrease text size">A−</button>
      <span id="yn-fontsize-label"></span>
      <button id="yn-fontsize-plus" type="button" aria-label="Increase text size">A+</button>
    `;
    document.body.appendChild(wrap);

    let index = getStoredIndex();
    applyScale(index);

    document.getElementById('yn-fontsize-minus').addEventListener('click', () => {
      index = setIndex(index - 1);
    });
    document.getElementById('yn-fontsize-plus').addEventListener('click', () => {
      index = setIndex(index + 1);
    });
  }

  function init() {
    // Apply the stored scale immediately (before the widget itself even
    // renders) so returning visitors never see a flash of default-size text.
    applyScale(getStoredIndex());
    injectStyles();
    injectWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
