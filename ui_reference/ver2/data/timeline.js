/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock timeline
     Document-style agent timeline events. Types:
       turn-header · user · assistant · thinking · plan · tool · tool-group
       approval · ask-user · checkpoint · compact · error · subagent
     ========================================================================== */

  const TIMELINE = [
    /* ================= TURN 1 ================= */
    {
      id: 'ev-t1-header',
      type: 'turn-header',
      turn: 1,
      time: '14:02',
      duration: '3m 41s',
      tokens: 128_400,
    },
    {
      id: 'ev-t1-user',
      type: 'user',
      time: '14:02',
      text: '把上游 `pi-web` v0.8.1 的更新同步到 `omp-web`，注意保留我们所有 OMP 特有的逻辑：`~/.omp/agent/` 路径适配、OMP 品牌、代码块主题选择器。冲突自己判断，拿不准的问我。',
      refs: [
        { kind: 'file', label: 'AGENTS.md', path: 'AGENTS.md' },
        { kind: 'dir', label: 'components/', path: 'components' },
      ],
    },
    {
      id: 'ev-t1-thinking',
      type: 'thinking',
      duration: '18s',
      tokens: 2_140,
      collapsed: true,
      text: `用户要做一次上游同步。先摸清两边的历史关系 —— 如果 omp-web 是从 pi-web fork 出来但没有共同祖先，直接 merge 会产生大量伪冲突。

  先看有没有配置 upstream remote。如果没有，需要加上并拉取 tags。然后确认 omp-web 的初始 commit 和 pi-web 的哪个 tag 对应，用 git replace --graft 建立 parent 链，这样后续 3-way merge 才有意义。

  OMP 特有的部分需要在 merge 前列清单，避免被上游覆盖：包名、CLI 名、配置路径、主题选择器、README 致谢。`,
    },
    {
      id: 'ev-t1-plan',
      type: 'plan',
      items: [
        { text: '配置 upstream remote 并拉取 Release Tags', done: true },
        { text: '用 git replace --graft 建立 parent 演进链', done: true },
        { text: '合并 v0.8.1 并逐个解决冲突', done: true },
        { text: '保留 OMP 特有定制（包名 / 路径 / 主题选择器）', done: true },
        { text: '类型检查与质量验证', done: true },
      ],
    },
    {
      id: 'ev-t1-tools-1',
      type: 'tool-group',
      tool: 'Bash',
      count: 4,
      status: 'completed',
      duration: '2.8s',
      summary: '探测 Git 历史关系',
      children: [
        { id: 'tg1-1', tool: 'Bash', target: 'git remote -v', status: 'completed', duration: '112ms',
          output: 'origin\thttps://github.com/17380936778/omp-web.git (fetch)\norigin\thttps://github.com/17380936778/omp-web.git (push)' },
        { id: 'tg1-2', tool: 'Bash', target: 'git log --oneline -1 $(git rev-list --max-parents=0 HEAD)', status: 'completed', duration: '89ms',
          output: 'a3f91c2 chore: initial commit (forked from pi-web)' },
        { id: 'tg1-3', tool: 'Bash', target: 'git remote add upstream https://github.com/agegr/pi-web.git', status: 'completed', duration: '48ms', output: '' },
        { id: 'tg1-4', tool: 'Bash', target: 'git fetch upstream --tags', status: 'completed', duration: '2.4s',
          output: 'From https://github.com/agegr/pi-web\n * [new tag]  v0.8.0 -> v0.8.0\n * [new tag]  v0.8.1 -> v0.8.1\n * [new branch] main -> upstream/main' },
      ],
    },
    {
      id: 'ev-t1-approval-graft',
      type: 'approval',
      resolved: 'allowed-once',
      approvalKind: 'bash',
      tool: 'Bash',
      command: 'git replace --graft a3f91c2 v0.8.0',
      risk: '改写 Git 对象图。不影响工作区文件，但会改变 log 的 parent 链。可用 git replace -d 撤销。',
      impact: ['Git 对象数据库', '不触碰工作区文件'],
      scope: 'workspace',
    },
    {
      id: 'ev-t1-tools-2',
      type: 'tool',
      tool: 'Bash',
      target: 'git merge v0.8.1',
      status: 'failed',
      duration: '640ms',
      affectsWorkspace: true,
      error: `Auto-merging package.json
  CONFLICT (content): Merge conflict in package.json
  Auto-merging components/Mermaid.tsx
  CONFLICT (content): Merge conflict in components/Mermaid.tsx
  Auto-merging lib/protocol.ts
  CONFLICT (content): Merge conflict in lib/protocol.ts
  Automatic merge failed; fix conflicts and then commit the result.`,
    },
    {
      id: 'ev-t1-assistant-1',
      type: 'assistant',
      text: `合并产生 3 个冲突，都在预期范围内。我逐个处理：

  - \`package.json\` — 保留 OMP 包名与 CLI 名，吸收上游的依赖升级
  - \`components/Mermaid.tsx\` — 上游重构了这个文件，我们的主题选择器逻辑要迁进去
  - \`lib/protocol.ts\` — 上游改了协议版本号，我们的 capability 字段需要保留`,
    },
    {
      id: 'ev-t1-tools-3',
      type: 'tool-group',
      tool: 'Read',
      count: 7,
      status: 'completed',
      duration: '1.2s',
      summary: '读取冲突文件与相关上下文',
      children: [
        { id: 'tg3-1', tool: 'Read', target: 'package.json', status: 'completed', duration: '18ms', output: '84 行' },
        { id: 'tg3-2', tool: 'Read', target: 'components/Mermaid.tsx', status: 'completed', duration: '22ms', output: '212 行' },
        { id: 'tg3-3', tool: 'Read', target: 'lib/protocol.ts', status: 'completed', duration: '14ms', output: '96 行' },
        { id: 'tg3-4', tool: 'Read', target: 'hooks/useCodeTheme.ts', status: 'completed', duration: '11ms', output: '48 行' },
        { id: 'tg3-5', tool: 'Read', target: 'AGENTS.md', status: 'completed', duration: '16ms', output: '124 行' },
        { id: 'tg3-6', tool: 'Read', target: 'lib/session.ts', status: 'completed', duration: '13ms', output: '156 行' },
        { id: 'tg3-7', tool: 'Read', target: 'README.md', status: 'completed', duration: '19ms', output: '203 行' },
      ],
    },
    {
      id: 'ev-t1-tools-4',
      type: 'tool-group',
      tool: 'Edit',
      count: 5,
      status: 'completed',
      duration: '3.4s',
      summary: '解决冲突并迁移主题选择器',
      affectsWorkspace: true,
      children: [
        { id: 'tg4-1', tool: 'Edit', target: 'package.json', status: 'completed', duration: '210ms', additions: 6, deletions: 4 },
        { id: 'tg4-2', tool: 'Write', target: 'components/MermaidBlock.tsx', status: 'completed', duration: '340ms', additions: 218, deletions: 0 },
        { id: 'tg4-3', tool: 'Bash', target: 'git rm components/Mermaid.tsx', status: 'completed', duration: '96ms' },
        { id: 'tg4-4', tool: 'Edit', target: 'lib/protocol.ts', status: 'completed', duration: '180ms', additions: 12, deletions: 3 },
        { id: 'tg4-5', tool: 'Edit', target: 'README.md', status: 'completed', duration: '124ms', additions: 8, deletions: 2 },
      ],
    },
    {
      id: 'ev-t1-checkpoint',
      type: 'checkpoint',
      label: 'Checkpoint · 冲突已解决',
      time: '14:06',
      filesChanged: 5,
      additions: 244,
      deletions: 9,
      tests: 'passed',
      build: 'passed',
      preview: 'refreshed',
      committed: false,
    },

    /* ================= TURN 2 ================= */
    {
      id: 'ev-t2-header',
      type: 'turn-header',
      turn: 2,
      time: '14:11',
      duration: '1m 52s',
      tokens: 64_200,
    },
    {
      id: 'ev-t2-user',
      type: 'user',
      time: '14:11',
      text: '类型检查跑一下，顺手把 `bun.lockb` 更新掉。',
    },
    {
      id: 'ev-t2-approval-install',
      type: 'approval',
      resolved: 'allowed-always',
      approvalKind: 'bash',
      tool: 'Bash',
      command: 'bun install',
      risk: '会写入 node_modules/ 与 bun.lockb，可能拉取网络依赖。',
      impact: ['node_modules/ (约 340 MB)', 'bun.lockb', '网络访问 registry.npmjs.org'],
      scope: 'workspace+network',
    },
    {
      id: 'ev-t2-tools-1',
      type: 'tool',
      tool: 'Bash',
      target: 'bun install',
      status: 'completed',
      duration: '8.2s',
      affectsWorkspace: true,
      output: `bun install v1.1.38
   + @earendil-works/pi-core@0.82.1
   + @earendil-works/pi-rpc@0.82.1
   + next@15.1.3
   ...
   142 packages installed [8.19s]`,
    },
    {
      id: 'ev-t2-tools-2',
      type: 'tool',
      tool: 'Bash',
      target: 'bun run typecheck',
      status: 'failed',
      duration: '4.1s',
      error: `components/bridge/RpcClient.ts:84:12 - error TS2339: Property 'capabilities' does not exist on type 'RpcHandshake'.

  84     if (hs.capabilities?.includes('preview')) {
                ~~~~~~~~~~~~

  hooks/useRpc.ts:31:7 - error TS2551: Property 'probeCapability' does not exist on type 'RpcClient'. Did you mean 'probeCapabilities'?

  Found 2 errors in 2 files.`,
    },
    {
      id: 'ev-t2-assistant-1',
      type: 'assistant',
      text: `上游把 \`RpcHandshake\` 的 \`capabilities\` 字段挪到了 \`RpcHandshake.meta.capabilities\`，同时 \`probeCapability\` 复数化了。两处都改。`,
    },
    {
      id: 'ev-t2-tools-3',
      type: 'tool-group',
      tool: 'Edit',
      count: 2,
      status: 'completed',
      duration: '420ms',
      summary: '修正类型错误',
      affectsWorkspace: true,
      children: [
        { id: 'tg5-1', tool: 'Edit', target: 'components/bridge/RpcClient.ts', status: 'completed', duration: '210ms', additions: 3, deletions: 3 },
        { id: 'tg5-2', tool: 'Edit', target: 'hooks/useRpc.ts', status: 'completed', duration: '190ms', additions: 1, deletions: 1 },
      ],
    },
    {
      id: 'ev-t2-tools-4',
      type: 'tool',
      tool: 'Bash',
      target: 'bun run typecheck',
      status: 'completed',
      duration: '3.8s',
      output: 'tsc --noEmit\n\n(no output — 0 errors)',
    },
    {
      id: 'ev-t2-checkpoint',
      type: 'checkpoint',
      label: 'Checkpoint · 类型检查通过',
      time: '14:13',
      filesChanged: 7,
      additions: 248,
      deletions: 13,
      tests: 'passed',
      build: 'passed',
      preview: 'refreshed',
      committed: false,
    },

    /* ================= TURN 3 (current, running) ================= */
    {
      id: 'ev-t3-header',
      type: 'turn-header',
      turn: 3,
      time: '14:32',
      duration: '2m 18s',
      tokens: 42_100,
      active: true,
    },
    {
      id: 'ev-t3-user',
      type: 'user',
      time: '14:32',
      text: '给 Capability 探测写个独立组件，把降级逻辑收进去。顺便跑一遍测试，如果 Preview 起得来也验一下页面没炸。',
      refs: [
        { kind: 'file', label: 'RpcClient.ts', path: 'components/bridge/RpcClient.ts' },
        { kind: 'diff', label: 'Diff · 7 个文件', path: null },
      ],
    },
    {
      id: 'ev-t3-thinking',
      type: 'thinking',
      duration: '12s',
      tokens: 1_420,
      collapsed: true,
      streaming: false,
      text: `要抽一个 CapabilityProbe 组件出来。当前的降级逻辑散在 RpcClient 和 useRpc 两处，先确认它们各自负责什么。

  RpcClient 负责握手时读 meta.capabilities；useRpc 负责在调用前检查某个能力可不可用。抽组件的话，应该让 CapabilityProbe 承担"能力清单 + 可用性判断"，RpcClient 只负责传输。

  测试和 Preview 验证放最后，先把组件写出来。`,
    },
    {
      id: 'ev-t3-tools-1',
      type: 'tool-group',
      tool: 'Read',
      count: 3,
      status: 'completed',
      duration: '680ms',
      summary: '确认现有降级逻辑分布',
      children: [
        { id: 'tg6-1', tool: 'Read', target: 'components/bridge/RpcClient.ts', status: 'completed', duration: '21ms', output: '184 行' },
        { id: 'tg6-2', tool: 'Read', target: 'hooks/useRpc.ts', status: 'completed', duration: '14ms', output: '62 行' },
        { id: 'tg6-3', tool: 'Grep', target: "'capabilit' in components/ lib/ hooks/", status: 'completed', duration: '340ms', output: '11 处匹配，分布在 4 个文件' },
      ],
    },
    {
      id: 'ev-t3-tool-write',
      type: 'tool',
      tool: 'Write',
      target: 'components/bridge/CapabilityProbe.tsx',
      status: 'running',
      duration: null,
      affectsWorkspace: true,
      declaredOnly: false,
      progress: 'writing',
      additions: 96,
      deletions: 0,
    },
    {
      id: 'ev-t3-subagents',
      type: 'subagent-group',
      count: 2,
      status: 'running',
      children: [
        { id: 'ag-test', name: 'test-runner', role: '运行测试并汇总失败', status: 'running-tool', currentTool: 'Bash · bun test', elapsed: '48s', tokens: 12_400, filesChanged: 0 },
        { id: 'ag-preview', name: 'preview-verifier', role: '启动 Preview 并验证页面', status: 'waiting-agent', currentTool: null, elapsed: '48s', tokens: 3_100, filesChanged: 0, waitingFor: 'test-runner' },
      ],
    },
  ];

  /* Minimap event kinds → color token + label.
     14 kinds, matching §8 of the spec. */
  const MINIMAP_KINDS = {
    user:       { color: 'var(--accent)',  label: '用户消息' },
    assistant:  { color: 'var(--text-tertiary)', label: 'Assistant 回复' },
    thinking:   { color: 'var(--muted)',   label: 'Thinking / Plan' },
    tool:       { color: 'var(--text-secondary)', label: '工具调用' },
    bash:       { color: 'var(--run)',     label: 'Bash' },
    file:       { color: 'var(--git-modified)', label: '文件修改' },
    approval:   { color: 'var(--warn)',    label: '审批请求' },
    error:      { color: 'var(--danger)',  label: '错误' },
    subagent:   { color: 'var(--accent)',  label: '子 Agent' },
    checkpoint: { color: 'var(--ok)',      label: 'Checkpoint' },
    compact:    { color: 'var(--muted)',   label: 'Compact' },
    preview:    { color: 'var(--run)',     label: 'Preview 更新' },
    test:       { color: 'var(--ok)',      label: '测试结果' },
    summary:    { color: 'var(--accent)',  label: '最终总结' },
  };

  /* Map a timeline event → minimap kind */
  function minimapKind(ev) {
    switch (ev.type) {
      case 'user': return 'user';
      case 'assistant': return 'assistant';
      case 'thinking':
      case 'plan': return 'thinking';
      case 'approval': return 'approval';
      case 'checkpoint': return 'checkpoint';
      case 'compact': return 'compact';
      case 'subagent-group': return 'subagent';
      case 'error': return 'error';
      case 'tool':
      case 'tool-group':
        if (ev.status === 'failed') return 'error';
        if (ev.tool === 'Bash') return 'bash';
        if (ev.tool === 'Write' || ev.tool === 'Edit') return 'file';
        if (ev.tool === 'Preview') return 'preview';
        return 'tool';
      default: return 'tool';
    }
  }

  /* A long session for the wb:minimap-long scenario — 180 events.
     Generated deterministically (no Math.random, which would make the
     minimap shuffle on every reload and defeat its purpose). */
  function buildLongTimeline() {
    const out = [];
    const tools = ['Read', 'Grep', 'Edit', 'Bash', 'Write', 'Search'];
    let evId = 0;

    for (let turn = 1; turn <= 14; turn++) {
      out.push({
        id: `lt-${evId++}`, type: 'turn-header', turn,
        time: `1${(turn % 10)}:${String((turn * 7) % 60).padStart(2, '0')}`,
        duration: `${1 + (turn % 4)}m ${(turn * 11) % 60}s`,
        tokens: 20_000 + turn * 3_400,
      });
      out.push({
        id: `lt-${evId++}`, type: 'user',
        time: `1${(turn % 10)}:${String((turn * 7) % 60).padStart(2, '0')}`,
        text: LONG_PROMPTS[turn % LONG_PROMPTS.length],
      });

      if (turn % 3 === 1) {
        out.push({ id: `lt-${evId++}`, type: 'thinking', duration: `${8 + turn}s`,
          tokens: 900 + turn * 60, collapsed: true, text: '(已折叠的推理内容)' });
      }

      const toolCount = 2 + (turn % 4);
      for (let i = 0; i < toolCount; i++) {
        const tool = tools[(turn + i) % tools.length];
        const failed = (turn * i) % 17 === 5;
        out.push({
          id: `lt-${evId++}`, type: 'tool', tool,
          target: LONG_TARGETS[(turn + i) % LONG_TARGETS.length],
          status: failed ? 'failed' : 'completed',
          duration: `${((turn + i) % 9) * 120 + 80}ms`,
          affectsWorkspace: tool === 'Edit' || tool === 'Write',
          error: failed ? 'ENOENT: no such file or directory' : null,
        });
      }

      if (turn % 4 === 2) {
        out.push({
          id: `lt-${evId++}`, type: 'approval', resolved: 'allowed-once',
          approvalKind: 'bash', tool: 'Bash',
          command: `bun test packages/core/${LONG_TARGETS[turn % LONG_TARGETS.length]}`,
          risk: '运行测试，可能写入快照文件。',
          impact: ['__snapshots__/'], scope: 'workspace',
        });
      }

      if (turn % 5 === 0) {
        out.push({
          id: `lt-${evId++}`, type: 'compact',
          turnsBefore: turn, tokensSaved: 180_000 + turn * 4_000,
        });
      }

      out.push({ id: `lt-${evId++}`, type: 'assistant', text: LONG_REPLIES[turn % LONG_REPLIES.length] });

      if (turn % 2 === 0) {
        out.push({
          id: `lt-${evId++}`, type: 'checkpoint',
          label: `Checkpoint · Turn ${turn}`,
          time: `1${(turn % 10)}:${String((turn * 7 + 20) % 60).padStart(2, '0')}`,
          filesChanged: 1 + (turn % 5), additions: turn * 18, deletions: turn * 4,
          tests: turn % 6 === 0 ? 'failed' : 'passed',
          build: 'passed', preview: 'refreshed', committed: turn % 8 === 0,
        });
      }
    }

    return out;
  }

  const LONG_PROMPTS = [
    '继续，把剩下的 transport 测试也补上。',
    '这个 case 在 Windows 上会挂，能复现吗？',
    '把错误信息改得更具体一点，现在只说 failed。',
    '加个超时保护，30 秒没响应就报错退出。',
    '重构一下，这个函数太长了。',
  ];

  const LONG_TARGETS = [
    'lib/transport.ts', 'lib/protocol.ts', 'components/bridge/RpcClient.ts',
    'hooks/useRpc.ts', 'test/transport.test.ts', 'lib/capability.ts',
    'app/api/rpc/route.ts', 'lib/session.ts',
  ];

  const LONG_REPLIES = [
    '改完了。`lib/transport.ts:84` 的超时从硬编码改成了从 options 读，默认 30s。',
    '能复现 —— Windows 下 `path.join` 产生的反斜杠没被 `normalize` 处理。已修。',
    '错误信息现在带上了 transport 类型、目标地址和底层 errno。',
    '拆成三个函数：`connect` / `handshake` / `probeCapabilities`，各自单测。',
    '测试补齐了，14 个 case 全过。覆盖率 transport.ts 从 62% 到 91%。',
  ];


  OMP.mod['data/timeline'] = { minimapKind, buildLongTimeline, TIMELINE, MINIMAP_KINDS };
})(window.OMP = window.OMP || { mod: {} });
