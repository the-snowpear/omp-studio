/* ============================================================
   OMP Studio — 「模型配置」页 · 外壳与路由
   把原来的 providers.html + roles.html 合并成一个入口，用两个
   tab 面板承载。本文件只做三件事：

     1. tab 状态（含 aria / 键盘 / 计数徽标）
     2. hash 路由 —— 全页只有一个 hash 所有者
     3. 把「查看供应商」「分配给角色」这类跨面板跳转，从整页导航
        降级为同页切 tab

   为什么合并：供应商与角色是同一件事的两半 —— 角色引用模型，模型
   来自供应商。拆成两个顶级入口时，最常见的两条路径（给角色挑模型、
   给模型找角色）都要跨页往返，而每次往返都会丢掉另一边的全部状态：
   正在填的供应商草稿、展开的模型列表、滚动位置。合并后这两条路径
   变成同页切换，状态留在原处。

   顶级入口也从 8 个降到 7 个 —— 「工作台」「项目主页」这一级应该
   按用户心里的任务来分，而不是按实现模块来分。
   ============================================================ */
(function () {
  const MR = window.OMP_MR;
  /* shell 在 tpl-model-config 模板里，脚本加载时尚未注入 DOM；router 进入
     model-config 时先注入模板再调 OMP.modelConfig.init()，init 里才取 shell。
     这里只校验数据存在。 */
  if (!MR) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const icon = OMP.icon;

  const PANELS = {
    providers: {
      label: '供应商',
      icon: 'server',
      panelId: 'mcPanelProviders',
      tabId: 'mcTabProviders',
      hash: 'providers',
      api: () => OMP.modelConfig && OMP.modelConfig.providers,
      /* 徽标：总数，以及「有几个需要处理」。数量是判断这里有没有问题的
         第一眼信息，放在 tab 上就不必先切进去才看得到。 */
      count() {
        const total = MR.providers.length;
        const bad = MR.providers.filter(p =>
          p.enabled && (p.status === 'auth-expired' || p.status === 'offline')).length;
        return { total, bad, tone: bad ? 'amber' : 'gray', unit: '个供应商' };
      }
    },
    roles: {
      label: '角色',
      icon: 'steering',
      panelId: 'mcPanelRoles',
      tabId: 'mcTabRoles',
      hash: 'roles',
      api: () => OMP.modelConfig && OMP.modelConfig.roles,
      count() {
        const total = MR.roles.length;
        const bad = MR.roles.filter(r => MR.roleIssue(r)).length;
        return { total, bad, tone: bad ? 'red' : 'gray', unit: '个角色' };
      }
    }
  };
  const KEYS = Object.keys(PANELS);

  let active = null;

  /* ---------------- tab 构建（一次） ----------------
     构建后不再替换 innerHTML：切 tab 只改属性。整块重渲染会把当前
     获得焦点的按钮换成新节点，方向键操作到一半焦点就掉了。 */
  function buildTabs() {
    $('#mcTabs').innerHTML = KEYS.map(key => {
      const p = PANELS[key];
      return `<button role="tab" id="${p.tabId}" data-mc-tab="${key}"
                aria-controls="${p.panelId}" tabindex="-1" aria-selected="false">
        ${icon(p.icon, 'sm')}<span>${p.label}</span>
        <span class="chip gray xs" data-mc-count="${key}"></span>
      </button>`;
    }).join('');
  }

  /* 徽标随时可能过期：禁用一个供应商会连带让引用它的角色不可用，所以
     两个数字必须一起刷新，否则切回去看到的是旧数字。 */
  function refreshCounts() {
    KEYS.forEach(key => {
      const c = PANELS[key].count();
      const el = $(`[data-mc-count="${key}"]`);
      if (!el) return;
      el.className = `chip ${c.tone} xs`;
      /* 数字本身给眼睛看；完整语义给读屏 —— 一个光秃秃的 “12” 读出来
         不知道是 12 个什么，更不知道其中有没有出问题的。 */
      el.innerHTML = `${c.total}<span class="sr-only"> ${c.unit}${c.bad ? `，其中 ${c.bad} 个需要处理` : ''}</span>`;
    });
  }

  /* ---------------- tab 切换 ---------------- */
  function activate(key, opts) {
    opts = opts || {};
    if (!PANELS[key]) key = KEYS[0];
    active = key;

    KEYS.forEach(k => {
      const p = PANELS[k];
      const on = k === key;
      const panel = document.getElementById(p.panelId);
      /* hidden 而不是一个 display:none 的类：隐藏面板里有几十个可聚焦
         控件，只做视觉隐藏会把它们留在 tab 序列和无障碍树里，键盘用户
         得穿过一片看不见的东西。 */
      if (panel) panel.hidden = !on;
      const tab = document.getElementById(p.tabId);
      if (tab) {
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
        /* roving tabindex：整组只留一个 tab 停靠点，Tab 键跨过整组而不是
           逐个穿过。 */
        tab.setAttribute('tabindex', on ? '0' : '-1');
      }
    });

    refreshCounts();

    /* 首次显示才 mount：两个面板的首渲染都不便宜（供应商要渲染全部卡片，
       角色要跑一遍 roleIssue），没必要为没打开的那个先付这笔成本。 */
    const api = PANELS[key].api();
    if (api) api.mount();

    if (opts.focusTab) {
      const t = document.getElementById(PANELS[key].tabId);
      if (t) t.focus();
    }
    if (opts.scrollTop !== false) {
      const body = $('.page-body');
      if (body) body.scrollTop = 0;
    }
    if (opts.hash !== false) writeHash(PANELS[key].hash);
  }

  /* 写 hash 但不触发自己的路由：否则 activate → writeHash → hashchange
     → route → activate 会绕回来，把面板刚打开的编辑器重置掉。
     SPA：hash 归全局 router 所有，这里写 #!model-config/<sub>（replaceState
     避免切 tab 堆历史）。 */
  function writeHash(h) {
    const full = '#!model-config/' + h;
    if (location.hash === full) return;
    if (history.replaceState) history.replaceState(null, '', full);
    else location.hash = full;
  }

  /* ---------------- 场景键 ----------------
     两个面板各自的验收场景键有两个重名（yaml / yaml-error）。合并后
     #s= 只有一个命名空间，所以支持显式前缀 p: / r:；不带前缀时按下表
     解析，重名的归供应商（保持原 providers.html 的行为）。 */
  const P_SCENARIOS = new Set(['list', 'new-custom', 'preset-collapsed', 'preset-open',
    'preset-anthropic', 'preset-openai', 'preset-ollama', 'custom-gateway', 'auth-apikey',
    'auth-env', 'auth-command', 'oauth-ok', 'oauth-out', 'test-ok', 'test-401',
    'test-unreachable', 'discovery-ok', 'discovery-fail', 'models-multi', 'custom-model-add',
    'model-override', 'advanced', 'yaml', 'yaml-error', 'edit-existing']);
  const R_SCENARIOS = new Set(['overview', 'default', 'smol', 'slow', 'vision', 'advisor',
    'global', 'project', 'restore-global', 'fallback-add', 'fallback-multi', 'custom-new',
    'cycle', 'unavailable', 'provider-unauth', 'model-disabled', 'yaml', 'yaml-error']);

  function runScenario(raw) {
    let key = raw, target = null;
    if (/^p:/.test(raw)) { target = 'providers'; key = raw.slice(2); }
    else if (/^r:/.test(raw)) { target = 'roles'; key = raw.slice(2); }
    else if (P_SCENARIOS.has(raw)) target = 'providers';
    else if (R_SCENARIOS.has(raw)) target = 'roles';

    if (!target) { activate('providers', { hash: false }); return; }
    activate(target, { hash: false });
    const api = PANELS[target].api();
    if (api && api.scenario) api.scenario(key);
  }

  /* ---------------- hash 路由 ----------------
     SPA：hash 所有权归全局 router。router 进入 model-config 时调用
     OMP.modelConfig.route(sub)，sub 是去掉 "#!model-config/" 前缀的部分
     （providers / roles / edit=… / role=… / assign=… / s=…）。这里兼容裸
     sub（旧调用方），不再自己监听 hashchange。 */
  function route(sub) {
    let h = (sub || '').replace(/^#!model-config\//, '').replace(/^#/, '');

    if (h.startsWith('s=')) { runScenario(h.slice(2)); return; }

    if (h.startsWith('edit=')) {
      const pid = decodeURIComponent(h.slice(5));
      activate('providers', { hash: false });
      const api = PANELS.providers.api();
      if (!api) return;
      /* 成功/失败都给一句 toast。跨面板跳转会同时换 tab 又换视图，
         不说话的话用户只看到画面整个变了，不知道自己落在哪里；
         找不到时更需要说 —— 分享出去的链接会因为对方本地没有这个
         Provider 而落空，静默失败最难排查。 */
      if (api.openProvider(pid)) OMP.ui.toast(`已定位到供应商 ${pid}`, 'server');
      else OMP.ui.toast(`找不到供应商「${pid}」`, 'alert');
      return;
    }

    if (h.startsWith('role=')) {
      const rid = decodeURIComponent(h.slice(5));
      activate('roles', { hash: false });
      const api = PANELS.roles.api();
      if (!api) return;
      if (!api.openRole(rid)) OMP.ui.toast(`找不到角色「${rid}」`, 'alert');
      return;
    }

    if (h.startsWith('assign=')) {
      const sel = decodeURIComponent(h.slice(7));
      activate('roles', { hash: false });
      const api = PANELS.roles.api();
      if (!api) return;
      /* 这条路径是从供应商面板点「分配给角色」过来的：换了 tab 又弹出
         对话框，变化很大，所以成功时也说一句用户落在哪儿。 */
      if (api.openAssign(sel)) OMP.ui.toast(`为 ${sel} 选择角色`, 'user');
      else OMP.ui.toast(`模型「${sel}」当前不可用，无法分配`, 'alert');
      return;
    }

    if (PANELS[h]) { activate(h, { hash: false }); return; }
    activate('providers', { hash: false });
  }

  /* ---------------- 绑定 ---------------- */
  function init() {
    const shell = document.getElementById('mcRoot');   // 模板注入后才存在
    if (!shell) return;
    buildTabs();

    const tabs = $('#mcTabs');
    tabs.addEventListener('click', e => {
      const b = e.target.closest('[data-mc-tab]');
      if (b) activate(b.dataset.mcTab, { focusTab: true });
    });

    /* 自己处理方向键，不复用 OMP.ui.initTablist：那个 helper 有自己的
       aria-selected / tabindex 写入逻辑，跟这里的 activate() 会变成两个
       写同一份状态的地方。委托在容器上，与 tab 是否重建无关。 */
    tabs.addEventListener('keydown', e => {
      const i = KEYS.indexOf(active);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = KEYS[(i + 1) % KEYS.length];
      else if (e.key === 'ArrowLeft') next = KEYS[(i - 1 + KEYS.length) % KEYS.length];
      else if (e.key === 'Home') next = KEYS[0];
      else if (e.key === 'End') next = KEYS[KEYS.length - 1];
      if (!next) return;
      e.preventDefault();
      activate(next, { focusTab: true });
    });

    /* 面板里的跨面板链接保持为真的 <a href="#…">（可中键 / 新标签页打开，
       也可复制分享），但同页左键点击时拦下来直接路由：
         - 不整页重载，另一边的草稿不会丢
         - hash 相同时不会触发 hashchange，只靠监听会「点第二次没反应」
       SPA：写 #!model-config/<sub>（真位置变化用 pushState，可返回）。 */
    shell.addEventListener('click', e => {
      const a = e.target.closest('a[href^="#"]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const h = a.getAttribute('href').slice(1);
      if (!h) return;
      e.preventDefault();
      if (history.pushState) history.pushState(null, '', '#!model-config/' + h);
      route(h);
    });
  }

  OMP.modelConfig = OMP.modelConfig || {};
  /* 面板改完数据后调一下，让 tab 徽标跟上（跨面板的连带影响见 refreshCounts）。 */
  OMP.modelConfig.refreshTabs = refreshCounts;
  OMP.modelConfig.goto = route;
  /* SPA：router 首次进入 model-config 时调 init() 建 tab 一次；之后每次
     进入调 route(sub)。不再自启动 / 不再监听 hashchange。 */
  OMP.modelConfig.init = function () {
    if (OMP.modelConfig.inited) return;
    OMP.modelConfig.inited = true;
    init();
  };
  OMP.modelConfig.route = route;
})();
