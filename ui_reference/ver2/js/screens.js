/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — screens.js
     Project home, environment check, history + time travel, capabilities,
     settings, diagnostics. Same design language as the workbench.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon, fileIcon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { iconBtn, attachTooltip, showDialog, closeDialog, elidePath } = OMP.mod['js/ui'];
    const { WORKSPACES } = OMP.mod['data/workspaces'];
    const { THREADS, THREAD_STATUS, threadsFor } = OMP.mod['data/threads'];
    const { ENV_CHECKS_OK, ENV_CHECKS_FAIL, DIAGNOSTICS, OMP_STATUS_LABEL } = OMP.mod['data/diagnostics'];
    const { SKILLS, PLUGINS, MCP_SERVERS, HOST_TOOLS, SLASH_COMMANDS, CAP_STATE_LABEL, capStates } = OMP.mod['data/capabilities'];
    const { MODELS, PERMISSION_MODES, THINKING_LEVELS, fmtTokens, fmtCost } = OMP.mod['data/telemetry'];
  /* ==========================================================================
     Project Home
     ========================================================================== */

  function renderProjectHome() {
    const quick = [
      ['folderOpen', '打开本地文件夹', '选择一个已有的项目目录'],
      ['gitBranch', '克隆 Git 仓库', '从远程仓库拉取并打开'],
      ['history', '恢复最近对话', '继续上次未完成的工作'],
      ['flask', '创建临时工作区', '在沙箱中快速试验'],
    ];

    const activity = [
      ['zap', 'run', 'OMP 正在 ', 'omp-web', ' 中执行「跟踪上游 pi-web 更新」', '刚刚'],
      ['file', 'dirty', '', 'CapabilityProbe.tsx', ' 已创建（+96）', '1 分钟前'],
      ['shield', 'warn', '', 'RPC Capability 探测', ' 有一个 Bash 命令等待审批', '8 分钟前'],
      ['toolPreview', 'run', 'Preview 正在运行于 ', 'localhost:5173', '', '18 分钟前'],
      ['checkCircle', 'ok', '', '修复 Git Bash 路径未找到问题', ' 已完成', '2 小时前'],
      ['alertCircle', 'danger', '', 'Audit and fix OSS repository issues', ' 因子 Agent 失败而中止', '2 小时前'],
    ];

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '项目'),
          h('p', { class: 'screen-subtitle' },
            '选择一个项目继续，或新建一个工作区。OMP Studio 会记住每个项目的侧栏布局、展开状态和输入草稿。'),
        ),

        h('div', { class: 'home-quick' },
          quick.map(([ic, title, desc]) =>
            h('button', {
              class: 'home-quick-card',
              onclick: () => store.toast(title, 'info'),
            },
              h('span', { class: 'home-quick-icon' }, icon(ic, 'icon')),
              h('div', { class: 'home-quick-info' },
                h('div', { class: 'home-quick-title' }, title),
                h('div', { class: 'home-quick-desc' }, desc),
              ),
            )),
        ),

        h('div', { class: 'screen-section' },
          h('h2', { class: 'screen-section-title' }, '最近项目'),
          h('div', { class: 'home-projects' },
            WORKSPACES.map(ws => {
              const threads = threadsFor(ws.id);
              const latest = threads[0];

              return h('div', {
                class: 'home-project',
                onclick: () => store.set({ activeProjectId: ws.id, screen: 'workbench' }),
              },
                h('span', { class: 'home-project-icon' },
                  icon(ws.kind === 'worktree' ? 'gitBranch' : ws.kind === 'temp' ? 'flask' : 'folder', 'icon-lg')),

                h('div', { class: 'home-project-main' },
                  h('div', { class: 'home-project-name-row' },
                    h('span', { class: 'home-project-name' }, ws.name),
                    ws.pinned ? icon('pin', 'icon-sm') : null,
                    ws.kind === 'worktree' ? h('span', { class: 'pill pill-muted' }, 'Worktree') : null,
                    ws.kind === 'temp' ? h('span', { class: 'pill pill-muted' }, '临时工作区') : null,
                  ),
                  h('div', { class: 'home-project-path' }, ws.path),
                  h('div', { class: 'home-project-meta' },
                    ws.branch
                      ? h('span', { class: 'home-project-meta-item' },
                          icon('gitBranch', 'icon-sm'), ws.branch)
                      : null,
                    ws.dirty
                      ? h('span', { class: 'home-project-meta-item home-project-meta-dirty' },
                          icon('edit', 'icon-sm'), `${ws.dirtyCount} 个未提交修改`)
                      : null,
                    ws.running
                      ? h('span', { class: 'home-project-meta-item home-project-meta-run' },
                          icon('zap', 'icon-sm'), '有任务正在运行')
                      : null,
                    ws.needsAttention
                      ? h('span', { class: 'home-project-meta-item home-project-meta-warn' },
                          icon('shield', 'icon-sm'), '需要你处理')
                      : null,
                    ws.previewRunning
                      ? h('span', { class: 'home-project-meta-item home-project-meta-run' },
                          icon('toolPreview', 'icon-sm'), 'Preview 运行中')
                      : null,
                    h('span', { class: 'home-project-meta-item' },
                      icon('clock', 'icon-sm'), ws.lastOpened),
                  ),
                ),

                latest
                  ? h('div', { class: 'home-project-thread' },
                      h('div', { class: 'home-project-thread-label' }, '最近对话'),
                      h('div', { class: 'home-project-thread-title' }, latest.title),
                    )
                  : null,
              );
            }),
          ),
        ),

        h('div', { class: 'screen-section' },
          h('h2', { class: 'screen-section-title' }, '最近活动'),
          h('div', { class: 'home-activity' },
            activity.map(([ic, tone, pre, strong, post, time]) =>
              h('div', { class: 'home-activity-item' },
                h('span', {
                  class: 'home-activity-icon',
                  style: tone !== 'muted' ? { color: `var(--${tone === 'dirty' ? 'git-modified' : tone})` } : {},
                }, icon(ic, 'icon-sm')),
                h('span', { class: 'home-activity-text' },
                  pre, h('strong', {}, strong), post),
                h('span', { class: 'home-activity-time' }, time),
              )),
          ),
        ),
      ),
    );
  }

  /* ==========================================================================
     Environment Check
     ========================================================================== */

  function renderEnvCheck() {
    const fail = store.get('scenario') === 'env-check:fail';
    const checks = fail ? ENV_CHECKS_FAIL : ENV_CHECKS_OK;

    const errors = checks.filter(c => c.status === 'error').length;
    const warns = checks.filter(c => c.status === 'warn').length;

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '环境检查'),
          h('p', { class: 'screen-subtitle' },
            'OMP Studio 依赖你本机安装的 OMP CLI 提供 Agent 运行时。以下是当前环境的健康状况。'),
        ),

        h('div', { class: `env-summary ${fail ? 'env-summary-fail' : 'env-summary-ok'}` },
          h('span', { class: 'env-summary-icon' },
            icon(fail ? 'alertCircle' : 'shieldCheck', 'icon-lg')),
          h('div', { class: 'env-summary-info' },
            h('div', { class: 'env-summary-title' },
              fail ? `${errors} 项失败，${warns} 项警告` : '环境正常，全部 13 项检查通过'),
            h('div', { class: 'env-summary-desc' },
              fail
                ? 'OMP 无法正常工作。请先处理下面标红的项目 —— 模型未认证会导致所有请求失败，RPC 版本不兼容会禁用 Preview 与 Subagent。'
                : 'OMP CLI v0.8.4 · RPC v3 · 14/14 Capability 可用。可以开始使用了。'),
          ),
          h('div', { class: 'env-summary-actions' },
            h('button', {
              class: 'btn btn-outline',
              onclick: () => store.toast('正在重新检测…', 'info'),
            }, icon('refresh', 'icon-sm'), '重新检测'),
            h('button', {
              class: 'btn btn-primary',
              onclick: () => store.set({ screen: 'workbench' }),
            }, fail ? '仍然继续' : '进入工作台'),
          ),
        ),

        h('div', { class: 'env-list' },
          checks.map(c =>
            h('div', { class: 'env-item', data: { status: c.status } },
              h('span', { class: 'env-item-status' },
                icon(c.status === 'ok' ? 'checkCircle'
                  : c.status === 'warn' ? 'alertTriangle' : 'xCircle', 'icon')),
              h('div', { class: 'env-item-info' },
                h('div', { class: 'env-item-label' }, c.label),
                h('div', { class: 'env-item-value' }, c.value),
                h('div', { class: 'env-item-detail' }, c.detail),
              ),
              c.actions?.length
                ? h('div', { class: 'env-item-actions' },
                    c.actions.map((a, i) =>
                      h('button', {
                        class: i === 0 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline',
                        onclick: () => store.toast(a, 'info'),
                      }, a)))
                : null,
            )),
        ),

        h('div', { style: { marginTop: '24px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('打开安装说明', 'info') },
            icon('externalLink', 'icon-sm'), '打开安装说明'),
          h('button', { class: 'btn btn-outline', onclick: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'terminal', screen: 'workbench' }) },
            icon('terminal', 'icon-sm'), '打开终端'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('打开 OMP 登录', 'info') },
            icon('user', 'icon-sm'), '打开 OMP 登录'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('已打开 ~/.omp/agent/config.yml', 'ok') },
            icon('settings', 'icon-sm'), '打开配置'),
          h('button', { class: 'btn btn-outline', onclick: () => store.set({ screen: 'diagnostics' }) },
            icon('activity', 'icon-sm'), '查看诊断'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('正在检查更新…', 'info') },
            icon('download', 'icon-sm'), '检查更新'),
        ),
      ),
    );
  }

  /* ==========================================================================
     History + Time Travel
     ========================================================================== */

  function renderHistory() {
    const timeTravel = store.get('scenario') === 'history:time-travel';

    if (timeTravel) return renderTimeTravel();

    const byProject = {};
    THREADS.forEach(t => { (byProject[t.projectId] ||= []).push(t); });

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '会话历史'),
          h('p', { class: 'screen-subtitle' },
            '按项目组织的全部 Thread。可以恢复、Fork、导出，或从任意 Checkpoint 继续。'),
        ),

        h('div', { class: 'history-toolbar' },
          h('div', { class: 'search-field', style: { flex: '1', maxWidth: '360px' } },
            icon('search', 'icon-sm'),
            h('input', { class: 'input', placeholder: '搜索对话标题、模型、分支…' }),
          ),
          h('select', { class: 'input', style: { width: '140px' } },
            h('option', {}, '全部状态'),
            h('option', {}, '已完成'),
            h('option', {}, '运行中'),
            h('option', {}, '失败'),
            h('option', {}, '已归档'),
          ),
          h('select', { class: 'input', style: { width: '140px' } },
            h('option', {}, '全部模型'),
            ...MODELS.map(m => h('option', {}, m.name)),
          ),
        ),

        ...Object.entries(byProject).map(([pid, threads]) => {
          const ws = WORKSPACES.find(w => w.id === pid);
          return h('div', { class: 'history-group' },
            h('div', { class: 'history-group-title' },
              icon(ws?.kind === 'worktree' ? 'gitBranch' : 'folder', 'icon-sm'),
              ws?.name || pid,
              h('span', { style: { color: 'var(--text-tertiary)', fontWeight: '400' } },
                `· ${threads.length} 个 Thread`),
            ),
            ...threads.map(t => {
              const st = THREAD_STATUS[t.status];
              return h('div', {
                class: 'history-item',
                onclick: () => store.set({ activeThreadId: t.id, activeProjectId: t.projectId, screen: 'workbench' }),
              },
                h('span', {
                  class: 'history-item-status',
                  style: { color: `var(--${st.tone})` },
                }, icon(st.icon || 'quote', 'icon-sm')),

                h('div', { class: 'history-item-main' },
                  h('div', { class: 'history-item-title' }, t.title),
                  h('div', { class: 'history-item-meta' },
                    h('span', {}, st.label),
                    h('span', {}, t.updatedAt),
                    h('span', {}, t.model),
                    h('span', {}, `${t.turns} turns`),
                    h('span', {}, `${t.filesChanged} 文件`),
                    h('span', {}, `${fmtTokens(t.tokensIn)} / ${fmtTokens(t.tokensOut)}`),
                    h('span', {}, fmtCost(t.costUsd)),
                    t.forkedFrom
                      ? h('span', { class: 'history-item-relation' },
                          icon('gitFork', 'icon-sm'), 'Fork')
                      : null,
                    t.handoffTo
                      ? h('span', { class: 'history-item-relation' },
                          icon('cornerUpRight', 'icon-sm'), 'Handoff')
                      : null,
                    t.compactCount
                      ? h('span', { class: 'history-item-relation' },
                          icon('layers', 'icon-sm'), `${t.compactCount}× Compact`)
                      : null,
                    t.archived
                      ? h('span', { class: 'history-item-relation' },
                          icon('archive', 'icon-sm'), '已归档')
                      : null,
                  ),
                ),

                h('div', { class: 'history-item-actions' },
                  iconBtn('rotateCcw', 'Time Travel', (e) => {
                    e.stopPropagation();
                    store.set({ scenario: 'history:time-travel' });
                  }, { small: true }),
                  iconBtn('gitFork', 'Fork', () => store.toast('已 Fork', 'ok'), { small: true }),
                  iconBtn('edit', '重命名', () => store.toast('重命名', 'info'), { small: true }),
                  iconBtn('pin', '固定', () => store.toast('已固定', 'ok'), { small: true }),
                  iconBtn('download', '导出', () => store.toast('已导出', 'ok'), { small: true }),
                  iconBtn('archive', '归档', () => store.toast('已归档', 'ok'), { small: true }),
                  iconBtn('trash', '删除', () => store.toast('已删除', 'ok'), { small: true }),
                ),
              );
            }),
          );
        }),
      ),
    );
  }

  function renderTimeTravel() {
    const nodes = [
      ['user', '用户请求', '把上游 pi-web v0.8.1 的更新同步到 omp-web，保留所有 OMP 特有逻辑。', '14:02'],
      ['plan', 'OMP 计划', '5 步：配置 upstream → graft parent 链 → 合并 → 保留定制 → 类型检查', '14:02'],
      ['tool', '工具执行', 'Bash ×4 · Read ×7 · Edit ×5 · git merge（3 个冲突）', '14:03'],
      ['file', '文件变化', '5 个文件 · +244 −9 · MermaidBlock.tsx 新建、Mermaid.tsx 删除', '14:05'],
      ['test', '测试与构建', '类型检查通过 · 构建通过 · Preview 已刷新', '14:06'],
      ['checkpoint', 'Checkpoint', '冲突已解决 · 可恢复到此节点', '14:06'],
      ['user', '后续请求', '类型检查跑一下，顺手把 bun.lockb 更新掉。', '14:11'],
      ['tool', '工具执行', 'bun install · bun run typecheck（2 个错误）· Edit ×2', '14:12'],
      ['checkpoint', 'Checkpoint', '类型检查通过 · 7 个文件 · +248 −13', '14:13'],
    ];

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner' },
        h('div', { class: 'screen-header' },
          h('button', {
            class: 'btn btn-sm btn-outline',
            style: { marginBottom: '12px' },
            onclick: () => store.set({ scenario: 'history:list' }),
          }, icon('arrowLeft', 'icon-sm'), '返回历史列表'),
          h('h1', { class: 'screen-title' }, 'Time Travel · 跟踪上游 pi-web 更新到 omp-web'),
          h('p', { class: 'screen-subtitle' },
            '这条 Thread 的完整执行链。可以从任意节点恢复或创建新对话 —— 恢复前会明确说明影响范围。'),
        ),

        h('div', { class: 'timetravel' },
          nodes.map(([kind, label, text, time]) =>
            h('div', { class: 'tt-node', data: { kind } },
              h('div', { class: 'tt-node-card' },
                h('div', { class: 'tt-node-header' },
                  h('span', { class: 'tt-node-kind' }, label),
                  h('span', { class: 'tt-node-time' }, time),
                ),
                h('div', { class: 'tt-node-text' }, text),
                kind === 'checkpoint'
                  ? h('div', { class: 'tt-node-actions' },
                      h('button', {
                        class: 'btn btn-sm btn-primary',
                        onclick: () => openRestore(time),
                      }, icon('rotateCcw', 'icon-sm'), '恢复到这里'),
                      h('button', {
                        class: 'btn btn-sm btn-outline',
                        onclick: () => store.toast('已从此节点创建新对话', 'ok'),
                      }, icon('gitFork', 'icon-sm'), '从这里创建新对话'),
                      h('button', {
                        class: 'btn btn-sm btn-outline',
                        onclick: () => store.toast('已从此节点继续', 'ok'),
                      }, icon('play', 'icon-sm'), '从这里继续'),
                    )
                  : null,
              ),
            )),
        ),
      ),
    );
  }

  function openRestore(time) {
    let scope = 'both';

    const impacts = {
      both: [
        ['file', '工作区文件回滚到 ' + time + ' 的状态', 'danger'],
        ['history', time + ' 之后的对话记录被移除', 'danger'],
        ['checkCircle', '此节点之前的内容保持不变', 'ok'],
      ],
      code: [
        ['file', '工作区文件回滚到 ' + time + ' 的状态', 'danger'],
        ['checkCircle', '对话历史完整保留', 'ok'],
      ],
      chat: [
        ['history', time + ' 之后的对话记录被移除', 'danger'],
        ['checkCircle', '工作区文件保持当前状态', 'ok'],
      ],
    };

    const box = h('div', { class: 'impact-list' },
      ...impacts.both.map(i =>
        h('div', { class: `impact-item impact-item-${i[2]}` }, icon(i[0], 'icon-sm'), i[1])));

    const opt = (id, title, desc) => h('button', {
      class: 'restore-option',
      data: { selected: String(scope === id) },
      onclick: (e) => {
        e.currentTarget.parentElement.querySelectorAll('.restore-option')
          .forEach(n => n.setAttribute('data-selected', 'false'));
        e.currentTarget.setAttribute('data-selected', 'true');
        scope = id;
        box.replaceChildren(...impacts[id].map(i =>
          h('div', { class: `impact-item impact-item-${i[2]}` }, icon(i[0], 'icon-sm'), i[1])));
      },
    },
      h('div', { class: 'checkbox-label' },
        h('div', { class: 'checkbox-title' }, title),
        h('div', { class: 'checkbox-desc' }, desc),
      ),
    );

    showDialog({
      title: `恢复到 ${time} 的 Checkpoint`,
      iconName: 'rotateCcw',
      body: h('div', {},
        h('div', { class: 'restore-scope' },
          opt('both', '恢复代码与对话', '文件和对话历史都回到该节点'),
          opt('code', '仅恢复代码', '文件回滚，对话历史完整保留'),
          opt('chat', '仅恢复对话', '对话回到该节点，工作区文件保持当前状态'),
        ),
        h('div', { class: 'field-label', style: { marginTop: '16px', marginBottom: '8px' } }, '这次恢复会影响'),
        box,
      ),
      footer: [
        h('button', { class: 'btn btn-outline', onclick: closeDialog }, '取消'),
        h('button', {
          class: 'btn btn-danger-solid',
          onclick: () => {
            closeDialog();
            store.toast(`已恢复${{ both: '代码与对话', code: '代码', chat: '对话' }[scope]}`, 'ok');
          },
        }, '确认恢复'),
      ],
    });
  }

  /* ==========================================================================
     Capabilities
     ========================================================================== */

  function renderCapabilities() {
    const tab = store.get('capTab') || 'skills';

    const tabs = [
      ['skills', 'Skills', SKILLS.length],
      ['plugins', 'Plugins', PLUGINS.length],
      ['mcp', 'MCP', MCP_SERVERS.length],
      ['host-tools', 'Host Tools', HOST_TOOLS.length],
      ['slash', 'Slash Commands', SLASH_COMMANDS.length],
    ];

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '能力中心'),
          h('p', { class: 'screen-subtitle' },
            '每一项能力都区分三种状态：已配置（存在于配置中）、已加载（CLI 实际加载成功）、当前会话可用。三者并不等价 —— 混为一谈会掩盖真实的失败。'),
        ),

        h('div', { class: 'tabs', style: { marginBottom: '20px' } },
          tabs.map(([id, label, count]) =>
            h('button', {
              class: 'tab',
              role: 'tab',
              'aria-selected': String(tab === id),
              data: tab === id ? { active: 'true' } : {},
              onclick: () => store.set({ capTab: id }),
            }, label, h('span', { class: 'tab-count' }, String(count)))),
        ),

        tab === 'skills' ? renderSkills()
          : tab === 'plugins' ? renderPlugins()
          : tab === 'mcp' ? renderMcp()
          : tab === 'host-tools' ? renderHostTools()
          : renderSlash(),
      ),
    );
  }

  function capStateBadges(c) {
    return h('div', { class: 'cap-states' },
      capStates(c).map(s =>
        h('span', { class: 'cap-state', data: { on: String(s.on) } },
          icon(s.on ? 'check' : 'close', 'icon-sm'),
          CAP_STATE_LABEL[s.key])));
  }

  function renderSkills() {
    return h('div', {},
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
        h('button', { class: 'btn btn-primary', onclick: () => store.toast('创建 Skill', 'info') },
          icon('plus', 'icon-sm'), '创建 Skill'),
        h('button', { class: 'btn btn-outline', onclick: () => store.toast('已打开 ~/.omp/skills/', 'ok') },
          icon('folderOpen', 'icon-sm'), '打开来源目录'),
      ),
      h('div', { class: 'cap-list' },
        SKILLS.map(s =>
          h('div', { class: 'cap-item' },
            h('div', { class: 'cap-item-head' },
              h('span', { class: 'cap-item-icon' }, icon('sparkles', 'icon')),
              h('div', { class: 'cap-item-info' },
                h('div', { class: 'cap-item-name-row' },
                  h('span', { class: 'cap-item-name' }, s.name),
                  h('span', { class: 'pill pill-muted' }, s.scope),
                ),
                h('div', { class: 'cap-item-desc' }, s.description),
                h('div', { class: 'cap-item-meta' },
                  h('span', { class: 'cap-item-source' }, s.source),
                  h('span', {}, `${s.sizeKb} KB`),
                  h('span', {}, `修改于 ${s.modified}`),
                ),
                capStateBadges(s),
              ),
              h('div', { class: 'cap-item-actions' },
                h('button', {
                  class: 'switch',
                  role: 'switch',
                  'aria-checked': String(s.enabled),
                  'aria-label': s.enabled ? '禁用' : '启用',
                  data: { on: String(s.enabled) },
                  onclick: (e) => {
                    const next = e.currentTarget.getAttribute('data-on') !== 'true';
                    e.currentTarget.setAttribute('data-on', String(next));
                    store.toast(next ? `已启用 ${s.name}` : `已禁用 ${s.name}`, 'ok');
                  },
                }),
                iconBtn('eye', '查看内容', () => store.toast('查看 SKILL.md', 'info'), { small: true }),
                iconBtn('edit', '编辑', () => store.toast('编辑 SKILL.md', 'info'), { small: true }),
                iconBtn('folderOpen', '打开来源目录', () => store.toast('已打开目录', 'ok'), { small: true }),
                iconBtn('trash', '删除', () => store.toast('已删除', 'ok'), { small: true }),
              ),
            ),
            s.error
              ? h('div', { class: 'cap-error' }, icon('alertCircle', 'icon-sm'), s.error)
              : null,
          )),
      ),
    );
  }

  function renderPlugins() {
    return h('div', { class: 'cap-list' },
      PLUGINS.map(p =>
        h('div', { class: 'cap-item' },
          h('div', { class: 'cap-item-head' },
            h('span', { class: 'cap-item-icon' }, icon('puzzle', 'icon')),
            h('div', { class: 'cap-item-info' },
              h('div', { class: 'cap-item-name-row' },
                h('span', { class: 'cap-item-name' }, p.name),
                h('span', { class: 'cap-item-version' }, `v${p.version}`),
              ),
              h('div', { class: 'cap-item-meta' },
                h('span', { class: 'cap-item-source' }, p.source),
              ),
              capStateBadges(p),
            ),
            h('div', { class: 'cap-item-actions' },
              h('button', {
                class: 'switch',
                role: 'switch',
                'aria-checked': String(p.enabled),
                data: { on: String(p.enabled) },
                onclick: (e) => {
                  const next = e.currentTarget.getAttribute('data-on') !== 'true';
                  e.currentTarget.setAttribute('data-on', String(next));
                  store.toast(next ? `已启用 ${p.name}` : `已禁用 ${p.name}`, 'ok');
                },
              }),
              iconBtn('refresh', '重新加载', () => store.toast('已重新加载', 'ok'), { small: true }),
            ),
          ),
          h('div', { class: 'cap-provides' },
            provides('提供的工具', p.tools),
            provides('Slash Commands', p.slashCommands),
            provides('UI 能力', p.uiCapabilities),
            provides('Hook', p.hooks),
          ),
          p.lastError
            ? h('div', { class: 'cap-error' }, icon('alertCircle', 'icon-sm'), p.lastError)
            : null,
        )),
    );
  }

  function provides(label, items) {
    if (!items?.length) return null;
    return h('div', { class: 'cap-provides-group' },
      h('span', { class: 'cap-provides-label' }, label),
      h('div', { class: 'cap-provides-items' },
        items.map(i => h('span', { class: 'cap-provides-item' }, i))),
    );
  }

  function renderMcp() {
    return h('div', { class: 'cap-list' },
      MCP_SERVERS.map(m =>
        h('div', { class: 'cap-item' },
          h('div', { class: 'cap-item-head' },
            h('span', { class: 'cap-item-icon' }, icon('toolMcp', 'icon')),
            h('div', { class: 'cap-item-info' },
              h('div', { class: 'cap-item-name-row' },
                h('span', { class: 'cap-item-name' }, m.name),
                h('span', { class: `pill pill-${m.status === 'connected' ? 'ok' : m.status === 'error' ? 'danger' : 'muted'}` },
                  m.status === 'connected' ? '已连接' : m.status === 'error' ? '连接失败' : '未连接'),
                h('span', { class: 'pill pill-muted' }, m.transport),
              ),
              h('div', { class: 'cap-item-meta' },
                h('span', { class: 'cap-item-source' }, m.command),
              ),
              capStateBadges(m),
            ),
            h('div', { class: 'cap-item-actions' },
              h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast(`正在测试 ${m.name}…`, 'info') },
                '测试连接'),
              iconBtn('refresh', '重启', () => store.toast(`已重启 ${m.name}`, 'ok'), { small: true }),
              iconBtn('list', '查看日志', () => store.set({ screen: 'workbench', bottomPanelOpen: true, bottomPanelTab: 'omp-logs' }), { small: true }),
              iconBtn('edit', '编辑配置', () => store.toast('编辑 MCP 配置', 'info'), { small: true }),
            ),
          ),
          (m.tools.length || m.resources.length || m.prompts.length)
            ? h('div', { class: 'cap-provides' },
                provides('Tools', m.tools),
                provides('Resources', m.resources),
                provides('Prompts', m.prompts),
                m.lastCall
                  ? h('div', { class: 'cap-provides-group' },
                      h('span', { class: 'cap-provides-label' }, '最近调用'),
                      h('span', { style: { fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' } },
                        `${m.lastCall} · 共 ${m.callCount} 次`))
                  : null,
              )
            : null,
          m.error
            ? h('div', { class: 'cap-error' }, icon('alertCircle', 'icon-sm'), m.error)
            : null,
        )),
    );
  }

  function renderHostTools() {
    const byCategory = {};
    HOST_TOOLS.forEach(t => { (byCategory[t.category] ||= []).push(t); });

    return h('div', {},
      h('p', { class: 'screen-section-desc' },
        '这些是 OMP Studio 向 OMP CLI 注册的工具。OMP 可以调用它们来控制 Preview、读取 DOM、截图或与系统集成。'),
      ...Object.entries(byCategory).map(([cat, tools]) =>
        h('div', { class: 'screen-section' },
          h('div', { class: 'section-label', style: { marginBottom: '10px' } }, cat),
          h('div', { class: 'cap-list' },
            tools.map(t =>
              h('div', { class: 'cap-item' },
                h('div', { class: 'cap-item-head' },
                  h('span', { class: 'cap-item-icon' }, icon('toolHost', 'icon')),
                  h('div', { class: 'cap-item-info' },
                    h('div', { class: 'cap-item-name-row' },
                      h('span', { class: 'cap-item-name' }, t.name),
                      h('span', { class: `pill pill-${t.available ? 'ok' : 'muted'}` },
                        t.available ? '已注册可用' : '不可用'),
                    ),
                    h('div', { class: 'cap-item-desc' }, t.description),
                    h('div', { class: 'cap-item-meta' },
                      h('span', {}, `调用 ${t.callCount} 次`),
                      t.lastCall ? h('span', {}, `最近 ${t.lastCall}`) : null,
                    ),
                  ),
                ),
                t.error
                  ? h('div', { class: 'cap-error' }, icon('alertCircle', 'icon-sm'), t.error)
                  : null,
              )),
          ),
        )),
    );
  }

  function renderSlash() {
    return h('div', { class: 'cap-list' },
      SLASH_COMMANDS.map(c =>
        h('div', { class: 'cap-item' },
          h('div', { class: 'cap-item-head' },
            h('span', { class: 'cap-item-icon' }, icon('command', 'icon')),
            h('div', { class: 'cap-item-info' },
              h('div', { class: 'cap-item-name-row' },
                h('span', { class: 'cap-item-name' }, c.name + (c.args ? ` ${c.args}` : '')),
                h('span', { class: `pill pill-${c.available ? 'ok' : 'muted'}` },
                  c.available ? '可用' : '不可用'),
              ),
              h('div', { class: 'cap-item-desc' },
                c.available ? c.description : `${c.description} — ${c.reason}`),
              h('div', { class: 'cap-item-meta' },
                h('span', {}, `来源：${c.source}`),
                h('span', { class: 'pill pill-muted' }, c.sourceKind),
              ),
            ),
            h('div', { class: 'cap-item-actions' },
              h('button', {
                class: 'btn btn-sm btn-outline',
                disabled: c.available ? null : 'disabled',
                onclick: () => { store.set({ screen: 'workbench' }); store.toast(`已插入 ${c.name}`, 'ok'); },
              }, '快速执行'),
            ),
          ),
        )),
    );
  }

  /* ==========================================================================
     Settings
     ========================================================================== */

  function renderSettings() {
    const tab = store.get('settingsTab') || 'general';

    const nav = [
      ['general', 'General', 'settings'],
      ['models', 'Models and Providers', 'sparkles'],
      ['permissions', 'Permissions', 'shield'],
      ['sessions', 'Sessions', 'history'],
      ['preview', 'Preview', 'toolPreview'],
      ['advanced', 'Advanced', 'sliders'],
    ];

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner screen-inner-wide' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '设置'),
        ),
        h('div', { class: 'settings-layout' },
          h('nav', { class: 'settings-nav' },
            nav.map(([id, label, ic]) =>
              h('button', {
                class: 'settings-nav-item',
                data: tab === id ? { active: 'true' } : {},
                onclick: () => store.set({ settingsTab: id }),
              }, icon(ic, 'icon-sm'), label)),
          ),
          h('div', { class: 'settings-content' },
            tab === 'general' ? settingsGeneral()
              : tab === 'models' ? settingsModels()
              : tab === 'permissions' ? settingsPermissions()
              : tab === 'sessions' ? settingsSessions()
              : tab === 'preview' ? settingsPreview()
              : settingsAdvanced(),
          ),
        ),
      ),
    );
  }

  function settingRow(title, desc, control) {
    return h('div', { class: 'setting-row' },
      h('div', { class: 'setting-info' },
        h('div', { class: 'setting-title' }, title),
        desc ? h('div', { class: 'setting-desc' }, desc) : null,
      ),
      h('div', { class: 'setting-control' }, control),
    );
  }

  function toggle(on, onChange) {
    return h('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(on),
      data: { on: String(on) },
      onclick: (e) => {
        const next = e.currentTarget.getAttribute('data-on') !== 'true';
        e.currentTarget.setAttribute('data-on', String(next));
        e.currentTarget.setAttribute('aria-checked', String(next));
        onChange?.(next);
      },
    });
  }

  function select(options, value, onChange, width = '180px') {
    return h('select', {
      class: 'input',
      style: { width },
      onchange: (e) => onChange?.(e.target.value),
    }, options.map(o =>
      h('option', {
        value: o.value ?? o,
        selected: (o.value ?? o) === value ? 'selected' : null,
      }, o.label ?? o)));
  }

  function settingsGeneral() {
    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'General'),
      settingRow('语言', '界面文案语言。技术术语（Thread / Turn / Checkpoint 等）保持英文。',
        select([{ value: 'zh', label: '简体中文' }, { value: 'en', label: 'English' }], 'zh')),
      settingRow('主题', '亮色 / 暗色 / 跟随系统。',
        select([
          { value: 'dark', label: '暗色' },
          { value: 'light', label: '亮色' },
          { value: 'system', label: '跟随系统' },
        ], store.get('theme'), v => { if (v !== 'system') store.set({ theme: v }); })),
      settingRow('信息密度', 'Compact 更紧凑，适合大屏和长时间高频使用。',
        select([
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable' },
        ], store.get('density'), v => store.set({ density: v }))),
      settingRow('编辑器行为', '点击文件引用时在哪里打开。',
        select([
          { value: 'internal', label: '在 Studio 内打开' },
          { value: 'external', label: '在外部编辑器打开' },
        ], 'internal')),
      settingRow('布局记忆', '记住每个项目的侧栏宽度、上下比例与展开状态。关闭后所有项目共用一套布局。',
        toggle(true)),
      settingRow('默认项目行为', '启动时打开哪个项目。',
        select([
          { value: 'last', label: '上次打开的项目' },
          { value: 'home', label: '项目主页' },
          { value: 'none', label: '空白工作台' },
        ], 'last')),
      settingRow('更新行为', '',
        select([
          { value: 'auto', label: '自动下载并提示安装' },
          { value: 'notify', label: '仅提示' },
          { value: 'manual', label: '手动检查' },
        ], 'notify')),
      h('div', { style: { marginTop: '20px' } },
        h('button', { class: 'btn btn-outline', onclick: () => { store.resetLayout(); store.toast('已恢复默认布局', 'ok'); } },
          icon('rotateCcw', 'icon-sm'), '恢复默认布局')),
    );
  }

  function settingsModels() {
    const providers = [...new Set(MODELS.map(m => m.provider))];

    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'Models and Providers'),
      h('p', { class: 'screen-section-desc' },
        '模型与 Provider 的配置。这里展示的是有意义的配置界面，而不是把 models.json 原样转成表单。'),

      ...providers.map(p => {
        const models = MODELS.filter(m => m.provider === p);
        const authed = p !== 'OpenRouter';

        return h('div', { class: 'provider-card' },
          h('div', { class: 'provider-head' },
            icon('server', 'icon'),
            h('span', { class: 'provider-name' }, p),
            h('span', { class: `pill pill-${authed ? 'ok' : 'warn'}` },
              authed ? '已登录' : '未配置 API Key'),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
              h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast(`正在测试 ${p} 连接…`, 'info') },
                '测试连接'),
              h('button', { class: 'btn btn-sm btn-outline', onclick: () => store.toast('配置 API Key', 'info') },
                authed ? '重新登录' : '配置 API Key'),
            ),
          ),
          h('div', { class: 'provider-body' },
            settingRow('Base URL', '留空使用默认端点。',
              h('input', { class: 'input input-mono', style: { width: '280px' }, placeholder: '默认' })),
            h('div', { class: 'section-label', style: { marginTop: '12px' } }, `${models.length} 个模型`),
            h('div', { class: 'provider-models' },
              models.map(m =>
                h('div', { class: 'provider-model' },
                  h('span', { class: 'provider-model-name' }, m.id),
                  h('div', { class: 'provider-model-meta' },
                    h('span', {}, `${fmtTokens(m.contextWindow)} ctx`),
                    h('span', {}, `$${m.priceIn}/M in`),
                    h('span', {}, `$${m.priceOut}/M out`),
                    m.thinking ? h('span', { class: 'pill pill-muted' }, 'Thinking') : null,
                    m.fast ? h('span', { class: 'pill pill-muted' }, 'Fast') : null,
                  ),
                  store.get('model') === m.id
                    ? h('span', { class: 'pill pill-accent' }, '默认')
                    : h('button', {
                        class: 'btn btn-sm btn-outline',
                        onclick: () => { store.set({ model: m.id }); store.toast(`已设为默认模型`, 'ok'); },
                      }, '设为默认'),
                )),
            ),
          ),
        );
      }),

      h('div', { class: 'screen-section', style: { marginTop: '24px' } },
        h('h2', { class: 'screen-section-title' }, '模型角色'),
        settingRow('主 Agent 模型', '处理主要对话与规划。',
          select(MODELS.map(m => ({ value: m.id, label: m.name })), store.get('model'), v => store.set({ model: v }), '200px')),
        settingRow('子 Agent 模型', '子 Agent 默认使用的模型，通常选更快更便宜的。',
          select(MODELS.map(m => ({ value: m.id, label: m.name })), 'omp-sonnet-5', null, '200px')),
        settingRow('Thinking Level', '推理深度。更高的等级延迟更大但更适合复杂重构。',
          select(THINKING_LEVELS.map(l => ({ value: l.id, label: l.label })), store.get('thinkingLevel'),
            v => store.set({ thinkingLevel: v }), '140px')),
        settingRow('Fast Mode', '更快的输出速度，不降级模型。',
          toggle(store.get('fastMode'), v => store.set({ fastMode: v }))),
        settingRow('Service Tier', 'Priority 延迟更低，Batch 成本更低但延迟不确定。',
          select([
            { value: 'standard', label: 'Standard' },
            { value: 'priority', label: 'Priority' },
            { value: 'batch', label: 'Batch' },
          ], store.get('serviceTier'), v => store.set({ serviceTier: v }), '140px')),
        settingRow('Fallback', '主模型不可用时自动切换到的备选模型。',
          select([{ value: 'none', label: '不使用 Fallback' }, ...MODELS.map(m => ({ value: m.id, label: m.name }))],
            'omp-sonnet-5', null, '200px')),
      ),
    );
  }

  function settingsPermissions() {
    const mode = store.get('permissionMode');

    const rules = [
      ['Bash · bun install', '工作区', '始终允许'],
      ['Bash · bun test *', '工作区', '始终允许'],
      ['Bash · git *', '工作区', '始终允许'],
      ['网络 · registry.npmjs.org', '全局', '始终允许'],
      ['MCP · filesystem/*', '工作区', '始终允许'],
    ];

    const granular = [
      ['文件读取（工作区内）', true],
      ['文件写入（工作区内）', true],
      ['工作区外文件访问', false],
      ['Bash 命令', true],
      ['网络访问', false],
      ['Browser 控制', true],
      ['Preview 控制', true],
      ['MCP 工具', true],
      ['Host Tools', true],
      ['Plugins', true],
      ['桌面操作', false],
      ['系统文件管理器', true],
    ];

    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'Permissions'),
      h('p', { class: 'screen-section-desc' },
        '控制 OMP 在未经询问的情况下可以做什么。危险操作在执行前一律会说明影响范围。'),

      h('div', { class: 'perm-presets' },
        PERMISSION_MODES.map(p =>
          h('button', {
            class: 'perm-preset',
            data: mode === p.id ? { active: 'true' } : {},
            onclick: () => { store.set({ permissionMode: p.id }); store.toast(`权限模式：${p.label}`, p.id === 'full' ? 'warn' : 'ok'); },
          },
            h('div', { class: 'perm-preset-header' },
              h('span', { class: 'perm-preset-icon' }, icon(p.icon, 'icon')),
              h('span', { class: 'perm-preset-name' }, p.label),
            ),
            h('div', { class: 'perm-preset-desc' }, p.description),
            h('div', { class: 'perm-preset-detail' }, p.detail),
          )),
      ),

      h('div', { class: 'screen-section' },
        h('h2', { class: 'screen-section-title' }, '细粒度控制'),
        h('p', { class: 'screen-section-desc' }, '在当前预设基础上单独调整。'),
        ...granular.map(([label, on]) => settingRow(label, null, toggle(on))),
      ),

      h('div', { class: 'screen-section' },
        h('h2', { class: 'screen-section-title' }, '始终允许规则'),
        h('p', { class: 'screen-section-desc' },
          '你之前选择「始终允许」时创建的规则。这些操作不会再请求审批。'),
        h('div', { class: 'perm-rules' },
          rules.map(([pattern, scope]) =>
            h('div', { class: 'perm-rule' },
              icon('shieldCheck', 'icon-sm'),
              h('span', { class: 'perm-rule-pattern' }, pattern),
              h('span', { class: 'perm-rule-scope' }, scope),
              iconBtn('trash', '删除规则', () => store.toast('已删除规则', 'ok'), { small: true }),
            )),
        ),
        h('button', {
          class: 'btn btn-danger',
          style: { marginTop: '12px' },
          onclick: () => store.toast('已清除全部授权规则', 'warn'),
        }, icon('trash', 'icon-sm'), '清除全部授权规则'),
      ),
    );
  }

  function settingsSessions() {
    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'Sessions'),
      settingRow('会话保存', '自动保存全部 Thread 到 ~/.omp/agent/sessions/。', toggle(true)),
      settingRow('自动命名', '根据第一条消息自动生成对话标题。', toggle(true)),
      settingRow('自动归档', '超过设定天数未更新的对话自动归档。',
        select([{ value: '7', label: '7 天' }, { value: '30', label: '30 天' }, { value: '90', label: '90 天' }, { value: 'never', label: '从不' }], '30')),
      settingRow('Checkpoint', '每轮任务结束时自动创建 Checkpoint。', toggle(true)),
      settingRow('Compact 阈值', 'Context 达到该比例时自动 Compact。',
        select([{ value: '0.8', label: '80%' }, { value: '0.9', label: '90%' }, { value: '0.95', label: '95%' }, { value: 'off', label: '不自动' }], '0.9')),
      settingRow('历史清理', '自动删除超过设定时间的归档对话。',
        select([{ value: 'never', label: '从不删除' }, { value: '180', label: '180 天后' }, { value: '365', label: '1 年后' }], 'never')),
      settingRow('导出格式', '',
        select([{ value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }, { value: 'html', label: 'HTML' }], 'md')),
      h('div', { style: { marginTop: '20px', display: 'flex', gap: '8px' } },
        h('button', { class: 'btn btn-outline', onclick: () => store.toast('已导出全部会话', 'ok') },
          icon('download', 'icon-sm'), '导出全部会话'),
        h('button', { class: 'btn btn-danger', onclick: () => store.toast('已清除历史', 'warn') },
          icon('trash', 'icon-sm'), '清除全部历史'),
      ),
    );
  }

  function settingsPreview() {
    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'Preview'),
      settingRow('启动命令', '留空则自动从 package.json 检测。',
        h('input', { class: 'input input-mono', style: { width: '260px' }, value: 'bun run dev' })),
      settingRow('包管理器', '',
        select([{ value: 'bun', label: 'bun' }, { value: 'npm', label: 'npm' }, { value: 'pnpm', label: 'pnpm' }, { value: 'yarn', label: 'yarn' }], 'bun', null, '140px')),
      settingRow('默认端口', '端口被占用时会询问你如何处理。',
        h('input', { class: 'input input-mono', style: { width: '100px' }, value: '5173' })),
      settingRow('自动启动', '打开项目时自动启动开发服务器。', toggle(false)),
      settingRow('自动刷新', '文件变化后自动刷新 Preview。', toggle(true)),
      settingRow('浏览器隔离', '为 Preview 使用独立的浏览器配置，不共享你的 Cookie 和登录状态。', toggle(true)),
      settingRow('Console 捕获', '捕获页面 Console 输出，供 OMP 读取与诊断。', toggle(true)),
      settingRow('Network 捕获', '记录网络请求。会增加内存占用。', toggle(true)),
    );
  }

  function settingsAdvanced() {
    return h('div', {},
      h('h2', { class: 'screen-section-title' }, 'Advanced'),
      settingRow('OMP 可执行文件路径', '留空则从 PATH 自动查找。',
        h('input', { class: 'input input-mono', style: { width: '320px' }, value: DIAGNOSTICS.basic.ompPath })),
      settingRow('配置目录', '',
        h('input', { class: 'input input-mono', style: { width: '320px' }, value: DIAGNOSTICS.basic.configDir })),
      settingRow('日志级别', '',
        select([{ value: 'error', label: 'Error' }, { value: 'warn', label: 'Warn' }, { value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }, { value: 'trace', label: 'Trace' }], 'info', null, '140px')),
      settingRow('RPC 超时', '单个 RPC 请求的超时时间。',
        h('input', { class: 'input input-mono', style: { width: '100px' }, value: '30000' })),
      settingRow('Bridge 自动重启', 'Bridge 崩溃时自动重启并恢复会话。', toggle(true)),
      settingRow('保留原始 RPC 日志', '记录全部 RPC 往返消息，便于排查协议问题。会显著增加日志体积。', toggle(true)),
      h('div', { class: 'screen-section', style: { marginTop: '24px' } },
        h('h2', { class: 'screen-section-title' }, '实验性能力'),
        settingRow('多 Worktree 并行会话', '允许在同一项目的多个 Worktree 中同时运行 Agent。', toggle(false)),
        settingRow('Preview DOM 深度检查', '让 OMP 读取完整 DOM 树而非摘要。', toggle(false)),
        settingRow('Agent 间直接通信', '允许子 Agent 之间直接交换消息，不经过主 Agent。', toggle(false)),
      ),
    );
  }

  /* ==========================================================================
     Diagnostics
     ========================================================================== */

  const diagExpanded = new Set(['processes']);

  function renderDiagnostics() {
    const d = DIAGNOSTICS;

    const section = (id, title, count, body) => {
      const open = diagExpanded.has(id);
      return h('div', { class: 'diag-section', data: { expanded: String(open) } },
        h('button', {
          class: 'diag-section-header',
          'aria-expanded': String(open),
          onclick: () => {
            if (open) diagExpanded.delete(id); else diagExpanded.add(id);
            store.set({ _diagTick: Date.now() });
          },
        },
          h('span', { class: 'diag-section-chevron' }, icon('chevronRight', 'icon-sm')),
          h('span', { class: 'diag-section-title' }, title),
          count != null ? h('span', { class: 'diag-section-count' }, String(count)) : null,
        ),
        h('div', { class: 'diag-section-body' }, body),
      );
    };

    return h('div', { class: 'screen' },
      h('div', { class: 'screen-inner screen-inner-wide' },
        h('div', { class: 'screen-header' },
          h('h1', { class: 'screen-title' }, '诊断中心'),
          h('p', { class: 'screen-subtitle' },
            '面向开源项目用户与开发者。普通信息在上，高级细节可以展开。'),
        ),

        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' } },
          h('button', { class: 'btn btn-primary', onclick: () => store.toast('诊断报告已复制到剪贴板', 'ok') },
            icon('copy', 'icon-sm'), '复制诊断报告'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('已导出日志', 'ok') },
            icon('download', 'icon-sm'), '导出日志'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('已打开日志目录', 'ok') },
            icon('folderOpen', 'icon-sm'), '打开日志目录'),
          h('button', { class: 'btn btn-outline', onclick: () => { store.set({ ompStatus: 'starting' }); setTimeout(() => store.set({ ompStatus: 'ready' }), 1400); store.toast('正在重启 Bridge…', 'info'); } },
            icon('refresh', 'icon-sm'), '重启 OMP Bridge'),
          h('button', { class: 'btn btn-outline', onclick: () => store.set({ screen: 'env-check' }) },
            icon('search', 'icon-sm'), '重新检测 OMP'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('已打开配置', 'ok') },
            icon('settings', 'icon-sm'), '打开配置'),
          h('button', { class: 'btn btn-outline', onclick: () => store.toast('已是最新版本', 'ok') },
            icon('download', 'icon-sm'), '检查更新'),
        ),

        h('div', { class: 'diag-grid' },
          diagField('OMP 可执行文件', d.basic.ompPath),
          diagField('OMP 版本', d.basic.ompVersion),
          diagField('RPC 协议版本', d.basic.rpcVersion),
          diagField('Bridge 状态', `${d.basic.bridgeStatus} · 已运行 ${d.basic.bridgeUptime}`),
          diagField('Studio 版本', d.basic.studioVersion),
          diagField('平台', d.basic.platform),
          diagField('当前工作目录', d.basic.cwd),
          diagField('配置目录', d.basic.configDir),
        ),

        section('capabilities', 'Capability 列表', `${d.capabilities.filter(c => c.available).length}/${d.capabilities.length}`,
          h('div', { class: 'diag-caps' },
            d.capabilities.map(c =>
              h('div', { class: 'diag-cap', data: { available: String(c.available) } },
                icon(c.available ? 'checkCircle' : 'xCircle', 'icon-sm'),
                h('span', { class: 'diag-cap-name' }, c.name),
                h('span', { class: 'diag-cap-since' }, c.since),
              ))),
        ),

        section('processes', '活跃进程', d.processes.length,
          h('div', {},
            d.processes.map(p =>
              h('div', { class: 'diag-process' },
                h('span', { class: 'diag-process-kind' }, p.kind),
                h('span', { class: 'diag-process-name' }, p.name),
                h('span', { class: 'diag-process-stat' }, `PID ${p.pid}`),
                h('span', { class: 'diag-process-stat' }, p.cpu),
                h('span', { class: 'diag-process-stat' }, p.mem),
                h('span', { class: 'diag-process-stat' }, p.uptime),
              ))),
        ),

        section('watchers', '文件 Watcher', d.watchers.length,
          h('div', {},
            d.watchers.map(w =>
              h('div', { class: 'diag-process' },
                h('span', { class: 'diag-process-kind' }, w.status),
                h('span', { class: 'diag-process-name' }, w.path),
                h('span', { class: 'diag-process-stat' }, `${w.files} 文件`),
                h('span', { class: 'diag-process-stat', style: { width: '180px' } }, w.backend),
              ))),
        ),

        section('errors', '最近错误', d.recentErrors.length,
          h('div', { class: 'logs' },
            d.recentErrors.map(e =>
              h('div', { class: 'log-row', data: { level: e.level } },
                h('span', { class: 'log-time' }, e.time),
                h('span', { class: 'log-source' }, e.source),
                h('span', { class: 'log-level' }, e.level),
                h('span', { class: 'log-text' }, e.text),
              ))),
        ),

        section('rpc', '原始 RPC 日志', d.rpcLog.length,
          h('div', { class: 'diag-rpc' },
            d.rpcLog.map(r =>
              h('div', { class: 'diag-rpc-row', data: { dir: r.dir } },
                h('span', { class: 'diag-rpc-time' }, r.time),
                h('span', { class: 'diag-rpc-dir' }, r.dir === 'out' ? '→' : '←'),
                h('span', { class: 'diag-rpc-method' }, r.method),
                h('span', { class: 'diag-rpc-payload', title: r.payload }, r.payload),
              ))),
        ),
      ),
    );
  }

  function diagField(label, value) {
    return h('div', { class: 'diag-field' },
      h('div', { class: 'diag-field-label' }, label),
      h('div', { class: 'diag-field-value' }, value),
    );
  }


  OMP.mod['js/screens'] = { renderProjectHome, renderEnvCheck, renderHistory, renderCapabilities, renderSettings, renderDiagnostics };
})(window.OMP = window.OMP || { mod: {} });
