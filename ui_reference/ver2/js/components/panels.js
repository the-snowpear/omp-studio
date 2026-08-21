/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — panels.js
     Bottom run panel (Terminal / Problems / Tests / Output / OMP Logs /
     Preview Logs) and the Agent Hub.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { iconBtn, attachTooltip, makeResizer, animateLayout } = OMP.mod['js/ui'];
    const { PROBLEMS, TESTS, TERMINALS, LOGS, LOG_SOURCES } = OMP.mod['data/diagnostics'];
    const { AGENT_STATUS, agentsForScenario } = OMP.mod['data/agents'];
    const { fmtTokens, fmtCost } = OMP.mod['data/telemetry'];
  /* ==========================================================================
     Bottom panel
     ========================================================================== */

  function createBottomPanel() {
    const el = h('div', { class: 'wb-bottom' });
    const resizer = h('div', { class: 'resizer resizer-h resizer-h-top' });
    let activeTerminal = 'term-1';
    const expandedSuites = new Set(['test/capability.test.ts']);
    let logFilter = null;

    makeResizer(resizer, {
      axis: 'y',
      invert: true,
      onMove: (delta) => {
        const next = Math.min(Math.max(store.get('bottomPanelHeight') + delta, 120), window.innerHeight * 0.7);
        el.style.height = `${next}px`;
      },
      onEnd: () => store.set({ bottomPanelHeight: el.getBoundingClientRect().height }),
    });

    function render() {
      const open = store.get('bottomPanelOpen');
      el.style.display = open ? 'flex' : 'none';
      if (!open) return;

      el.style.height = `${store.get('bottomPanelHeight')}px`;

      clear(el);
      el.append(resizer, renderTabs(), renderBody());
    }

    function renderTabs() {
      const tab = store.get('bottomPanelTab');
      const errors = PROBLEMS.filter(p => p.severity === 'error').length;
      const warns = PROBLEMS.filter(p => p.severity === 'warn').length;
      const running = TERMINALS.filter(t => t.running).length;

      const tabs = [
        ['terminal', 'Terminal', running ? String(running) : null, null],
        ['problems', 'Problems', String(errors + warns), errors ? 'danger' : warns ? 'warn' : null],
        ['tests', 'Tests', `${TESTS.summary.passed}/${TESTS.summary.total}`, TESTS.summary.failed ? 'danger' : null],
        ['output', 'Output', null, null],
        ['omp-logs', 'OMP Logs', null, null],
        ['preview-logs', 'Preview Logs', null, null],
      ];

      return h('div', { class: 'tabs' },
        tabs.map(([id, label, count, tone]) =>
          h('button', {
            class: 'tab',
            role: 'tab',
            'aria-selected': String(tab === id),
            data: tab === id ? { active: 'true' } : {},
            onclick: () => store.set({ bottomPanelTab: id }),
          },
            label,
            count ? h('span', { class: `tab-count${tone ? ` tab-count-${tone}` : ''}` }, count) : null,
          )),
        h('div', { class: 'tabs-actions' },
          iconBtn('minimize', '收起面板', () => {
            animateLayout(() => store.set({ bottomPanelOpen: false }));
          }, { small: true, kbd: '⌃`' }),
        ),
      );
    }

    function renderBody() {
      const tab = store.get('bottomPanelTab');
      const body = h('div', { class: 'panel-body' });

      switch (tab) {
        case 'terminal': body.appendChild(renderTerminal()); break;
        case 'problems': body.appendChild(renderProblems()); break;
        case 'tests': body.appendChild(renderTests()); break;
        case 'output':
        case 'omp-logs':
        case 'preview-logs': body.appendChild(renderLogs(tab)); break;
      }

      return body;
    }

    /* ---- Terminal -------------------------------------------------------- */
    function renderTerminal() {
      const term = TERMINALS.find(t => t.id === activeTerminal) || TERMINALS[0];

      return h('div', { class: 'terminal' },
        h('div', { class: 'terminal-list' },
          TERMINALS.map(t =>
            h('button', {
              class: 'terminal-list-item',
              data: {
                ...(t.id === activeTerminal ? { active: 'true' } : {}),
                running: String(t.running),
              },
              onclick: () => { activeTerminal = t.id; render(); },
            },
              h('span', { class: 'terminal-list-item-icon' },
                icon(t.running ? 'zap' : 'terminal', 'icon-sm')),
              h('div', { class: 'terminal-list-item-info' },
                h('div', { class: 'terminal-list-item-name' }, t.name),
                h('div', { class: 'terminal-list-item-meta' },
                  t.running ? `PID ${t.pid}` : '已结束'),
              ),
              /* Who started it matters: OMP-launched commands are part of the
                 agent's work; user-launched ones are not. */
              h('span', { class: `terminal-owner terminal-owner-${t.owner}` },
                t.owner === 'omp' ? 'OMP' : 'You'),
            )),
          h('button', {
            class: 'btn btn-sm btn-outline',
            style: { margin: '8px', width: 'calc(100% - 16px)', justifyContent: 'center' },
            onclick: () => store.toast('已新建终端', 'ok'),
          }, icon('plus', 'icon-sm'), '新建终端'),
        ),

        h('div', { class: 'terminal-output' },
          h('div', { class: 'terminal-output-header' },
            h('span', {}, term.cwd),
            h('div', { class: 'terminal-output-actions' },
              iconBtn('search', '搜索', () => store.toast('搜索终端输出', 'info'), { small: true }),
              iconBtn('copy', '复制全部', () => store.toast('已复制', 'ok'), { small: true }),
              iconBtn('trash', '清空', () => store.toast('已清空', 'ok'), { small: true }),
              term.running
                ? iconBtn('stop', '终止进程', () => store.toast(`已终止 PID ${term.pid}`, 'warn'), { small: true })
                : null,
            ),
          ),
          h('div', { class: 'terminal-output-body' },
            term.lines.map(l =>
              h('div', { class: 'terminal-line', data: { kind: l.kind } }, l.text)),
            term.running ? h('div', { class: 'terminal-line' }, h('span', { class: 'terminal-cursor' })) : null,
          ),
        ),
      );
    }

    /* ---- Problems -------------------------------------------------------- */
    function renderProblems() {
      return h('div', { class: 'problems-list' },
        PROBLEMS.map(p =>
          h('div', {
            class: 'problem-row',
            data: { severity: p.severity },
            onclick: () => p.file && store.set({ activeFile: p.file }),
          },
            h('span', { class: 'problem-icon' },
              icon(p.severity === 'error' ? 'xCircle' : p.severity === 'warn' ? 'alertTriangle' : 'info', 'icon-sm')),
            h('div', { class: 'problem-info' },
              h('div', { class: 'problem-message' }, p.message),
              h('div', { class: 'problem-meta' },
                p.file
                  ? h('span', { class: 'problem-location' }, `${p.file}:${p.line}:${p.col}`)
                  : null,
                h('span', { class: 'problem-source' }, p.source),
                p.code ? h('span', {}, p.code) : null,
              ),
            ),
            h('div', { class: 'problem-actions' },
              iconBtn('paperclip', '加入 OMP 上下文', () => store.toast('已加入上下文', 'ok'), { small: true }),
              iconBtn('sparkles', '请求 OMP 修复', () => store.toast('已请求修复', 'info'), { small: true }),
            ),
          )),
      );
    }

    /* ---- Tests ----------------------------------------------------------- */
    function renderTests() {
      const s = TESTS.summary;

      return h('div', { class: 'tests' },
        h('div', { class: 'tests-summary' },
          h('span', { class: 'tests-summary-item tests-summary-passed' },
            icon('checkCircle', 'icon-sm'), `${s.passed} 通过`),
          s.failed ? h('span', { class: 'tests-summary-item tests-summary-failed' },
            icon('xCircle', 'icon-sm'), `${s.failed} 失败`) : null,
          s.skipped ? h('span', { class: 'tests-summary-item tests-summary-skipped' },
            icon('minus', 'icon-sm'), `${s.skipped} 跳过`) : null,
          s.running ? h('span', { class: 'tests-summary-item tests-summary-running' },
            icon('zap', 'icon-sm'), `${s.running} 运行中`) : null,
          h('span', { style: { marginLeft: 'auto', color: 'var(--text-tertiary)' } }, s.duration),
          h('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => store.toast('正在重跑全部测试…', 'info'),
          }, icon('refresh', 'icon-sm'), '全部重跑'),
        ),

        TESTS.suites.map(suite => {
          const open = expandedSuites.has(suite.name);
          return h('div', {
            class: 'test-suite',
            data: { expanded: String(open), status: suite.status },
          },
            h('button', {
              class: 'test-suite-header',
              'aria-expanded': String(open),
              onclick: () => {
                if (open) expandedSuites.delete(suite.name);
                else expandedSuites.add(suite.name);
                render();
              },
            },
              h('span', { class: 'test-suite-chevron' }, icon('chevronRight', 'icon-sm')),
              h('span', { class: 'test-suite-status' },
                icon(suite.status === 'passed' ? 'checkCircle'
                  : suite.status === 'failed' ? 'xCircle' : 'zap', 'icon-sm')),
              h('span', { class: 'test-suite-name' }, suite.name),
              h('span', { class: 'test-suite-duration' }, suite.duration || '运行中'),
            ),
            h('div', { class: 'test-suite-body' },
              suite.cases.map(c => [
                h('div', { class: 'test-case', data: { status: c.status } },
                  h('span', { class: 'test-case-status' },
                    icon(c.status === 'passed' ? 'check'
                      : c.status === 'failed' ? 'close'
                      : c.status === 'running' ? 'zap' : 'minus', 'icon-sm')),
                  h('span', { class: 'test-case-name' }, c.name),
                  h('span', { class: 'test-case-duration' }, c.duration || ''),
                ),
                c.error ? h('div', { class: 'test-case-error' }, c.error) : null,
                c.error ? h('div', { class: 'test-case-actions' },
                  h('button', {
                    class: 'btn btn-sm btn-primary',
                    onclick: () => store.toast('已请求 OMP 修复该用例', 'info'),
                  }, icon('sparkles', 'icon-sm'), '请求 OMP 修复'),
                  h('button', {
                    class: 'btn btn-sm btn-outline',
                    onclick: () => store.toast('正在重跑该用例…', 'info'),
                  }, icon('refresh', 'icon-sm'), '重跑'),
                  h('button', {
                    class: 'btn btn-sm btn-outline',
                    onclick: () => store.toast('已加入 OMP 上下文', 'ok'),
                  }, icon('paperclip', 'icon-sm'), '加入上下文'),
                ) : null,
              ].filter(Boolean)).flat(),
            ),
          );
        }),
      );
    }

    /* ---- Logs ------------------------------------------------------------ */
    function renderLogs(tab) {
      const sourceFilter = tab === 'preview-logs' ? ['Preview']
        : tab === 'omp-logs' ? ['OMP Bridge', 'OMP CLI', 'RPC']
        : null;

      const rows = LOGS.filter(l =>
        (!sourceFilter || sourceFilter.includes(l.source)) &&
        (!logFilter || l.source === logFilter));

      return h('div', { class: 'logs' },
        h('div', { class: 'logs-toolbar' },
          h('select', {
            class: 'input',
            style: { height: '24px', fontSize: 'var(--fs-xs)' },
            onchange: (e) => { logFilter = e.target.value || null; render(); },
          },
            h('option', { value: '' }, '全部来源'),
            ...LOG_SOURCES.map(s => h('option', { value: s }, s)),
          ),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } },
            iconBtn('copy', '复制日志', () => store.toast('已复制', 'ok'), { small: true }),
            iconBtn('download', '导出日志', () => store.toast('已导出', 'ok'), { small: true }),
            iconBtn('trash', '清空', () => store.toast('已清空', 'ok'), { small: true }),
          ),
        ),
        rows.map(l =>
          h('div', { class: 'log-row', data: { level: l.level } },
            h('span', { class: 'log-time' }, l.time),
            h('span', { class: 'log-source' }, l.source),
            h('span', { class: 'log-level' }, l.level),
            h('span', { class: 'log-text' }, l.text),
          )),
      );
    }

    store.subscribe(['bottomPanelOpen', 'bottomPanelTab', 'bottomPanelHeight', 'scenario'], render);
    render();

    return { el, render };
  }

  /* ==========================================================================
     Agent Hub
     Indented hierarchy list — devs need to scan status, not admire a graph.
     ========================================================================== */

  function createAgentHub() {
    const el = h('div', { class: 'agent-hub' });

    function render() {
      clear(el);

      const agents = agentsForScenario(store.get('scenario'));

      el.append(
        h('div', { class: 'agent-hub-toolbar' },
          h('span', { class: 'section-label' }, `${agents.length} 个 Agent`),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } },
            iconBtn('pause', '全部暂停', () => store.toast('已暂停全部 Agent', 'warn'), { small: true }),
            iconBtn('stop', '全部中止', () => store.toast('已中止全部 Agent', 'warn'), { small: true }),
          ),
        ),
        h('div', { class: 'agent-hub-list' }, agents.map(renderAgent)),
      );
    }

    function renderAgent(a) {
      const st = AGENT_STATUS[a.status];
      const active = store.get('activeAgentId') === a.id;

      return h('div', {
        class: 'agent-card',
        style: { '--agent-depth': String(a.depth) },
        data: { status: a.status, depth: String(a.depth), ...(active ? { active: 'true' } : {}) },
        onclick: () => store.set({ activeAgentId: a.id }),
      },
        h('span', { class: 'agent-status-icon' }, icon(st.icon, 'icon')),

        h('div', { class: 'agent-info' },
          h('div', { class: 'agent-name-row' },
            h('span', { class: 'agent-name' }, a.name),
            h('span', { class: `pill pill-${st.tone}` }, st.label),
            a.depth === 0 ? h('span', { class: 'agent-role' }, '主 Agent') : null,
          ),
          h('div', { class: 'agent-task' }, a.task),

          h('div', { class: 'agent-meta' },
            a.lastTool
              ? h('span', { class: 'agent-last-tool' }, icon('zap', 'icon-sm'), a.lastTool)
              : null,
            a.waitingFor
              ? h('span', { class: 'agent-waiting' },
                  icon('clock', 'icon-sm'), `等待 ${a.waitingFor}`)
              : null,
            a.status === 'waiting-user'
              ? h('span', { class: 'agent-waiting' },
                  icon('helpCircle', 'icon-sm'), '等待你的回应')
              : null,
            h('span', { class: 'agent-meta-item' }, icon('clock', 'icon-sm'), a.elapsed),
            h('span', { class: 'agent-meta-item' }, `${fmtTokens(a.tokens)} tok`),
            h('span', { class: 'agent-meta-item' }, fmtCost(a.costUsd)),
            a.filesChanged
              ? h('span', { class: 'agent-meta-item' }, icon('file', 'icon-sm'), `${a.filesChanged} 个文件`)
              : null,
            h('span', { class: 'agent-meta-item' }, a.model),
          ),

          a.error ? renderAgentError(a.error) : null,
          a.summary
            ? h('div', { class: 'agent-summary' }, icon('checkCircle', 'icon-sm'), a.summary)
            : null,
        ),

        h('div', { class: 'agent-actions' },
          iconBtn('eye', '查看 Agent 对话', () => store.toast(`打开 ${a.name} 的对话`, 'info'), { small: true }),
          iconBtn('list', '查看工具调用', () => store.toast(`${a.name} 的工具调用`, 'info'), { small: true }),
          iconBtn('file', '查看修改文件', () => store.set({ rightPanelTab: 'changes' }), { small: true }),
          a.status === 'running-tool' || a.status === 'thinking'
            ? iconBtn('zap', '发送 Steering', () => store.toast(`已向 ${a.name} 发送 Steering`, 'ok'), { small: true })
            : null,
          a.status === 'running-tool' || a.status === 'thinking'
            ? iconBtn('pause', '暂停', () => store.toast(`已暂停 ${a.name}`, 'warn'), { small: true })
            : null,
          a.status === 'failed' || a.status === 'aborted'
            ? iconBtn('refresh', '重新运行', () => store.toast(`正在重跑 ${a.name}…`, 'info'), { small: true })
            : iconBtn('stop', '中止', () => store.toast(`已中止 ${a.name}`, 'warn'), { small: true }),
        ),
      );
    }

    function renderAgentError(err) {
      return h('div', { class: 'agent-error error-region' },
        h('div', { class: 'error-head' },
          icon('alertCircle', 'icon'),
          h('div', {},
            h('div', { class: 'error-title' }, err.summary),
            err.file
              ? h('div', { class: 'error-meta' },
                  h('span', {
                    class: 'path-link',
                    onclick: (e) => { e.stopPropagation(); store.set({ activeFile: err.file }); },
                  }, `${err.file}:${err.line}`))
              : null,
          ),
        ),
        h('div', { class: 'error-detail' }, err.detail),
        h('div', { class: 'error-actions' },
          h('button', {
            class: 'btn btn-sm btn-primary',
            onclick: (e) => { e.stopPropagation(); store.toast('已请求 OMP 修复', 'info'); },
          }, icon('sparkles', 'icon-sm'), '请求修复'),
          h('button', {
            class: 'btn btn-sm btn-outline',
            onclick: (e) => { e.stopPropagation(); store.set({ bottomPanelOpen: true, bottomPanelTab: 'output' }); },
          }, icon('list', 'icon-sm'), '查看完整日志'),
        ),
      );
    }

    store.subscribe(['scenario', 'activeAgentId'], render);
    render();
    return { el, render };
  }


  OMP.mod['js/components/panels'] = { createBottomPanel, createAgentHub };
})(window.OMP = window.OMP || { mod: {} });
