'use strict';

(function () {
  const STORAGE_KEY = 'elizdrave-lang';
  let currentLang = 'bg';

  function getLang() {
    return currentLang;
  }

  function t(bg, en) {
    return currentLang === 'en' ? en : bg;
  }

  function applyLang(lang) {
    if (lang !== 'bg' && lang !== 'en') lang = 'bg';
    currentLang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
    document.documentElement.lang = lang;

    document.querySelectorAll('[data-en]').forEach(function (el) {
      if (lang === 'en') {
        if (el.dataset.bg === undefined) el.dataset.bg = el.innerHTML;
        el.innerHTML = el.dataset.en;
      } else {
        if (el.dataset.bg !== undefined) el.innerHTML = el.dataset.bg;
      }
    });

    document.querySelectorAll('.lang-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  window.elizdraveI18n = { getLang, t, applyLang };

  const saved = (function () {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  })();
  applyLang(saved === 'en' ? 'en' : 'bg');

  document.querySelectorAll('.lang-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { applyLang(btn.dataset.lang); });
  });
})();
