/* ============================================================
   OMP Studio — SPA 路由（单 HTML 壳）
   hash 格式：#!page[/sub]
   工作台默认（#!workbench）；二级页在 .page 根里换内容，页头 nav 常驻。
   不命中 #! 的裸 hash（如旧 #theme=dark）留给 theme.js，这里回落工作台。
   ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);

  /* 视图清单：page -> { title, icon, tpl, init } */
  const PAGES = {
    home:           { title: '首页',                  icon: 'home',    tpl: 'tpl-home',         init: 'home' },
    'env-check':    { title: '环境检查',             icon: 'pulse',   tpl: 'tpl-env',          init: 'env' },
    history:        { title: '会话历史与 Time Travel', icon: 'history', tpl: 'tpl-history',     init: 'history' },
    capabilities:   { title: '能力中心',             icon: 'package', tpl: 'tpl-capabilities', init: 'capabilities' },
    settings:       { title: '设置',                 icon: 'settings', tpl: 'tpl-settings',     init: 'settings' },
    diagnostics:    { title: '诊断中心',             icon: 'pulse',   tpl: 'tpl-diagnostics',  init: 'diagnostics' },
    'model-config': { title: '模型配置',             icon: 'server',  tpl: 'tpl-model-config', init: 'model-config' },
    'agent-hub':    { title: 'Agent Hub',            icon: 'bot',     tpl: 'tpl-agent-hub',    init: 'agent-hub' }
  };

  const appRoot = $('#appRoot');
  const pageRoot = $('#pageRoot');
  const pageBody = $('#pageBody');
  const pageHead = $('#pageHead');

  let current = 'workbench';
  /* 深链直开（加载即路由到二级页）时首帧落位不滑动；之后的导航气泡滑动。 */
  let initialRoute = true;

  /* 内容切换淡入淡出时长：对齐 pages.css 的 --dur-slow（260ms）。
     prefers-reduced-motion 时跳过淡出等待，直接换内容。 */
  const EXIT_MS = 260;
  const REDUCED = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 视图 init 注册表：pages.js / page-model-config.js 填。
     每个 init 收一个 sub，视图自身负责（重新）渲染。 */
  const initMap = {};
  window.OMP = window.OMP || {};
  window.OMP.router = window.OMP.router || { register: (k, fn) => { initMap[k] = fn; } };

  function isWorkbench() { return document.body.dataset.page === 'workbench'; }

  /* ---------- 页头：标题 / 激活入口 ----------
     每次只改 .ph-title 文本与 nav 的激活态；nav 结构本身从不重建。 */
  function setPageHead(title, icon) {
    const t = $('.ph-title', pageHead);
    if (t) t.innerHTML = OMP.icon(icon, 'sm') + title;
    document.title = 'OMP Studio — ' + title;

    const nav = $('.page-nav', pageHead);
    if (!nav) return;
    const links = Array.from(nav.querySelectorAll('a[href^="#!"]'));
    const match = links.find(a => a.getAttribute('href') === '#!' + current);
    links.forEach(l => l.classList.remove('active'));
    if (match) {
      match.classList.add('active');
      nav.classList.remove('no-bubble');
      // 深链首帧落位不滑动；之后每次导航气泡平滑滑到激活入口。
      if (window.OMP.navSlide) OMP.navSlide.place(match, !initialRoute);
    } else {
      nav.classList.add('no-bubble');
    }
  }

  /* ---------- 内容注入 + 视图 init（无过渡，只换内容） ---------- */
  function doSwap(meta, sub) {
    if (meta.init === 'model-config') {
      /* model-config 两个面板常驻 DOM：只注入模板一次。再次进入（从其他
         视图路由过来）时模板已装好，重建会丢掉面板里的草稿与展开状态。
         靠 pageBody 里是否已有 #mcRoot 判断。 */
      if (!document.getElementById('mcRoot')) {
        const tpl = document.getElementById(meta.tpl);
        pageBody.innerHTML = tpl ? tpl.innerHTML : '';
        OMP.injectIcons(pageBody);
        // 模板重建 → 之前的 tab/面板 DOM 已随 innerHTML 一起销毁，
        // inited 标志作废，必须让 init() 重新建 tab。
        if (OMP.modelConfig) OMP.modelConfig.inited = false;
      }
      if (OMP.modelConfig && !OMP.modelConfig.inited) {
        if (OMP.modelConfig.init) OMP.modelConfig.init();
      }
      if (OMP.modelConfig && OMP.modelConfig.route) OMP.modelConfig.route(sub);
    } else {
      const tpl = document.getElementById(meta.tpl);
      pageBody.innerHTML = tpl ? tpl.innerHTML : '';
      OMP.injectIcons(pageBody);
      if (initMap[meta.init]) initMap[meta.init](sub);
    }
  }

  /* ---------- 内容注入（淡入淡出） ----------
     旧内容先淡出（--dur-exit，opacity transition），再换 innerHTML + 视图
     init，新内容淡入（page-in 动画）。快速连点时只有最后一次生效
     （pendingSwap 令牌）。气泡滑动与此并行：切页时胶囊在滑、旧内容在淡、
     新内容淡入。
     深链首帧（initialRoute）跳过淡出：此刻 page-body 还是空的，对空白容器
     做 260ms 淡出只是把「首次进入白屏」拖得更久。直接换内容，之后才淡入淡出。 */
  let pendingSwap = 0;
  function mount(meta, sub) {
    if (REDUCED || initialRoute) { doSwap(meta, sub); return; }
    const t = ++pendingSwap;
    pageBody.classList.add('page-out');
    setTimeout(() => {
      if (t !== pendingSwap) return;   // 已被更新的导航取代
      doSwap(meta, sub);
      pageBody.classList.remove('page-out');
      pageBody.classList.remove('page-in');
      void pageBody.offsetWidth;
      pageBody.classList.add('page-in');
    }, EXIT_MS);
  }

  /* ---------- 切换视图 ---------- */
  function navigate(page, sub) {
    if (!PAGES[page]) page = 'workbench';
    current = page;
    document.body.dataset.page = page;

    if (page === 'workbench') {
      appRoot.removeAttribute('hidden');
      pageRoot.setAttribute('hidden', '');
      const fab = $('#scenarioFab');
      if (fab) fab.removeAttribute('hidden');
      document.title = 'OMP Studio — 工作台';
      return;
    }

    appRoot.setAttribute('hidden', '');
    pageRoot.removeAttribute('hidden');
    const fab = $('#scenarioFab');
    if (fab) fab.setAttribute('hidden', '');

    setPageHead(PAGES[page].title, PAGES[page].icon);
    mount(PAGES[page], sub || '');
  }

  /* ---------- hash 解析 ---------- */
  function routeHash(hash) {
    hash = (hash || '').replace(/^#/, '');
    // hash 去掉前导 # 后，路由 hash 是 "!page[/sub]"（即 #!page…）。
    // 非 ! 开头（如旧 #theme=dark）不是路由：留给 theme.js，这里回落工作台。
    if (hash.charAt(0) !== '!') { navigate('workbench'); return; }
    const parts = hash.slice(1).split('/');
    const page = parts[0];
    const sub = parts.slice(1).join('/');
    navigate(page, sub);
  }

  /* ---------- 委托点击：a[href^="#!"] ----------
     工作台生成的链接大多改 href 即路由；这里统一拦截左键，修饰键/中键
     放行给浏览器原生（新标签）。 */
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#!"]');
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    routeHash(a.getAttribute('href'));
  });

  /* 程序化跳转（app.js/workbench.js 的菜单项用） */
  window.OMP.router.goto = function (page, sub) {
    const h = '#!' + page + (sub ? '/' + sub : '');
    if (location.hash === h) { navigate(page, sub); return; }
    // pushState 不触发 hashchange，手动 navigate；浏览器返回键仍能退回。
    if (history.pushState) history.pushState(null, '', h);
    else location.hash = h;
    navigate(page, sub);
  };
  window.OMP.router.routeHash = routeHash;
  window.OMP.router.isWorkbench = isWorkbench;

  window.addEventListener('hashchange', () => routeHash(location.hash));

  /* 首次路由推迟到 DOMContentLoaded：pages.js 的 buildNav（页头/nav/气泡）
     与 app.js 的工作台渲染都要先就位，深链（如 #!model-config/roles）首帧
     才能把气泡正确落位。按注册顺序，router.js 的监听最后触发。 */
  const firstRoute = () => {
    routeHash(location.hash);
    initialRoute = false;   // 之后的导航（含工作台回来）气泡滑动
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', firstRoute);
  } else {
    firstRoute();
  }
})();
