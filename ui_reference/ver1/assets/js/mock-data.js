/* ============================================================
   OMP Studio — Mock Data
   所有项目 / 对话 / 工具调用 / Diff / Agent / Preview / 诊断数据
   ============================================================ */
(function () {
  const D = {};

  /* ---------- 项目 ---------- */
  D.projects = [
    {
      id: 'p1', name: 'omp-web', path: 'C:\\Aspace\\Tools\\omp-web',
      branch: 'main', worktree: null, dirty: 3, running: true,
      attention: true, preview: 'running', pinned: true,
      threads: [
        { id: 't1', title: '跟踪上游 pi-web 更新到 omp-web', time: '32m ago', msgs: 45, status: 'running', pinned: true, hasSub: true, unread: 3 },
        { id: 't2', title: 'Audit and fix OSS repository issues', time: '2h ago', msgs: 12, status: 'idle', unread: 0 },
        { id: 't3', title: '选择 gemini3.6flash 随意发送消息后报错…', time: '4d ago', msgs: 1337, status: 'approval', hasSub: true, unread: 1 },
        { id: 't4', title: '修复 Git Bash 路径未找到问题', time: '4d ago', msgs: 8, status: 'idle' },
        { id: 't5', title: '重构 session 存储层 (session)', time: '6d ago', msgs: 156, status: 'archived' }
      ]
    },
    {
      id: 'p2', name: 'pi-web (upstream)', path: 'C:\\Aspace\\Tools\\pi-web',
      branch: 'v0.8.1', worktree: null, dirty: 0, running: false,
      attention: false, preview: 'stopped',
      threads: [
        { id: 't6', title: '对比 v0.8.0 → v0.8.1 变更清单', time: '1d ago', msgs: 22, status: 'idle' }
      ]
    },
    {
      id: 'p3', name: 'omp-web (feat/mermaid)', path: 'C:\\Aspace\\Tools\\omp-web\\.worktrees\\mermaid',
      branch: 'feat/mermaid-zoom', worktree: 'mermaid', dirty: 7, running: true,
      attention: false, preview: 'building',
      threads: [
        { id: 't7', title: 'Mermaid 渲染优化与全屏缩放拖拽', time: '18m ago', msgs: 63, status: 'running', hasSub: true, unread: 2 },
        { id: 't8', title: 'DirectoryPicker IDE 风格目录选择器', time: '3d ago', msgs: 41, status: 'idle' }
      ]
    }
  ];

  /* ---------- 文件树 ---------- */
  D.fileTree = [
    { type: 'dir', name: '.claude', children: [ { type: 'file', name: 'settings.local.json' } ] },
    { type: 'dir', name: '.code-review-graph', children: [] },
    { type: 'dir', name: '.github', children: [ { type: 'file', name: 'FUNDING.yml' }, { type: 'dir', name: 'workflows', children: [ { type: 'file', name: 'ci.yml' } ] } ] },
    { type: 'dir', name: 'app', open: true, children: [
      { type: 'file', name: 'App.tsx', status: 'M', turn: true },
      { type: 'file', name: 'main.tsx' },
      { type: 'dir', name: 'routes', children: [ { type: 'file', name: 'session.tsx', status: 'M', reading: true }, { type: 'file', name: 'home.tsx' } ] }
    ] },
    { type: 'dir', name: 'bin', children: [ { type: 'file', name: 'omp-web.js' } ] },
    { type: 'dir', name: 'components', open: true, children: [
      { type: 'file', name: 'DirectoryPicker.tsx', status: 'A', writing: true },
      { type: 'file', name: 'MermaidBlock.tsx', status: 'M', turn: true, diagnostic: 'error' },
      { type: 'file', name: 'ChatTimeline.tsx' },
      { type: 'file', name: 'CodeBlock.tsx', status: 'M' },
      { type: 'file', name: 'TelemetryBar.tsx', dirty: true }
    ] },
    { type: 'dir', name: 'docs', children: [ { type: 'file', name: 'UPSTREAM-SYNC.md', status: 'A' }, { type: 'file', name: 'README.md', status: 'M', turn: true } ] },
    { type: 'dir', name: 'hooks', children: [ { type: 'file', name: 'useCodeTheme.ts', status: 'M' }, { type: 'file', name: 'useSession.ts' } ] },
    { type: 'dir', name: 'lib', children: [ { type: 'file', name: 'rpc.ts', diagnostic: 'warn' }, { type: 'file', name: 'graft.ts' } ] },
    { type: 'file', name: '.gitignore' },
    { type: 'file', name: 'AGENTS.md' },
    { type: 'file', name: 'package.json', status: 'M', turn: true },
    { type: 'file', name: 'config.yml', status: '?' }
  ];

  /* ---------- 会话 Telemetry ---------- */
  D.telemetry = {
    model: 'gemini-3.6-flash (default)', thinking: 'high', permission: 'default',
    fastMode: false, serviceTier: 'default', compact: 'auto',
    inputTokens: '3.5M', outputTokens: '73k', cacheTokens: '36.6M',
    ctxUsed: '225k', ctxTotal: '1.0M', ctxPct: 22,
    turnTime: '1m 42s', sessionTime: '1h 18m', cost: '¥ 4.62',
    retries: 1, fallback: null, subagentCost: '¥ 0.87'
  };

  /* ---------- 长会话事件流（文本块 + 工具批次）
     类型：user / assistant / batch / approval(已决) /
     error / checkpoint / compact
     batch.items.kind：OMP 原生工具名（见 D.nativeToolGallery）+ think ---------- */
  D.events = [
    { id: 'e1', type: 'user', time: '14:02',
      html: '已成功完成从上游 <span class="chip-code">pi-web</span>（<span class="chip-code">v0.8.1</span>）到 <span class="chip-code">omp-web</span> 的同步更新，并确保 omp-web 的所有特有逻辑（<span class="chip-code">~/.omp/agent/</span> 路径适配、OMP 逻辑、代码主题选择器等）完整保留。帮我把这次同步的过程整理成文档，并验证类型检查通过。',
      refs: ['docs/UPSTREAM-SYNC.md', 'package.json'] },

    { id: 'e2', type: 'batch', items: [
      { kind: 'think', status: 'done', dur: '12s',
        preview: '用户想把上游同步过程整理成文档并跑类型检查，先看 docs/ 目录结构和 package.json scripts…',
        full: '用户想把上游同步过程整理成文档，并运行类型检查。\n先确认 docs/ 目录里有没有现成的同步记录，以及 README 的文档索引怎么写。\npackage.json 的 scripts 里 typecheck / lint / build 的命名要对上，避免写错命令。\n同步过程可以拆成三个阶段：graft 关联、合并冲突、质量验证。\nUPSTREAM-SYNC.md 应该放在 docs/ 下，而不是仓库根。\nREADME 只加一条索引链接，不要改其它章节。\n验证用 npm run typecheck，不要跑完整测试套件。\n如果 typecheck 失败，先看 Mermaid 主题字面量有没有被 widen。\n子代理可以并行：一个扫依赖版本，一个抽 Release Notes。\n文档写完后再改 README，避免索引指向还不存在的文件。\n冲突解决要保留 ~/.omp/agent/ 路径和包名 omp-web。\nDirectory Picker 和 Mermaid 全屏是上游 0.8.1 的功能，文档里点一下即可。\n最后用 grep 确认 UPSTREAM 只出现在文档索引里。\n如果还有安全扫描结果，放到验证一节，不要另开文件。\n以上做完再回复用户。' },
      { kind: 'task', name: 'Task', status: 'done', dur: '42s',
        spawn: {
          agent: 'scout',
          isolated: true,
          context: '# Goal\n并行调研上游 v0.8.1 变更，确认依赖与文档要点。不需要交付完整文档。\n\n# Constraints\n- 只读调研，不要编辑、新建或删除任何文件\n- 不要跑 build、test、lint、formatter 或其它重命令\n- 各自交一份要点摘要，不要写完整文档',
          tasks: [
            { name: 'deps', agent: 'scout', task: '审计 @earendil-works/pi-* 0.82.1 变更' },
            { name: 'docs', agent: 'scout', task: '提取 v0.8.1 Release Notes 要点' }
          ]
        },
        agents: [
          { name: 'deps', status: 'done', activity: 'done', dur: '38s',
            resolvedModel: 'gemini-3.6-flash', thinking: 'max',
            tokens: '12.6k', tools: 8, requests: 4, cost: '¥ 0.51', files: 6,
            lastTool: 'Grep · "pi-core" in lockfile' },
          { name: 'docs', status: 'done', activity: 'done', dur: '41s',
            resolvedModel: 'claude-sonnet-4.5', thinking: 'high',
            tokens: '9.8k', tools: 5, requests: 3, cost: '¥ 0.36', files: 2,
            lastTool: 'Web Search · v0.8.1 notes' }
        ] },
      { kind: 'read', name: 'Read', target: 'docs/README.md', status: 'done', dur: '0.2s',
        summary: '86 行 · 文档索引结构', lines: 86, encoding: 'UTF-8', size: '3.1 KB', offset: 1,
        preview: ['# omp-web', '', '## 文档', '', '- [更新日志](docs/CHANGELOG.md)', '- [架构说明](docs/ARCH.md)'] },
      { kind: 'read', name: 'Read', target: 'package.json', status: 'done', dur: '0.1s',
        summary: 'scripts: typecheck / lint / build', lines: 48, encoding: 'UTF-8', size: '1.4 KB', offset: 6,
        preview: ['  "scripts": {', '    "typecheck": "tsc --noEmit",', '    "lint": "eslint .",', '    "build": "vite build"', '  },'] },
      { kind: 'glob', name: 'Glob', target: 'docs/**/*.md', status: 'done', dur: '0.1s',
        pattern: 'docs/**/*.md', files: ['docs/README.md', 'docs/CHANGELOG.md', 'docs/ARCH.md'] },
      { kind: 'grep', name: 'Grep', target: '"UPSTREAM" in *.md', status: 'done', dur: '0.4s',
        pattern: 'UPSTREAM', paths: '*.md', count: '2 matches · 2 files',
        matches: [
          { file: 'docs/README.md', line: '12', text: '- [上游同步](docs/UPSTREAM-SYNC.md)' },
          { file: 'README.md', line: '48', text: '详见 docs/UPSTREAM-SYNC.md' }
        ] },
      { kind: 'read', name: 'Read', target: 'README.md', status: 'done', dur: '0.2s',
        summary: '132 行 · 项目说明', lines: 132, encoding: 'UTF-8', size: '6.8 KB', offset: 44,
        preview: ['## 文档', '', '- [更新日志](docs/CHANGELOG.md)', '- [架构说明](docs/ARCH.md)'] }
    ] },

    { id: 'e5', type: 'assistant', time: '14:04', model: 'gemini-3.6-flash', html:
      '<h3>一、本次同步完成的工作</h3>' +
      '<p><strong>1. 配置 Upstream 远程仓库与历史关联：</strong></p><ul>' +
      '<li>添加上游仓库地址 <span class="chip-code">https://github.com/agegr/pi-web.git</span> 并拉取最新的 Release Tags。</li>' +
      '<li>使用 <span class="chip-code">git replace --graft</span> 将 omp-web 初始提交与 pi-web 的 <span class="chip-code">v0.8.0</span> Commit 建立了清晰的 Parent 演进链，为后续标准 3-way 自动合并打下基础。</li></ul>' +
      '<p><strong>2. 合并 v0.8.1 并解决冲突：</strong></p><ul>' +
      '<li>保留 OMP 特有定制：包名（<span class="chip-code">omp-web</span>）及 CLI 命令名称。</li>' +
      '<li>配置文件与会话读取路径（<span class="chip-file">~/.omp/agent/sessions/</span>、<span class="chip-file">models.json</span>、<span class="chip-file">config.yml</span> 等）。</li>' +
      '<li>代码块主题选择器（<span class="chip-code">useCodeTheme</span> 钩子集成到 <span class="chip-file">MermaidBlock.tsx</span>）。</li></ul>' +
      '<p><strong>3. 吸纳上游 v0.8.1 更新与安全增强：</strong></p><ul>' +
      '<li>引入 IDE 风格 Directory Picker 目录选择器（<span class="chip-file">components/DirectoryPicker.tsx</span>）。</li>' +
      '<li>升级 <span class="chip-code">@earendil-works/pi-*</span> 衍生核心依赖至 <span class="chip-code">0.82.1</span>。</li>' +
      '<li>限制默认监听地址为 Loopback（<span class="chip-code">127.0.0.1</span>）及路径/请求安全校验增强。</li>' +
      '<li>Mermaid 渲染优化与全屏缩放拖拽功能。</li></ul>' },

    { id: 'e6', type: 'batch', items: [
      { kind: 'write', name: 'Write', target: 'docs/UPSTREAM-SYNC.md', status: 'done', dur: '1.8s',
        summary: '新建文档：graft 关联、合并策略与验证步骤',
        lines: 214, encoding: 'UTF-8', created: true,
        preview: ['# 上游同步记录（pi-web v0.8.1 → omp-web）', '', '## 一、准备阶段', '', '- 添加上游远程仓库并拉取 Release Tags', '- git replace --graft 建立 Parent 演进链', '', '## 二、合并与冲突解决'] },
      { kind: 'edit', name: 'Edit', target: 'README.md', status: 'done', dur: '0.6s',
        diff: [
          [' ', '46', '46', '- [更新日志](docs/CHANGELOG.md)'],
          ['+', '', '47', '- [上游同步](docs/UPSTREAM-SYNC.md)'],
          [' ', '47', '48', '- [架构说明](docs/ARCH.md)']
        ] }
    ] },

    { id: 'e8', type: 'approval', status: 'allowed', kind: 'Bash',
      cmd: 'npm run typecheck && npm run lint', time: '14:05' },

    { id: 'e9', type: 'batch', items: [
      { kind: 'bash', name: 'Bash', target: 'npm run typecheck', status: 'error', dur: '8.4s',
        cmd: 'npm run typecheck',
        output: [
          ['> omp-web@0.8.1 typecheck', 'dim'],
          ['> tsc --noEmit', 'dim'],
          ['', ''],
          ["components/MermaidBlock.tsx(147,11): error TS2322: Type 'string' is not assignable to type 'MermaidTheme'.", 'err']
        ], exit: 1 }
    ] },

    { id: 'e10', type: 'error', title: '类型检查发现 1 个错误',
      html: '<span class="chip-file">components/MermaidBlock.tsx:147</span> · <span class="chip-code">TS2322</span> 字面量类型被 widen 成 string。来自本次上游合并，不在你最初要求的范围内，我可以顺手修掉。' },

    { id: 'e11', type: 'batch', items: [
      { kind: 'ask', name: 'Ask', target: '是否一并修复这个类型错误？', status: 'done', dur: '12s',
        question: '是否一并修复这个类型错误？',
        options: [
          { label: '修复它', rec: true, selected: true },
          { label: '先不动，只记到文档' },
          { label: '让我自己改' }
        ],
        answer: '修复它' }
    ] },

    { id: 'e12', type: 'checkpoint', no: 12, time: '14:06',
      files: 3, add: 218, del: 4, build: '通过', desc: '文档整理完成' },

    { id: 'e13', type: 'user', time: '14:07',
      html: '修复它。另外把 Mermaid 缩放也顺手验证一下 Preview。',
      refs: ['components/MermaidBlock.tsx'] },

    { id: 'e13b', type: 'batch', items: [
      { kind: 'grep', name: 'Grep', target: '"theme?: string" in components/', status: 'done', dur: '0.3s', matches: [
        { file: 'components/MermaidBlock.tsx', line: '147', text: 'const codeTheme = getCodeTheme() as string;' },
        { file: 'components/CodeBlock.tsx', line: '22', text: 'theme?: string' }
      ] },
      { kind: 'web_search', name: 'Web Search', target: 'mermaid fullscreen pan inertia UX', status: 'done', dur: '2.2s',
        query: 'mermaid fullscreen pan inertia UX', provider: 'exa', sources: 2,
        answer: '主流图表库在大图平移时普遍提供释放惯性（inertia），可显著降低像素级定位的操作成本。',
        cites: [
          { title: 'd3-zoom inertia notes', url: 'github.com/d3' },
          { title: 'panzoom README', url: 'github.com/anvaka' }
        ] },
      { kind: 'mcp', name: 'github.get_release', target: 'MCP · github', status: 'done', dur: '0.8s',
        args: '{ "repo": "agegr/pi-web", "tag": "v0.8.1" }',
        output: '{ "name": "v0.8.1", "assets": 3, "published": "2026-08-02" }' },
      { kind: 'edit', name: 'Edit', target: 'components/MermaidBlock.tsx', status: 'done', dur: '0.9s',
        diff: [
          ['-', '147', '', '    const codeTheme = getCodeTheme() as string;'],
          ['+', '', '147', '    const codeTheme = getCodeTheme() as const;']
        ] },
      { kind: 'bash', name: 'Bash', target: 'npm run typecheck', status: 'done', dur: '11.2s',
        cmd: 'npm run typecheck',
        output: [['> tsc --noEmit', 'dim'], ['', ''], ['0 errors, 0 warnings', 'ok']], exit: 0 },
      { kind: 'browser', name: 'Browser', target: 'http://127.0.0.1:30141', status: 'done', dur: '2.1s',
        action: 'open', url: 'http://127.0.0.1:30141', tab: 'omp-web',
        output: 'opened · Mermaid 全屏缩放拖拽验证正常' }
    ] },

    { id: 'e15', type: 'assistant', time: '14:09', model: 'gemini-3.6-flash', html:
      '<h3>3. 类型检查与质量验证：</h3>' +
      '<p>已修复 <span class="chip-file">MermaidBlock.tsx:147</span> 的字面量类型问题（改为 <span class="chip-code">as const</span> 断言），<span class="chip-code">tsc --noEmit</span> 现在 0 错误通过。Preview 已在 <span class="chip-code">127.0.0.1:30141</span> 热更新，Mermaid 全屏缩放拖拽验证正常。</p>' +
      '<p>本轮共修改 <strong>4 个文件</strong>（+221 / -5），建议创建一个 Checkpoint。</p>' },

    { id: 'e16', type: 'compact', pct: 22, summary: 'Context 22%（225k / 1.0M）· 距自动 Compact 阈值 80% 较远' }
  ];

  /* ---------- Todo 列表（固定 dock 在输入框上方） ---------- */
  D.todos = {
    updatedAt: '14:08',
    items: [
      { id: 't1', text: '阅读 docs/ 现有文档与 package.json', status: 'done' },
      { id: 't2', text: '整理上游同步三阶段（graft / 合并 / 验证）', status: 'done' },
      { id: 't3', text: '新建 docs/UPSTREAM-SYNC.md 并更新 README 链接', status: 'done' },
      { id: 't4', text: '修复 MermaidBlock.tsx:147 字面量类型（TS2322）', status: 'done' },
      { id: 't5', text: '重新运行 typecheck 与 lint 确认通过', status: 'doing' },
      { id: 't6', text: '验证 Mermaid 全屏缩放拖拽（Preview）', status: 'doing' },
      { id: 't7', text: '创建 Checkpoint #13 并汇总本轮变更', status: 'todo' }
    ]
  };

  /* ---------- 待处理请求（审批 / 提问，固定 dock 在输入框上方） ---------- */
  D.inbox = [
    { id: 'ib1', type: 'approval', risk: 'high', kind: 'Bash',
      title: 'OMP 想要执行 Bash 命令',
      cmd: 'git add -A && git commit -m "docs: 上游同步记录与 Mermaid 类型修复"',
      reason: '该命令会把当前工作区全部改动（含未跟踪的 config.yml）写入一条 commit。',
      scope: '工作区内 · 写入 Git 历史',
      agent: '主 Agent', time: '14:09' },
    { id: 'ib2', type: 'ask',
      title: '缩放交互确认：拖拽平移是否需要惯性？',
      desc: 'preview 子 Agent 在验证 Mermaid 全屏缩放时发现释放后无惯性，大图像素级定位较累。',
      options: [
        { label: '需要惯性', rec: true },
        { label: '不需要' },
        { label: '做成设置项' }
      ],
      agent: 'preview 子 Agent', time: '14:08' }
  ];

  /* ---------- Minimap 节点（回合语义，参照 omp-web ChatMinimap）
     evId: 对应对话流事件 DOM；headings: assistant 标题大纲（可点击跳转） ---------- */
  D.minimap = [
    { type: 'user', evId: 'e1', at: 2,
      userPreview: '已成功完成从上游 pi-web（v0.8.1）到 omp-web 的同步更新…整理成文档，并验证类型检查通过。',
      headings: [] },
    { type: 'file', evId: 'e2', at: 10,
      userPreview: 'Task · 并行调研上游 v0.8.1 变更（2 个子 Agent 已完成）',
      headings: [] },
    { type: 'assistant', evId: 'e5', at: 19,
      userPreview: '一、本次同步完成的工作：配置上游远程仓库与 graft 历史关联、合并 v0.8.1 并解决冲突…',
      headings: ['一、本次同步完成的工作', '2. 合并 v0.8.1 并解决冲突', '3. 类型检查与质量验证'] },
    { type: 'file', evId: 'e6', at: 28,
      userPreview: '工具调用 · Write docs/UPSTREAM-SYNC.md（+214 行）',
      headings: [] },
    { type: 'approval', evId: 'e8', at: 37,
      userPreview: '✓ 审批（已允许）· OMP 想要执行 Bash：npm run typecheck && npm run lint',
      headings: [] },
    { type: 'bash', evId: 'e9', at: 44,
      userPreview: 'Bash · npm run typecheck — 类型检查进行中…',
      headings: [] },
    { type: 'error', evId: 'e10', at: 51,
      userPreview: '✗ 类型检查发现 1 个错误：MermaidBlock.tsx:147 · TS2322',
      headings: [] },
    { type: 'ask', evId: 'e11', at: 57,
      userPreview: '✓ Ask User（已回答）· 是否一并修复这个类型错误？',
      headings: [] },
    { type: 'checkpoint', evId: 'e12', at: 63,
      userPreview: 'Checkpoint #12 · 3 个文件 · +218/-4 · 构建通过',
      headings: [] },
    { type: 'user', evId: 'e13', at: 70,
      userPreview: '修复它。另外把 Mermaid 缩放也顺手验证一下 Preview。',
      headings: [] },
    { type: 'file', evId: 'e13b', at: 75,
      userPreview: 'Grep · "theme?: string" in components/（2 处匹配）',
      headings: [] },
    { type: 'assistant', evId: 'e15', at: 84,
      userPreview: '3. 类型检查与质量验证：已修复 MermaidBlock.tsx:147（as const 断言），tsc 0 错误通过…',
      headings: ['3. 类型检查与质量验证', '4. 建议创建 Checkpoint'] },
    { type: 'compact', evId: 'e16', at: 94,
      userPreview: 'Compact 状态 · Context 使用 22%（225k / 1.0M）',
      headings: [] }
  ];

  /* ---------- Changes（三类变化） ---------- */
  D.changes = {
    turn: [
      { file: 'components/MermaidBlock.tsx', status: 'M', add: 6, del: 3, agent: '主 Agent' },
      { file: 'docs/UPSTREAM-SYNC.md', status: 'A', add: 214, del: 0, agent: '主 Agent' }
    ],
    thread: [
      { file: 'README.md', status: 'M', add: 3, del: 1, agent: '主 Agent' },
      { file: 'package.json', status: 'M', add: 4, del: 4, agent: 'deps 子 Agent' },
      { file: 'app/App.tsx', status: 'M', add: 18, del: 9, agent: '主 Agent' },
      { file: 'hooks/useCodeTheme.ts', status: 'M', add: 11, del: 6, agent: '主 Agent' }
    ],
    preexisting: [
      { file: 'components/TelemetryBar.tsx', status: 'M', add: 42, del: 11, agent: null, note: 'Agent 开始前已存在' },
      { file: 'config.yml', status: '?', add: 0, del: 0, agent: null, note: '未跟踪' }
    ]
  };

  /* ---------- Diff 示例（MermaidBlock.tsx） ---------- */
  D.diff = {
    file: 'components/MermaidBlock.tsx', add: 6, del: 3,
    hunks: [
      { head: '@@ -142,7 +142,7 @@', lines: [
        [' ', '142', '142', '  const renderMermaid = useCallback(async (theme: MermaidTheme) => {'],
        [' ', '143', '143', '    const mermaid = await import("mermaid");'],
        ['-', '144', '', '    const codeTheme = getCodeTheme() as string;'],
        ['+', '', '144', '    const codeTheme = getCodeTheme() as const;'],
        [' ', '145', '145', '    mermaid.initialize({'],
        ['-', '146', '', '      theme: codeTheme,'],
        ['+', '', '146', '      theme: codeTheme satisfies MermaidTheme,'],
        [' ', '147', '147', '      securityLevel: "strict",'],
        ['+', '', '148', '      themeVariables: buildThemeVars(codeTheme),'],
        [' ', '148', '149', '    });'],
        [' ', '149', '150', '  }, []);'],
        ['collapse', '52 行未变化', '', ''],
        [' ', '201', '203', '  const onWheel = usePinchZoom(containerRef);'],
        ['-', '202', '', '  // legacy drag handler'],
        ['+', '', '204', '  const onDrag = usePanDrag(containerRef, { clamp: true });'],
        [' ', '203', '205', '  return <div ref={containerRef} className="mermaid-wrap" />;']
      ] }
    ]
  };

  /* ---------- Agent Hub ---------- */
  D.agents = [
    { id: 'a1', hubId: 'agent-019fac94', name: '主 Agent', role: 'Coordinator', parent: null, task: '整理上游同步文档并验证类型检查',
      status: 'running', statusText: 'Running Tool · Bash', lastTool: 'Bash · npm run typecheck',
      resolvedModel: 'gemini-3.6-flash', thinking: 'max',
      time: '6m 12s', tokens: '48.2k', tools: 24, requests: 11, cost: '¥ 1.94', files: 4, waiting: false, error: false },
    { id: 'a2', hubId: 'agent-019fcb01', name: 'deps 子 Agent', role: 'Dependency Auditor', parent: '主 Agent', task: '审计 @earendil-works/pi-* 0.82.1 变更',
      status: 'running', statusText: 'Thinking', lastTool: 'Grep · "pi-core" in lockfile',
      resolvedModel: 'gemini-3.6-flash', thinking: 'max',
      time: '2m 47s', tokens: '12.6k', tools: 8, requests: 4, cost: '¥ 0.51', files: 1, waiting: false, error: false },
    { id: 'a3', hubId: 'agent-019fcb17', name: 'preview 子 Agent', role: 'Preview Verifier', parent: '主 Agent', task: '验证 Mermaid 全屏缩放拖拽',
      status: 'waiting', statusText: 'Waiting for User', lastTool: 'AskUser · 缩放交互确认',
      resolvedModel: 'gemini-3.6-flash', thinking: 'high',
      time: '1m 03s', tokens: '5.1k', tools: 6, requests: 4, cost: '¥ 0.22', files: 0, waiting: true, error: false },
    { id: 'a4', hubId: 'agent-019fcb55', name: 'lint 子 Agent', role: 'Lint Runner', parent: '主 Agent', task: 'ESLint 全量扫描',
      status: 'failed', statusText: 'Failed', lastTool: 'Bash · eslint . (exit 2)',
      resolvedModel: 'gpt-5-mini', thinking: 'low',
      time: '38s', tokens: '3.3k', tools: 2, requests: 2, cost: '¥ 0.14', files: 0, waiting: false, error: true }
  ];

  /* ---------- Preview ---------- */
  D.preview = {
    url: '127.0.0.1:30141', path: '/?session=019fac94-5e18-7000',
    status: 'ok', // ok | hmr | error
    viewport: 'desktop',
    logs: [
      '[vite] connected.',
      '[vite] hmr update /components/MermaidBlock.tsx',
      '[vite] page reload src/App.tsx',
      '[omp] preview attached, session=019fac94'
    ],
    error: {
      summary: 'Failed to resolve import "@earendil-works/pi-mermaid"',
      file: 'components/MermaidBlock.tsx', line: 12,
      stack: 'Failed to resolve import "@earendil-works/pi-mermaid" from "components/MermaidBlock.tsx". Does the file exist?\n  at TransformPluginContext.error (vite/dist/node/chunks/dep.js:18233)\n  at normalizeUrl (vite/dist/node/chunks/dep.js:64120)'
    }
  };

  /* ---------- Problems ---------- */
  D.problems = [
    { sev: 'error', src: 'TypeScript', msg: "TS2322: Type 'string' is not assignable to type 'MermaidTheme'", file: 'components/MermaidBlock.tsx', line: 147 },
    { sev: 'error', src: 'Preview', msg: 'Failed to resolve import "@earendil-works/pi-mermaid"', file: 'components/MermaidBlock.tsx', line: 12 },
    { sev: 'warn', src: 'ESLint', msg: "'onDrag' is defined but never used", file: 'components/MermaidBlock.tsx', line: 204 },
    { sev: 'warn', src: 'ESLint', msg: 'React Hook useCallback has a missing dependency', file: 'hooks/useCodeTheme.ts', line: 31 },
    { sev: 'info', src: 'OMP 诊断', msg: 'RPC capability "preview.dom" 协商成功 (v2)', file: null, line: null },
    { sev: 'warn', src: 'Git', msg: 'config.yml 未被跟踪，可能被意外提交', file: 'config.yml', line: null }
  ];

  /* ---------- Tests ---------- */
  D.tests = [
    { suite: 'lib/graft.test.ts', total: 12, pass: 12, fail: 0, time: '0.42s', status: 'pass' },
    { suite: 'lib/rpc.test.ts', total: 27, pass: 26, fail: 1, time: '1.18s', status: 'fail',
      failDetail: 'rpc › should negotiate capability v2\n  Expected: "preview.dom"\n  Received: undefined' },
    { suite: 'components/DirectoryPicker.test.tsx', total: 8, pass: 8, fail: 0, time: '0.67s', status: 'pass' }
  ];

  /* ---------- Terminal（多终端列表） ---------- */
  D.terminals = [
    { id: 'tm1', name: 'bun run dev', pid: 15840, src: 'OMP', status: 'running', active: true,
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      lines: [
        ['$ bun run dev', 'cmd'],
        ['', ''],
        ['  VITE v5.4.11  ready in 1.8s', 'ok'],
        ['  ➜  Local:   http://127.0.0.1:30141/', 'ok'],
        ['  ➜  Network: http://192.168.1.24:30141/', ''],
        ['✓ Compiled / in 2.1s (1284 modules)', 'ok'],
        ['o HMR update /components/MermaidBlock.tsx', 'warn'],
        ['✓ Compiled in 184ms (1285 modules)', 'ok'],
        ['o HMR update /docs/UPSTREAM-SYNC.md', 'warn'],
        ['✓ Compiled in 96ms (1285 modules)', 'ok']
      ] },
    { id: 'tm2', name: 'bun test --coverage', pid: 16022, src: 'OMP', status: 'running',
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      lines: [
        ['$ bun test --coverage', 'cmd'],
        ['bun test v1.1.29 (9a296260)', ''],
        ['', ''],
        ['✓ lib/graft.test.ts · 12 pass (42ms)', 'ok'],
        ['✗ lib/rpc.test.ts · 26 pass, 1 fail (118ms)', 'err'],
        ['✓ components/DirectoryPicker.test.tsx · 8 pass (67ms)', 'ok'],
        ['', ''],
        ['----------------|---------|', ''],
        ['All files      |   84.2% |', ''],
        ['----------------|---------|', ''],
        ['Ran 47 tests · 46 pass · 1 fail', 'err']
      ] },
    { id: 'tm3', name: 'pwsh', pid: null, src: 'YOU', status: 'ended',
      cwd: 'C:\\Aspace\\Tools\\omp-web',
      lines: [
        ['PS C:\\Aspace\\Tools\\omp-web> git status', 'cmd'],
        ['On branch main', ''],
        ['Changes not staged for commit:', 'warn'],
        ['  modified:   components/TelemetryBar.tsx', 'warn'],
        ['Untracked files:', ''],
        ['  config.yml', ''],
        ['PS C:\\Aspace\\Tools\\omp-web> exit', 'cmd'],
        ['（进程已结束，退出码 0）', '']
      ] }
  ];

  /* ---------- 能力中心 ---------- */
  D.skills = [
    { name: 'upstream-sync', desc: '跟踪上游仓库同步的标准流程（graft、合并、验证）', src: '项目', scope: 'workspace', path: '.omp/skills/upstream-sync/SKILL.md', enabled: true, loaded: true, session: true },
    { name: 'code-review-graph', desc: '生成代码审查依赖图', src: '用户', scope: 'global', path: '~/.omp/skills/code-review-graph/SKILL.md', enabled: true, loaded: true, session: true },
    { name: 'mermaid-verify', desc: 'Mermaid 图表渲染回归验证', src: '项目', scope: 'workspace', path: '.omp/skills/mermaid-verify/SKILL.md', enabled: true, loaded: true, session: false },
    { name: 'commit-msg', desc: '生成符合 Conventional Commits 的提交信息', src: '用户', scope: 'global', path: '~/.omp/skills/commit-msg/SKILL.md', enabled: false, loaded: false, session: false },
    { name: 'oss-audit', desc: '开源仓库发布前合规检查', src: '内置', scope: 'builtin', path: 'omp:builtin/oss-audit', enabled: true, loaded: true, session: true, error: 'SKILL.md 第 42 行 frontmatter 缺 summary' }
  ];
  D.plugins = [
    { name: 'omp-preview-tools', src: '内置', status: 'loaded', tools: 4, commands: 1, hooks: 2, ui: true, err: null,
      toolItems: ['preview_snapshot', 'preview_diff', 'preview_open', 'preview_dom'],
      commandItems: ['/preview'],
      hookItems: ['PreToolUse:Preview', 'PostToolUse:Preview'],
      uiItems: ['Preview 侧栏扩展'] },
    { name: 'git-worktree-plus', src: 'npm · omp-plugin-worktree', status: 'loaded', tools: 3, commands: 2, hooks: 1, ui: true, err: null,
      toolItems: ['git_blame_range', 'git_file_history', 'git_stash_diff'],
      commandItems: ['/blame', '/file-history'],
      hookItems: ['PreToolUse:Bash'],
      uiItems: ['Diff 侧栏扩展'] },
    { name: 'browser-lab', src: '本地目录 · ~/omp-plugins/browser-lab', status: 'error', tools: 0, commands: 0, hooks: 0, ui: false, err: '加载失败：manifest.json 缺少 "omp" 字段' }
  ];
  D.mcp = [
    { name: 'filesystem', transport: 'stdio', status: 'connected', tools: 12, resources: 0, prompts: 0, last: '2m ago' },
    { name: 'github', transport: 'http · :38412', status: 'connected', tools: 26, resources: 4, prompts: 2, last: '38s ago' },
    { name: 'playwright', transport: 'stdio', status: 'reconnecting', tools: 18, resources: 0, prompts: 0, last: '失败 3 次' },
    { name: 'sqlite-sessions', transport: 'stdio', status: 'disabled', tools: 7, resources: 2, prompts: 0, last: '—' }
  ];
  D.slashCommands = [
    { name: '/compact', desc: '立即压缩当前会话上下文', src: '内置', args: '[focus?]', ok: true },
    { name: '/review', desc: '对当前 Changes 发起代码审查', src: '内置', args: '[path?]', ok: true },
    { name: '/test', desc: '运行测试并汇总失败详情', src: '内置', args: '[suite?]', ok: true },
    { name: '/upstream-sync', desc: '执行上游同步流程', src: 'Skill', args: '<tag>', ok: true },
    { name: '/graph', desc: '生成代码审查依赖图', src: 'Skill', args: '[entry?]', ok: true },
    { name: '/worktree-new', desc: '在新 Worktree 中开始对话', src: 'Plugin', args: '<branch>', ok: true },
    { name: '/handoff', desc: '将会话交接给新 Thread', src: '内置', args: '', ok: true },
    { name: '/doctor', desc: '打开诊断中心', src: '内置', args: '', ok: true }
  ];
  D.hostTools = [
    { name: 'preview.open', desc: '打开 / 刷新 Preview 页面', registered: true, calls: 142 },
    { name: 'preview.screenshot', desc: 'Preview 页面截图', registered: true, calls: 56 },
    { name: 'preview.dom', desc: '读取 Preview DOM 摘要', registered: true, calls: 23 },
    { name: 'editor.openExternal', desc: '在外部编辑器打开文件', registered: true, calls: 31 },
    { name: 'system.reveal', desc: '在系统文件管理器中显示', registered: true, calls: 18 },
    { name: 'browser.controlled', desc: '受控浏览器页面操作', registered: false, calls: 0 }
  ];

  /* ---------- 诊断中心 ---------- */
  D.diagnostics = {
    ompPath: 'C:\\Users\\snowpear\\AppData\\Local\\Programs\\omp\\omp.exe',
    version: 'v0.82.1', rpc: 'omp-rpc/2.1', bridge: 'connected · pid 21480',
    processes: [
      { name: 'omp bridge', pid: 21480, role: 'Bridge', mem: '84 MB' },
      { name: 'omp agent (t1)', pid: 22104, role: '会话进程', mem: '312 MB' },
      { name: 'omp agent (t7)', pid: 22331, role: '会话进程', mem: '287 MB' },
      { name: 'vite dev (30141)', pid: 21996, role: 'Preview 进程', mem: '406 MB' },
      { name: 'chokidar watcher', pid: '—', role: '文件 Watcher', mem: '—' }
    ],
    cwd: 'C:\\Aspace\\Tools\\omp-web',
    configDir: 'C:\\Users\\snowpear\\.omp',
    capabilities: ['agent.run', 'agent.steer', 'fs.read', 'fs.write', 'bash.exec', 'preview.open', 'preview.dom', 'mcp.proxy', 'checkpoint.create', 'checkpoint.restore'],
    errors: [
      { time: '13:58:12', src: 'MCP · playwright', msg: 'transport closed unexpectedly (code 1006)' },
      { time: '13:41:03', src: 'RPC', msg: 'capability "browser.controlled" 未在握手时声明' },
      { time: '12:02:47', src: 'Plugin · browser-lab', msg: '加载失败：manifest.json 缺少 "omp" 字段' }
    ]
  };

  /* ---------- 会话历史 ---------- */
  D.history = [
    { title: '跟踪上游 pi-web 更新到 omp-web', project: 'omp-web', branch: 'main', time: '32m ago', model: 'gemini-3.6-flash', status: 'running', files: 4, cost: '¥ 4.62', forkedFrom: null, checkpoints: 12, pinned: true },
    { title: 'Mermaid 渲染优化与全屏缩放拖拽', project: 'omp-web (feat/mermaid)', branch: 'feat/mermaid-zoom', time: '18m ago', model: 'gemini-3.6-flash', status: 'running', files: 7, cost: '¥ 2.31', forkedFrom: '跟踪上游 pi-web 更新…', checkpoints: 5, pinned: false },
    { title: 'Audit and fix OSS repository issues', project: 'omp-web', branch: 'main', time: '2h ago', model: 'claude-sonnet-4.5', status: 'completed', files: 9, cost: '¥ 8.14', forkedFrom: null, checkpoints: 3, pinned: false },
    { title: '选择 gemini3.6flash 随意发送消息后报错…', project: 'omp-web', branch: 'main', time: '4d ago', model: 'gemini-3.6-flash', status: 'failed', files: 0, cost: '¥ 0.42', forkedFrom: null, checkpoints: 0, pinned: false },
    { title: '修复 Git Bash 路径未找到问题', project: 'omp-web', branch: 'main', time: '4d ago', model: 'gpt-5.2-codex', status: 'completed', files: 2, cost: '¥ 1.08', forkedFrom: null, checkpoints: 2, pinned: false },
    { title: '重构 session 存储层 (session)', project: 'omp-web', branch: 'refactor/session-db', time: '6d ago', model: 'claude-sonnet-4.5', status: 'archived', files: 21, cost: '¥ 22.90', forkedFrom: null, checkpoints: 9, pinned: false }
  ];

  /* ---------- 项目主页活动 ---------- */
  D.activity = [
    { icon: 'bot', color: 'blue', text: 'omp-web · 主 Agent 正在执行 npm run typecheck', time: '刚刚' },
    { icon: 'diff', color: 'purple', text: 'omp-web · docs/UPSTREAM-SYNC.md 已写入（+214）', time: '4m ago' },
    { icon: 'globe', color: 'green', text: 'omp-web · Preview 热更新完成（127.0.0.1:30141）', time: '6m ago' },
    { icon: 'alert', color: 'amber', text: 'omp-web (feat/mermaid) · preview 子 Agent 等待用户确认', time: '12m ago' },
    { icon: 'check', color: 'green', text: 'pi-web · 「对比 v0.8.0 → v0.8.1 变更清单」已完成', time: '1d ago' }
  ];

  /* ---------- Token 使用（项目主页统计卡） ----------
     逐日序列（580 天前后），确保日历从 1 月 1 日到今天始终有数据。
     项目开工日 = 590 天前（≈ 2025-01-19），近 580 天开始稳定活跃。
     活跃度曲线：前 30 天缓慢入场，之后 200 天增长到 1.0 base，剩余天数保
     持在工作日 24k / 周末 9k 区间。两条曲线：常用模型（total = claude +
     codex），CC/CLI 占比 55:45 / 波动 ±10%。 */
  D.tokenUsage = (function () {
    const DAY = 86400000;
    const seedBy = (i, salt) => {
      const v = Math.sin((i + 1) * 37.719 + salt * 97.31) * 46638.9426;
      return v - Math.floor(v);
    };
    const days = [];
    const TOTAL = 600;     // 向前 600 天，先于 1 月 1 日还有富余
    for (let i = TOTAL - 1; i >= 0; i--) {
      const ts = Date.now() - i * DAY;
      const dow = new Date(ts).getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isFriday = dow === 5;
      /* 活跃度曲线：age = i 距今天数。0 = 今天，TOTAL-1 = 最远。
         i >= 590: 项目未启用（calendar 之前）；i 590→560: 入场期；
         i 560→270: 稳定增长到 1.0；i < 270: 1.0~1.05（轻微季节波动）。 */
      let trend;
      if (i >= 590) trend = 0;
      else if (i >= 560) trend = (590 - i) / 30 * 0.45;       // 入场 0 → 0.45
      else if (i >= 270) trend = 0.45 + (560 - i) / 290 * 0.55;  // 0.45 → 1.0
      else trend = 1.0 + Math.sin((TOTAL - 1 - i) / 30) * 0.05;   // 稳定 ±5%
      if (trend === 0) {
        days.push({ date: ts, claude: 0, codex: 0, total: 0 });
        continue;
      }
      const base = isWeekend ? 9000 : isFriday ? 30000 : 26000;
      const noise = 0.78 + seedBy(i, 1) * 0.44;               // ±22% 波动
      const total = Math.round(base * trend * noise);
      const isZero = seedBy(i, 7) > 0.985;
      if (isZero) {
        days.push({ date: ts, claude: 0, codex: 0, total: 0 });
        continue;
      }
      const claude = Math.round(total * (0.55 + seedBy(i, 2) * 0.10));
      const codex = total - claude;
      days.push({ date: ts, claude, codex, total });
    }
    return days;
  })();

  /* ---------- Agent Hub（对齐 OMP docs/agent-hub.md 与 agent-registry 数据模型） ----------
     状态枚举：running | idle | parked | aborted（OMP AgentStatus；UI 派生 waiting=idle+progress.waiting）。
     kind：main | sub | advisor。advisor 是观察记录：只读，不可 message / revive / kill。
     时间戳为相对页面加载时刻的毫秒偏移，让 age（formatAge）每次打开页面都是"活的"。 */
  /* ---------- Agent Hub（对齐 OMP docs/agent-hub.md 与 agent-registry 数据模型） ----------
     状态枚举：running | idle | parked | aborted（OMP AgentStatus；UI 派生 waiting=idle+progress.waiting）。
     kind：main | sub | advisor。advisor 是观察记录：只读，不可 message / revive / kill。
     时间戳为相对页面加载时刻的毫秒偏移，让 age（formatAge）每次打开页面都是"活的"。 */
  const NOW = Date.now();
  const AGO = (s) => NOW - s * 1000;
  D.hub = {
    runtime: { label: 'Full Parity Runtime', pid: 18402, missingCaps: [] },
    conn: { state: 'online' },
    main: {
      id: 'main', name: '主对话', model: 'gemini-3.6-flash', statusText: 'Running Tool · Bash',
      task: '整理上游同步文档并验证类型检查', durationMs: 372000, contextPct: 42, unread: 0
    },
    agents: [
      { id: 'agent-019fcb01', name: 'deps 子 Agent', kind: 'sub', parentId: 'main',
        status: 'running', activity: 'thinking',
        task: '审计 @earendil-works/pi-* 0.82.1 变更，确认 mermaid 类型签名',
        currentTool: { name: 'Grep', args: '"pi-core" in package-lock.json', sinceMs: 3200 },
        lastIntent: '先扫 lockfile 定位间接依赖，再对 pi-mermaid 做类型 diff',
        retryState: null,
        modelRole: '@smol', resolvedModel: 'gemini-3.6-flash', fallback: null,
        metrics: { cost: 0.51, durationMs: 167000, durationKind: 'active', requests: 9, tools: 14, tokens: 12600, contextTokens: 31200, contextWindow: 128000 },
        readOnly: false, outputPath: null, patchPath: null, branchName: null,
        children: ['agent-019fcb20'], ircUnread: 2, sessionFile: 'agent-019fcb01.jsonl',
        createdAt: AGO(812), lastActivity: AGO(3), hasTranscript: true },

      { id: 'agent-019fcb17', name: 'preview 子 Agent', kind: 'sub', parentId: 'main',
        status: 'idle', activity: 'waiting', waitingPrompt: '缩放交互确认：拖拽平移是否需要惯性？',
        task: '验证 Mermaid 全屏缩放拖拽在 125% DPI 下的表现',
        currentTool: null, lastIntent: 'AskUserQuestion 挂起，等待用户选择交互方案', retryState: null,
        modelRole: '@vision', resolvedModel: 'gemini-3.6-flash', fallback: null,
        metrics: { cost: 0.22, durationMs: 63000, durationKind: 'active', requests: 4, tools: 6, tokens: 5100, contextTokens: 9800, contextWindow: 128000 },
        readOnly: false, outputPath: null, patchPath: null, branchName: null,
        children: [], ircUnread: 0, sessionFile: 'agent-019fcb17.jsonl',
        createdAt: AGO(663), lastActivity: AGO(63), hasTranscript: true },

      { id: 'agent-019fcb55', name: 'lint 子 Agent', kind: 'sub', parentId: 'main',
        status: 'idle', activity: 'failed',
        task: 'ESLint 全量扫描（merge 后回归）',
        currentTool: { name: 'Bash', args: 'eslint . (exit 2)', sinceMs: null },
        lastIntent: '两次扫描均因 .eslintrc 合并冲突失败，已停止重试',
        retryState: { attempt: 2, maxAttempts: 2, errorMessage: 'ESLint exited with code 2' },
        modelRole: '@worker', resolvedModel: 'gpt-5-mini', fallback: null,
        metrics: { cost: 0.14, durationMs: 38000, durationKind: 'active', requests: 2, tools: 2, tokens: 3300, contextTokens: 6100, contextWindow: 128000 },
        readOnly: false, outputPath: 'agent-019fcb55.md', patchPath: null, branchName: null,
        children: [], ircUnread: 0, sessionFile: 'agent-019fcb55.jsonl',
        createdAt: AGO(438), lastActivity: AGO(400), hasTranscript: true },

      { id: 'agent-019fcb20', name: 'typecheck 子 Agent', kind: 'sub', parentId: 'agent-019fcb01',
        status: 'running', activity: 'tool',
        task: 'bunx tsc --noEmit 全量类型检查并归类错误',
        currentTool: { name: 'Bash', args: 'bunx tsc --noEmit (running 24s)', sinceMs: 24000 },
        lastIntent: null, retryState: null,
        modelRole: '@worker', resolvedModel: 'gpt-5.2-codex', fallback: null,
        metrics: { cost: 0.87, durationMs: 234000, durationKind: 'active', requests: 6, tools: 9, tokens: 21400, contextTokens: 44800, contextWindow: 200000 },
        readOnly: false, outputPath: null, patchPath: 'agent-019fcb20.patch', branchName: 'agent/typecheck-019fcb20',
        children: [], ircUnread: 0, sessionFile: 'agent-019fcb20.jsonl',
        createdAt: AGO(294), lastActivity: AGO(8), hasTranscript: true },

      { id: 'agent-019fc9d2', name: 'docs 子 Agent', kind: 'sub', parentId: 'main',
        status: 'parked', activity: 'parked',
        task: '整理 UPSTREAM-SYNC.md 三阶段章节草稿',
        currentTool: null, lastIntent: '草稿 v2 已交付，空闲 TTL 到期自动 park', retryState: null,
        modelRole: '@writer', resolvedModel: 'claude-sonnet-4.5', fallback: 'anthropic/claude-sonnet-4.5',
        metrics: { cost: 0.96, durationMs: 145000, durationKind: 'active', requests: 7, tools: 11, tokens: 18200, contextTokens: 52100, contextWindow: 200000 },
        readOnly: false, outputPath: 'agent-019fc9d2.md', patchPath: null, branchName: null,
        children: [], ircUnread: 0, sessionFile: 'agent-019fc9d2.jsonl',
        createdAt: AGO(1445), lastActivity: AGO(692), hasTranscript: true },

      { id: 'agent-019fc8a0', name: 'audit 子 Agent', kind: 'sub', parentId: 'main',
        status: 'parked', activity: 'parked',
        task: 'OSS 仓库发布前合规检查（license / NOTICE / 依赖审计）',
        currentTool: null, lastIntent: '报告已生成，等待下一次手动 revive', retryState: null,
        modelRole: '@audit', resolvedModel: 'gpt-5.2-codex', fallback: null,
        metrics: { cost: 1.23, durationMs: 412000, durationKind: 'active', requests: 15, tools: 21, tokens: 40300, contextTokens: 88200, contextWindow: 200000 },
        readOnly: false, outputPath: 'agent-019fc8a0.md', patchPath: 'agent-019fc8a0.patch', branchName: null,
        children: [], ircUnread: 0, sessionFile: 'agent-019fc8a0.jsonl',
        createdAt: AGO(5200), lastActivity: AGO(3612), hasTranscript: true },

      { id: 'agent-019fc77e', name: 'spike 子 Agent', kind: 'sub', parentId: 'main',
        status: 'aborted', activity: 'aborted',
        task: '试验 ws 通道替代 stdio 的可行性（spike）',
        currentTool: null, lastIntent: '方案被否决后由用户 kill（tombstone 已写入）', retryState: null,
        modelRole: '@spike', resolvedModel: 'gpt-5-mini', fallback: null,
        metrics: { cost: 0.09, durationMs: 41000, durationKind: 'active', requests: 3, tools: 4, tokens: 2900, contextTokens: null, contextWindow: null },
        readOnly: false, outputPath: null, patchPath: null, branchName: null,
        children: [], ircUnread: 0, sessionFile: 'agent-019fc77e.jsonl',
        createdAt: AGO(7400), lastActivity: AGO(6200), hasTranscript: true },

      { id: 'advisor-019fab10', name: 'advisor', kind: 'advisor', parentId: 'main',
        status: 'idle', activity: 'review',
        task: '架构顾问：评审 session 存储层重构方案的风险点',
        currentTool: null, lastIntent: 'advisor 是只读观察记录，不参与 agent 间消息', retryState: null,
        modelRole: '@advisor', resolvedModel: 'claude-opus-4.8', fallback: null,
        metrics: { cost: 0.44, durationMs: 95000, durationKind: 'active', requests: 2, tools: 0, tokens: 9600, contextTokens: 21400, contextWindow: 200000 },
        readOnly: true, outputPath: 'advisor-019fab10.md', patchPath: null, branchName: null,
        children: [], ircUnread: 0, sessionFile: 'advisor-019fab10.jsonl',
        createdAt: AGO(2400), lastActivity: AGO(1200), hasTranscript: true }
    ],
    /* 聚合行：page 端按 agent.metrics 现算（下方 8 条之和：cost 4.46 / dur 1113000 / req 48 /
       tools 67 / tok 116.4k / 8 timed / 8 measured）。此快照供 OMP.agentHub.summary 对齐校验。 */
    usage: { cost: 4.46, durationMs: 1113000, requests: 48, tools: 67, tokens: 116400, timedAgents: 8, measuredAgents: 8 },
    jobs: [
      { id: 'job-91', type: 'bash', status: 'running', label: 'bunx tsc --noEmit', durationMs: 24000, ownerId: 'agent-019fcb20', resultText: null, errorText: null },
      { id: 'job-87', type: 'task', status: 'failed', label: 'eslint . 全量扫描', durationMs: 31000, ownerId: 'agent-019fcb55', resultText: null, errorText: 'ESLint exited with code 2 · .eslintrc 合并冲突' },
      { id: 'job-83', type: 'bash', status: 'completed', label: 'grep -rn "pi-core" package-lock.json', durationMs: 4200, ownerId: 'agent-019fcb01', resultText: '4 matches in 2 files', errorText: null },
      { id: 'job-77', type: 'task', status: 'cancelled', label: 'playwright 截图回归', durationMs: 18000, ownerId: 'agent-019fcb17', resultText: null, errorText: 'cancelled by owner agent' }
    ],
    irc: [
      { dir: 'out', from: 'main', to: 'agent-019fcb01', text: '把 pi-mermaid 的 MermaidTheme 变更单独列一节，给出迁移建议', time: AGO(320), outcome: 'injected', read: true },
      { dir: 'in', from: 'agent-019fcb01', to: 'main', text: '发现 pi-core 0.82.1 把 securityLevel 默认值从 loose 收紧为 strict，会影响现有调用吗？', time: AGO(145), outcome: null, read: false },
      { dir: 'in', from: 'agent-019fcb01', to: 'main', text: 'typecheck 子 Agent 已 spawn（agent-019fcb20），预计 2 分钟内出第一轮错误清单', time: AGO(96), outcome: null, read: false },
      { dir: 'out', from: 'main', to: 'agent-019fc8a0', text: 'revive 一下，把 NOTICE 文件那节补上第三方字体声明', time: AGO(3700), outcome: 'revived', read: true }
    ],
    transcripts: {
      'agent-019fcb01': [
        { role: 'user', time: '13:47', body: '审计 @earendil-works/pi-* 0.82.1 变更，确认 mermaid 类型签名是否破坏现有 theme 注入。' },
        { role: 'assistant', time: '13:47', body: '收到。计划：1) lockfile 定位间接依赖 2) 对 pi-mermaid 做类型 diff 3) 核对 MermaidTheme 必填字段。' },
        { role: 'tool', time: '13:48', body: 'Grep "pi-core" in package-lock.json → 4 matches in 2 files' },
        { role: 'tool', time: '13:49', body: 'Read node_modules/@earendil-works/pi-mermaid/dist/index.d.ts (212 lines)' },
        { role: 'assistant', time: '13:50', body: '类型 diff 完成：MermaidTheme 新增必填字段 securityLevel（默认 "strict"）。现有 buildThemeVars 未传，会报 TS2322。我先 spawn 一个 typecheck 子 Agent 验证全量影响面。' },
        { role: 'tool', time: '13:50', body: 'Task spawn agent-019fcb20 "bunx tsc --noEmit 全量类型检查"' }
      ],
      'agent-019fcb17': [
        { role: 'user', time: '13:52', body: '验证 Mermaid 全屏缩放拖拽在 125% DPI 下的表现，重点看 pinch-zoom 跟手感。' },
        { role: 'assistant', time: '13:53', body: 'Preview 已附加（127.0.0.1:30141）。拖拽平移本身流畅，但释放时没有惯性，大图像素级定位有点累。' },
        { role: 'tool', time: '13:53', body: 'AskUserQuestion { question: "缩放交互确认：拖拽平移是否需要惯性？", options: ["需要", "不需要", "做成设置项"] }' }
      ],
      'agent-019fcb55': [
        { role: 'user', time: '13:55', body: 'ESLint 全量扫描，merge 上游后回归。' },
        { role: 'tool', time: '13:55', body: 'Bash eslint . → exit 2（.eslintrc 合并冲突：extends 数组重复项）' },
        { role: 'assistant', time: '13:56', body: '冲突点在 extends：上游新增了 "plugin:mermaid/recommended"，本地保留了旧 overrides 顺序。我不自动改配置，等你确认合并策略。' },
        { role: 'tool', time: '13:56', body: 'Bash eslint . (retry 2/2) → exit 2' }
      ],
      'agent-019fcb20': [
        { role: 'user', time: '13:58', body: 'bunx tsc --noEmit 全量类型检查并归类错误，输出按文件分组的清单。' },
        { role: 'assistant', time: '13:58', body: '开始扫描。先用补丁分支 agent/typecheck-019fcb20 隔离，避免污染主工作区。' },
        { role: 'tool', time: '13:58', body: 'Bash bunx tsc --noEmit (running 24s)' }
      ],
      'agent-019fc9d2': [
        { role: 'user', time: '13:12', body: '整理 UPSTREAM-SYNC.md 三阶段章节草稿，语言收敛一点。' },
        { role: 'assistant', time: '13:14', body: '草稿 v2 已交付到 agent-019fc9d2.md：三阶段改为「准备 / 同步 / 验证」，每节控制在 40 行内。' },
        { role: 'system', time: '13:21', body: '空闲 TTL（600s）到期，session 已 dispose；ref 与 sessionFile 保留，可随时 revive。' }
      ],
      'agent-019fc8a0': [
        { role: 'user', time: '12:26', body: 'OSS 仓库发布前合规检查：license、NOTICE、依赖审计。' },
        { role: 'assistant', time: '12:33', body: '报告已生成 agent-019fc8a0.md：license 齐全；NOTICE 缺第三方字体声明；依赖审计 0 高危。' },
        { role: 'system', time: '12:52', body: '空闲 TTL 到期，session 已 park。' }
      ],
      'agent-019fc77e': [
        { role: 'user', time: '11:50', body: '试验 ws 通道替代 stdio 的可行性（spike，不动主代码）。' },
        { role: 'assistant', time: '11:53', body: '结论：ws 通道在断线重连语义上不如 stdio 可控，不建议替换。详细对比在对话内。' },
        { role: 'system', time: '12:10', body: '用户执行 kill：abort 后写入 tombstone，agent 进入终态 aborted（不可 revive）。' }
      ],
      'advisor-019fab10': [
        { role: 'user', time: '13:13', body: '评审 session 存储层重构方案的风险点（只读顾问）。' },
        { role: 'assistant', time: '13:15', body: '三个风险：1) 迁移期双写一致性 2) 大型 transcript 的索引重建耗时 3) tombstone 边车与备份策略的交互。详见输出 advisor-019fab10.md。' }
      ]
    }
  };

  /* ---------- OMP 原生工具卡图鉴（演示场景 42，全部展开）
     来源：coding-agent BUILTIN_TOOL_NAMES + HIDDEN_TOOL_NAMES
     + thinking / MCP / 常见 companion（generate_image, tts, vibe） ---------- */
  D.nativeToolGallery = [
    { kind: 'think', name: 'Think', status: 'done', dur: '8s',
      preview: '先按 TUI 分型画每张展开卡，Plan 不再单独占一行。',
      full: '对话只保留文本块和工具批次。\nThinking 进链，限高往上滚。\n每张工具卡对齐 OMP 原生 renderer，没有 renderer 的走 Args + Output 默认卡。' },
    { kind: 'read', name: 'Read', target: 'src/tools/builtin-names.ts', status: 'done', dur: '0.2s',
      lines: 67, encoding: 'UTF-8', size: '1.8 KB', offset: 1,
      preview: ['export const BUILTIN_TOOL_NAMES = [', '\t"read",', '\t"bash",', '\t"edit",', '\t"ast_grep",', '\t"write",', '];'] },
    { kind: 'write', name: 'Write', target: 'docs/UPSTREAM-SYNC.md', status: 'done', dur: '1.8s',
      created: true, lines: 214, encoding: 'UTF-8',
      preview: ['# 上游同步记录', '', '## graft 关联', '', '- git replace --graft'] },
    { kind: 'edit', name: 'Edit', target: 'README.md', status: 'done', dur: '0.6s',
      diff: [
        [' ', '46', '46', '- [更新日志](docs/CHANGELOG.md)'],
        ['+', '', '47', '- [上游同步](docs/UPSTREAM-SYNC.md)'],
        [' ', '47', '48', '- [架构说明](docs/ARCH.md)']
      ] },
    { kind: 'bash', name: 'Bash', target: 'npm run typecheck', status: 'done', dur: '11.2s',
      cmd: 'npm run typecheck', cwd: 'C:\\Aspace\\Tools\\omp-web',
      output: [['> tsc --noEmit', 'dim'], ['', ''], ['0 errors, 0 warnings', 'ok']], exit: 0 },
    { kind: 'grep', name: 'Grep', target: 'UPSTREAM in *.md', status: 'done', dur: '0.4s',
      pattern: 'UPSTREAM', paths: '*.md', count: '2 matches · 2 files',
      matches: [
        { file: 'docs/README.md', line: '12', text: '- [上游同步](docs/UPSTREAM-SYNC.md)' },
        { file: 'README.md', line: '48', text: '详见 docs/UPSTREAM-SYNC.md' }
      ] },
    { kind: 'glob', name: 'Glob', target: 'src/tools/*.ts', status: 'done', dur: '0.2s',
      pattern: 'src/tools/*.ts', files: ['src/tools/read.ts', 'src/tools/bash.ts', 'src/tools/grep.ts', 'src/tools/todo.ts'] },
    { kind: 'ast_grep', name: 'AST Grep', target: 'console.log($MSG)', status: 'done', dur: '0.7s',
      pattern: 'console.log($MSG)', lang: 'tsx', searched: 42,
      matches: [
        { file: 'components/MermaidBlock.tsx', line: '88', text: 'console.log("zoom", scale)' },
        { file: 'hooks/useCodeTheme.ts', line: '14', text: 'console.log(theme)' }
      ] },
    { kind: 'ast_edit', name: 'AST Edit', target: 'console.log($MSG) → void', status: 'done', dur: '1.1s',
      pattern: 'console.log($MSG)', rewrite: '() => {}', replacements: 2, filesChanged: 2,
      changes: [
        { file: 'components/MermaidBlock.tsx', before: 'console.log("zoom", scale)', after: '' },
        { file: 'hooks/useCodeTheme.ts', before: 'console.log(theme)', after: '' }
      ] },
    { kind: 'ask', name: 'Ask', target: '是否一并修复这个类型错误？', status: 'done', dur: '12s',
      question: '是否一并修复这个类型错误？',
      options: [
        { label: '修复它', rec: true, selected: true },
        { label: '先不动，只记到文档' },
        { label: '让我自己改' }
      ],
      answer: '修复它' },
    { kind: 'debug', name: 'Debug', target: 'launch · omp-web', status: 'done', dur: '3.4s',
      action: 'launch', program: 'bin/omp-web.js',
      snapshot: 'paused at MermaidBlock.tsx:147',
      output: ['Debugger attached', 'Breakpoint hit: TS2322 site'] },
    { kind: 'eval', name: 'Eval', target: 'javascript', status: 'done', dur: '0.8s',
      lang: 'javascript',
      cells: [
        { code: 'const t = getCodeTheme()\nt', stdout: '"dark"', status: 'ok' }
      ] },
    { kind: 'github', name: 'GitHub', target: 'pr view #812', status: 'done', dur: '1.4s',
      op: 'pr_view', repo: 'agegr/pi-web', pr: 812,
      output: { title: 'v0.8.1 DirectoryPicker', state: 'merged', user: 'agegr' } },
    { kind: 'lsp', name: 'LSP', target: 'diagnostics · MermaidBlock.tsx', status: 'done', dur: '0.5s',
      action: 'diagnostics',
      diagnostics: [
        { sev: 'error', file: 'components/MermaidBlock.tsx', line: 147, msg: "Type 'string' is not assignable to type 'MermaidTheme'." },
        { sev: 'warning', file: 'lib/rpc.ts', line: 40, msg: 'Unused parameter ctx' }
      ] },
    { kind: 'inspect_image', name: 'Inspect', target: 'docs/mermaid-zoom.png', status: 'done', dur: '2.6s',
      question: '全屏拖拽有没有惯性？', mime: 'image/png', model: 'gemini-3.6-flash',
      answer: '截图里松手后画布立即停下，没有惯性滑动。' },
    { kind: 'browser', name: 'Browser', target: 'run · waitForSelector', status: 'done', dur: '1.9s',
      action: 'run', tab: 'omp-web', url: 'http://127.0.0.1:30141',
      code: 'await page.waitForSelector(".mermaid")',
      output: 'ok · 1 node' },
    { kind: 'computer', name: 'Computer', target: 'screenshot + click', status: 'done', dur: '4.2s',
      code: 'await click("Allow once")', shots: 1,
      output: 'clicked Allow once' },
    { kind: 'checkpoint', name: 'Checkpoint', target: '调查 Mermaid 类型错误前', status: 'done', dur: '0.9s',
      goal: '调查 Mermaid 类型错误前', sha: 'c12f9a1',
      args: { goal: '调查 Mermaid 类型错误前' },
      output: 'checkpoint c12f9a1 created' },
    { kind: 'rewind', name: 'Rewind', target: 'c12f9a1', status: 'done', dur: '1.3s',
      report: '类型修复已验证，工作区回到 checkpoint。',
      args: { checkpoint: 'c12f9a1' },
      output: 'restored 3 files' },
    { kind: 'security_scan', name: 'Security Scan', target: 'workspace', status: 'done', dur: '6.8s',
      action: 'scan',
      args: { action: 'scan', target: 'workspace' },
      output: { findings: 0, scanners: ['omp', 'codex'] } },
    { kind: 'task', name: 'Task', status: 'done', dur: '42s',
      spawn: {
        agent: 'scout',
        isolated: true,
        context: '# Goal\n并行调研上游 v0.8.1 变更，确认依赖、文档要点与 Mermaid 全屏缩放。不需要交付完整文档。\n\n# Constraints\n- 只读调研，不要编辑、新建或删除任何文件\n- 不要跑 build、test、lint、formatter 或其它重命令\n- 核对 Preview 后可用 `sleep 45` 把总时长凑到约一分钟\n- 最终只交一段看过什么的摘要',
        tasks: [
          { name: 'deps', agent: 'scout', task: '审计 @earendil-works/pi-* 0.82.1 变更' },
          { name: 'docs', agent: 'scout', task: '提取 v0.8.1 Release Notes 要点' },
          { name: 'preview', agent: 'scout', task: '核对 Mermaid 全屏缩放' }
        ]
      },
      agents: [
        { name: 'deps', status: 'done', activity: 'done', dur: '38s',
          resolvedModel: 'gemini-3.6-flash', thinking: 'max',
          tokens: '12.6k', tools: 8, requests: 4, cost: '¥ 0.51', files: 6,
          lastTool: 'Grep · "pi-core" in lockfile' },
        { name: 'docs', status: 'done', activity: 'done', dur: '41s',
          resolvedModel: 'claude-sonnet-4.5', thinking: 'high',
          tokens: '9.8k', tools: 5, requests: 3, cost: '¥ 0.36', files: 2,
          lastTool: 'Web Search · v0.8.1 notes' },
        { name: 'preview', status: 'running', activity: 'tool', dur: '9s',
          resolvedModel: 'gemini-3.6-flash', thinking: 'max',
          tokens: '5.1k', tools: 3, requests: 2, cost: '¥ 0.18',
          currentTool: { name: 'Browser', args: 'waitForSelector' },
          lastTool: 'Browser · waitForSelector' }
      ] },
    { kind: 'hub', name: 'Hub', target: 'IRC ➤ #omp', status: 'done', dur: '0.4s',
      hubKind: 'irc', to: '#omp', text: 'typecheck 已通过', receipt: 'delivered' },
    { kind: 'todo', name: 'Todo', target: 'update phase 验证', status: 'done', dur: '0.1s',
      op: 'done',
      phases: [
        { name: '文档', tasks: [
          { content: '阅读 docs 与 package.json', status: 'completed' },
          { content: '写 UPSTREAM-SYNC.md', status: 'completed' }
        ] },
        { name: '验证', tasks: [
          { content: 'typecheck / lint', status: 'in_progress' },
          { content: 'Preview 缩放', status: 'pending' }
        ] }
      ] },
    { kind: 'web_search', name: 'Web Search', target: 'mermaid pan inertia', status: 'done', dur: '2.2s',
      query: 'mermaid fullscreen pan inertia', provider: 'exa', sources: 2,
      answer: '大图平移普遍提供释放惯性。',
      cites: [
        { title: 'd3-zoom inertia notes', url: 'github.com/d3' },
        { title: 'panzoom README', url: 'github.com/anvaka' }
      ] },
    { kind: 'retain', name: 'Retain', status: 'done', dur: '0.3s',
      stored: 2, items: ['omp-web 会话目录是 ~/.omp/agent/sessions/', '代码主题走 useCodeTheme'] },
    { kind: 'recall', name: 'Recall', target: 'omp-web 路径适配', status: 'done', dur: '0.4s',
      query: 'omp-web 路径适配', count: 1,
      excerpts: ['会话、models.json、config.yml 都在 ~/.omp/agent/ 下，不要写回 pi-web 路径。'] },
    { kind: 'reflect', name: 'Reflect', target: '这次同步该保留什么？', status: 'done', dur: '0.6s',
      query: '这次同步该保留什么？',
      answer: '保留包名、CLI 名、~/.omp/agent/ 路径和 useCodeTheme；吸纳 DirectoryPicker 与 loopback 监听。' },
    { kind: 'memory_edit', name: 'Memory Edit', target: 'update mem_02', status: 'done', dur: '0.2s',
      args: { op: 'update', id: 'mem_02' },
      output: 'updated mem_02' },
    { kind: 'learn', name: 'Learn', target: 'graft 后再走 3-way merge', status: 'done', dur: '0.3s',
      args: { memory: 'graft 后再走 3-way merge', skill: 'upstream-sync' },
      output: 'lesson stored · skill upstream-sync queued' },
    { kind: 'manage_skill', name: 'Manage Skill', target: 'create upstream-sync', status: 'done', dur: '0.5s',
      args: { action: 'create', name: 'upstream-sync' },
      output: 'skill created at .omp/skills/upstream-sync/SKILL.md' },
    { kind: 'yield', name: 'Submit Result', target: 'type: result', status: 'done', dur: '0.1s',
      args: { type: 'result' },
      output: { summary: 'v0.8.1 同步完成', files: 4 } },
    { kind: 'goal', name: 'Goal', target: 'create', status: 'done', dur: '0.2s',
      op: 'create', objective: '把上游同步过程写成可复查文档',
      budget: '200k tokens · 30m', statusLabel: 'active' },
    { kind: 'generate_image', name: 'GenerateImage', target: 'graft 演进链示意', status: 'done', dur: '5.1s',
      subject: 'git replace --graft 把 omp-web 接到 pi-web v0.8.0',
      images: 1, output: 'image attached · 1024×576' },
    { kind: 'tts', name: 'Speech Generation', target: 'out/sync-done.wav', status: 'done', dur: '2.8s',
      args: { text: '同步完成', output_path: 'out/sync-done.wav', voice_id: 'af_heart' },
      output: 'wrote 248 KB wav · kokoro' },
    { kind: 'vibe', name: 'Vibe Wait', target: 'wait · preview-bot', status: 'done', dur: '9.4s',
      vibeOp: 'wait', sessions: [
        { id: 'preview-bot', status: 'done', tool: 'browser', elapsed: '8.1s' },
        { id: 'types-bot', status: 'done', tool: 'bash', elapsed: '11.2s' }
      ] },
    { kind: 'mcp', name: 'github.get_release', target: 'MCP · github', status: 'done', dur: '0.8s',
      args: '{ "repo": "agegr/pi-web", "tag": "v0.8.1" }',
      output: '{ "name": "v0.8.1", "assets": 3, "published": "2026-08-02" }' },
    { kind: 'resolve', name: 'Resolve', target: 'Accept ast_edit preview', status: 'done', dur: '0.2s',
      action: 'accept', reason: '两处 console.log 都是调试残留' }
  ];

  window.OMP_DATA = D;
})();
