/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock diagnostics + environment checks
     Aimed at open-source users and developers debugging their own setup.
     Ordinary info first, advanced detail collapsed.
     ========================================================================== */

  const ENV_CHECKS_OK = [
    { id: 'cli', label: 'OMP CLI', status: 'ok', value: 'C:\\Users\\the_snowpear\\.bun\\bin\\omp.exe', detail: '通过 PATH 找到' },
    { id: 'version', label: 'OMP 版本', status: 'ok', value: '0.8.4', detail: '满足最低要求 0.8.0' },
    { id: 'rpc', label: 'RPC 协议', status: 'ok', value: 'v3', detail: 'Bridge 支持 v2–v3' },
    { id: 'capability', label: 'Capability', status: 'ok', value: '14 / 14 可用', detail: 'preview, browser, screenshot, dom, mcp, skills, plugins, hooks, subagent, checkpoint, compact, fork, handoff, telemetry' },
    { id: 'auth', label: '模型认证', status: 'ok', value: '已登录 · Anthropic', detail: 'OAuth token 有效期至 2026-09-14' },
    { id: 'provider', label: 'Provider 状态', status: 'ok', value: '3 个可用', detail: 'Anthropic, Google, OpenRouter' },
    { id: 'git', label: 'Git', status: 'ok', value: '2.47.1', detail: 'C:\\Program Files\\Git\\cmd\\git.exe' },
    { id: 'node', label: 'Node', status: 'ok', value: 'v22.11.0', detail: 'C:\\Program Files\\nodejs\\node.exe' },
    { id: 'bun', label: 'Bun', status: 'ok', value: '1.1.38', detail: 'C:\\Users\\the_snowpear\\.bun\\bin\\bun.exe' },
    { id: 'config', label: 'OMP 配置目录', status: 'ok', value: '~/.omp/agent/', detail: 'config.yml, models.json, sessions/, agent.db' },
    { id: 'perms', label: '文件权限', status: 'ok', value: '读写正常', detail: '配置目录与工作区均可写' },
    { id: 'preview-deps', label: 'Preview 运行依赖', status: 'ok', value: '已就绪', detail: 'Chromium 132 · 内置' },
    { id: 'watcher', label: '文件 Watcher', status: 'ok', value: '正常', detail: '监听 1 个工作区，284 个文件' },
  ];

  const ENV_CHECKS_FAIL = [
    { id: 'cli', label: 'OMP CLI', status: 'ok', value: 'C:\\Users\\the_snowpear\\.bun\\bin\\omp.exe', detail: '通过 PATH 找到' },
    {
      id: 'version', label: 'OMP 版本', status: 'warn', value: '0.7.2',
      detail: '低于最低要求 0.8.0。Capability 探测与 Checkpoint 恢复不可用。',
      actions: ['查看升级说明', '检查更新'],
    },
    {
      id: 'rpc', label: 'RPC 协议', status: 'error', value: 'v2（Bridge 需要 v3）',
      detail: 'OMP CLI 0.7.2 只实现到 RPC v2。Bridge 会以兼容模式运行，Preview 与 Subagent 相关能力不可用。',
      actions: ['升级 OMP CLI', '查看协议差异'],
    },
    {
      id: 'capability', label: 'Capability', status: 'warn', value: '8 / 14 可用',
      detail: '不可用：preview, browser, screenshot, dom, subagent, checkpoint',
      actions: ['查看详情'],
    },
    {
      id: 'auth', label: '模型认证', status: 'error', value: '未认证',
      detail: '未找到有效的 Anthropic 凭据。所有模型请求都会失败。',
      actions: ['打开 OMP 登录', '配置 API Key'],
    },
    { id: 'provider', label: 'Provider 状态', status: 'warn', value: '0 个可用', detail: '认证完成后重新检测' },
    { id: 'git', label: 'Git', status: 'ok', value: '2.47.1', detail: 'C:\\Program Files\\Git\\cmd\\git.exe' },
    { id: 'node', label: 'Node', status: 'ok', value: 'v22.11.0', detail: 'C:\\Program Files\\nodejs\\node.exe' },
    {
      id: 'bun', label: 'Bun', status: 'error', value: '未安装',
      detail: 'Preview 的默认包管理器不可用。可以改用 npm 或 pnpm。',
      actions: ['安装 Bun', '改用 npm'],
    },
    { id: 'config', label: 'OMP 配置目录', status: 'ok', value: '~/.omp/agent/', detail: 'config.yml, models.json, sessions/' },
    {
      id: 'perms', label: '文件权限', status: 'warn', value: '部分受限',
      detail: '~/.omp/agent/sessions/ 只读 — 会话无法保存。',
      actions: ['修复权限', '查看说明'],
    },
    {
      id: 'preview-deps', label: 'Preview 运行依赖', status: 'error', value: '缺失',
      detail: 'Chromium 未下载。Preview、截图与元素选择不可用。',
      actions: ['下载 Chromium', '跳过'],
    },
    { id: 'watcher', label: '文件 Watcher', status: 'ok', value: '正常', detail: '监听 1 个工作区' },
  ];

  const DIAGNOSTICS = {
    basic: {
      ompPath: 'C:\\Users\\the_snowpear\\.bun\\bin\\omp.exe',
      ompVersion: '0.8.4',
      rpcVersion: 'v3',
      bridgeStatus: 'connected',
      bridgeUptime: '2h 14m',
      studioVersion: '2.0.0-preview.3',
      platform: 'win32 · Windows 11 Home China 10.0.26200',
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      configDir: 'C:\\Users\\the_snowpear\\.omp\\agent',
      logDir: 'C:\\Users\\the_snowpear\\.omp\\agent\\logs',
    },

    capabilities: [
      { name: 'preview', available: true, since: 'v0.8.0' },
      { name: 'browser', available: true, since: 'v0.8.0' },
      { name: 'screenshot', available: true, since: 'v0.8.0' },
      { name: 'dom', available: true, since: 'v0.8.2' },
      { name: 'mcp', available: true, since: 'v0.6.0' },
      { name: 'skills', available: true, since: 'v0.7.0' },
      { name: 'plugins', available: true, since: 'v0.7.4' },
      { name: 'hooks', available: true, since: 'v0.7.4' },
      { name: 'subagent', available: true, since: 'v0.8.0' },
      { name: 'checkpoint', available: true, since: 'v0.8.1' },
      { name: 'compact', available: true, since: 'v0.6.2' },
      { name: 'fork', available: true, since: 'v0.8.1' },
      { name: 'handoff', available: true, since: 'v0.8.3' },
      { name: 'telemetry', available: true, since: 'v0.8.0' },
    ],

    processes: [
      { kind: 'bridge', name: 'omp-bridge', pid: 14882, cpu: '0.4%', mem: '82 MB', uptime: '2h 14m' },
      { kind: 'session', name: 'omp (th-sync-upstream)', pid: 15104, cpu: '12.8%', mem: '412 MB', uptime: '48m' },
      { kind: 'session', name: 'omp (th-capability-probe)', pid: 15288, cpu: '0.0%', mem: '188 MB', uptime: '12m' },
      { kind: 'subagent', name: 'omp-subagent (test-runner)', pid: 16022, cpu: '48.2%', mem: '640 MB', uptime: '48s' },
      { kind: 'subagent', name: 'omp-subagent (docs-writer)', pid: 16044, cpu: '3.1%', mem: '204 MB', uptime: '32s' },
      { kind: 'preview', name: 'bun run dev', pid: 15840, cpu: '2.1%', mem: '318 MB', uptime: '18m' },
      { kind: 'preview', name: 'chromium (preview)', pid: 15912, cpu: '1.8%', mem: '284 MB', uptime: '18m' },
    ],

    watchers: [
      { path: 'C:\\Aspace\\Tools\\omp-web', files: 284, status: 'ok', backend: 'ReadDirectoryChangesW' },
      { path: 'C:\\Aspace\\Tools\\omp-web\\.worktrees\\bridge-rewrite', files: 42, status: 'ok', backend: 'ReadDirectoryChangesW' },
    ],

    recentErrors: [
      { time: '14:33:18', source: 'MCP', level: 'error', text: 'postgres-local: ECONNREFUSED 127.0.0.1:5432' },
      { time: '14:12:04', source: 'Plugin', level: 'warn', text: 'omp-lint-bridge: eslint binary not found in project' },
      { time: '13:58:41', source: 'RPC', level: 'warn', text: 'request timeout after 30s (method: tools/call), retried once' },
      { time: '13:22:10', source: 'Preview', level: 'error', text: 'dev server exited with code 1 (EADDRINUSE :5173)' },
    ],

    rpcLog: [
      { time: '14:33:41.208', dir: 'out', method: 'tools/call', id: 1842, payload: '{"name":"Write","arguments":{"file_path":"components/bridge/CapabilityProbe.tsx","content":"..."}}' },
      { time: '14:33:41.284', dir: 'in', method: 'tools/call', id: 1842, payload: '{"content":[{"type":"text","text":"File created successfully"}]}' },
      { time: '14:33:42.011', dir: 'in', method: 'notifications/file_changed', id: null, payload: '{"path":"components/bridge/CapabilityProbe.tsx","kind":"created"}' },
      { time: '14:33:42.104', dir: 'out', method: 'tools/call', id: 1843, payload: '{"name":"Bash","arguments":{"command":"bun test --coverage"}}' },
      { time: '14:33:42.118', dir: 'in', method: 'notifications/approval_required', id: null, payload: '{"toolCallId":1843,"reason":"bash_command","risk":"workspace_write"}' },
    ],
  };

  const OMP_STATUS_LABEL = {
    ready:              { text: 'OMP Ready',            tone: 'ok' },
    running:            { text: 'OMP Running',          tone: 'run' },
    reconnecting:       { text: 'OMP Reconnecting',     tone: 'warn' },
    disconnected:       { text: 'OMP Disconnected',     tone: 'danger' },
    error:              { text: 'OMP Error',            tone: 'danger' },
    'update-available': { text: 'OMP Update Available', tone: 'warn' },
    starting:           { text: 'OMP Starting',         tone: 'run' },
  };

  /* ---- Bottom panel data ------------------------------------------------- */
  const PROBLEMS = [
    { severity: 'error', source: 'TypeScript', code: 'TS2339', file: 'components/bridge/RpcClient.ts', line: 84, col: 12,
      message: "Property 'capabilities' does not exist on type 'RpcHandshake'." },
    { severity: 'error', source: 'TypeScript', code: 'TS2551', file: 'hooks/useRpc.ts', line: 31, col: 7,
      message: "Property 'probeCapability' does not exist on type 'RpcClient'. Did you mean 'probeCapabilities'?" },
    { severity: 'error', source: 'Git', code: 'CONFLICT', file: 'lib/protocol.ts', line: 14, col: 1,
      message: '未解决的合并冲突标记' },
    { severity: 'warn', source: 'ESLint', code: 'react/jsx-key', file: 'components/MessageList.tsx', line: 84, col: 18,
      message: 'Missing "key" prop for element in iterator' },
    { severity: 'warn', source: 'Preview', code: 'HMR', file: 'components/bridge/CapabilityProbe.tsx', line: 1, col: 1,
      message: '新文件尚未被 HMR 加载，可能需要刷新页面' },
    { severity: 'info', source: 'OMP', code: 'CTX', file: null, line: null, col: null,
      message: 'Context 已使用 22%，距离自动 Compact 阈值还有 58%' },
  ];

  const TESTS = {
    suites: [
      {
        name: 'test/transport.test.ts',
        status: 'passed',
        duration: '1.2s',
        cases: [
          { name: 'connects over stdio', status: 'passed', duration: '12ms' },
          { name: 'retries on ECONNRESET', status: 'passed', duration: '34ms' },
          { name: 'handles 10k concurrent frames', status: 'passed', duration: '840ms' },
          { name: 'closes cleanly on abort', status: 'passed', duration: '18ms' },
        ],
      },
      {
        name: 'test/capability.test.ts',
        status: 'failed',
        duration: '640ms',
        cases: [
          { name: 'probes all declared capabilities', status: 'passed', duration: '22ms' },
          { name: 'degrades when preview missing', status: 'failed', duration: '18ms',
            error: `expect(received).toEqual(expected)

  Expected: ["mcp", "skills"]
  Received: ["mcp", "skills", "preview"]

    at test/capability.test.ts:42:31` },
          { name: 'reads meta.capabilities on v0.82+', status: 'passed', duration: '14ms' },
          { name: 'falls back to flat capabilities on v0.81', status: 'skipped', duration: '0ms' },
        ],
      },
      {
        name: 'test/protocol.test.ts',
        status: 'running',
        duration: null,
        cases: [
          { name: 'negotiates highest common version', status: 'passed', duration: '8ms' },
          { name: 'rejects incompatible major', status: 'running', duration: null },
        ],
      },
    ],
    summary: { passed: 8, failed: 1, skipped: 1, running: 1, total: 11, duration: '2.1s' },
  };

  const TERMINALS = [
    {
      id: 'term-1',
      name: 'bun run dev',
      owner: 'omp',            // 'omp' = started by OMP · 'user' = started by the user
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      running: true,
      pid: 15840,
      lines: [
        { kind: 'cmd', text: '$ bun run dev' },
        { kind: 'out', text: '  ▲ Next.js 15.1.3' },
        { kind: 'out', text: '  - Local:        http://localhost:5173' },
        { kind: 'out', text: '  - Network:      http://192.168.1.24:5173' },
        { kind: 'out', text: '' },
        { kind: 'out', text: ' ✓ Ready in 1.8s' },
        { kind: 'out', text: ' ○ Compiling / ...' },
        { kind: 'out', text: ' ✓ Compiled / in 2.1s (1284 modules)' },
        { kind: 'out', text: ' ✓ Compiled in 184ms (1285 modules)' },
      ],
    },
    {
      id: 'term-2',
      name: 'bun test --coverage',
      owner: 'omp',
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      running: true,
      pid: 16022,
      lines: [
        { kind: 'cmd', text: '$ bun test --coverage' },
        { kind: 'out', text: 'bun test v1.1.38' },
        { kind: 'out', text: '' },
        { kind: 'out', text: 'test/transport.test.ts:' },
        { kind: 'ok',  text: '  ✓ connects over stdio (12ms)' },
        { kind: 'ok',  text: '  ✓ retries on ECONNRESET (34ms)' },
        { kind: 'ok',  text: '  ✓ handles 10k concurrent frames (840ms)' },
        { kind: 'out', text: '' },
        { kind: 'out', text: 'test/capability.test.ts:' },
        { kind: 'ok',  text: '  ✓ probes all declared capabilities (22ms)' },
        { kind: 'err', text: '  ✗ degrades when preview missing (18ms)' },
      ],
    },
    {
      id: 'term-3',
      name: 'pwsh',
      owner: 'user',
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      running: false,
      pid: null,
      lines: [
        { kind: 'cmd', text: 'PS C:\\Aspace\\Tools\\omp-web> git status --short' },
        { kind: 'out', text: ' M app/globals.css' },
        { kind: 'out', text: ' M components/bridge/RpcClient.ts' },
        { kind: 'out', text: 'A  components/bridge/CapabilityProbe.tsx' },
        { kind: 'out', text: 'UU lib/protocol.ts' },
        { kind: 'out', text: '?? public/preview.png' },
        { kind: 'cmd', text: 'PS C:\\Aspace\\Tools\\omp-web> ' },
      ],
    },
  ];

  const LOG_SOURCES = ['OMP Bridge', 'OMP CLI', 'RPC', 'Preview', 'Extension', 'Plugin', 'MCP'];

  const LOGS = [
    { time: '14:33:42.118', source: 'RPC', level: 'debug', text: '← notifications/approval_required {"toolCallId":1843}' },
    { time: '14:33:42.104', source: 'RPC', level: 'debug', text: '→ tools/call {"name":"Bash","id":1843}' },
    { time: '14:33:42.011', source: 'OMP Bridge', level: 'info', text: 'watcher: created components/bridge/CapabilityProbe.tsx' },
    { time: '14:33:41.284', source: 'OMP CLI', level: 'info', text: 'tool Write completed in 340ms' },
    { time: '14:33:41.208', source: 'RPC', level: 'debug', text: '→ tools/call {"name":"Write","id":1842}' },
    { time: '14:33:18.442', source: 'MCP', level: 'error', text: 'postgres-local: ECONNREFUSED 127.0.0.1:5432' },
    { time: '14:33:02.918', source: 'Preview', level: 'info', text: '[vite] hmr update /components/bridge/RpcClient.ts' },
    { time: '14:32:08.104', source: 'Preview', level: 'info', text: 'dev server ready on http://localhost:5173' },
    { time: '14:12:04.882', source: 'Plugin', level: 'warn', text: 'omp-lint-bridge: eslint binary not found' },
    { time: '12:19:40.001', source: 'OMP Bridge', level: 'info', text: 'bridge started, pid 14882, rpc v3' },
  ];


  OMP.mod['data/diagnostics'] = { ENV_CHECKS_OK, ENV_CHECKS_FAIL, DIAGNOSTICS, OMP_STATUS_LABEL, PROBLEMS, TESTS, TERMINALS, LOG_SOURCES, LOGS };
})(window.OMP = window.OMP || { mod: {} });
