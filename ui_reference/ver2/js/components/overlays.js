/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — overlays.js
     Command Palette and the scenario switcher.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { SCENARIOS, applyScenario } = OMP.mod['js/scenarios'];
    const { WORKSPACES } = OMP.mod['data/workspaces'];
    const { THREADS } = OMP.mod['data/threads'];
    const { SKILLS, PLUGINS, MCP_SERVERS, SLASH_COMMANDS } = OMP.mod['data/capabilities'];
  /* ==========================================================================
     Command Palette
     Unified search over commands, projects, threads, files, skills,
     slash commands, plugins and MCP tools.
     ========================================================================== */

  function createPalette() {
    const el = h('div', { class: 'palette-backdrop', style: { display: 'none' } });
    let query = '';
    let selected = 0;
    let input = null;

    const COMMANDS = [
      { icon: 'plus', label: '新建对话', hint: '⌘N', run: () => store.toast('已新建对话', 'ok') },
      { icon: 'folderOpen', label: '打开本地项目', hint: '⌘O', run: () => store.toast('打开项目', 'info') },
      { icon: 'gitBranch', label: '克隆 Git 仓库', run: () => store.toast('克隆仓库', 'info') },
      { icon: 'flask', label: '创建临时工作区', run: () => store.toast('已创建临时工作区', 'ok') },
      { icon: 'sidebar', label: '切换侧栏', hint: '⌘B', run: () => store.set({ sidebarCollapsed: !store.get('sidebarCollapsed') }) },
      { icon: 'panelBottom', label: '切换底部面板', hint: '⌃`', run: () => store.set({ bottomPanelOpen: !store.get('bottomPanelOpen') }) },
      { icon: 'panelRight', label: '切换右侧面板', hint: '⌘⌥B', run: () => store.set({ rightPanelOpen: !store.get('rightPanelOpen') }) },
      { icon: 'layoutSplitH', label: '切换到左右分栏', run: () => store.set({ mainLayout: 'split-h' }) },
      { icon: 'layoutSingle', label: '切换到单区域', run: () => store.set({ mainLayout: 'single' }) },
      { icon: 'rotateCcw', label: '恢复默认布局', hint: '⌘⇧R', run: () => { store.resetLayout(); store.toast('已恢复默认布局', 'ok'); } },
      { icon: 'sun', label: '切换主题（亮 / 暗）', run: () => store.set({ theme: store.get('theme') === 'dark' ? 'light' : 'dark' }) },
      { icon: 'type', label: '切换信息密度', run: () => store.set({ density: store.get('density') === 'compact' ? 'comfortable' : 'compact' }) },
      { icon: 'stop', label: 'Abort 当前任务', hint: 'Esc', run: () => { store.set({ runState: 'idle' }); store.toast('已中止', 'warn'); } },
      { icon: 'layers', label: 'Compact 当前上下文', run: () => applyScenario('wb:compacting') },
      { icon: 'terminal', label: '打开终端', run: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'terminal' }) },
      { icon: 'alertCircle', label: '查看 Problems', run: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'problems' }) },
      { icon: 'flask', label: '查看 Tests', run: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'tests' }) },
      { icon: 'toolPreview', label: '打开 Preview', run: () => store.set({ mainLayout: 'split-h', mainSecondary: 'preview' }) },
      { icon: 'columns', label: '打开 Changes', run: () => store.set({ rightPanelOpen: true, rightPanelTab: 'changes' }) },
      { icon: 'toolSubagent', label: '打开 Agent Hub', run: () => store.set({ rightPanelOpen: true, rightPanelTab: 'agents' }) },
      { icon: 'layers', label: '项目主页', run: () => store.set({ screen: 'project-home' }) },
      { icon: 'history', label: '会话历史', run: () => store.set({ screen: 'history' }) },
      { icon: 'puzzle', label: '能力中心', run: () => store.set({ screen: 'capabilities' }) },
      { icon: 'settings', label: '设置', hint: '⌘,', run: () => store.set({ screen: 'settings' }) },
      { icon: 'activity', label: '诊断中心', run: () => store.set({ screen: 'diagnostics' }) },
      { icon: 'shieldCheck', label: '环境检查', run: () => store.set({ screen: 'env-check' }) },
      { icon: 'refresh', label: '重启 OMP Bridge', run: () => { store.set({ ompStatus: 'starting' }); setTimeout(() => store.set({ ompStatus: 'ready' }), 1400); } },
    ];

    function results() {
      const q = query.trim().toLowerCase();
      const groups = [];

      const match = (s) => !q || String(s).toLowerCase().includes(q);

      const cmds = COMMANDS.filter(c => match(c.label));
      if (cmds.length) groups.push(['命令', cmds.map(c => ({ ...c, kind: 'command' }))]);

      if (q) {
        const projects = WORKSPACES.filter(w => match(w.name) || match(w.path));
        if (projects.length) groups.push(['项目', projects.map(w => ({
          icon: 'folder', label: w.name, hint: w.path, kind: 'project',
          run: () => store.set({ activeProjectId: w.id, screen: 'workbench' }),
        }))]);

        const threads = THREADS.filter(t => match(t.title));
        if (threads.length) groups.push(['对话', threads.slice(0, 6).map(t => ({
          icon: 'quote', label: t.title, hint: t.updatedAt, kind: 'thread',
          run: () => store.set({ activeThreadId: t.id, activeProjectId: t.projectId, screen: 'workbench' }),
        }))]);

        const slash = SLASH_COMMANDS.filter(c => match(c.name) || match(c.description));
        if (slash.length) groups.push(['Slash Commands', slash.map(c => ({
          icon: 'command', label: c.name, hint: c.description, kind: 'slash',
          run: () => store.toast(`已插入 ${c.name}`, 'ok'),
        }))]);

        const skills = SKILLS.filter(s => match(s.name) || match(s.description));
        if (skills.length) groups.push(['Skills', skills.map(s => ({
          icon: 'sparkles', label: s.name, hint: s.scope, kind: 'skill',
          run: () => store.set({ screen: 'capabilities', capTab: 'skills' }),
        }))]);

        const plugins = PLUGINS.filter(p => match(p.name));
        if (plugins.length) groups.push(['Plugins', plugins.map(p => ({
          icon: 'puzzle', label: p.name, hint: p.version, kind: 'plugin',
          run: () => store.set({ screen: 'capabilities', capTab: 'plugins' }),
        }))]);

        const mcpTools = MCP_SERVERS.flatMap(s =>
          s.tools.filter(match).map(t => ({
            icon: 'toolMcp', label: t, hint: `MCP · ${s.name}`, kind: 'mcp',
            run: () => store.set({ screen: 'capabilities', capTab: 'mcp' }),
          })));
        if (mcpTools.length) groups.push(['MCP Tools', mcpTools.slice(0, 8)]);
      }

      return groups;
    }

    function flatResults() {
      return results().flatMap(([, items]) => items);
    }

    function render() {
      const open = store.get('paletteOpen');
      el.style.display = open ? 'flex' : 'none';
      if (!open) return;

      clear(el);

      input = h('input', {
        class: 'palette-input',
        placeholder: '搜索命令、项目、对话、文件、Skills、Slash Commands、Plugins、MCP Tools…',
        'aria-label': 'Command Palette',
        oninput: (e) => { query = e.target.value; selected = 0; render(); },
        onkeydown: onKeyDown,
      });
      input.value = query;

      const groups = results();
      const flat = flatResults();

      const resultsEl = h('div', { class: 'palette-results', role: 'listbox' });

      if (!flat.length) {
        resultsEl.appendChild(
          h('div', { class: 'empty-state' },
            icon('search', 'icon-lg'),
            h('div', { class: 'empty-state-title' }, '没有匹配结果'),
            h('div', { class: 'empty-state-desc' }, `没有找到与「${query}」相关的内容。`),
          )
        );
      }

      let idx = 0;
      groups.forEach(([label, items]) => {
        resultsEl.appendChild(h('div', { class: 'palette-group-label' }, label));
        items.forEach(item => {
          const myIdx = idx++;
          resultsEl.appendChild(
            h('button', {
              class: 'palette-item',
              role: 'option',
              'aria-selected': String(myIdx === selected),
              data: myIdx === selected ? { selected: 'true' } : {},
              onclick: () => execute(item),
              onpointerenter: () => { selected = myIdx; updateSelection(resultsEl); },
            },
              icon(item.icon, 'icon'),
              h('span', { class: 'palette-item-label' }, item.label),
              item.hint ? h('span', { class: 'palette-item-meta' }, item.hint) : null,
            )
          );
        });
      });

      const panel = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'palette-input-wrap' },
          icon('search', 'icon'),
          input,
          h('kbd', {}, 'Esc'),
        ),
        resultsEl,
        h('div', { class: 'palette-footer' },
          h('span', { class: 'palette-footer-item' }, h('kbd', {}, '↑↓'), '选择'),
          h('span', { class: 'palette-footer-item' }, h('kbd', {}, '↵'), '执行'),
          h('span', { class: 'palette-footer-item' }, h('kbd', {}, 'Esc'), '关闭'),
          h('span', { style: { marginLeft: 'auto' } }, `${flat.length} 个结果`),
        ),
      );

      el.appendChild(panel);
      requestAnimationFrame(() => input.focus());
    }

    function updateSelection(resultsEl) {
      resultsEl.querySelectorAll('.palette-item').forEach((n, i) => {
        if (i === selected) n.setAttribute('data-selected', 'true');
        else n.removeAttribute('data-selected');
      });
    }

    function onKeyDown(e) {
      const flat = flatResults();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selected = Math.min(selected + 1, flat.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selected = Math.max(selected - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (flat[selected]) execute(flat[selected]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }

    function execute(item) {
      close();
      item.run?.();
    }

    function close() {
      query = '';
      selected = 0;
      store.set({ paletteOpen: false });
    }

    el.addEventListener('click', (e) => { if (e.target === el) close(); });

    store.subscribe('paletteOpen', render);
    render();

    return { el, render };
  }

  /* ==========================================================================
     Scenario switcher — index of all 40 + 16 states
     ========================================================================== */

  function createScenarioSwitcher() {
    const wrap = h('div');
    const fab = h('button', {
      class: 'scenario-fab',
      'aria-label': '打开场景切换器',
      onclick: () => store.set({ scenarioSwitcherOpen: true }),
    },
      icon('layers', 'icon-sm'),
      h('span', {}, 'Scenarios'),
      h('kbd', {}, '⌘⇧S'),
    );

    const panel = h('div', { class: 'scenario-panel', style: { display: 'none' } });
    wrap.append(fab, panel);

    function render() {
      const open = store.get('scenarioSwitcherOpen');
      fab.style.display = open ? 'none' : 'flex';
      panel.style.display = open ? 'flex' : 'none';
      if (!open) return;

      clear(panel);

      const current = store.get('scenario');
      const groups = {};
      SCENARIOS.forEach(s => { (groups[s.group] ||= []).push(s); });

      const body = h('div', { class: 'scenario-body' });

      Object.entries(groups).forEach(([group, items]) => {
        body.appendChild(h('div', { class: 'scenario-group-label' }, group));
        items.forEach(s => {
          body.appendChild(
            h('button', {
              class: 'scenario-item',
              data: current === s.id ? { active: 'true' } : {},
              onclick: () => {
                applyScenario(s.id);
                store.set({ scenarioSwitcherOpen: false });
              },
            },
              h('span', { class: 'scenario-num' }, s.n ? String(s.n) : '·'),
              h('span', { class: 'scenario-item-label' }, s.label),
              s.play ? h('span', { class: 'scenario-play' }, icon('play', 'icon-sm')) : null,
            )
          );
        });
      });

      panel.append(
        h('div', { class: 'scenario-header' },
          icon('layers', 'icon-sm'),
          h('span', { class: 'scenario-title' }, '场景切换器'),
          h('button', {
            class: 'btn btn-icon btn-sm',
            'aria-label': '关闭',
            onclick: () => store.set({ scenarioSwitcherOpen: false }),
          }, icon('close', 'icon-sm')),
        ),
        body,
        h('div', { class: 'scenario-footer' },
          icon('play', 'icon-sm'),
          h('span', {}, '带 ▶ 的场景会按真实时序播放'),
          h('span', { style: { marginLeft: 'auto' } }, `${SCENARIOS.length} 个`),
        ),
      );
    }

    store.subscribe(['scenarioSwitcherOpen', 'scenario'], render);
    render();

    return { el: wrap, render };
  }


  OMP.mod['js/components/overlays'] = { createPalette, createScenarioSwitcher };
})(window.OMP = window.OMP || { mod: {} });
