/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — topbar.js
     Workspace bar: breadcrumb, thread actions, layout switcher, connection
     status, and the Session Telemetry strip.

     Telemetry rule: every number carries a label and a unit. A bare figure
     next to an icon is decoration that looks like information.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { showPopover, closePopover, menuItem, menuSep, menuGroupLabel, iconBtn, attachTooltip, ring, animateLayout } = OMP.mod['js/ui'];
    const { WORKSPACES } = OMP.mod['data/workspaces'];
    const { threadById } = OMP.mod['data/threads'];
    const { MODELS, THINKING_LEVELS, PERMISSION_MODES, SERVICE_TIERS, SESSION_TELEMETRY, modelById, fmtTokens, fmtDuration, fmtCost, fmtPercent, contextTone } = OMP.mod['data/telemetry'];
  function createTopbar() {
    const el = h('header', { class: 'topbar', role: 'banner' });

    function render() {
      clear(el);

      const ws = WORKSPACES.find(w => w.id === store.get('activeProjectId')) || WORKSPACES[0];
      const thread = threadById(store.get('activeThreadId'));

      el.append(
        renderNav(ws, thread),
        renderActions(),
        renderRight(),
      );
    }

    /* ---- Breadcrumb: project › branch › thread --------------------------- */
    function renderNav(ws, thread) {
      return h('nav', { class: 'topbar-nav', 'aria-label': '当前位置' },
        h('button', {
          class: 'topbar-nav-item',
          onclick: (e) => openProjectMenu(e.currentTarget, ws),
        },
          icon(ws.kind === 'worktree' ? 'gitBranch' : ws.kind === 'temp' ? 'flask' : 'folder', 'icon-sm'),
          ws.name,
          icon('chevronDown', 'icon-sm'),
        ),

        ws.branch ? h('span', { class: 'topbar-nav-sep' }, '›') : null,
        ws.branch ? h('button', {
          class: 'topbar-nav-item',
          onclick: (e) => openBranchMenu(e.currentTarget, ws),
        },
          icon('gitBranch', 'icon-sm'),
          ws.branch,
          ws.dirty ? h('span', { class: 'dot dot-warn', style: { marginLeft: '2px' } }) : null,
        ) : null,

        h('span', { class: 'topbar-nav-sep' }, '›'),
        h('button', {
          class: 'topbar-nav-item topbar-nav-item-current',
          onclick: (e) => openThreadMenu(e.currentTarget, thread),
        },
          thread?.title || '新对话',
          icon('chevronDown', 'icon-sm'),
        ),
      );
    }

    /* ---- Center actions -------------------------------------------------- */
    function renderActions() {
      return h('div', { class: 'topbar-actions' },
        iconBtn('plus', '新建对话', () => store.toast('已新建对话', 'ok'), { kbd: '⌘N' }),
        iconBtn('history', '会话历史', () => store.set({ screen: 'history' })),
        iconBtn('gitFork', 'Fork 当前对话', () => store.toast('已 Fork 当前对话', 'ok')),
        iconBtn('cornerUpRight', 'Handoff 到新对话', () => store.toast('已 Handoff', 'ok')),
      );
    }

    /* ---- Right: layout + status + telemetry ------------------------------ */
    function renderRight() {
      const layout = store.get('mainLayout');
      const status = store.get('ompStatus');

      const statusDot = h('span', { class: 'topbar-status', data: { status } });
      attachTooltip(statusDot, {
        ready: 'OMP 已连接',
        running: 'OMP 正在运行任务',
        reconnecting: 'OMP 正在重连',
        disconnected: 'OMP 已断开',
        error: 'OMP 发生错误',
        starting: 'OMP 正在启动',
        'update-available': 'OMP 有可用更新',
      }[status] || status);

      return h('div', { class: 'topbar-right' },
        /* Layout switcher */
        h('div', { class: 'topbar-layout', role: 'group', 'aria-label': '主区域布局' },
          layoutBtn('layoutSingle', 'single', '单区域'),
          layoutBtn('layoutSplitH', 'split-h', '左右分栏'),
          layoutBtn('layoutSplitV', 'split-v', '上下分栏'),
        ),

        iconBtn('panelRight', '右侧面板', () => {
          animateLayout(() => store.set({ rightPanelOpen: !store.get('rightPanelOpen') }));
        }, { active: store.get('rightPanelOpen'), kbd: '⌘⌥B' }),

        iconBtn('panelBottom', '底部面板', () => {
          animateLayout(() => store.set({ bottomPanelOpen: !store.get('bottomPanelOpen') }));
        }, { active: store.get('bottomPanelOpen'), kbd: '⌃`' }),

        h('span', { class: 'divider-vertical', style: { height: '18px' } }),

        statusDot,
        renderTelemetry(),
      );
    }

    function layoutBtn(iconName, mode, label) {
      const btn = h('button', {
        class: 'topbar-layout-btn',
        'aria-label': label,
        'aria-pressed': String(store.get('mainLayout') === mode),
        data: store.get('mainLayout') === mode ? { active: 'true' } : {},
        onclick: () => animateLayout(() => store.set({ mainLayout: mode })),
      }, icon(iconName, 'icon-sm'));
      attachTooltip(btn, label);
      return btn;
    }

    /* ==========================================================================
       Session Telemetry
       ========================================================================== */
    function renderTelemetry() {
      const t = SESSION_TELEMETRY;
      const model = modelById(store.get('model'));
      const ctxRatio = t.context.used / t.context.total;
      const tone = contextTone(ctxRatio);

      const strip = h('button', {
        class: 'telemetry',
        data: { contextTone: tone },
        'aria-label': 'Session Telemetry — 点击查看详情',
        onclick: (e) => { e.stopPropagation(); openTelemetryFlyout(strip); },
      },
        /* 1. Model */
        h('span', { class: 'telemetry-item' },
          icon('sparkles', 'icon-sm'),
          h('span', { class: 'telemetry-value' }, model.short),
        ),
        h('span', { class: 'telemetry-sep' }),

        /* 2. Tokens in / out */
        h('span', { class: 'telemetry-item' },
          icon('arrowUp', 'icon-sm'),
          h('span', { class: 'telemetry-value' }, fmtTokens(t.session.tokensIn)),
          icon('arrowDown', 'icon-sm'),
          h('span', { class: 'telemetry-value' }, fmtTokens(t.session.tokensOut)),
        ),
        h('span', { class: 'telemetry-sep' }),

        /* 3. Context usage ring + percent */
        h('span', { class: 'telemetry-item' },
          ring(ctxRatio, tone, 14),
          h('span', { class: 'telemetry-value' }, fmtPercent(ctxRatio)),
        ),
        h('span', { class: 'telemetry-sep' }),

        /* 4. Current turn elapsed */
        h('span', { class: 'telemetry-item' },
          icon('clock', 'icon-sm'),
          h('span', { class: 'telemetry-value' }, fmtDuration(t.turn.durationMs)),
        ),
      );

      /* Hover reveals the same numbers with full labels and units */
      attachTooltip(strip, () => h('div', {},
        h('div', { class: 'tooltip-title' }, 'Session Telemetry'),
        tipRow('模型', model.name),
        tipRow('输入 Token（会话）', t.session.tokensIn.toLocaleString()),
        tipRow('输出 Token（会话）', t.session.tokensOut.toLocaleString()),
        tipRow('缓存读取', t.session.tokensCacheRead.toLocaleString()),
        tipRow('Context 已用', `${t.context.used.toLocaleString()} / ${t.context.total.toLocaleString()}`),
        tipRow('本轮耗时', fmtDuration(t.turn.durationMs)),
        tipRow('会话总耗时', fmtDuration(t.session.durationMs)),
        tipRow('本轮 Cost', fmtCost(t.turn.costUsd)),
        h('div', { style: { marginTop: '6px', color: 'var(--text-tertiary)', fontSize: '10px' } }, '点击查看完整分解'),
      ), { delay: 300 });

      return strip;
    }

    function tipRow(label, value) {
      return h('div', { class: 'tooltip-row' },
        h('span', {}, label),
        h('strong', {}, String(value)),
      );
    }

    /* ---- Telemetry detail flyout ----------------------------------------- */
    function openTelemetryFlyout(anchor) {
      const t = SESSION_TELEMETRY;
      const model = modelById(store.get('model'));
      const ctxRatio = t.context.used / t.context.total;
      const tone = contextTone(ctxRatio);

      showPopover(anchor, [
        /* Model + quick settings */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, '模型'),
          h('button', {
            class: 'telemetry-model-row',
            onclick: (e) => { e.stopPropagation(); openModelMenu(e.currentTarget); },
          },
            h('div', { class: 'telemetry-model-info' },
              h('div', { class: 'telemetry-model-name' }, model.name),
              h('div', { class: 'telemetry-model-meta' },
                h('span', { class: 'telemetry-model-meta-item' }, `${model.provider}`),
                h('span', { class: 'telemetry-model-meta-item' }, `Thinking ${store.get('thinkingLevel')}`),
                store.get('fastMode') ? h('span', { class: 'telemetry-model-meta-item' }, 'Fast') : null,
                h('span', { class: 'telemetry-model-meta-item' }, `Tier ${store.get('serviceTier')}`),
              ),
            ),
            h('span', { class: 'telemetry-model-chevron' }, icon('chevronRight', 'icon-sm')),
          ),
        ),

        /* Current turn */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, `本轮统计 · Turn ${t.turn.number}`),
          flyRow('输入 Token', t.turn.tokensIn.toLocaleString()),
          flyRow('输出 Token', t.turn.tokensOut.toLocaleString()),
          flyRow('缓存读取', t.turn.tokensCacheRead.toLocaleString(), 'muted'),
          flyRow('缓存写入', t.turn.tokensCacheWrite.toLocaleString(), 'muted'),
          flyRow('耗时', fmtDuration(t.turn.durationMs)),
          flyRow('Cost', fmtCost(t.turn.costUsd)),
        ),

        /* Whole session */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, '整个会话'),
          flyRow('Turn 数', String(t.session.turns)),
          flyRow('模型请求数', String(t.session.requests)),
          flyRow('输入 Token', t.session.tokensIn.toLocaleString()),
          flyRow('输出 Token', t.session.tokensOut.toLocaleString()),
          flyRow('会话总耗时', fmtDuration(t.session.durationMs)),
          flyRow('Cost 合计', fmtCost(t.session.costUsd)),
        ),

        /* Context breakdown */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, 'Context 构成'),
          flyRow(
            '已使用',
            `${t.context.used.toLocaleString()} / ${t.context.total.toLocaleString()} (${fmtPercent(ctxRatio, 1)})`,
            tone === 'muted' ? null : tone
          ),
          h('div', { class: 'telemetry-breakdown' },
            t.context.breakdown.map(seg =>
              h('div', {
                class: 'telemetry-breakdown-segment',
                style: {
                  flexBasis: `${(seg.tokens / t.context.used) * 100}%`,
                  background: seg.color,
                },
                title: `${seg.label} · ${seg.tokens.toLocaleString()} tok`,
              })
            ),
          ),
          h('div', { class: 'telemetry-legend' },
            t.context.breakdown.map(seg =>
              h('div', { class: 'telemetry-legend-item' },
                h('span', { class: 'telemetry-legend-color', style: { background: seg.color } }),
                h('span', { class: 'telemetry-legend-label' }, seg.label),
                h('span', { class: 'telemetry-legend-value' }, fmtTokens(seg.tokens)),
              )
            ),
          ),
        ),

        /* Cache */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, '缓存'),
          h('div', { class: 'telemetry-flyout-row' },
            h('span', { class: 'telemetry-flyout-label' }, '命中率'),
            h('span', { class: 'telemetry-cache-badge' },
              icon('zap', 'icon-sm'), fmtPercent(t.cache.hitRate)),
          ),
          flyRow('已节省', fmtCost(t.cache.savedUsd), 'muted'),
        ),

        /* Compact history */
        h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, 'Compact'),
          h('div', { class: 'telemetry-compact-note' },
            icon('layers', 'icon-sm'),
            '本会话尚未触发 Compact。达到 80% 时会提示，90% 自动执行。',
          ),
        ),

        /* Retries & fallbacks */
        t.retries.length ? h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, '重试与 Fallback'),
          t.retries.map(r =>
            h('div', { class: 'telemetry-flyout-row' },
              h('span', { class: 'telemetry-flyout-label' }, `${r.at} · ${r.method}`),
              h('span', { class: 'telemetry-flyout-value telemetry-flyout-value-warn' },
                `${r.reason}（第 ${r.attempt} 次）`),
            )
          ),
        ) : null,

        /* Subagent consumption */
        t.subagents.length ? h('div', { class: 'telemetry-flyout-section' },
          h('div', { class: 'telemetry-flyout-title' }, '子 Agent 消耗'),
          h('div', { class: 'telemetry-subagents' },
            t.subagents.map(s =>
              h('div', { class: 'telemetry-subagent-row' },
                h('span', { class: 'telemetry-subagent-name' }, s.name),
                h('span', { class: 'telemetry-subagent-tokens' },
                  `↑${fmtTokens(s.tokensIn)} ↓${fmtTokens(s.tokensOut)}`),
                h('span', { class: 'telemetry-subagent-cost' }, fmtCost(s.costUsd)),
              )
            ),
          ),
        ) : null,
      ].filter(Boolean), {
        placement: 'bottom-end',
        className: 'popover telemetry-flyout',
      });
    }

    function flyRow(label, value, tone = null) {
      return h('div', { class: 'telemetry-flyout-row' },
        h('span', { class: 'telemetry-flyout-label' }, label),
        h('span', {
          class: `telemetry-flyout-value${tone ? ` telemetry-flyout-value-${tone}` : ''}`,
        }, value),
      );
    }

    /* ---- Model menu (also hosts Thinking / Fast / Tier / Permission) ----- */
    function openModelMenu(anchor) {
      showPopover(anchor, [
        menuGroupLabel('模型'),
        ...MODELS.map(m =>
          h('button', {
            class: 'model-menu-item',
            data: store.get('model') === m.id ? { active: 'true' } : {},
            onclick: () => { store.set({ model: m.id }); closePopover(); store.toast(`已切换到 ${m.name}`, 'ok'); },
          },
            h('div', { class: 'model-menu-item-header' },
              h('span', { class: 'model-menu-item-name' }, m.name),
              store.get('model') === m.id ? h('span', { class: 'model-menu-item-check' }, icon('check', 'icon-sm')) : null,
            ),
            h('div', { class: 'model-menu-item-meta' },
              h('span', { class: 'model-menu-item-meta-item' }, m.provider),
              h('span', { class: 'model-menu-item-meta-item' }, `${fmtTokens(m.contextWindow)} context`),
              h('span', { class: 'model-menu-item-meta-item' }, `$${m.priceIn}/M in · $${m.priceOut}/M out`),
            ),
            h('div', { class: 'model-menu-item-badges' },
              m.thinking ? h('span', { class: 'model-menu-item-badge' }, icon('brain', 'icon-sm'), 'Thinking') : null,
              m.fast ? h('span', { class: 'model-menu-item-badge' }, icon('zap', 'icon-sm'), 'Fast') : null,
            ),
          )
        ),

        h('div', { class: 'model-menu-sep' }),
        menuGroupLabel('运行参数'),
        h('div', { class: 'model-menu-settings' },
          h('div', { class: 'model-menu-setting' },
            h('span', { class: 'model-menu-setting-label' }, 'Thinking Level'),
            h('select', {
              class: 'input thinking-select',
              onchange: (e) => store.set({ thinkingLevel: e.target.value }),
            }, THINKING_LEVELS.map(l =>
              h('option', {
                value: l.id,
                selected: store.get('thinkingLevel') === l.id ? 'selected' : null,
              }, l.label)
            )),
          ),
          h('div', { class: 'model-menu-setting' },
            h('span', { class: 'model-menu-setting-label' }, 'Fast Mode'),
            h('button', {
              class: 'switch',
              role: 'switch',
              'aria-checked': String(store.get('fastMode')),
              data: { on: String(store.get('fastMode')) },
              onclick: (e) => {
                const next = !store.get('fastMode');
                store.set({ fastMode: next });
                e.currentTarget.setAttribute('data-on', String(next));
                e.currentTarget.setAttribute('aria-checked', String(next));
              },
            }),
          ),
          h('div', { class: 'model-menu-setting' },
            h('span', { class: 'model-menu-setting-label' }, 'Service Tier'),
            h('select', {
              class: 'input thinking-select',
              onchange: (e) => store.set({ serviceTier: e.target.value }),
            }, SERVICE_TIERS.map(t =>
              h('option', {
                value: t.id,
                selected: store.get('serviceTier') === t.id ? 'selected' : null,
              }, t.label)
            )),
          ),
        ),

        h('div', { class: 'model-menu-sep' }),
        menuGroupLabel('权限模式'),
        ...PERMISSION_MODES.map(p =>
          h('button', {
            class: 'permission-item',
            data: store.get('permissionMode') === p.id ? { active: 'true' } : {},
            onclick: () => {
              store.set({ permissionMode: p.id });
              closePopover();
              store.toast(`权限模式已切换为 ${p.label}`, p.id === 'full' ? 'warn' : 'ok');
            },
          },
            h('span', { class: 'permission-item-icon' }, icon(p.icon, 'icon-sm')),
            h('div', { class: 'permission-item-info' },
              h('div', { class: 'permission-item-name' }, p.label),
              h('div', { class: 'permission-item-desc' }, p.description),
              h('div', { class: 'permission-item-detail' }, p.detail),
            ),
            store.get('permissionMode') === p.id
              ? h('span', { class: 'permission-item-check' }, icon('check', 'icon-sm'))
              : null,
          )
        ),
      ], { placement: 'bottom-end', className: 'popover model-menu' });
    }

    /* ---- Breadcrumb menus ------------------------------------------------ */
    function openProjectMenu(anchor, ws) {
      showPopover(anchor, [
        menuGroupLabel('切换项目'),
        ...WORKSPACES.map(w =>
          menuItem(w.name, {
            iconName: w.kind === 'worktree' ? 'gitBranch' : w.kind === 'temp' ? 'flask' : 'folder',
            active: w.id === ws.id,
            hint: w.dirty ? `${w.dirtyCount} 处修改` : null,
            onClick: () => store.set({ activeProjectId: w.id }),
          })
        ),
        menuSep(),
        menuItem('打开项目目录', { iconName: 'folderOpen', onClick: () => store.toast(`已打开 ${ws.path}`, 'ok') }),
        menuItem('在终端中打开', { iconName: 'terminal', onClick: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'terminal' }) }),
        menuItem('在外部编辑器中打开', { iconName: 'externalLink', onClick: () => store.toast('已在 VS Code 中打开', 'ok') }),
        menuSep(),
        menuItem('项目主页', { iconName: 'layers', onClick: () => store.set({ screen: 'project-home' }) }),
      ], { placement: 'bottom-start' });
    }

    function openBranchMenu(anchor, ws) {
      showPopover(anchor, [
        h('div', { class: 'menu-header' },
          h('div', { class: 'menu-header-title' }, icon('gitBranch', 'icon'), ws.branch),
          h('div', { class: 'menu-header-meta' },
            ws.upstream ? `↑${ws.ahead} ↓${ws.behind} · ${ws.upstream}` : '无上游分支'),
        ),
        menuItem(`${ws.dirtyCount} 个未提交修改`, {
          iconName: 'gitCommit',
          onClick: () => store.set({ rightPanelOpen: true, rightPanelTab: 'changes' }),
        }),
        menuSep(),
        menuItem('查看 Changes', { iconName: 'columns', onClick: () => store.set({ rightPanelOpen: true, rightPanelTab: 'changes' }) }),
        menuItem('创建 Commit', { iconName: 'gitCommit', onClick: () => store.toast('创建 Commit', 'info') }),
        menuItem('切换分支', { iconName: 'gitBranch', onClick: () => store.toast('切换分支', 'info') }),
        menuItem('新建 Worktree', { iconName: 'gitFork', onClick: () => store.toast('新建 Worktree', 'info') }),
      ], { placement: 'bottom-start' });
    }

    function openThreadMenu(anchor, thread) {
      if (!thread) return;
      showPopover(anchor, [
        menuItem('重命名对话', { iconName: 'edit', onClick: () => store.toast('重命名', 'info') }),
        menuItem('Fork 当前对话', { iconName: 'gitFork', onClick: () => store.toast('已 Fork', 'ok') }),
        menuItem('Handoff 到新对话', { iconName: 'cornerUpRight', onClick: () => store.toast('已 Handoff', 'ok') }),
        menuSep(),
        menuItem('Compact 当前上下文', { iconName: 'layers', onClick: () => store.toast('正在 Compact…', 'info') }),
        menuItem('导出对话', { iconName: 'download', onClick: () => store.toast('已导出为 Markdown', 'ok') }),
        menuSep(),
        menuItem('会话历史', { iconName: 'history', onClick: () => store.set({ screen: 'history' }) }),
        menuItem('归档', { iconName: 'archive', onClick: () => store.toast('已归档', 'ok') }),
      ], { placement: 'bottom-start' });
    }

    store.subscribe(
      ['activeProjectId', 'activeThreadId', 'mainLayout', 'rightPanelOpen',
       'bottomPanelOpen', 'ompStatus', 'model', 'thinkingLevel', 'fastMode',
       'permissionMode', 'serviceTier', 'scenario'],
      render
    );

    render();
    return { el, render };
  }


  OMP.mod['js/components/topbar'] = { createTopbar };
})(window.OMP = window.OMP || { mod: {} });
