import type { ConversationContentBlock, JsonValue } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";
import { getNativeToolGallery } from "./nativeToolGallery";
import { demoPath } from "./demoPaths";
import { previewActionsWatch } from "../hubPreview";

type Card = { readonly [key: string]: JsonValue };

function buildExtraCards(zh: boolean): readonly Card[] {
  return [
    { kind: "find", name: "Find", query: zh ? "会话切换后保留阅读位置" : "Preserve reading position across session switches", elapsedMs: 126, hits: [
      { rel: "conversation/useConversationScroll.ts", contentScore: 0.96, ranges: [{ start: 42, end: 45, snippet: "const anchor = captureReadingAnchor(scroller);\nrestoreReadingAnchor(scroller, anchor);" }] },
      { rel: "conversation/ConversationPane.tsx", contentScore: 0.81, ranges: [{ start: 110, end: 111, snippet: "retainConversationWhileRemounting(current, previous, sessionId)" }] },
    ] },
    { kind: "process", name: "read", path: "proc://renderer-check", daemon: { name: "renderer-check", state: "exited", exitCode: 0, persist: false }, status: "completed", result: { stdout: "72 suites passed", exitCode: 0 } },
    { kind: "agent_message", name: "write", path: "agent://scout", status: "delivered", result: { agent: "scout", message: zh ? "请补充浅色与深色下的正文检查记录。" : "Please add prose verification notes in light and dark themes.", accepted: true } },
    { kind: "documentation", name: "read", path: "omp://tools/read", args: { path: "omp://tools/read" }, output: zh ? "# Read\n读取文件、进程、Agent 消息和内置文档。\n\n支持 offset / limit 与 Markdown 结果。" : "# Read\nRead files, processes, Agent messages, and built-in docs.\n\nSupports offset / limit and Markdown output." },
    { kind: "wait", name: "Wait", op: "wait", jobs: [
      { id: "gallery-types", label: zh ? "类型检查" : "Type check", type: "process", status: "completed", completionPercent: 100, exitCode: 0, durationMs: 980 },
      { id: "gallery-render", label: zh ? "界面检查" : "UI inspection", type: "agent", status: "running", stage: zh ? "检查窄阅读列" : "Checking narrow column", completionPercent: 68, durationMs: 4200 },
      { id: "gallery-failed", label: zh ? "旧版本复查" : "Legacy recheck", type: "process", status: "failed", exitCode: 2, durationMs: 1240 },
    ] },
    { kind: "web", name: "Web", query: "Mermaid theme configuration", answer: zh ? "主题可用 default、dark、forest 和 neutral，配置变化后重新渲染图表。" : "Supported themes include default, dark, forest, and neutral; diagrams re-render when config changes.", cites: [{ title: zh ? "Mermaid 文档" : "Mermaid Docs", url: "https://mermaid.js.org/config/theming.html" }] },
    { kind: "report_issue", name: "Report Issue", args: { title: zh ? "窄窗口内长路径换行" : "Long path wrapping in narrow windows", category: "renderer" }, output: { recorded: true, issue: "gallery-001", attachments: ["narrow-layout.png"] } },
    { kind: "extension_tool", name: "Extension Tool", args: { action: "inspect", scope: ["conversation", "tools"], options: { verbose: true } }, output: { summary: zh ? "扩展工具使用通用 Args / Output 卡" : "Extension tools use the shared Args / Output card", count: 2, ready: true, warning: null } },
  ];
}

export function getContentGalleryTools(zh = isZh()): readonly Card[] {
  return [...getNativeToolGallery(zh).filter(card => !["ask", "askuser", "think"].includes(String(card.kind))), ...buildExtraCards(zh)];
}

export const CONTENT_GALLERY_TOOLS = getContentGalleryTools();

export function galleryToolBlocks(cards: readonly Card[], chapter: string): ConversationContentBlock[] {
  return cards.flatMap((card, index): ConversationContentBlock[] => {
    const toolName = String(card.name), toolCallId = `content-gallery-${chapter}-${index}`;
    return [
      { type: "toolCall", toolCallId, toolName, arguments: card },
      { type: "toolResult", toolCallId, toolName, data: card, ...(typeof card.output === "string" ? { output: card.output } : {}), isError: card.status === "error" },
    ];
  });
}

