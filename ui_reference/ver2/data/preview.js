/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock preview states
     12 states covering the full lifecycle from unconfigured to crashed.
     ========================================================================== */

  const PREVIEW_STATES = {
    unconfigured: {
      label: '未配置启动命令',
      tone: 'muted',
      icon: 'info',
      message: '需要配置开发服务器启动命令',
      actions: ['配置启动命令', '自动检测'],
    },
    detecting: {
      label: '正在检测项目',
      tone: 'run',
      icon: 'search',
      message: '正在扫描 package.json 与项目结构...',
      actions: [],
    },
    installing: {
      label: '正在安装依赖',
      tone: 'run',
      icon: 'download',
      message: 'bun install 正在运行...',
      progress: 0.42,
      actions: [],
    },
    starting: {
      label: '正在启动开发服务器',
      tone: 'run',
      icon: 'play',
      message: '$ bun run dev',
      actions: [],
    },
    building: {
      label: '正在构建',
      tone: 'run',
      icon: 'cpu',
      message: 'Next.js 编译中...',
      progress: 0.68,
      actions: [],
    },
    running: {
      label: '页面正常',
      tone: 'ok',
      icon: 'checkCircle',
      message: null,
      url: 'http://localhost:5173/',
      actions: [],
    },
    hmr: {
      label: '热更新中',
      tone: 'run',
      icon: 'zap',
      message: 'HMR update · components/bridge/CapabilityProbe.tsx',
      actions: [],
    },
    'compile-error': {
      label: '编译失败',
      tone: 'danger',
      icon: 'xCircle',
      message: null,
      error: {
        summary: 'TypeScript 编译错误',
        file: 'components/bridge/RpcClient.ts',
        line: 84,
        column: 12,
        detail: `components/bridge/RpcClient.ts:84:12 - error TS2339: Property 'capabilities' does not exist on type 'RpcHandshake'.

  84     if (hs.capabilities?.includes('preview')) {
                ~~~~~~~~~~~~

  Did you mean 'meta.capabilities'?`,
      },
      actions: ['打开文件', '复制错误', '加入上下文', '请求 OMP 修复', '查看完整日志', '重启 Preview'],
    },
    'server-exit': {
      label: '服务退出',
      tone: 'danger',
      icon: 'alertCircle',
      message: '开发服务器进程已终止 (exit code 1)',
      error: {
        summary: 'dev server 退出码 1',
        detail: `Error: listen EADDRINUSE: address already in use :::5173
      at Server.setupListenHandle [as _listen2] (node:net:1855:16)
      at listenInCluster (node:net:1903:12)`,
      },
      actions: ['查看完整日志', '更换端口', '重启'],
    },
    'port-conflict': {
      label: '端口冲突',
      tone: 'warn',
      icon: 'alertTriangle',
      message: '端口 5173 被占用',
      error: {
        summary: 'EADDRINUSE: address already in use :::5173',
        detail: `$ lsof -i :5173
  COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
  node    8214 user   21u  IPv6 124811      0t0  TCP *:5173 (LISTEN)`,
      },
      actions: ['更换端口', '终止占用进程', '取消'],
    },
    crashed: {
      label: '页面崩溃',
      tone: 'danger',
      icon: 'xCircle',
      message: '页面渲染崩溃',
      error: {
        summary: 'Uncaught TypeError: Cannot read properties of undefined',
        file: 'app/page.tsx',
        line: 42,
        detail: `Uncaught TypeError: Cannot read properties of undefined (reading 'map')
      at Page (page.tsx:42:18)
      at renderWithHooks (react-dom.development.js:16175:18)

  Source (app/page.tsx:42):
  40 |   const threads = useThreads();
  41 |
  42 |   return threads.map(t => <ThreadCard key={t.id} thread={t} />);
     |                  ^
  43 | }`,
      },
      actions: ['打开文件', '查看 Console', '重新加载页面', '重启 Preview'],
    },
    unreachable: {
      label: '无法访问',
      tone: 'danger',
      icon: 'wifiOff',
      message: 'localhost:5173 未响应',
      error: {
        summary: 'ERR_CONNECTION_REFUSED',
        detail: 'Failed to connect to http://localhost:5173/\n\nThe server may not be running, or the port may be incorrect.',
      },
      actions: ['检查端口', '重启开发服务器', '查看日志'],
    },
  };

  const PREVIEW_CONSOLE = [
    { kind: 'log', time: '14:32:08', text: '[vite] connected.', source: 'client.ts:48' },
    { kind: 'log', time: '14:32:09', text: '[HMR] Listening for file changes...', source: 'client.ts:52' },
    { kind: 'warn', time: '14:33:02', text: '[React] Warning: Each child in a list should have a unique "key" prop.', source: 'MessageList.tsx:84' },
    { kind: 'log', time: '14:33:41', text: '[vite] hmr update /components/bridge/CapabilityProbe.tsx', source: 'client.ts:124' },
    { kind: 'log', time: '14:33:42', text: '[HMR] Updated 1 module.', source: 'client.ts:128' },
  ];

  const PREVIEW_NETWORK = [
    { method: 'GET', url: '/', status: 200, size: '4.2 KB', time: '142ms', cached: false },
    { method: 'GET', url: '/_next/static/chunks/main.js', status: 200, size: '182 KB', time: '8ms', cached: true },
    { method: 'POST', url: '/api/rpc', status: 200, size: '840 B', time: '24ms', cached: false },
    { method: 'GET', url: '/api/capabilities', status: 200, size: '320 B', time: '12ms', cached: false },
  ];

  const PREVIEW_VIEWPORTS = [
    { id: 'desktop', label: 'Desktop', width: 1440, height: 900, icon: 'monitor' },
    { id: 'laptop', label: 'Laptop', width: 1280, height: 800, icon: 'monitor' },
    { id: 'tablet', label: 'Tablet', width: 768, height: 1024, icon: 'tablet' },
    { id: 'mobile', label: 'Mobile', width: 375, height: 667, icon: 'smartphone' },
  ];

  /* Element picker — the user clicked a button in the preview */
  const PICKED_ELEMENT = {
    kind: 'button',
    text: '提交订单',
    url: 'http://localhost:5173/checkout',
    selector: 'button.btn-primary[type="submit"]',
    domPath: 'body > div#root > main > form > div.actions > button',
    rect: { x: 720, y: 580, width: 140, height: 36 },
    screenshot: '(base64 thumbnail)',
    styles: {
      fontSize: '14px',
      fontWeight: '600',
      color: '#FFFFFF',
      backgroundColor: '#7C6BF0',
      borderRadius: '6px',
      padding: '8px 16px',
    },
    a11y: {
      role: 'button',
      label: '提交订单',
      tabindex: 0,
      keyboardAccessible: true,
    },
  };


  OMP.mod['data/preview'] = { PREVIEW_STATES, PREVIEW_CONSOLE, PREVIEW_NETWORK, PREVIEW_VIEWPORTS, PICKED_ELEMENT };
})(window.OMP = window.OMP || { mod: {} });
