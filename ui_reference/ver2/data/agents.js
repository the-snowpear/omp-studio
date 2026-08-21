/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock agents
     Main agent + subagents. Rendered as an indented hierarchy list, not a
     relationship graph — devs need to scan status, not admire a diagram.
     ========================================================================== */

  const AGENT_STATUS = {
    starting:        { label: 'Starting',        tone: 'muted',  icon: 'clock' },
    thinking:        { label: 'Thinking',        tone: 'run',    icon: 'brain' },
    'running-tool':  { label: 'Running Tool',    tone: 'run',    icon: 'zap' },
    'waiting-agent': { label: 'Waiting for Agent', tone: 'muted', icon: 'clock' },
    'waiting-user':  { label: 'Waiting for User', tone: 'warn',  icon: 'helpCircle' },
    completed:       { label: 'Completed',       tone: 'ok',     icon: 'checkCircle' },
    failed:          { label: 'Failed',          tone: 'danger', icon: 'xCircle' },
    aborted:         { label: 'Aborted',         tone: 'muted',  icon: 'stop' },
  };

  /* Scenario: wb:agents-parallel — main + 3 subagents running concurrently */
  const AGENTS_PARALLEL = [
    {
      id: 'ag-main',
      name: 'main',
      role: '主 Agent · 协调本轮任务',
      parentId: null,
      depth: 0,
      task: '抽离 CapabilityProbe 组件并验证',
      status: 'waiting-agent',
      waitingFor: 'test-runner, preview-verifier',
      lastTool: 'Write · CapabilityProbe.tsx',
      elapsed: '2m 18s',
      tokens: 42_100,
      costUsd: 0.94,
      filesChanged: 2,
      model: 'omp-opus-5',
    },
    {
      id: 'ag-test',
      name: 'test-runner',
      role: '运行测试套件并汇总失败',
      parentId: 'ag-main',
      depth: 1,
      task: '跑 bun test，把失败用例整理成可修复的清单',
      status: 'running-tool',
      lastTool: 'Bash · bun test --coverage',
      elapsed: '48s',
      tokens: 12_400,
      costUsd: 0.21,
      filesChanged: 0,
      model: 'omp-sonnet-5',
    },
    {
      id: 'ag-preview',
      name: 'preview-verifier',
      role: '启动 Preview 并验证关键页面',
      parentId: 'ag-main',
      depth: 1,
      task: '等 test-runner 通过后启动 dev server，截图验证首页与设置页',
      status: 'waiting-agent',
      waitingFor: 'test-runner',
      lastTool: null,
      elapsed: '48s',
      tokens: 3_100,
      costUsd: 0.05,
      filesChanged: 0,
      model: 'omp-sonnet-5',
    },
    {
      id: 'ag-docs',
      name: 'docs-writer',
      role: '更新 capability 文档',
      parentId: 'ag-main',
      depth: 1,
      task: '把新的 CapabilityProbe 用法写进 docs/capabilities.md',
      status: 'running-tool',
      lastTool: 'Edit · docs/capabilities.md',
      elapsed: '32s',
      tokens: 8_900,
      costUsd: 0.14,
      filesChanged: 1,
      model: 'omp-sonnet-5',
    },
  ];

  /* Scenario: wb:agent-waiting-user */
  const AGENTS_WAITING_USER = AGENTS_PARALLEL.map(a =>
    a.id === 'ag-preview'
      ? {
          ...a,
          status: 'waiting-user',
          waitingFor: null,
          task: '需要确认：dev server 端口 5173 被占用，是否换到 5174？',
          lastTool: 'Bash · lsof -i :5173',
          elapsed: '1m 12s',
        }
      : a
  );

  /* Scenario: wb:agent-failed */
  const AGENTS_FAILED = [
    { ...AGENTS_PARALLEL[0], status: 'failed', task: '抽离 CapabilityProbe 组件并验证（子 Agent 失败）' },
    {
      ...AGENTS_PARALLEL[1],
      status: 'failed',
      lastTool: 'Bash · bun test --coverage',
      elapsed: '2m 04s',
      tokens: 28_200,
      error: {
        summary: 'bun test 退出码 137 — 进程被 OOM killer 终止',
        detail: `$ bun test --coverage

  test/transport.test.ts:
    ✓ connects over stdio (12ms)
    ✓ retries on ECONNRESET (34ms)
    ✗ handles 10k concurrent frames

  <--- Last few GCs --->
  [8214:0x7f8] 48210 ms: Mark-sweep 3892.1 (4011.3) -> 3891.4 (4012.1) MB

  FATAL ERROR: Reached heap limit Allocation failed
  Killed (exit code 137)`,
        file: 'test/transport.test.ts',
        line: 84,
      },
    },
    { ...AGENTS_PARALLEL[2], status: 'aborted', task: '因 test-runner 失败而中止', elapsed: '2m 04s' },
    { ...AGENTS_PARALLEL[3], status: 'completed', elapsed: '1m 08s', tokens: 14_200, filesChanged: 1 },
  ];

  /* Scenario: single agent (default workbench) */
  const AGENTS_SINGLE = [AGENTS_PARALLEL[0]];

  /* Scenario: subagents completed and summarized back to main */
  const AGENTS_SUMMARIZED = [
    {
      ...AGENTS_PARALLEL[0],
      status: 'completed',
      task: '抽离 CapabilityProbe 组件并验证 — 已完成',
      elapsed: '4m 02s',
      tokens: 68_400,
      filesChanged: 3,
    },
    { ...AGENTS_PARALLEL[1], status: 'completed', elapsed: '1m 51s', tokens: 22_800,
      summary: '46 个用例全过，覆盖率 transport.ts 62% → 91%' },
    { ...AGENTS_PARALLEL[2], status: 'completed', elapsed: '2m 12s', tokens: 11_200,
      summary: '首页与设置页渲染正常，无 console error' },
    { ...AGENTS_PARALLEL[3], status: 'completed', elapsed: '1m 08s', tokens: 14_200, filesChanged: 1,
      summary: 'docs/capabilities.md 增加 CapabilityProbe 小节' },
  ];

  function agentsForScenario(scenario) {
    switch (scenario) {
      case 'wb:agents-parallel': return AGENTS_PARALLEL;
      case 'wb:agent-waiting-user': return AGENTS_WAITING_USER;
      case 'wb:agent-failed': return AGENTS_FAILED;
      case 'wb:agent-summarized': return AGENTS_SUMMARIZED;
      default: return AGENTS_SINGLE;
    }
  }


  OMP.mod['data/agents'] = { agentsForScenario, AGENT_STATUS, AGENTS_PARALLEL, AGENTS_WAITING_USER, AGENTS_FAILED, AGENTS_SINGLE, AGENTS_SUMMARIZED };
})(window.OMP = window.OMP || { mod: {} });
