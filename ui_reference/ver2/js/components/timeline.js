/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — timeline.js
     The document-style agent timeline. Renders every event type:
       turn-header · user · assistant · thinking · plan · tool · tool-group
       approval · ask-user · checkpoint · compact · subagent-group
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon, TOOL_ICONS } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { attachTooltip, iconBtn, showDialog, closeDialog, splitPath } = OMP.mod['js/ui'];
    const { TIMELINE, buildLongTimeline } = OMP.mod['data/timeline'];
    const { AGENT_STATUS } = OMP.mod['data/agents'];
    const { fmtTokens } = OMP.mod['data/telemetry'];
  /* Track expansion per event so re-renders don't collapse what the user opened */
  const expanded = new Set(['ev-t3-tool-write']);

  function createTimeline() {
    const el = h('div', { class: 'timeline', role: 'log', 'aria-label': '对话时间线' });
    const inner = h('div', { class: 'timeline-inner' });
    el.appendChild(inner);

    let scrollLatestBtn = null;

    function events() {
      const s = store.get('scenario');
      if (s === 'wb:minimap-long') return buildLongTimeline();
      if (s === 'wb:idle') return [];
      return TIMELINE;
    }

    function render() {
      /* Preserve scroll position across re-renders — switching views must
         never lose where the user was reading. */
      const prevScroll = el.scrollTop;
      const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

      clear(inner);

      const evs = events();

      if (!evs.length) {
        inner.appendChild(renderEmpty());
        return;
      }

      evs.forEach(ev => {
        const node = renderEvent(ev);
        if (node) inner.appendChild(node);
      });

      /* Scenario-specific trailing states */
      const s = store.get('scenario');
      if (s === 'wb:streaming') inner.appendChild(renderStreaming());
      if (s === 'wb:compacting') inner.appendChild(renderCompacting());
      if (s === 'wb:ask-user') inner.appendChild(renderAskUser());
      if (s === 'wb:approval-bash') inner.appendChild(renderPendingApproval());
      if (s === 'wb:agent-failed') inner.appendChild(renderAgentFailure());

      requestAnimationFrame(() => {
        el.scrollTop = wasAtBottom ? el.scrollHeight : prevScroll;
      });
    }

    /* ---- Empty (idle) ---------------------------------------------------- */
    function renderEmpty() {
      return h('div', { class: 'timeline-empty' },
        icon('pi', 'timeline-empty-icon'),
        h('div', { class: 'timeline-empty-title' }, '开始一个新的 Thread'),
        h('div', { class: 'timeline-empty-desc' },
          '描述你想做的事。OMP 会读取工作区、制定计划、调用工具并把改动写入文件 —— 每一步都可见、可中止、可回退。'),
        h('div', { class: 'timeline-empty-hints' },
          hint('@', '引用文件、目录、Diff、Agent 或 Preview 元素'),
          hint('/', '运行 Slash Command'),
          hint('⌘K', '打开 Command Palette'),
          hint('Esc', '随时 Abort 正在运行的任务'),
        ),
      );
    }

    function hint(key, text) {
      return h('div', { class: 'timeline-empty-hint' },
        h('kbd', {}, key),
        h('span', {}, text),
      );
    }

    /* ---- Event dispatch -------------------------------------------------- */
    function renderEvent(ev) {
      switch (ev.type) {
        case 'turn-header': return renderTurnHeader(ev);
        case 'user': return renderUser(ev);
        case 'assistant': return renderAssistant(ev);
        case 'thinking': return renderThinking(ev);
        case 'plan': return renderPlan(ev);
        case 'tool': return wrap(renderTool(ev));
        case 'tool-group': return wrap(renderToolGroup(ev));
        case 'approval': return wrap(renderApproval(ev));
        case 'checkpoint': return wrap(renderCheckpoint(ev));
        case 'compact': return renderCompactMarker(ev);
        case 'subagent-group': return wrap(renderSubagentGroup(ev));
        default: return null;
      }
    }

    function wrap(node) {
      return node ? h('div', { class: 'entry' }, node) : null;
    }

    /* ---- Turn header ----------------------------------------------------- */
    function renderTurnHeader(ev) {
      const running = ev.active && store.get('runState') === 'running';

      return h('div', {
        class: 'turn-header',
        data: ev.active ? { active: 'true' } : {},
        id: `turn-${ev.turn}`,
      },
        h('span', { class: 'turn-header-label' }, `Turn ${ev.turn}`),
        h('div', { class: 'turn-header-meta' },
          h('span', { class: 'turn-header-meta-item' }, icon('clock', 'icon-sm'), ev.time),
          h('span', { class: 'turn-header-meta-item' }, ev.duration),
          h('span', { class: 'turn-header-meta-item' }, `${fmtTokens(ev.tokens)} tok`),
        ),
        running
          ? h('span', { class: 'turn-header-running' },
              h('span', { class: 'dot dot-run' }), '运行中')
          : null,
        h('div', { class: 'turn-header-actions' },
          iconBtn('gitFork', '从这里 Fork', () => store.toast(`已从 Turn ${ev.turn} Fork`, 'ok'), { small: true }),
          iconBtn('rotateCcw', '恢复到这里', () => openRestoreDialog(ev.turn), { small: true }),
          iconBtn('copy', '复制此 Turn', () => store.toast('已复制', 'ok'), { small: true }),
        ),
      );
    }

    /* ---- User message ---------------------------------------------------- */
    function renderUser(ev) {
      return h('div', { class: 'msg-user' },
        h('div', { class: 'msg-user-header' },
          h('span', { class: 'msg-user-avatar' }, 'N'),
          h('span', { class: 'msg-user-name' }, 'the_snowpear'),
          h('span', { class: 'msg-user-time' }, ev.time),
        ),
        h('div', { class: 'msg-user-body md' }, ...md(ev.text)),
        ev.refs?.length
          ? h('div', { class: 'msg-user-refs' }, ev.refs.map(r => refChip(r)))
          : null,
      );
    }

    function refChip(r) {
      const iconMap = {
        file: 'file', dir: 'folder', project: 'layers', agent: 'toolSubagent',
        diff: 'columns', terminal: 'terminal', error: 'alertCircle',
        preview: 'toolPreview', 'preview-element': 'crosshair',
        screenshot: 'image', checkpoint: 'bookmark',
      };
      const chip = h('button', { class: 'ref-chip', onclick: () => jumpToRef(r) },
        icon(iconMap[r.kind] || 'file', 'icon-sm'),
        h('span', { class: 'ref-chip-label' }, r.label),
      );
      if (r.path) attachTooltip(chip, r.path);
      return chip;
    }

    function jumpToRef(r) {
      if (r.kind === 'file' && r.path) {
        store.set({ activeFile: r.path, activeDiffFile: r.path });
        store.toast(`已定位到 ${r.label}`, 'ok');
      } else if (r.kind === 'diff') {
        store.set({ mainPrimary: 'diff' });
      } else {
        store.toast(`已定位到 ${r.label}`, 'ok');
      }
    }

    /* ---- Assistant ------------------------------------------------------- */
    function renderAssistant(ev) {
      return h('div', { class: 'entry' },
        h('div', { class: 'msg-assistant md' }, ...md(ev.text)),
      );
    }

    /* ---- Thinking -------------------------------------------------------- */
    function renderThinking(ev) {
      const open = expanded.has(ev.id);

      const card = h('div', {
        class: 'thinking',
        data: { expanded: String(open), streaming: String(!!ev.streaming) },
      },
        h('button', {
          class: 'thinking-header',
          'aria-expanded': String(open),
          onclick: () => { toggle(ev.id); render(); },
        },
          icon('brain', 'icon-sm'),
          h('span', { class: 'thinking-label' }, 'Thinking'),
          ev.streaming
            ? h('span', { class: 'thinking-stream-preview' }, ev.text.slice(-60))
            : null,
          h('div', { class: 'thinking-meta' },
            h('span', {}, ev.duration),
            h('span', {}, `${fmtTokens(ev.tokens)} tok`),
          ),
          h('span', { class: 'thinking-chevron' }, icon('chevronRight', 'icon-sm')),
        ),
        h('div', { class: 'thinking-body' }, ev.text),
      );

      return h('div', { class: 'entry' }, card);
    }

    /* ---- Plan ------------------------------------------------------------ */
    function renderPlan(ev) {
      const done = ev.items.filter(i => i.done).length;

      return h('div', { class: 'entry' },
        h('div', { class: 'plan' },
          h('div', { class: 'plan-header' },
            icon('list', 'icon-sm'),
            'Plan',
            h('span', { class: 'plan-progress' }, `${done} / ${ev.items.length}`),
          ),
          h('div', { class: 'plan-list' },
            ev.items.map(item =>
              h('div', {
                class: 'plan-item',
                data: { done: String(item.done), active: String(!!item.active) },
              },
                h('span', { class: 'plan-item-check' },
                  item.done ? icon('check', 'icon-sm') : null),
                h('span', { class: 'plan-item-text' }, item.text),
              )
            ),
          ),
        ),
      );
    }

    /* ---- Tool card ------------------------------------------------------- */
    function renderTool(ev) {
      const open = expanded.has(ev.id);
      const iconName = TOOL_ICONS[ev.tool] || 'toolBash';

      return h('div', {
        class: 'tool-card',
        data: { expanded: String(open), status: ev.status },
      },
        h('button', {
          class: 'tool-card-head',
          'aria-expanded': String(open),
          onclick: () => { toggle(ev.id); render(); },
        },
          h('span', { class: 'tool-card-chevron' }, icon('chevronRight', 'icon-sm')),
          h('span', { class: 'tool-card-icon' }, icon(iconName, 'icon-sm')),
          h('span', { class: 'tool-card-name' }, ev.tool),
          h('span', { class: 'tool-card-target', title: ev.target }, ev.target),
          h('div', { class: 'tool-card-meta' },
            ev.additions != null
              ? h('span', { class: 'tool-card-stat' },
                  h('span', { class: 'tool-card-stat-add' }, `+${ev.additions}`),
                  ev.deletions ? h('span', { class: 'tool-card-stat-del' }, `−${ev.deletions}`) : null)
              : null,
            ev.affectsWorkspace
              ? (() => {
                  const b = h('span', { class: 'tool-card-affects' }, icon('save', 'icon-sm'), '影响工作区');
                  attachTooltip(b, '这次调用会写入工作区文件');
                  return b;
                })()
              : null,
            statusPill(ev.status),
            ev.duration ? h('span', {}, ev.duration) : null,
          ),
        ),
        h('div', { class: 'tool-card-body' },
          ev.status === 'running' && ev.progress
            ? h('div', { class: 'tool-card-section' },
                h('div', { class: 'tool-card-section-label' }, '进行中'),
                h('div', { class: 'progress progress-indeterminate' },
                  h('div', { class: 'progress-fill' })),
                h('div', { style: { marginTop: '8px', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' } },
                  '正在写入文件… 工具已声明修改，等待文件系统 watcher 确认。'),
              )
            : null,
          h('div', { class: 'tool-card-section' },
            h('div', { class: 'tool-card-section-label' }, '输入参数'),
            h('div', { class: 'tool-card-params' },
              param(ev.tool === 'Bash' ? 'command' : 'path', ev.target),
              ev.tool === 'Bash' ? param('cwd', 'C:\\Aspace\\Tools\\omp-web') : null,
              ev.tool === 'Bash' ? param('timeout', '120000ms') : null,
            ),
          ),
          ev.output
            ? h('div', { class: 'tool-card-section' },
                h('div', { class: 'tool-card-section-label' }, '输出'),
                h('div', { class: 'tool-card-output' }, ev.output),
              )
            : null,
          ev.error
            ? h('div', { class: 'tool-card-section' },
                h('div', { class: 'tool-card-section-label' }, '错误'),
                h('div', { class: 'tool-card-output tool-card-output-error' }, ev.error),
              )
            : null,
          h('div', { class: 'tool-card-actions' },
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('已复制', 'ok') },
              icon('copy', 'icon-sm'), '复制'),
            h('button', {
              class: 'btn btn-sm btn-outline',
              onclick: () => store.toast('已加入 OMP 上下文', 'ok'),
            }, icon('paperclip', 'icon-sm'), '加入上下文'),
            ev.status === 'failed'
              ? h('button', {
                  class: 'btn btn-sm btn-primary',
                  onclick: () => store.toast('已请求 OMP 修复', 'info'),
                }, icon('sparkles', 'icon-sm'), '请求修复')
              : null,
            ev.affectsWorkspace
              ? h('button', {
                  class: 'btn btn-sm btn-outline',
                  onclick: () => store.set({ mainPrimary: 'diff', activeDiffFile: ev.target }),
                }, icon('columns', 'icon-sm'), '查看 Diff')
              : null,
          ),
        ),
      );
    }

    function param(key, value) {
      if (value == null) return null;
      return h('div', { class: 'tool-card-param' },
        h('span', { class: 'tool-card-param-key' }, key),
        h('span', { class: 'tool-card-param-value' }, String(value)),
      );
    }

    function statusPill(status) {
      const map = {
        pending: ['Pending', 'muted'],
        running: ['Running', 'run'],
        'awaiting-approval': ['等待审批', 'warn'],
        completed: ['完成', 'ok'],
        failed: ['失败', 'danger'],
        aborted: ['已中止', 'muted'],
      };
      const [label, tone] = map[status] || ['—', 'muted'];
      return h('span', { class: `pill pill-${tone}` }, label);
    }

    /* ---- Tool group (aggregated consecutive calls) ----------------------- */
    function renderToolGroup(ev) {
      const open = expanded.has(ev.id);
      const iconName = TOOL_ICONS[ev.tool] || 'toolBash';
      const failed = ev.children.filter(c => c.status === 'failed').length;

      return h('div', {
        class: 'tool-group',
        data: { expanded: String(open || failed > 0) },
      },
        h('button', {
          class: 'tool-group-head',
          'aria-expanded': String(open),
          onclick: () => { toggle(ev.id); render(); },
        },
          h('span', { class: 'tool-card-chevron' }, icon('chevronRight', 'icon-sm')),
          h('span', { class: 'tool-card-icon' }, icon(iconName, 'icon-sm')),
          h('span', { class: 'tool-card-name' }, ev.tool),
          h('span', { class: 'tool-group-count' }, `×${ev.count}`),
          h('span', { class: 'tool-group-summary' }, ev.summary),
          h('div', { class: 'tool-card-meta' },
            ev.affectsWorkspace
              ? h('span', { class: 'tool-card-affects' }, icon('save', 'icon-sm'), '影响工作区')
              : null,
            failed
              ? h('span', { class: 'pill pill-danger' }, `${failed} 失败`)
              : statusPill(ev.status),
            h('span', {}, ev.duration),
          ),
        ),
        h('div', { class: 'tool-group-body' },
          ev.children.map(c =>
            h('div', {
              class: 'tool-group-item',
              data: { status: c.status },
              onclick: () => {
                if (c.target?.includes('/') || c.target?.includes('.')) {
                  store.set({ activeDiffFile: c.target });
                }
              },
            },
              icon(TOOL_ICONS[c.tool] || 'toolBash', 'icon-sm'),
              h('span', { class: 'tool-group-item-target', title: c.target }, c.target),
              c.additions != null
                ? h('span', { class: 'tool-card-stat' },
                    h('span', { class: 'tool-card-stat-add' }, `+${c.additions}`),
                    c.deletions ? h('span', { class: 'tool-card-stat-del' }, `−${c.deletions}`) : null)
                : null,
              c.output ? h('span', { class: 'tool-group-item-meta' }, c.output) : null,
              h('span', { class: 'tool-group-item-meta' }, c.duration),
            )
          ),
        ),
      );
    }

    /* ---- Approval card --------------------------------------------------- */
    function renderApproval(ev) {
      const kindLabel = {
        bash: 'Bash 命令',
        'file-outside': '工作区外文件访问',
        network: '网络访问',
        browser: '浏览器交互',
        mcp: 'MCP 工具',
        'host-tool': 'Host Tool',
        desktop: '桌面操作',
        plugin: '插件工具',
      }[ev.approvalKind] || ev.approvalKind;

      const resolvedLabel = {
        'allowed-once': '已允许一次',
        'allowed-always': '已设为始终允许',
        denied: '已拒绝',
      }[ev.resolved];

      return h('div', {
        class: 'approval',
        data: ev.resolved ? { resolved: ev.resolved } : {},
        role: ev.resolved ? null : 'alert',
      },
        h('div', { class: 'approval-head' },
          h('span', { class: 'approval-icon' }, icon('shield', 'icon-lg')),
          h('div', { class: 'approval-info' },
            h('div', { class: 'approval-title' },
              'OMP 请求执行' + kindLabel,
              ev.resolved
                ? h('span', { class: 'approval-resolved-badge' },
                    icon(ev.resolved === 'denied' ? 'close' : 'check', 'icon-sm'), resolvedLabel)
                : null,
            ),
            h('div', { class: 'approval-desc' },
              ev.resolved
                ? '此请求已处理，保留在时间线中作为记录。'
                : '在你确认之前，OMP 不会执行这个操作。'),
          ),
        ),

        h('div', { class: 'approval-target' + (ev.resolved ? '' : ' approval-target-editable') },
          ev.resolved ? null : h('span', { class: 'approval-target-edit-hint' }, '可编辑'),
          ev.command || ev.path || ev.url,
        ),

        h('div', { class: 'approval-risk' },
          icon('alertTriangle', 'icon-sm'),
          h('span', {}, ev.risk),
        ),

        h('div', { class: 'approval-impact' },
          h('div', { class: 'approval-impact-label' }, '影响范围'),
          h('div', { class: 'approval-impact-list' },
            ev.impact.map(i =>
              h('div', { class: 'approval-impact-item' }, icon('arrowRight', 'icon-sm'), i))),
        ),

        h('div', { class: 'approval-actions' },
          h('button', {
            class: 'btn btn-primary',
            onclick: () => resolveApproval('allowed-once'),
          }, icon('check', 'icon-sm'), '允许一次'),
          h('button', {
            class: 'btn btn-outline',
            onclick: () => resolveApproval('allowed-always'),
          }, '始终允许此类操作'),
          h('button', {
            class: 'btn btn-outline',
            onclick: () => store.toast('可在上方直接编辑命令后再允许', 'info'),
          }, icon('edit', 'icon-sm'), '修改后允许'),
          h('span', { class: 'approval-actions-spacer' }),
          h('button', {
            class: 'btn btn-danger',
            onclick: () => resolveApproval('denied'),
          }, icon('close', 'icon-sm'), '拒绝'),
        ),
      );
    }

    function resolveApproval(kind) {
      const msg = {
        'allowed-once': '已允许，OMP 继续执行',
        'allowed-always': '已加入始终允许规则',
        denied: '已拒绝，OMP 已停止该操作',
      }[kind];
      store.set({ runState: kind === 'denied' ? 'idle' : 'running' });
      store.toast(msg, kind === 'denied' ? 'warn' : 'ok');
    }

    /* ---- Pending approval (scenario) ------------------------------------- */
    function renderPendingApproval() {
      return h('div', { class: 'entry' }, renderApproval({
        id: 'ev-pending-approval',
        type: 'approval',
        resolved: null,
        approvalKind: 'bash',
        tool: 'Bash',
        command: 'bun test --coverage --bail',
        risk: '运行测试套件。会写入 coverage/ 与 __snapshots__/，并可能创建或更新快照文件。执行时间预计 30–90 秒。',
        impact: [
          'coverage/ (新建目录)',
          'test/__snapshots__/*.snap (可能更新)',
          '不访问网络',
          '不修改源代码',
        ],
        scope: 'workspace',
      }));
    }

    /* ---- Ask User -------------------------------------------------------- */
    function renderAskUser() {
      let selected = null;

      const options = [
        { id: 'a', label: '改用 5174 端口', desc: '保留占用 5173 的进程，Preview 换到新端口启动。' },
        { id: 'b', label: '终止占用进程后使用 5173', desc: 'kill PID 8214（node），然后在 5173 启动。' },
        { id: 'c', label: '暂时跳过 Preview 验证', desc: '继续完成剩余任务，Preview 稍后手动启动。' },
      ];

      const card = h('div', { class: 'askuser' },
        h('div', { class: 'askuser-head' },
          h('span', { class: 'askuser-icon' }, icon('helpCircle', 'icon-lg')),
          h('div', { class: 'askuser-question' },
            '端口 5173 已被占用，你希望怎么处理？'),
        ),
        h('div', { class: 'askuser-body' },
          h('div', { class: 'askuser-options' },
            options.map(o =>
              h('button', {
                class: 'askuser-option',
                data: { selected: 'false' },
                onclick: (e) => {
                  card.querySelectorAll('.askuser-option')
                    .forEach(n => n.setAttribute('data-selected', 'false'));
                  e.currentTarget.setAttribute('data-selected', 'true');
                  selected = o.id;
                },
              },
                h('div', { class: 'askuser-option-info' },
                  h('div', { class: 'askuser-option-label' }, o.label),
                  h('div', { class: 'askuser-option-desc' }, o.desc),
                ),
              )
            ),
          ),
          h('div', { class: 'askuser-actions' },
            h('button', {
              class: 'btn btn-primary',
              onclick: () => {
                if (!selected) { store.toast('请先选择一个选项', 'warn'); return; }
                store.set({ runState: 'running' });
                store.toast('已回复 OMP，任务继续', 'ok');
              },
            }, '提交回复'),
            h('button', {
              class: 'btn btn-outline',
              onclick: () => store.toast('已跳过，OMP 将自行决定', 'info'),
            }, '让 OMP 自己决定'),
          ),
        ),
      );

      return h('div', { class: 'entry' }, card);
    }

    /* ---- Checkpoint ------------------------------------------------------ */
    function renderCheckpoint(ev) {
      return h('div', { class: 'checkpoint' },
        h('div', { class: 'checkpoint-head' },
          h('span', { class: 'checkpoint-icon' }, icon('bookmark', 'icon-lg')),
          h('div', { class: 'checkpoint-info' },
            h('div', { class: 'checkpoint-title' }, ev.label),
            h('div', { class: 'checkpoint-meta' },
              h('span', { class: 'checkpoint-meta-item' },
                icon('file', 'icon-sm'), `${ev.filesChanged} 个文件`),
              h('span', { class: 'checkpoint-meta-item' },
                h('span', { style: { color: 'var(--add)' } }, `+${ev.additions}`),
                h('span', { style: { color: 'var(--del)' } }, `−${ev.deletions}`)),
              h('span', { class: 'checkpoint-meta-item' },
                icon('clock', 'icon-sm'), ev.time),
            ),
          ),
          h('div', { class: 'checkpoint-badges' },
            badge(ev.tests, { passed: ['测试通过', 'ok', 'checkCircle'], failed: ['测试失败', 'fail', 'xCircle'] }),
            badge(ev.build, { passed: ['构建通过', 'ok', 'checkCircle'], failed: ['构建失败', 'fail', 'xCircle'] }),
            badge(ev.preview, { refreshed: ['Preview 已刷新', 'run', 'toolPreview'], failed: ['Preview 失败', 'fail', 'xCircle'] }),
          ),
        ),
        h('div', { class: 'checkpoint-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => openRestoreDialog(null, ev) },
            icon('rotateCcw', 'icon-sm'), '恢复到这里'),
          h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('已从此 Checkpoint Fork', 'ok') },
            icon('gitFork', 'icon-sm'), '从这里 Fork'),
          h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('已创建 Git Commit', 'ok') },
            icon('gitCommit', 'icon-sm'), '创建 Git Commit'),
        ),
        ev.committed
          ? h('div', { class: 'checkpoint-commit' },
              icon('gitCommit', 'icon-sm'), 'a3f91c2 · 已提交到 feat/rpc-capability-probe')
          : null,
      );
    }

    function badge(value, map) {
      const entry = map[value];
      if (!entry) return h('span', { class: 'checkpoint-badge checkpoint-badge-muted' }, '未运行');
      const [label, tone, iconName] = entry;
      return h('span', { class: `checkpoint-badge checkpoint-badge-${tone}` },
        icon(iconName, 'icon-sm'), label);
    }

    /* Restore must state exactly what changes — never a bare "are you sure". */
    function openRestoreDialog(turn, ev) {
      let scope = 'both';

      const opt = (id, title, desc, impacts) => h('button', {
        class: 'restore-option',
        data: { selected: String(scope === id) },
        onclick: (e) => {
          e.currentTarget.parentElement.querySelectorAll('.restore-option')
            .forEach(n => n.setAttribute('data-selected', 'false'));
          e.currentTarget.setAttribute('data-selected', 'true');
          scope = id;
          impactBox.replaceChildren(...impacts.map(i =>
            h('div', { class: `impact-item impact-item-${i[2]}` }, icon(i[0], 'icon-sm'), i[1])));
        },
      },
        h('div', { class: 'checkbox-label' },
          h('div', { class: 'checkbox-title' }, title),
          h('div', { class: 'checkbox-desc' }, desc),
        ),
      );

      const bothImpacts = [
        ['file', '工作区文件回滚到该 Checkpoint 的状态', 'danger'],
        ['history', `Turn ${(turn || 3)} 之后的对话记录被移除`, 'danger'],
        ['checkCircle', '该 Checkpoint 之前的所有内容保持不变', 'ok'],
      ];

      const impactBox = h('div', { class: 'impact-list' },
        ...bothImpacts.map(i =>
          h('div', { class: `impact-item impact-item-${i[2]}` }, icon(i[0], 'icon-sm'), i[1])));

      showDialog({
        title: '恢复到 Checkpoint',
        iconName: 'rotateCcw',
        desc: ev ? ev.label : `恢复到 Turn ${turn} 结束时的状态。`,
        body: h('div', {},
          h('div', { class: 'restore-scope' },
            opt('both', '恢复代码与对话', '文件和对话历史都回到该节点', bothImpacts),
            opt('code', '仅恢复代码', '文件回滚，对话历史完整保留', [
              ['file', '工作区文件回滚到该 Checkpoint 的状态', 'danger'],
              ['checkCircle', '对话历史完整保留', 'ok'],
            ]),
            opt('chat', '仅恢复对话', '对话回到该节点，工作区文件保持当前状态', [
              ['history', `Turn ${(turn || 3)} 之后的对话记录被移除`, 'danger'],
              ['checkCircle', '工作区文件不变（当前修改会保留）', 'ok'],
            ]),
          ),
          h('div', { class: 'field-label', style: { marginTop: '16px', marginBottom: '8px' } }, '这次恢复会影响'),
          impactBox,
        ),
        footer: [
          h('button', { class: 'btn btn-outline', onclick: closeDialog }, '取消'),
          h('button', {
            class: 'btn btn-danger-solid',
            onclick: () => {
              closeDialog();
              const label = { both: '代码与对话', code: '代码', chat: '对话' }[scope];
              store.toast(`已恢复${label}`, 'ok');
            },
          }, '确认恢复'),
        ],
      });
    }

    /* ---- Compact --------------------------------------------------------- */
    function renderCompactMarker(ev) {
      return h('div', { class: 'compact-marker' },
        h('span', { class: 'compact-marker-label' },
          icon('layers', 'icon-sm'),
          `Compact · 压缩了前 ${ev.turnsBefore} 个 Turn，节省 ${fmtTokens(ev.tokensSaved)} tok`),
      );
    }

    function renderCompacting() {
      return h('div', { class: 'entry' },
        h('div', { class: 'compact-active' },
          h('span', { class: 'compact-active-icon' }, icon('layers', 'icon-lg')),
          h('div', { class: 'compact-active-info' },
            h('div', { class: 'compact-active-title' }, '正在 Compact 上下文…'),
            h('div', { class: 'compact-active-desc' },
              'OMP 正在把前 2 个 Turn 压缩成摘要。当前 Turn 与所有文件引用会被保留，压缩完成后可以继续对话。'),
            h('div', { class: 'progress progress-indeterminate', style: { marginTop: '10px' } },
              h('div', { class: 'progress-fill' })),
          ),
          h('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => { store.set({ compacting: false, runState: 'idle' }); store.toast('已取消 Compact', 'info'); },
          }, '取消'),
        ),
      );
    }

    /* ---- Streaming ------------------------------------------------------- */
    function renderStreaming() {
      const text = `我先看一下 \`RpcClient\` 和 \`useRpc\` 各自承担了什么，再决定 \`CapabilityProbe\` 的边界。

  从刚才读到的代码看，降级逻辑确实散在两处：

  - \`RpcClient.handshake()\` 在握手时读 \`meta.capabilities\`，顺手设置了 \`this.features\`
  - \`useRpc.probe()\` 在每次调用前再查一遍

  这两件事其实是同一个职责。我打算让 \`CapabilityProbe\` 接管「能力清单 + 可用性判断」`;

      return h('div', { class: 'entry' },
        h('div', { class: 'msg-assistant md stream-chunk' },
          ...md(text),
          h('span', { class: 'streaming-cursor' }),
        ),
      );
    }

    /* ---- Subagent group -------------------------------------------------- */
    function renderSubagentGroup(ev) {
      const open = !expanded.has(`${ev.id}-collapsed`);

      return h('div', { class: 'subagent-group', data: { expanded: String(open) } },
        h('button', {
          class: 'subagent-group-head',
          'aria-expanded': String(open),
          onclick: () => { toggle(`${ev.id}-collapsed`); render(); },
        },
          h('span', { class: 'tool-card-chevron' }, icon('chevronRight', 'icon-sm')),
          icon('toolSubagent', 'icon-sm'),
          h('span', { class: 'subagent-group-title' }, `${ev.count} 个子 Agent`),
          h('div', { class: 'tool-card-meta' },
            statusPill(ev.status === 'running' ? 'running' : 'completed'),
          ),
        ),
        h('div', { class: 'subagent-list' },
          ev.children.map(a => {
            const st = AGENT_STATUS[a.status];
            return h('div', {
              class: 'subagent-row',
              data: { status: a.status },
              onclick: () => store.set({ rightPanelOpen: true, rightPanelTab: 'agents', activeAgentId: a.id }),
            },
              h('span', { class: 'subagent-row-status' }, icon(st.icon, 'icon-sm')),
              h('div', { class: 'subagent-row-info' },
                h('div', { class: 'subagent-row-name' },
                  a.name,
                  h('span', { class: `pill pill-${st.tone}` }, st.label),
                  a.waitingFor
                    ? h('span', { class: 'subagent-waiting' }, `等待 ${a.waitingFor}`)
                    : null,
                ),
                h('div', { class: 'subagent-row-role' }, a.currentTool || a.role),
              ),
              h('div', { class: 'subagent-row-meta' },
                h('span', {}, a.elapsed),
                h('span', {}, `${fmtTokens(a.tokens)} tok`),
              ),
            );
          }),
        ),
      );
    }

    /* ---- Agent failure summary ------------------------------------------- */
    function renderAgentFailure() {
      return h('div', { class: 'entry' },
        h('div', { class: 'error-region' },
          h('div', { class: 'error-head' },
            icon('alertCircle', 'icon-lg'),
            h('div', {},
              h('div', { class: 'error-title' }, '子 Agent test-runner 失败，本轮已中止'),
              h('div', { class: 'error-cause' },
                'bun test 进程被系统 OOM killer 终止（exit code 137）。测试在处理 10k 并发帧的用例时堆内存超过 4 GB 上限。'),
              h('div', { class: 'error-meta' },
                h('span', {}, 'test/transport.test.ts:84'),
                h('span', {}, '耗时 2m 04s'),
                h('span', {}, '已消耗 28.2k tok'),
                h('span', {}, 'preview-verifier 因依赖失败而中止'),
              ),
            ),
          ),
          h('div', { class: 'error-detail' },
            `$ bun test --coverage

  test/transport.test.ts:
    ✓ connects over stdio (12ms)
    ✓ retries on ECONNRESET (34ms)
    ✗ handles 10k concurrent frames

  <--- Last few GCs --->
  [8214:0x7f8] 48210 ms: Mark-sweep 3892.1 (4011.3) -> 3891.4 (4012.1) MB

  FATAL ERROR: Reached heap limit Allocation failed
  Killed (exit code 137)`),
          h('div', { class: 'error-actions' },
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => store.toast('已请求 OMP 修复', 'info') },
              icon('sparkles', 'icon-sm'), '请求 OMP 修复'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('正在重跑 test-runner…', 'info') },
              icon('refresh', 'icon-sm'), '重新运行该 Agent'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.set({ activeFile: 'test/transport.test.ts' }) },
              icon('file', 'icon-sm'), '打开 test/transport.test.ts:84'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'output' }) },
              icon('list', 'icon-sm'), '查看完整日志'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('已加入 OMP 上下文', 'ok') },
              icon('paperclip', 'icon-sm'), '加入上下文'),
          ),
        ),
      );
    }

    /* ---- Helpers --------------------------------------------------------- */
    function toggle(id) {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
    }

    store.subscribe(['activeThreadId', 'scenario', 'runState'], render);
    render();

    /* When a run is active, park the view at the latest content — that's
       where the action is. Idle sessions keep whatever position the user
       had, so switching views never loses their place. */
    store.subscribe(['scenario'], () => {
      const s = store.get('scenario');
      const live = ['wb:streaming', 'wb:tool-burst', 'wb:file-writing',
                    'wb:approval-bash', 'wb:ask-user', 'wb:steering',
                    'wb:followup', 'wb:compacting', 'wb:agent-failed',
                    'wb:agents-parallel'].includes(s);
      if (!live) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });

    return { el, render, scrollTo: (id) => {
      const target = inner.querySelector(`#${CSS.escape(id)}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }};
  }

  /* ==========================================================================
     Minimal Markdown renderer
     Handles what an agent timeline actually emits: headings, lists, inline
     code, bold, links, code fences. Not a general-purpose parser.
     ========================================================================== */
  function md(text) {
    const out = [];
    const lines = String(text).split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      /* Code fence */
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
        i++;
        out.push(
          h('div', { class: 'code-block' },
            h('div', { class: 'code-block-header' },
              icon('fileCode', 'icon-sm'),
              lang || 'text',
              h('div', { class: 'code-block-actions' },
                h('button', { class: 'btn btn-sm', onclick: () => {} }, icon('copy', 'icon-sm'))),
            ),
            h('pre', {}, h('code', {}, buf.join('\n'))),
          )
        );
        continue;
      }

      /* Headings */
      const hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) {
        out.push(h(`h${hm[1].length}`, {}, ...inline(hm[2])));
        i++;
        continue;
      }

      /* Unordered list */
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(h('li', {}, ...inline(lines[i].replace(/^\s*[-*]\s+/, ''))));
          i++;
        }
        out.push(h('ul', {}, ...items));
        continue;
      }

      /* Ordered list */
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(h('li', {}, ...inline(lines[i].replace(/^\s*\d+\.\s+/, ''))));
          i++;
        }
        out.push(h('ol', {}, ...items));
        continue;
      }

      /* Blank line */
      if (!line.trim()) { i++; continue; }

      /* Paragraph */
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !lines[i].startsWith('```') && !/^#{1,4}\s/.test(lines[i]) &&
             !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(h('p', {}, ...inline(buf.join(' '))));
    }

    return out;
  }

  /* Inline: `code`, **bold**, [text](url) */
  function inline(text) {
    const nodes = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      if (m.index > last) nodes.push(text.slice(last, m.index));

      const tok = m[0];
      if (tok.startsWith('`')) {
        nodes.push(h('code', {}, tok.slice(1, -1)));
      } else if (tok.startsWith('**')) {
        nodes.push(h('strong', {}, tok.slice(2, -2)));
      } else {
        const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
        nodes.push(h('a', { href: lm[2], target: '_blank', rel: 'noopener' }, lm[1]));
      }
      last = m.index + tok.length;
    }

    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }


  OMP.mod['js/components/timeline'] = { createTimeline, md };
})(window.OMP = window.OMP || { mod: {} });
