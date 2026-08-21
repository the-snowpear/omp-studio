/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — scenarios.js
     The 40 required interface states plus 16 additional ones covering §12,
     §17 and §20. Each scenario is a store patch; ▶ ones also drive a
     time-sequenced playback through the bus.
     ========================================================================== */

    const { store } = OMP.mod['js/store'];
    const { bus } = OMP.mod['js/bus'];
  /* Baseline the workbench returns to before each scenario applies.
     Every overlay and sticky view flag must be listed here, or state
     leaks from the previously-selected scenario. */
  const BASE = {
    screen: 'workbench',
    runState: 'idle',
    ompStatus: 'ready',
    ompError: null,
    mainLayout: 'single',
    mainPrimary: 'conversation',
    mainSecondary: 'diff',
    rightPanelOpen: false,
    bottomPanelOpen: false,
    previewPicking: false,
    previewState: 'running',
    followUpQueue: [],
    compacting: false,
    activeAgentId: null,
    activeDiffFile: null,
    paletteOpen: false,
    scenarioSwitcherOpen: false,
    minimapPinned: false,
    sidebarCollapsed: false,
    changesScope: 'turn',
    activeThreadId: 'th-sync-upstream',
    activeProjectId: 'ws-omp-web',
  };

  const SCENARIOS = [
    /* ---------- 1–3 · 入口与环境 ---------- */
    { id: 'project-home', n: 1, group: '入口与环境', label: '项目主页',
      patch: { screen: 'project-home' } },
    { id: 'env-check:ok', n: 2, group: '入口与环境', label: '环境检查成功',
      patch: { screen: 'env-check' } },
    { id: 'env-check:fail', n: 3, group: '入口与环境', label: '环境检查失败',
      patch: { screen: 'env-check' } },

    /* ---------- 4–8 · 工作台运行 ---------- */
    { id: 'wb:idle', n: 4, group: '工作台运行', label: '工作台空闲',
      patch: { activeThreadId: 'th-scratch-empty', activeProjectId: 'ws-scratch' } },
    { id: 'wb:streaming', n: 5, group: '工作台运行', label: 'OMP 流式回答', play: true,
      patch: { runState: 'running', activeThreadId: 'th-sync-upstream', activeProjectId: 'ws-omp-web' } },
    { id: 'wb:tool-burst', n: 6, group: '工作台运行', label: '连续调用多个工具', play: true,
      patch: { runState: 'running' } },
    { id: 'wb:approval-bash', n: 7, group: '工作台运行', label: 'Bash 等待审批', play: true,
      patch: { runState: 'awaiting-approval' } },
    { id: 'wb:file-writing', n: 8, group: '工作台运行', label: '文件正在被修改', play: true,
      patch: { runState: 'running', rightPanelOpen: true, rightPanelTab: 'changes', changesScope: 'turn' } },

    /* ---------- 9–10 · Changes 与 Diff ---------- */
    { id: 'wb:changes-multi', n: 9, group: 'Changes 与 Diff', label: '多文件 Changes',
      patch: { rightPanelOpen: true, rightPanelTab: 'changes', changesScope: 'thread', activeDiffFile: null } },
    { id: 'wb:diff-split', n: 10, group: 'Changes 与 Diff', label: 'Split Diff 审查',
      patch: {
        mainLayout: 'split-h', mainPrimary: 'conversation', mainSecondary: 'diff',
        diffMode: 'split', activeDiffFile: 'components/bridge/RpcClient.ts',
      } },

    /* ---------- 11–14 · Preview ---------- */
    { id: 'wb:preview-ok', n: 11, group: 'Preview', label: 'Preview 正常运行',
      patch: { mainLayout: 'split-h', mainSecondary: 'preview', previewState: 'running' } },
    { id: 'wb:preview-hmr', n: 12, group: 'Preview', label: 'Preview 热更新', play: true,
      patch: { mainLayout: 'split-h', mainSecondary: 'preview', previewState: 'hmr' } },
    { id: 'wb:preview-error', n: 13, group: 'Preview', label: 'Preview 编译失败',
      patch: { mainLayout: 'split-h', mainSecondary: 'preview', previewState: 'compile-error' } },
    { id: 'wb:preview-pick', n: 14, group: 'Preview', label: 'Preview 元素选择',
      patch: { mainLayout: 'split-h', mainSecondary: 'preview', previewState: 'running', previewPicking: true } },

    /* ---------- 15–17 · Agent ---------- */
    { id: 'wb:agents-parallel', n: 15, group: 'Agent', label: '主 Agent + 多子 Agent 并行', play: true,
      patch: { runState: 'running', rightPanelOpen: true, rightPanelTab: 'agents' } },
    { id: 'wb:agent-waiting-user', n: 16, group: 'Agent', label: 'Agent 等待用户',
      patch: { runState: 'awaiting-user', rightPanelOpen: true, rightPanelTab: 'agents' } },
    { id: 'wb:agent-failed', n: 17, group: 'Agent', label: 'Agent 失败',
      patch: { runState: 'idle', rightPanelOpen: true, rightPanelTab: 'agents' } },

    /* ---------- 18–22 · 导航与流程 ---------- */
    { id: 'wb:minimap-long', n: 18, group: '导航与流程', label: '长会话 Conversation Minimap',
      patch: { minimapPinned: true, activeThreadId: 'th-gemini-error' } },
    { id: 'wb:steering', n: 19, group: '导航与流程', label: 'Steering', play: true,
      patch: { runState: 'running' } },
    { id: 'wb:followup', n: 20, group: '导航与流程', label: 'Follow-up Queue', play: true,
      patch: {
        runState: 'running',
        followUpQueue: ['跑一遍完整测试并把失败整理成清单', '把 capability 文档补上 CapabilityProbe 小节'],
      } },
    { id: 'wb:compacting', n: 21, group: '导航与流程', label: 'Compact', play: true,
      patch: { runState: 'compacting', compacting: true } },
    { id: 'wb:checkpoint', n: 22, group: '导航与流程', label: 'Checkpoint',
      patch: { runState: 'idle' } },

    /* ---------- 23–24 · 恢复与连接 ---------- */
    { id: 'history:time-travel', n: 23, group: '恢复与连接', label: 'Time Travel 恢复',
      patch: { screen: 'history' } },
    { id: 'wb:disconnected', n: 24, group: '恢复与连接', label: 'OMP 断开并自动重连', play: true,
      patch: { ompStatus: 'disconnected', ompError: 'Bridge 进程意外退出（exit code 1）· 正在自动重连' } },

    /* ---------- 25–30 · 能力、设置、诊断 ---------- */
    { id: 'cap:skills', n: 25, group: '能力与设置', label: 'Skills',
      patch: { screen: 'capabilities', capTab: 'skills' } },
    { id: 'cap:plugins', n: 26, group: '能力与设置', label: 'Plugins',
      patch: { screen: 'capabilities', capTab: 'plugins' } },
    { id: 'cap:mcp', n: 27, group: '能力与设置', label: 'MCP',
      patch: { screen: 'capabilities', capTab: 'mcp' } },
    { id: 'settings:models', n: 28, group: '能力与设置', label: 'Models and Providers',
      patch: { screen: 'settings', settingsTab: 'models' } },
    { id: 'settings:permissions', n: 29, group: '能力与设置', label: 'Permissions',
      patch: { screen: 'settings', settingsTab: 'permissions' } },
    { id: 'diagnostics', n: 30, group: '能力与设置', label: '诊断中心',
      patch: { screen: 'diagnostics' } },

    /* ---------- 31–36 · 侧栏布局 ---------- */
    { id: 'layout:threads-major', n: 31, group: '侧栏布局', label: '项目对话区域展开',
      layout: { splitRatio: 0.75, threadsCollapsed: false, filesCollapsed: false } },
    { id: 'layout:files-major', n: 32, group: '侧栏布局', label: '文件树区域展开',
      layout: { splitRatio: 0.25, threadsCollapsed: false, filesCollapsed: false } },
    { id: 'layout:split-even', n: 33, group: '侧栏布局', label: '上下平分',
      layout: { splitRatio: 0.5, threadsCollapsed: false, filesCollapsed: false } },
    { id: 'layout:threads-collapsed', n: 34, group: '侧栏布局', label: '项目对话区域收起',
      layout: { threadsCollapsed: true, filesCollapsed: false } },
    { id: 'layout:files-collapsed', n: 35, group: '侧栏布局', label: '文件树区域收起',
      layout: { threadsCollapsed: false, filesCollapsed: true } },
    { id: 'layout:sidebar-collapsed', n: 36, group: '侧栏布局', label: '整个侧栏收起',
      patch: { sidebarCollapsed: true } },

    /* ---------- 37–40 · 浮层与面板 ---------- */
    { id: 'overlay:omp-menu', n: 37, group: '浮层与面板', label: '左下 OMP 状态菜单展开',
      open: 'omp-menu' },
    { id: 'overlay:app-menu', n: 38, group: '浮层与面板', label: '左上应用菜单展开',
      open: 'app-menu' },
    { id: 'overlay:palette', n: 39, group: '浮层与面板', label: 'Command Palette',
      patch: { paletteOpen: true } },
    { id: 'wb:bottom-panel', n: 40, group: '浮层与面板', label: '底部 Terminal 和 Problems 面板',
      patch: { bottomPanelOpen: true, bottomPanelTab: 'terminal' } },

    /* ---------- 追加：覆盖 §12 / §17 / §20 ---------- */
    { id: 'wb:agent-hub', group: '追加状态', label: 'Agent Hub · 子 Agent 汇总',
      patch: { rightPanelOpen: true, rightPanelTab: 'agents' } },
    { id: 'wb:ask-user', group: '追加状态', label: 'Ask User 卡片',
      patch: { runState: 'awaiting-user' } },
    { id: 'wb:context-limit', group: '追加状态', label: 'Context 接近上限',
      patch: { runState: 'idle' } },
    { id: 'wb:model-retry', group: '追加状态', label: '模型请求重试',
      patch: { runState: 'running' } },
    { id: 'wb:model-fallback', group: '追加状态', label: '模型 Fallback',
      patch: { runState: 'running', model: 'omp-sonnet-5' } },
    { id: 'wb:rpc-incompatible', group: '追加状态', label: 'RPC 协议不兼容',
      patch: { ompStatus: 'error', ompError: 'RPC 协议版本不兼容：CLI v2，Bridge 需要 v3' } },
    { id: 'wb:watcher-failed', group: '追加状态', label: '文件 Watcher 失败',
      patch: { ompStatus: 'error', ompError: '文件 Watcher 启动失败：达到系统 inotify 上限' } },
    { id: 'wb:project-moved', group: '追加状态', label: '项目目录被移动或删除',
      patch: { ompStatus: 'error', ompError: '当前项目目录不存在：C:\\Aspace\\Tools\\omp-web' } },
    { id: 'wb:starting', group: '追加状态', label: 'OMP 启动中',
      patch: { ompStatus: 'starting' } },
    { id: 'cap:host-tools', group: '追加状态', label: 'Host Tools',
      patch: { screen: 'capabilities', capTab: 'host-tools' } },
    { id: 'cap:slash-commands', group: '追加状态', label: 'Slash Commands',
      patch: { screen: 'capabilities', capTab: 'slash' } },
    { id: 'settings:general', group: '追加状态', label: '设置 · General',
      patch: { screen: 'settings', settingsTab: 'general' } },
    { id: 'settings:sessions', group: '追加状态', label: '设置 · Sessions',
      patch: { screen: 'settings', settingsTab: 'sessions' } },
    { id: 'settings:preview', group: '追加状态', label: '设置 · Preview',
      patch: { screen: 'settings', settingsTab: 'preview' } },
    { id: 'settings:advanced', group: '追加状态', label: '设置 · Advanced',
      patch: { screen: 'settings', settingsTab: 'advanced' } },
    { id: 'history:list', group: '追加状态', label: '会话历史列表',
      patch: { screen: 'history' } },
  ];

  function scenarioById(id) {
    return SCENARIOS.find(s => s.id === id);
  }

  /* Apply a scenario: reset to baseline, apply the patch, run any playback. */
  function applyScenario(id) {
    const sc = scenarioById(id);
    if (!sc) return;

    bus.abort();

    store.set({ ...BASE, ...(sc.patch || {}), scenario: id, lastScenario: id });

    if (sc.layout) {
      store.set({ screen: 'workbench', sidebarCollapsed: false });
      store.setProjectLayout(sc.layout);
    }

    if (sc.open) {
      /* Defer so the sidebar has re-rendered before we click its trigger */
      setTimeout(() => {
        const sel = sc.open === 'omp-menu' ? '.sidebar-footer' : '.sidebar-header-logo';
        document.querySelector(sel)?.click();
      }, 120);
    }

    if (sc.play) playScenario(id);
  }

  /* ==========================================================================
     Playback scripts — the ▶ scenarios advance over real time
     ========================================================================== */
  function playScenario(id) {
    switch (id) {
      case 'wb:disconnected':
        bus.play([
          { at: 0,    type: 'omp.disconnected', payload: { reason: 'Bridge 进程意外退出（exit code 1）· 正在自动重连' } },
          { at: 2200, type: 'omp.reconnecting' },
          { at: 4600, type: 'omp.connected' },
        ]);
        setTimeout(() => store.toast('OMP 已重新连接，会话状态已恢复', 'ok'), 4700);
        break;

      case 'wb:compacting':
        setTimeout(() => {
          store.set({ compacting: false, runState: 'idle' });
          store.toast('Compact 完成 · 节省 182k tok', 'ok');
        }, 4200);
        break;

      case 'wb:file-writing':
        setTimeout(() => store.toast('文件系统已确认写入 CapabilityProbe.tsx', 'ok'), 2600);
        break;

      case 'wb:preview-hmr':
        setTimeout(() => store.set({ previewState: 'running' }), 1400);
        break;

      case 'wb:steering':
        setTimeout(() => store.toast('可以在输入区发送 Steering 立即调整当前任务', 'info'), 500);
        break;

      case 'wb:followup':
        setTimeout(() => store.toast('当前任务完成后会依次执行队列中的 2 条消息', 'info'), 500);
        break;

      case 'wb:tool-burst':
      case 'wb:agents-parallel':
      case 'wb:streaming':
      case 'wb:approval-bash':
      default:
        break;
    }
  }


  OMP.mod['js/scenarios'] = { scenarioById, applyScenario, SCENARIOS };
})(window.OMP = window.OMP || { mod: {} });