export function getContentGalleryVariants(zh = isZh()): readonly Card[] {
  return [
    { name: "Read", path: "docs/UPSTREAM-SYNC.md", contentType: "text/markdown", preview: zh ? ["## Markdown 读取结果", "", "**类型检查通过**，保留 `MermaidTheme` 返回类型。", "", "- [x] 文档入口", "- [ ] 窄窗口复查"] : ["## Markdown read result", "", "**Type check passed**, keeping `MermaidTheme` return type.", "", "- [x] Docs entry", "- [ ] Narrow-window recheck"] },
    { name: "GitHub", kind: "github", op: "run_watch", status: "error", watch: previewActionsWatch(true) as unknown as JsonValue, output: zh ? "原生 workflow watch 遇到失败后结束；剩余排队作业保留最后观察状态，不推算进度。" : "Native workflow watch stopped on failure; remaining queued jobs keep their last observed state without extrapolated progress." },
    { name: "Edit", kind: "edit", status: "error", isError: true, output: zh ? "历史部分编辑记录：主题类型变更已应用，另一文件被拒绝。只审核 perFileResults 中已应用的结果。" : "Historical partial edit: theme type update applied while another file was rejected. Review only applied items in perFileResults.", perFileResults: [
      { path: "components/MermaidBlock.tsx", op: "update", diff: "-147|const theme: string = getCodeTheme();\n+147|const theme: MermaidTheme = getCodeTheme();" },
      { path: "hooks/useCodeTheme.ts", isError: true, diff: "", errorText: zh ? "历史记录中的匹配失败；没有已应用差异。" : "Historical match failure; no diff applied." },
    ] },
    { name: "Edit", kind: "edit", status: "error", path: "hooks/useCodeTheme.ts", input: "*** Begin Patch\n*** Update File: hooks/useCodeTheme.ts\n@@\n-missing old line\n+new line\n*** End Patch", diff: "", perFileResults: [], output: zh ? "原生阶段校验失败；没有返回任何已应用文件，不能从 input 推断成功。" : "Native phase validation failed; no applied files were returned, so success cannot be inferred from input." },
    { name: "Todo", kind: "todo", op: "view", phases: [{ name: zh ? "验证" : "Verification", tasks: [{ content: zh ? "验证旧会话的全屏缩放拖拽" : "Verify fullscreen zoom & pan on old sessions", status: "blocked" }] }], output: zh ? "历史阻塞状态仅供回看，不是当前 Todo 可设置的状态。" : "Historical blocked state is read-only context, not a currently assignable Todo status." },
    { name: "Todo", kind: "todo", op: "view", phases: [{ name: zh ? "验证" : "Verification", tasks: [{ content: zh ? "验证旧会话的全屏缩放拖拽" : "Verify fullscreen zoom & pan on old sessions", status: "pending" }] }], output: zh ? "原生恢复后的同一任务回到待办；旧 transcript 没有被改写。" : "The same task returns to pending after native restore; old transcript stays unchanged." },
    { name: "Write", path: "docs/check-result.json", created: false, content: { passed: true, checks: ["types", "render"] }, encoding: "UTF-8" },
    { name: "Grep", pattern: "obsoleteTheme", path: "components", matches: [], matchCount: 0, fileCount: 0 },
    { name: "Glob", pattern: "missing/**/*.tsx", files: [] },
    { name: "Bash", cmd: "npm run typecheck", cwd: demoPath("omp-web"), exit: 2, status: "error", output: "\u001b[33m> tsc --noEmit\u001b[0m\ncomponents/MermaidBlock.tsx(147,7): error TS2322\nType 'string' is not assignable to type 'MermaidTheme'.\n", dur: "1.24s" },
    { name: "Bash", cmd: "npm run check -- --only renderer", cwd: demoPath("omp-web"), exit: 0, output: "Preparing 10%\rPreparing 100%\n" + Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(2, "0")} PASS conversation/check-${i + 1}.test.tsx`).join("\n") + "\n\u001b[32m80 suites passed\u001b[0m", meta: { truncation: { elidedBytes: 12000, elidedLines: 120, artifactId: "gallery-full-output" } } },
    { name: "LSP", action: "references", refs: [{ file: "components/MermaidBlock.tsx", line: 147, text: "theme: getCodeTheme()," }, { file: "hooks/useCodeTheme.ts", line: 8, text: "export function getCodeTheme(): MermaidTheme {" }] },
    { name: "Eval", lang: "javascript", cells: [
      { code: "print(results)", status: "ok", stdout: zh ? "检查表\n结构化摘要\nMarkdown 报告" : "Checklist\nStructured summary\nMarkdown report", views: [
        { text: zh ? "检查表" : "Checklist", view: { kind: "table", columns: [{ head: zh ? "项目" : "Suite", numeric: false }, { head: zh ? "数量" : "Count", numeric: true }, { head: zh ? "耗时 ms" : "Duration ms", numeric: true }], rows: [["types", 18, 980], ["render", 24, 1240], ["preview", 12, 680]] } },
        { text: zh ? "结构化摘要" : "Structured summary", view: { kind: "json", value: { ready: true, count: 54, warning: null, nested: { platforms: ["Windows", "macOS"], empty: {} } } } },
        { text: zh ? "Markdown 报告" : "Markdown report", view: { kind: "markdown", text: zh ? "### 结果\n\n**通过** · `54 checks`\n\n- [x] 正文\n- [x] 工具卡" : "### Results\n\n**PASS** · `54 checks`\n\n- [x] Prose\n- [x] Tool cards" } },
      ] },
      { code: "completion('check theme')", status: "error", stdout: "fallback pending", stderr: "Primary model unavailable", statusEvents: [{ op: "kernel_restart", runtime: "JS", stateLost: true }, { op: "mcp_progress", id: "gallery-progress", tool: zh ? "检查记录" : "Check report", progress: 3, total: 5, message: zh ? "整理摘要" : "Formatting summary" }, { op: "mcp_progress", id: "gallery-indeterminate", tool: zh ? "资源读取" : "Read resources", progress: 12, message: zh ? "等待剩余结果" : "Waiting for remaining results" }] },
    ] },
    { name: "Hub", op: "status", jobs: [{ id: "gallery-widget", label: zh ? "检查摘要" : "Check summary", status: "completed", completionPercent: 100, widget: { title: "Renderer", state: "live", updatedAt: 1794207600000, headline: { label: zh ? "通过" : "Passed", text: "54 / 54", trend: { text: "+12", tone: "success" } }, stage: zh ? "检查完成" : "Checks completed", blocks: [
      { kind: "text", text: zh ? "正文与工具检查完成" : "Prose and tool checks finished", tone: "success" },
      { kind: "meter", label: zh ? "完成度" : "Completion", value: 1, text: "54 / 54", tone: "success" },
      { kind: "spark", label: zh ? "每轮检查数" : "Checks per round", values: [12, 18, 24, 36, 54], min: 0, max: 60, last: "54", tone: "accent" },
      { kind: "bars", label: zh ? "检查分组" : "Check groups", max: 24, items: [{ label: "types", value: 18, text: "18" }, { label: "render", value: 24, text: "24", tone: "success" }] },
      { kind: "stat", items: [{ label: zh ? "耗时" : "Duration", text: "1.24s", trend: { text: "−0.3s", tone: "success" } }] },
      { kind: "grid", label: zh ? "平台" : "Platforms", items: [{ label: "Windows", text: zh ? "通过" : "Pass", tone: "success" }, { label: "macOS", text: zh ? "待复查" : "Pending", tone: "pending" }] },
    ] } }] },
    { name: "Hub", status: "completed", jobId: "gallery-summary", result: { checks: 54, passed: true } },
    { name: "Eval", lang: "javascript", cells: [{ code: "display(raster); display(kitty); display(sixel);", status: "ok", stdout: "Raster / Kitty PNG / Kitty RGBA / Sixel" }],
      media: [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=" }],
      output: "\u001b_Ga=T,f=100;iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=\u001b\\\n\u001b_Ga=T,f=32,s=2,v=2;csu0/3LLtP9yy7T/csu0/w==\u001b\\\n\u001bPq\"1;1;24;12#1;2;45;80;70!24~-!24~\u001b\\\n\u001b_Ga=T,f=24,s=2,v=2;" + btoa(String.fromCharCode(114, 203, 180, 114, 203, 180, 114, 203, 180, 114, 203, 180)) + "\u001b\\" },
    { name: "Recall", query: zh ? "尚未记录的关键词" : "Unrecorded keyword", count: 0, excerpts: [] },
    { name: "Resolve", action: "discard", reason: zh ? "丢弃旧主题强制转换，保留原返回类型。" : "Discard legacy theme cast and preserve the original return type." },
    { name: "mcp__github_get_release", args: { repo: "agegr/pi-web", tag: "v0.8.1" }, output: { name: "v0.8.1", assets: [{ name: "notes.md", size: 2400 }], published: true } },
    { name: "read", path: "xd://read", xdev: { tool: "read", args: { path: "components/MermaidBlock.tsx" }, inner: { preview: ["const theme = getCodeTheme();"], lines: 1 }, result: "const theme = getCodeTheme();" } },
    { name: "read", path: "xd://powershell", xdev: { tool: "powershell", args: { cmd: "Get-Location" }, inner: { cwd: demoPath("omp-web"), output: demoPath("omp-web"), exit: 0 } } },
  ];
}

export const CONTENT_GALLERY_VARIANTS: readonly Card[] = getContentGalleryVariants();
