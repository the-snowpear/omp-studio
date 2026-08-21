/* ============================================================
   OMP Studio — Theme (Light / Dark)，localStorage 记忆
   ============================================================ */
(function () {
  const KEY = 'omp-studio-theme';
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.querySelectorAll('[data-theme-label]').forEach(function (el) {
      el.textContent = t === 'dark' ? 'Dark' : 'Light';
    });
    document.querySelectorAll('[data-theme-icon]').forEach(function (el) {
      el.innerHTML = '';
      el.setAttribute('data-icon', t === 'dark' ? 'moon' : 'light');
      if (window.OMP && OMP.injectIcons) OMP.injectIcons(el.parentElement || el);
    });
  }
  let saved = 'light';
  try { saved = localStorage.getItem(KEY) || 'light'; } catch (e) {}
  /* 原型评审便利：URL 上用 ?theme=dark / #theme=dark 可强制主题（不写入 localStorage） */
  const urlTheme = (location.search + location.hash).match(/theme=(dark|light)/);
  if (urlTheme) saved = urlTheme[1];
  // 尽早应用，避免闪烁
  document.documentElement.setAttribute('data-theme', saved);

  window.OMP = window.OMP || {};
  window.OMP.theme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || 'light'; },
    set: apply,
    toggle: function () { apply(OMP.theme.get() === 'dark' ? 'light' : 'dark'); }
  };

  document.addEventListener('DOMContentLoaded', function () {
    apply(saved);
    document.querySelectorAll('[data-action="toggle-theme"]').forEach(function (el) {
      el.addEventListener('click', function () { OMP.theme.toggle(); });
    });
  });
})();
