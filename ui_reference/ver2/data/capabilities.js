/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock capabilities
     Skills / Plugins / MCP / Host Tools / Slash Commands.

     Every capability distinguishes three things (§17):
       configured — present in config
       loaded     — the CLI actually loaded it
       available  — usable in the current session
     These are NOT the same, and conflating them hides real failures.
     ========================================================================== */

  const SKILLS = [
    {
      name: 'esp32-firmware-engineer',
      description: 'ESP-IDF 固件工程：FreeRTOS、外设、Wi-Fi/BLE、OTA、LVGL、崩溃分析',
      source: '~/.omp/skills/esp32-firmware-engineer/SKILL.md',
      sourceKind: 'user',
      scope: '全局',
      configured: true, loaded: true, available: true,
      enabled: true,
      modified: '3 天前',
      sizeKb: 18.4,
    },
    {
      name: 'dataviz',
      description: '图表与数据可视化设计规范，含配色验证器与图表选型启发式',
      source: '~/.omp/skills/dataviz/SKILL.md',
      sourceKind: 'user',
      scope: '全局',
      configured: true, loaded: true, available: true,
      enabled: true,
      modified: '1 周前',
      sizeKb: 24.1,
    },
    {
      name: 'rpc-protocol-review',
      description: '审查 RPC 协议变更的兼容性与版本协商',
      source: '.claude/skills/rpc-protocol-review/SKILL.md',
      sourceKind: 'project',
      scope: 'omp-web',
      configured: true, loaded: true, available: true,
      enabled: true,
      modified: '2 小时前',
      sizeKb: 6.2,
    },
    {
      name: 'release-notes',
      description: '从 commit 历史生成 Release Notes',
      source: '.claude/skills/release-notes/SKILL.md',
      sourceKind: 'project',
      scope: 'omp-web',
      configured: true, loaded: true, available: false,
      enabled: false,
      modified: '2 周前',
      sizeKb: 3.8,
    },
    {
      name: 'legacy-migration',
      description: '迁移 legacy transport 到新协议',
      source: '.claude/skills/legacy-migration/SKILL.md',
      sourceKind: 'project',
      scope: 'omp-web',
      configured: true, loaded: false, available: false,
      enabled: true,
      modified: '1 个月前',
      sizeKb: 11.2,
      error: 'SKILL.md frontmatter 缺少必需的 description 字段（第 3 行）',
    },
  ];

  const PLUGINS = [
    {
      name: 'omp-git-tools',
      version: '1.4.2',
      source: 'npm:@omp/git-tools',
      sourceKind: 'npm',
      configured: true, loaded: true, available: true,
      enabled: true,
      tools: ['git_blame_range', 'git_file_history', 'git_stash_diff'],
      slashCommands: ['/blame', '/file-history'],
      uiCapabilities: ['Diff 侧栏扩展'],
      hooks: ['PreToolUse:Bash'],
      lastError: null,
    },
    {
      name: 'omp-test-runner',
      version: '0.9.1',
      source: 'npm:@omp/test-runner',
      sourceKind: 'npm',
      configured: true, loaded: true, available: true,
      enabled: true,
      tools: ['run_test_file', 'run_test_suite', 'coverage_report'],
      slashCommands: ['/test', '/coverage'],
      uiCapabilities: ['Tests 面板'],
      hooks: ['PostToolUse:Edit'],
      lastError: null,
    },
    {
      name: 'omp-lint-bridge',
      version: '2.0.0-beta.3',
      source: 'file:~/.omp/plugins/lint-bridge',
      sourceKind: 'local',
      configured: true, loaded: true, available: false,
      enabled: true,
      tools: ['lint_file', 'lint_fix'],
      slashCommands: ['/lint'],
      uiCapabilities: ['Problems 面板'],
      hooks: ['PostToolUse:Write', 'PostToolUse:Edit'],
      lastError: 'eslint 未安装于当前项目 — lint_file 调用会失败（14:08）',
    },
    {
      name: 'omp-figma',
      version: '0.3.0',
      source: 'npm:@omp/figma',
      sourceKind: 'npm',
      configured: true, loaded: false, available: false,
      enabled: false,
      tools: [],
      slashCommands: [],
      uiCapabilities: [],
      hooks: [],
      lastError: 'FIGMA_TOKEN 环境变量未设置',
    },
  ];

  const MCP_SERVERS = [
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-filesystem /Users/dev/projects',
      configured: true, loaded: true, available: true,
      status: 'connected',
      tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'move_file'],
      resources: ['file://'],
      prompts: [],
      lastCall: '14:31:08 · list_directory · 12ms',
      callCount: 84,
      error: null,
    },
    {
      name: 'github',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-github',
      configured: true, loaded: true, available: true,
      status: 'connected',
      tools: ['create_issue', 'list_prs', 'get_pr_diff', 'create_pr_review', 'search_code'],
      resources: ['github://repo/'],
      prompts: ['review-pr'],
      lastCall: '13:52:41 · get_pr_diff · 340ms',
      callCount: 12,
      error: null,
    },
    {
      name: 'postgres-local',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/dev',
      configured: true, loaded: true, available: false,
      status: 'error',
      tools: [],
      resources: [],
      prompts: [],
      lastCall: null,
      callCount: 0,
      error: 'ECONNREFUSED 127.0.0.1:5432 — postgres 未运行',
    },
    {
      name: 'sentry',
      transport: 'sse',
      command: 'https://mcp.sentry.dev/sse',
      configured: true, loaded: false, available: false,
      status: 'disconnected',
      tools: [],
      resources: [],
      prompts: [],
      lastCall: null,
      callCount: 0,
      error: '需要交互式认证 — 请运行 omp mcp auth sentry',
    },
  ];

  /* Host Tools — provided BY OMP Studio TO the OMP CLI */
  const HOST_TOOLS = [
    {
      name: 'preview_screenshot',
      description: '截取 Preview 当前页面',
      category: 'Preview',
      registered: true, available: true,
      callCount: 24,
      lastCall: '14:29:12 · 340ms',
    },
    {
      name: 'preview_navigate',
      description: '导航 Preview 到指定 URL',
      category: 'Preview',
      registered: true, available: true,
      callCount: 8,
      lastCall: '14:28:04 · 82ms',
    },
    {
      name: 'preview_pick_element',
      description: '请求用户在 Preview 中选择一个元素',
      category: 'Preview',
      registered: true, available: true,
      callCount: 3,
      lastCall: '14:12:38 · 4.2s（含用户操作）',
    },
    {
      name: 'browser_query_dom',
      description: '查询 Preview 页面的 DOM 结构',
      category: 'Browser',
      registered: true, available: true,
      callCount: 16,
      lastCall: '14:29:14 · 48ms',
    },
    {
      name: 'browser_console_logs',
      description: '读取 Preview Console 输出',
      category: 'Browser',
      registered: true, available: true,
      callCount: 31,
      lastCall: '14:33:42 · 6ms',
    },
    {
      name: 'open_in_editor',
      description: '在外部编辑器中打开文件与行号',
      category: '系统集成',
      registered: true, available: true,
      callCount: 5,
      lastCall: '14:14:22 · 120ms',
    },
    {
      name: 'reveal_in_file_manager',
      description: '在系统文件管理器中显示文件',
      category: '系统集成',
      registered: true, available: true,
      callCount: 1,
      lastCall: '13:48:10 · 88ms',
    },
    {
      name: 'desktop_notification',
      description: '发送桌面通知',
      category: '系统集成',
      registered: true, available: false,
      callCount: 0,
      lastCall: null,
      error: '系统通知权限未授予',
    },
  ];

  const SLASH_COMMANDS = [
    { name: '/test', description: '运行测试套件', source: 'omp-test-runner', sourceKind: 'plugin',
      args: '[file|suite]', available: true },
    { name: '/coverage', description: '生成覆盖率报告', source: 'omp-test-runner', sourceKind: 'plugin',
      args: '', available: true },
    { name: '/blame', description: '查看指定行的 git blame', source: 'omp-git-tools', sourceKind: 'plugin',
      args: '<file>:<line>', available: true },
    { name: '/file-history', description: '查看文件修改历史', source: 'omp-git-tools', sourceKind: 'plugin',
      args: '<file>', available: true },
    { name: '/lint', description: '运行 lint 并修复', source: 'omp-lint-bridge', sourceKind: 'plugin',
      args: '[file]', available: false, reason: 'eslint 未安装' },
    { name: '/review', description: '审查当前工作区改动', source: '内置', sourceKind: 'builtin',
      args: '', available: true },
    { name: '/compact', description: '压缩当前会话上下文', source: '内置', sourceKind: 'builtin',
      args: '[instructions]', available: true },
    { name: '/clear', description: '清空当前会话', source: '内置', sourceKind: 'builtin',
      args: '', available: true },
    { name: '/init', description: '生成 AGENTS.md', source: '内置', sourceKind: 'builtin',
      args: '', available: true },
    { name: '/rpc-review', description: '审查 RPC 协议变更', source: 'rpc-protocol-review', sourceKind: 'skill',
      args: '', available: true },
  ];

  const CAP_STATE_LABEL = {
    configured: '已配置',
    loaded: '已加载',
    available: '当前会话可用',
  };

  /* Resolve the three-state badge set for any capability record */
  function capStates(c) {
    return [
      { key: 'configured', on: !!c.configured },
      { key: 'loaded', on: !!c.loaded },
      { key: 'available', on: !!c.available },
    ];
  }


  OMP.mod['data/capabilities'] = { capStates, SKILLS, PLUGINS, MCP_SERVERS, HOST_TOOLS, SLASH_COMMANDS, CAP_STATE_LABEL };
})(window.OMP = window.OMP || { mod: {} });
