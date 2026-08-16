import type { JsonValue } from "@omp-studio/client-contract";

/**
 * Preview-only copy of ver1 `D.nativeToolGallery` (scene 42).
 * Real mode must never import this.
 */
export const NATIVE_TOOL_GALLERY: readonly { readonly [key: string]: JsonValue }[] = [
  {
    kind: "think", name: "Think", status: "done", dur: "8s",
    preview: "先按 TUI 分型画每张展开卡，Plan 不再单独占一行。",
    full: "对话只保留文本块和工具批次。\nThinking 进链，限高往上滚。\n每张工具卡对齐 OMP 原生 renderer，没有 renderer 的走 Args + Output 默认卡。",
  },
  {
    kind: "read", name: "Read", target: "src/tools/builtin-names.ts", status: "done", dur: "0.2s",
    lines: 67, encoding: "UTF-8", size: "1.8 KB", offset: 1,
    preview: ["export const BUILTIN_TOOL_NAMES = [", "\t\"read\",", "\t\"bash\",", "\t\"edit\",", "\t\"ast_grep\",", "\t\"write\",", "];"],
  },
  {
    kind: "write", name: "Write", target: "docs/UPSTREAM-SYNC.md", status: "done", dur: "1.8s",
    created: true, lines: 214, encoding: "UTF-8",
    preview: ["# 上游同步记录", "", "## graft 关联", "", "- git replace --graft"],
  },
  {
    kind: "edit", name: "Edit", target: "README.md", status: "done", dur: "0.6s",
    diff: [
      [" ", "46", "46", "- [更新日志](docs/CHANGELOG.md)"],
      ["+", "", "47", "- [上游同步](docs/UPSTREAM-SYNC.md)"],
      [" ", "47", "48", "- [架构说明](docs/ARCH.md)"],
    ],
  },
  {
    kind: "bash", name: "Bash", target: "npm run typecheck", status: "done", dur: "11.2s",
    cmd: "npm run typecheck", cwd: "C:\\Aspace\\Tools\\omp-web",
    output: [["> tsc --noEmit", "dim"], ["", ""], ["0 errors, 0 warnings", "ok"]], exit: 0,
  },
  {
    kind: "grep", name: "Grep", target: "UPSTREAM in *.md", status: "done", dur: "0.4s",
    pattern: "UPSTREAM", paths: "*.md", count: "2 matches · 2 files",
    matches: [
      { file: "docs/README.md", line: "12", text: "- [上游同步](docs/UPSTREAM-SYNC.md)" },
      { file: "README.md", line: "48", text: "详见 docs/UPSTREAM-SYNC.md" },
    ],
  },
  {
    kind: "glob", name: "Glob", target: "src/tools/*.ts", status: "done", dur: "0.2s",
    pattern: "src/tools/*.ts",
    files: ["src/tools/read.ts", "src/tools/bash.ts", "src/tools/grep.ts", "src/tools/todo.ts"],
  },
  {
    kind: "ast_grep", name: "AST Grep", target: "console.log($MSG)", status: "done", dur: "0.7s",
    pattern: "console.log($MSG)", lang: "tsx", searched: 42,
    matches: [
      { file: "components/MermaidBlock.tsx", line: "88", text: "console.log(\"zoom\", scale)" },
      { file: "hooks/useCodeTheme.ts", line: "14", text: "console.log(theme)" },
    ],
  },
  {
    kind: "ast_edit", name: "AST Edit", target: "console.log($MSG) → void", status: "done", dur: "1.1s",
    pattern: "console.log($MSG)", rewrite: "() => {}", replacements: 2, filesChanged: 2,
    changes: [
      { file: "components/MermaidBlock.tsx", before: "console.log(\"zoom\", scale)", after: "" },
      { file: "hooks/useCodeTheme.ts", before: "console.log(theme)", after: "" },
    ],
  },
  {
    kind: "ask", name: "Ask", target: "是否一并修复这个类型错误？", status: "done", dur: "12s",
    question: "是否一并修复这个类型错误？",
    options: [
      { label: "修复它", rec: true, selected: true },
      { label: "先不动，只记到文档" },
      { label: "让我自己改" },
    ],
    answer: "修复它",
  },
  {
    kind: "debug", name: "Debug", target: "launch · omp-web", status: "done", dur: "3.4s",
    action: "launch", program: "bin/omp-web.js",
    snapshot: "paused at MermaidBlock.tsx:147",
    output: ["Debugger attached", "Breakpoint hit: TS2322 site"],
  },
  {
    kind: "eval", name: "Eval", target: "javascript", status: "done", dur: "0.8s",
    lang: "javascript",
    cells: [{ code: "const t = getCodeTheme()\nt", stdout: "\"dark\"", status: "ok" }],
  },
  {
    kind: "github", name: "GitHub", target: "pr view #812", status: "done", dur: "1.4s",
    op: "pr_view", repo: "agegr/pi-web", pr: 812,
    output: { title: "v0.8.1 DirectoryPicker", state: "merged", user: "agegr" },
  },
  {
    kind: "lsp", name: "LSP", target: "diagnostics · MermaidBlock.tsx", status: "done", dur: "0.5s",
    action: "diagnostics",
    diagnostics: [
      { sev: "error", file: "components/MermaidBlock.tsx", line: 147, msg: "Type 'string' is not assignable to type 'MermaidTheme'." },
      { sev: "warning", file: "lib/rpc.ts", line: 40, msg: "Unused parameter ctx" },
    ],
  },
  {
    kind: "inspect_image", name: "Inspect", target: "docs/mermaid-zoom.png", status: "done", dur: "2.6s",
    question: "全屏拖拽有没有惯性？", mime: "image/png", model: "gemini-3.6-flash",
    answer: "截图里松手后画布立即停下，没有惯性滑动。",
  },
  {
    kind: "browser", name: "Browser", target: "run · waitForSelector", status: "done", dur: "1.9s",
    action: "run", tab: "omp-web", url: "http://127.0.0.1:30141",
    code: "await page.waitForSelector(\".mermaid\")",
    output: "ok · 1 node",
  },
  {
    kind: "computer", name: "Computer", target: "screenshot + click", status: "done", dur: "4.2s",
    code: "await click(\"Allow once\")", shots: 1,
    output: "clicked Allow once",
  },
  {
    kind: "checkpoint", name: "Checkpoint", target: "调查 Mermaid 类型错误前", status: "done", dur: "0.9s",
    goal: "调查 Mermaid 类型错误前", sha: "c12f9a1",
    args: { goal: "调查 Mermaid 类型错误前" },
    output: "checkpoint c12f9a1 created",
  },
  {
    kind: "rewind", name: "Rewind", target: "c12f9a1", status: "done", dur: "1.3s",
    report: "类型修复已验证，工作区回到 checkpoint。",
    args: { checkpoint: "c12f9a1" },
    output: "restored 3 files",
  },
  {
    kind: "security_scan", name: "Security Scan", target: "workspace", status: "done", dur: "6.8s",
    action: "scan",
    args: { action: "scan", target: "workspace" },
    output: { findings: 0, scanners: ["omp", "codex"] },
  },
  {
    kind: "task", name: "Task", status: "done", dur: "42s",
    spawn: {
      agent: "scout",
      isolated: true,
      context: "# Goal\n并行调研上游 v0.8.1 变更，确认依赖、文档要点与 Mermaid 全屏缩放。不需要交付完整文档。\n\n# Constraints\n- 只读调研，不要编辑、新建或删除任何文件\n- 不要跑 build、test、lint、formatter 或其它重命令\n- 核对 Preview 后可用 `sleep 45` 把总时长凑到约一分钟\n- 最终只交一段看过什么的摘要",
      tasks: [
        { name: "deps", agent: "scout", task: "审计 @earendil-works/pi-* 0.82.1 变更" },
        { name: "docs", agent: "scout", task: "提取 v0.8.1 Release Notes 要点" },
        { name: "preview", agent: "scout", task: "核对 Mermaid 全屏缩放" },
      ],
    },
    agents: [
      {
        name: "deps", status: "done", activity: "done", dur: "38s",
        resolvedModel: "gemini-3.6-flash", thinking: "max",
        tokens: "12.6k", tools: 8, requests: 4, cost: "¥ 0.51", files: 6,
        lastTool: "Grep · \"pi-core\" in lockfile",
      },
      {
        name: "docs", status: "done", activity: "done", dur: "41s",
        resolvedModel: "claude-sonnet-4.5", thinking: "high",
        tokens: "9.8k", tools: 5, requests: 3, cost: "¥ 0.36", files: 2,
        lastTool: "Web Search · v0.8.1 notes",
      },
      {
        name: "preview", status: "running", activity: "tool", dur: "9s",
        resolvedModel: "gemini-3.6-flash", thinking: "max",
        tokens: "5.1k", tools: 3, requests: 2, cost: "¥ 0.18",
        currentTool: { name: "Browser", args: "waitForSelector" },
        lastTool: "Browser · waitForSelector",
      },
    ],
  },
  {
    kind: "hub", name: "Hub", target: "IRC ➤ #omp", status: "done", dur: "0.4s",
    hubKind: "irc", to: "#omp", text: "typecheck 已通过", receipt: "delivered",
  },
  {
    kind: "todo", name: "Todo", target: "update phase 验证", status: "done", dur: "0.1s",
    op: "done",
    phases: [
      {
        name: "文档",
        tasks: [
          { content: "阅读 docs 与 package.json", status: "completed" },
          { content: "写 UPSTREAM-SYNC.md", status: "completed" },
        ],
      },
      {
        name: "验证",
        tasks: [
          { content: "typecheck / lint", status: "in_progress" },
          { content: "Preview 缩放", status: "pending" },
        ],
      },
    ],
  },
  {
    kind: "web_search", name: "Web Search", target: "mermaid pan inertia", status: "done", dur: "2.2s",
    query: "mermaid fullscreen pan inertia", provider: "exa", sources: 2,
    answer: "大图平移普遍提供释放惯性。",
    cites: [
      { title: "d3-zoom inertia notes", url: "github.com/d3" },
      { title: "panzoom README", url: "github.com/anvaka" },
    ],
  },
  {
    kind: "retain", name: "Retain", status: "done", dur: "0.3s",
    stored: 2, items: ["omp-web 会话目录是 ~/.omp/agent/sessions/", "代码主题走 useCodeTheme"],
  },
  {
    kind: "recall", name: "Recall", target: "omp-web 路径适配", status: "done", dur: "0.4s",
    query: "omp-web 路径适配", count: 1,
    excerpts: ["会话、models.json、config.yml 都在 ~/.omp/agent/ 下，不要写回 pi-web 路径。"],
  },
  {
    kind: "reflect", name: "Reflect", target: "这次同步该保留什么？", status: "done", dur: "0.6s",
    query: "这次同步该保留什么？",
    answer: "保留包名、CLI 名、~/.omp/agent/ 路径和 useCodeTheme；吸纳 DirectoryPicker 与 loopback 监听。",
  },
  {
    kind: "memory_edit", name: "Memory Edit", target: "update mem_02", status: "done", dur: "0.2s",
    args: { op: "update", id: "mem_02" },
    output: "updated mem_02",
  },
  {
    kind: "learn", name: "Learn", target: "graft 后再走 3-way merge", status: "done", dur: "0.3s",
    args: { memory: "graft 后再走 3-way merge", skill: "upstream-sync" },
    output: "lesson stored · skill upstream-sync queued",
  },
  {
    kind: "manage_skill", name: "Manage Skill", target: "create upstream-sync", status: "done", dur: "0.5s",
    args: { action: "create", name: "upstream-sync" },
    output: "skill created at .omp/skills/upstream-sync/SKILL.md",
  },
  {
    kind: "yield", name: "Submit Result", target: "type: result", status: "done", dur: "0.1s",
    args: { type: "result" },
    output: { summary: "v0.8.1 同步完成", files: 4 },
  },
  {
    kind: "goal", name: "Goal", target: "create", status: "done", dur: "0.2s",
    op: "create", objective: "把上游同步过程写成可复查文档",
    budget: "200k tokens · 30m", statusLabel: "active",
  },
  {
    kind: "generate_image", name: "GenerateImage", target: "graft 演进链示意", status: "done", dur: "5.1s",
    subject: "git replace --graft 把 omp-web 接到 pi-web v0.8.0",
    images: 1, output: "image attached · 1024×576",
  },
  {
    kind: "tts", name: "Speech Generation", target: "out/sync-done.wav", status: "done", dur: "2.8s",
    args: { text: "同步完成", output_path: "out/sync-done.wav", voice_id: "af_heart" },
    output: "wrote 248 KB wav · kokoro",
  },
  {
    kind: "vibe", name: "Vibe Wait", target: "wait · preview-bot", status: "done", dur: "9.4s",
    vibeOp: "wait",
    sessions: [
      { id: "preview-bot", status: "done", tool: "browser", elapsed: "8.1s" },
      { id: "types-bot", status: "done", tool: "bash", elapsed: "11.2s" },
    ],
  },
  {
    kind: "mcp", name: "github.get_release", target: "MCP · github", status: "done", dur: "0.8s",
    args: "{ \"repo\": \"agegr/pi-web\", \"tag\": \"v0.8.1\" }",
    output: "{ \"name\": \"v0.8.1\", \"assets\": 3, \"published\": \"2026-08-02\" }",
  },
  {
    kind: "resolve", name: "Resolve", target: "Accept ast_edit preview", status: "done", dur: "0.2s",
    action: "accept", reason: "两处 console.log 都是调试残留",
  },
];
