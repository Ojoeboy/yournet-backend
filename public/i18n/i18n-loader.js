// YourNet Control - i18n loader. Include translations.js BEFORE this script.
(function () {
  const DICT = window.YOURNET_I18N || { languages: { en: 'English' }, en: {} };
  const STORAGE_KEY = 'yournet_lang';

  function currentLang() {
    return localStorage.getItem(STORAGE_KEY) || 'en';
  }

  function t(key) {
    const lang = currentLang();
    return (DICT[lang] && DICT[lang][key]) || (DICT.en && DICT.en[key]) || key;
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.documentElement.setAttribute('lang', currentLang());
  }

  function setLanguage(lang) {
    localStorage.setItem(STORAGE_KEY, lang);
    applyTranslations();
    const sel = document.getElementById('yournetLangSwitcher');
    if (sel) sel.value = lang;
  }

  function renderSwitcher(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const select = document.createElement('select');
    select.id = 'yournetLangSwitcher';
    select.style.cssText = 'padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#132228;color:#fff;font-size:13px';
    Object.keys(DICT.languages || {}).forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = DICT.languages[code];
      select.appendChild(opt);
    });
    select.value = currentLang();
    select.addEventListener('change', (e) => setLanguage(e.target.value));
    container.appendChild(select);
  }

  // Expose globally so pages can call setLanguage(...) from inline handlers,
  // and so this loader can auto-run once the DOM is ready.
  window.yournetI18n = { t, setLanguage, renderSwitcher, currentLang, applyTranslations };

  document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();
    renderSwitcher('yournetLangSwitcherContainer');
  });
})();
