/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — app.js
     Composition root: shell, routing, panels, global keyboard map.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { bus } = OMP.mod['js/bus'];
    const { mountToasts, makeResizer, animateLayout, iconBtn, closePopover, closeDialog } = OMP.mod['js/ui'];
    const { createSidebar } = OMP.mod['js/components/sidebar'];
    const { createTopbar } = OMP.mod['js/components/topbar'];
    const { createTimeline } = OMP.mod['js/components/timeline'];
    const { createMinimap } = OMP.mod['js/components/minimap'];
    const { createComposer } = OMP.mod['js/components/composer'];
    const { createChanges, createDiff } = OMP.mod['js/components/changes'];
    const { createPreview } = OMP.mod['js/components/preview'];
    const { createBottomPanel, createAgentHub } = OMP.mod['js/components/panels'];
    const { createPalette, createScenarioSwitcher } = OMP.mod['js/components/overlays'];
    const { applyScenario } = OMP.mod['js/scenarios'];
    const { renderProjectHome, renderEnvCheck, renderHistory, renderCapabilities, renderSettings, renderDiagnostics } = OMP.mod['js/screens'];
    const { OMP_STATUS_LABEL } = OMP.mod['data/diagnostics'];
  function mount(root) {
    /* ---- Shell ----------------------------------------------------------- */
    const shell = h('div', { class: 'app' });

    const sidebarWrap = h('div', { class: 'app-sidebar' });
    const sidebarResizer = h('div', {
      class: 'resizer resizer-v',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整侧栏宽度',
      tabindex: '0',
    });
    const mainWrap = h('div', { class: 'app-main' });

    shell.append(sidebarWrap, sidebarResizer, mainWrap);
    root.appendChild(shell);

    /* ---- Components ------------------------------------------------------ */
    const sidebar = createSidebar();
    sidebarWrap.appendChild(sidebar.el);

    const topbar = createTopbar();
    const timeline = createTimeline();
    const minimap = createMinimap(() => timeline.el);
    const composer = createComposer();
    const changes = createChanges();
    const diff = createDiff();
    const preview = createPreview();
    const agentHub = createAgentHub();
    const bottomPanel = createBottomPanel();
    const palette = createPalette();
    const scenarioSwitcher = createScenarioSwitcher();

    document.body.append(palette.el, scenarioSwitcher.el);
    mountToasts(document.body);

    /* ---- Workbench structure --------------------------------------------- */
    const statusbar = h('div', { class: 'statusbar', style: { display: 'none' } });

    /* conversation pane = timeline + composer, with the minimap pinned right */
    const convPane = h('div', { class: 'wb-conversation' },
      h('div', { class: 'wb-conv-body' }, timeline.el, minimap.el),
      composer.el,
    );

    const primarySlot = h('div', { class: 'wb-pane wb-pane-primary' });
    const paneResizer = h('div', {
      class: 'resizer',
      role: 'separator',
      'aria-label': '调整分栏比例',
    });
    const secondarySlot = h('div', { class: 'wb-pane wb-pane-secondary' });
    const mainSplit = h('div', { class: 'wb-split' }, primarySlot, paneResizer, secondarySlot);

    const rightPanel = h('div', { class: 'wb-right' });
    const rightResizer = h('div', {
      class: 'resizer resizer-v',
      role: 'separator',
      'aria-label': '调整右侧面板宽度',
    });

    const wbMain = h('div', { class: 'wb-main' }, mainSplit, rightResizer, rightPanel);
    const workbench = h('div', { class: 'workbench' }, topbar.el, wbMain, bottomPanel.el, statusbar);

    const screenHost = h('div', { class: 'screen-host', style: { display: 'none' } });

    mainWrap.append(workbench, screenHost);

    /* ==========================================================================
       Pane routing — three views (conversation / diff / preview) across
       four layout modes. Switching must not destroy component state, so we
       move the same nodes rather than re-creating them.
       ========================================================================== */

    const views = {
      conversation: convPane,
      diff: diff.el,
      preview: preview.el,
      changes: changes.el,
      agents: agentHub.el,
    };

    function renderPanes() {
      const layout = store.get('mainLayout');
      const primary = store.get('mainPrimary');
      const secondary = store.get('mainSecondary');

      mainSplit.setAttribute('data-layout', layout);

      /* Detach without unmounting: appendChild moves nodes, preserving
         scroll offsets, expanded cards, and draft text. */
      clear(primarySlot);
      clear(secondarySlot);

      primarySlot.appendChild(views[primary] || convPane);

      const split = layout === 'split-h' || layout === 'split-v';
      paneResizer.style.display = split ? 'block' : 'none';
      secondarySlot.style.display = split ? 'flex' : 'none';

      if (split) {
        paneResizer.className = layout === 'split-h' ? 'resizer resizer-v' : 'resizer resizer-h';
        secondarySlot.appendChild(views[secondary] || diff.el);
      }

      primarySlot.style.flexBasis = split ? `${store.get('splitRatio') * 100}%` : '100%';

      /* View switcher chips inside each pane header would live here in a
         fuller build; the topbar layout buttons cover the required states. */
    }

    function renderRightPanel() {
      const open = store.get('rightPanelOpen');
      rightPanel.style.display = open ? 'flex' : 'none';
      rightResizer.style.display = open ? 'block' : 'none';
      if (!open) return;

      rightPanel.style.width = `${store.get('rightPanelWidth')}px`;

      const tab = store.get('rightPanelTab');
      const tabs = [
        ['changes', 'Changes', 'columns'],
        ['diff', 'Diff', 'fileCode'],
        ['preview', 'Preview', 'toolPreview'],
        ['agents', 'Agents', 'toolSubagent'],
      ];

      clear(rightPanel);
      rightPanel.append(
        h('div', { class: 'tabs' },
          tabs.map(([id, label, ic]) =>
            h('button', {
              class: 'tab',
              role: 'tab',
              'aria-selected': String(tab === id),
              data: tab === id ? { active: 'true' } : {},
              onclick: () => store.set({ rightPanelTab: id }),
            }, icon(ic, 'icon-sm'), label)),
          h('div', { class: 'tabs-actions' },
            iconBtn('close', '关闭面板', () => {
              animateLayout(() => store.set({ rightPanelOpen: false }));
            }, { small: true }),
          ),
        ),
        h('div', { class: 'wb-right-body' }, views[tab] || changes.el),
      );
    }

    /* ==========================================================================
       Screen routing
       ========================================================================== */

    function renderScreen() {
      const screen = store.get('screen');
      const isWorkbench = screen === 'workbench';

      workbench.style.display = isWorkbench ? 'flex' : 'none';
      screenHost.style.display = isWorkbench ? 'none' : 'block';

      if (isWorkbench) {
        renderPanes();
        renderRightPanel();
        return;
      }

      clear(screenHost);
      screenHost.appendChild(screenTopbar(screen));

      const body =
        screen === 'project-home' ? renderProjectHome()
        : screen === 'env-check' ? renderEnvCheck()
        : screen === 'history' ? renderHistory()
        : screen === 'capabilities' ? renderCapabilities()
        : screen === 'settings' ? renderSettings()
        : screen === 'diagnostics' ? renderDiagnostics()
        : renderProjectHome();

      screenHost.appendChild(body);
    }

    function screenTopbar(screen) {
      const titles = {
        'project-home': '项目',
        'env-check': '环境检查',
        history: '会话历史',
        capabilities: '能力中心',
        settings: '设置',
        diagnostics: '诊断中心',
      };

      return h('div', { class: 'topbar' },
        h('button', {
          class: 'btn btn-sm btn-outline',
          onclick: () => store.set({ screen: 'workbench' }),
        }, icon('arrowLeft', 'icon-sm'), '返回工作台'),
        h('span', { style: { fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semi)', marginLeft: '8px' } },
          titles[screen] || screen),
        h('div', { class: 'topbar-right' },
          iconBtn(store.get('theme') === 'dark' ? 'sun' : 'moon', '切换主题', () => {
            store.set({ theme: store.get('theme') === 'dark' ? 'light' : 'dark' });
          }),
        ),
      );
    }

    /* ==========================================================================
       Global status bar — only appears for abnormal states. Toast alone is not
       enough for a condition that persists (§20).
       ========================================================================== */

    function renderStatusbar() {
      const status = store.get('ompStatus');
      const err = store.get('ompError');

      const abnormal = ['disconnected', 'error', 'reconnecting', 'starting'].includes(status);
      statusbar.style.display = abnormal ? 'flex' : 'none';
      if (!abnormal) return;

      const info = OMP_STATUS_LABEL[status];
      const tone = status === 'reconnecting' || status === 'starting' ? 'warn' : 'danger';

      clear(statusbar);
      statusbar.setAttribute('data-tone', tone);
      statusbar.append(
        h('span', { class: 'statusbar-icon' },
          icon(status === 'reconnecting' || status === 'starting' ? 'refresh' : 'wifiOff', 'icon-sm')),
        h('span', { class: 'statusbar-text' }, err || info.text),
        h('div', { class: 'statusbar-actions' },
          h('button', {
            class: 'statusbar-action',
            onclick: () => {
              store.set({ ompStatus: 'reconnecting' });
              setTimeout(() => { store.set({ ompStatus: 'ready', ompError: null }); store.toast('已重新连接', 'ok'); }, 1600);
            },
          }, '重试'),
          h('button', {
            class: 'statusbar-action',
            onclick: () => store.set({ screen: 'diagnostics' }),
          }, '诊断'),
          h('button', {
            class: 'statusbar-action',
            onclick: () => store.toast(err || info.text, 'info'),
          }, '详细信息'),
        ),
      );
    }

    /* ==========================================================================
       Resizers
       ========================================================================== */

    makeResizer(sidebarResizer, {
      axis: 'x',
      onMove: (delta) => {
        const next = Math.min(Math.max(store.get('sidebarWidth') + delta, 200), 480);
        sidebarWrap.style.width = `${next}px`;
      },
      onEnd: () => store.set({ sidebarWidth: sidebarWrap.getBoundingClientRect().width }),
    });

    sidebarResizer.addEventListener('dblclick', () => {
      animateLayout(() => store.set({ sidebarCollapsed: !store.get('sidebarCollapsed') }));
    });

    makeResizer(rightResizer, {
      axis: 'x',
      invert: true,
      onMove: (delta) => {
        const next = Math.min(Math.max(store.get('rightPanelWidth') + delta, 280), 720);
        rightPanel.style.width = `${next}px`;
      },
      onEnd: () => store.set({ rightPanelWidth: rightPanel.getBoundingClientRect().width }),
    });

    makeResizer(paneResizer, {
      axis: 'x',
      onMove: (delta) => {
        const total = mainSplit.getBoundingClientRect().width;
        const cur = primarySlot.getBoundingClientRect().width;
        const next = Math.min(Math.max((cur + delta) / total, 0.25), 0.75);
        primarySlot.style.flexBasis = `${next * 100}%`;
      },
      onEnd: () => {
        const total = mainSplit.getBoundingClientRect().width;
        store.set({ splitRatio: primarySlot.getBoundingClientRect().width / total });
      },
    });

    /* ==========================================================================
       Layout application
       ========================================================================== */

    function applyShellLayout() {
      const collapsed = store.get('sidebarCollapsed');
      sidebarWrap.style.width = collapsed
        ? 'var(--sidebar-mini)'
        : `${store.get('sidebarWidth')}px`;
      sidebarResizer.style.display = collapsed ? 'none' : 'block';
    }

    /* ==========================================================================
       Keyboard map
       ========================================================================== */

    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

      /* ⌘K — palette (works even in fields) */
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.set({ paletteOpen: !store.get('paletteOpen') });
        return;
      }

      /* ⌘⇧S — scenario switcher */
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        store.set({ scenarioSwitcherOpen: !store.get('scenarioSwitcherOpen') });
        return;
      }

      if (inField && !mod) return;

      /* ⌘B — sidebar */
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        animateLayout(() => store.set({ sidebarCollapsed: !store.get('sidebarCollapsed') }));
        return;
      }

      /* ⌘⌥B — right panel */
      if (mod && e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        animateLayout(() => store.set({ rightPanelOpen: !store.get('rightPanelOpen') }));
        return;
      }

      /* ⌃` — bottom panel */
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        animateLayout(() => store.set({ bottomPanelOpen: !store.get('bottomPanelOpen') }));
        return;
      }

      /* ⌘⇧R — reset layout */
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        store.resetLayout();
        store.toast('已恢复默认布局', 'ok');
        return;
      }

      /* ⌘, — settings */
      if (mod && e.key === ',') {
        e.preventDefault();
        store.set({ screen: 'settings' });
        return;
      }

      /* ⌘N — new thread */
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        store.toast('已新建对话', 'ok');
        return;
      }

      /* ⌘/ — shortcuts help */
      if (mod && e.key === '/') {
        e.preventDefault();
        document.querySelector('.sidebar-header-logo')?.click();
        return;
      }

      /* Esc — abort, or close overlays */
      if (e.key === 'Escape') {
        if (store.get('paletteOpen')) { store.set({ paletteOpen: false }); return; }
        if (store.get('scenarioSwitcherOpen')) { store.set({ scenarioSwitcherOpen: false }); return; }
        if (store.get('runState') === 'running') {
          store.set({ runState: 'aborting' });
          setTimeout(() => { store.set({ runState: 'idle' }); store.toast('已中止当前任务', 'warn'); }, 700);
        }
        return;
      }

      /* ⌘End — jump to latest */
      if (mod && e.key === 'End') {
        e.preventDefault();
        timeline.el.scrollTo({ top: timeline.el.scrollHeight, behavior: 'smooth' });
      }
    });

    /* Composer's model pill and the topbar share one menu implementation */
    document.addEventListener('omp:open-model-menu', (e) => {
      /* Route to the topbar telemetry → model menu by clicking through */
      const anchor = e.detail?.anchor;
      if (anchor) document.querySelector('.telemetry')?.click();
    });

    /* ==========================================================================
       Theme / density application
       ========================================================================== */

    function applyTheme() {
      document.documentElement.setAttribute('data-theme', store.get('theme'));
      document.documentElement.setAttribute('data-density', store.get('density'));
    }

    /* ==========================================================================
       Wire up
       ========================================================================== */

    store.subscribe(['sidebarCollapsed', 'sidebarWidth'], applyShellLayout);
    store.subscribe(['screen', 'scenario', 'capTab', 'settingsTab', '_diagTick'], renderScreen);
    store.subscribe(['mainLayout', 'mainPrimary', 'mainSecondary', 'splitRatio'], renderPanes);
    store.subscribe(['rightPanelOpen', 'rightPanelTab', 'rightPanelWidth'], renderRightPanel);
    store.subscribe(['ompStatus', 'ompError'], renderStatusbar);
    store.subscribe(['theme', 'density'], applyTheme);

    applyTheme();
    applyShellLayout();
    renderScreen();
    renderStatusbar();

    /* Restore the last scenario, or start on the default workbench view */
    const initial = store.get('scenario') || 'wb:streaming';
    applyScenario(initial);

    /* Expose for console poking during review. Extend the namespace —
       never reassign it, or the module registry is destroyed. */
    Object.assign(OMP, { store, bus, applyScenario, timeline, minimap });
  }


  OMP.mod['js/app'] = { mount };
})(window.OMP = window.OMP || { mod: {} });
