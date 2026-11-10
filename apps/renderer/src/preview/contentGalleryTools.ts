import type { ConversationContentBlock, JsonValue } from "@omp-studio/studio-protocol";
import { NATIVE_TOOL_GALLERY } from "./nativeToolGallery";
import { demoPath } from "./demoPaths";

type Card = { readonly [key: string]: JsonValue };

const EXTRA_CARDS: readonly Card[] = [
  { kind: "find", name: "Find", query: "会话切换后保留阅读位置", elapsedMs: 126, hits: [
    { rel: "conversation/useConversationScroll.ts", contentScore: 0.96, ranges: [{ start: 42, end: 45, snippet: "const anchor = captureReadingAnchor(scroller);\nrestoreReadingAnchor(scroller, anchor);" }] },
    { rel: "conversation/ConversationPane.tsx", contentScore: 0.81, ranges: [{ start: 110, end: 111, snippet: "retainConversationWhileRemounting(current, previous, sessionId)" }] },
  ] },
  { kind: "process", name: "read", path: "proc://renderer-check", daemon: { name: "renderer-check", state: "exited", exitCode: 0, persist: false }, status: "completed", result: { stdout: "72 suites passed", exitCode: 0 } },
  { kind: "agent_message", name: "write", path: "agent://scout", status: "delivered", result: { agent: "scout", message: "请补充浅色与深色下的正文检查记录。", accepted: true } },
  { kind: "documentation", name: "read", path: "omp://tools/read", args: { path: "omp://tools/read" }, output: "# Read\n读取文件、进程、Agent 消息和内置文档。\n\n支持 offset / limit 与 Markdown 结果。" },
  { kind: "wait", name: "Wait", op: "wait", jobs: [
    { id: "gallery-types", label: "类型检查", type: "process", status: "completed", completionPercent: 100, exitCode: 0, durationMs: 980 },
    { id: "gallery-render", label: "界面检查", type: "agent", status: "running", stage: "检查窄阅读列", completionPercent: 68, durationMs: 4200 },
    { id: "gallery-failed", label: "旧版本复查", type: "process", status: "failed", exitCode: 2, durationMs: 1240 },
  ] },
  { kind: "web", name: "Web", query: "Mermaid theme configuration", answer: "主题可用 default、dark、forest 和 neutral，配置变化后重新渲染图表。", cites: [{ title: "Mermaid 文档", url: "https://mermaid.js.org/config/theming.html" }] },
  { kind: "report_issue", name: "Report Issue", args: { title: "窄窗口内长路径换行", category: "renderer" }, output: { recorded: true, issue: "gallery-001", attachments: ["narrow-layout.png"] } },
  { kind: "extension_tool", name: "Extension Tool", args: { action: "inspect", scope: ["conversation", "tools"], options: { verbose: true } }, output: { summary: "扩展工具使用通用 Args / Output 卡", count: 2, ready: true, warning: null } },
];

export const CONTENT_GALLERY_TOOLS = [...NATIVE_TOOL_GALLERY.filter(card => !["ask", "askuser", "think"].includes(String(card.kind))), ...EXTRA_CARDS];

export function galleryToolBlocks(cards: readonly Card[], chapter: string): ConversationContentBlock[] {
  return cards.flatMap((card, index): ConversationContentBlock[] => {
    const toolName = String(card.name), toolCallId = `content-gallery-${chapter}-${index}`;
    return [
      { type: "toolCall", toolCallId, toolName, arguments: card },
      { type: "toolResult", toolCallId, toolName, data: card, ...(typeof card.output === "string" ? { output: card.output } : {}), isError: card.status === "error" },
    ];
  });
}

export const CONTENT_GALLERY_VARIANTS: readonly Card[] = [
  { name: "Read", path: "docs/UPSTREAM-SYNC.md", contentType: "text/markdown", preview: ["## Markdown 读取结果", "", "**类型检查通过**，保留 `MermaidTheme` 返回类型。", "", "- [x] 文档入口", "- [ ] 窄窗口复查"] },
  { name: "Write", path: "docs/check-result.json", created: false, content: { passed: true, checks: ["types", "render"] }, encoding: "UTF-8" },
  { name: "Grep", pattern: "obsoleteTheme", path: "components", matches: [], matchCount: 0, fileCount: 0 },
  { name: "Glob", pattern: "missing/**/*.tsx", files: [] },
  { name: "Bash", cmd: "npm run typecheck", cwd: demoPath("omp-web"), exit: 2, status: "error", output: "\u001b[33m> tsc --noEmit\u001b[0m\ncomponents/MermaidBlock.tsx(147,7): error TS2322\nType 'string' is not assignable to type 'MermaidTheme'.\n", dur: "1.24s" },
  { name: "Bash", cmd: "npm run check -- --only renderer", cwd: demoPath("omp-web"), exit: 0, output: "Preparing 10%\rPreparing 100%\n" + Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(2, "0")} PASS conversation/check-${i + 1}.test.tsx`).join("\n") + "\n\u001b[32m80 suites passed\u001b[0m", meta: { truncation: { elidedBytes: 12000, elidedLines: 120, artifactId: "gallery-full-output" } } },
  { name: "LSP", action: "references", refs: [{ file: "components/MermaidBlock.tsx", line: 147, text: "theme: getCodeTheme()," }, { file: "hooks/useCodeTheme.ts", line: 8, text: "export function getCodeTheme(): MermaidTheme {" }] },
  { name: "Eval", lang: "javascript", cells: [
    { code: "print(results)", status: "ok", stdout: "检查表\n结构化摘要\nMarkdown 报告", views: [
      { text: "检查表", view: { kind: "table", columns: [{ head: "项目", numeric: false }, { head: "数量", numeric: true }, { head: "耗时 ms", numeric: true }], rows: [["types", 18, 980], ["render", 24, 1240], ["preview", 12, 680]] } },
      { text: "结构化摘要", view: { kind: "json", value: { ready: true, count: 54, warning: null, nested: { platforms: ["Windows", "macOS"], empty: {} } } } },
      { text: "Markdown 报告", view: { kind: "markdown", text: "### 结果\n\n**通过** · `54 checks`\n\n- [x] 正文\n- [x] 工具卡" } },
    ] },
    { code: "completion('check theme')", status: "error", stdout: "fallback pending", stderr: "Primary model unavailable", statusEvents: [{ op: "kernel_restart", runtime: "JS", stateLost: true }, { op: "mcp_progress", id: "gallery-progress", tool: "检查记录", progress: 3, total: 5, message: "整理摘要" }, { op: "mcp_progress", id: "gallery-indeterminate", tool: "资源读取", progress: 12, message: "等待剩余结果" }] },
  ] },
  { name: "Hub", op: "status", jobs: [{ id: "gallery-widget", label: "检查摘要", status: "completed", completionPercent: 100, widget: { title: "Renderer", state: "live", updatedAt: 1794207600000, headline: { label: "通过", text: "54 / 54", trend: { text: "+12", tone: "success" } }, stage: "检查完成", blocks: [
    { kind: "text", text: "正文与工具检查完成", tone: "success" },
    { kind: "meter", label: "完成度", value: 1, text: "54 / 54", tone: "success" },
    { kind: "spark", label: "每轮检查数", values: [12, 18, 24, 36, 54], min: 0, max: 60, last: "54", tone: "accent" },
    { kind: "bars", label: "检查分组", max: 24, items: [{ label: "types", value: 18, text: "18" }, { label: "render", value: 24, text: "24", tone: "success" }] },
    { kind: "stat", items: [{ label: "耗时", text: "1.24s", trend: { text: "−0.3s", tone: "success" } }] },
    { kind: "grid", label: "平台", items: [{ label: "Windows", text: "通过", tone: "success" }, { label: "macOS", text: "待复查", tone: "pending" }] },
  ] } }] },
  { name: "Hub", status: "completed", jobId: "gallery-summary", result: { checks: 54, passed: true } },
  { name: "Eval", lang: "javascript", cells: [{ code: "display(raster); display(kitty); display(sixel);", status: "ok", stdout: "Raster / Kitty PNG / Kitty RGBA / Sixel" }],
    media: [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=" }],
    output: "\u001b_Ga=T,f=100;iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=\u001b\\\n\u001b_Ga=T,f=32,s=2,v=2;csu0/3LLtP9yy7T/csu0/w==\u001b\\\n\u001bPq\"1;1;24;12#1;2;45;80;70!24~-!24~\u001b\\\n\u001b_Ga=T,f=24,s=2,v=2;" + btoa(String.fromCharCode(114, 203, 180, 114, 203, 180, 114, 203, 180, 114, 203, 180)) + "\u001b\\" },
  { name: "Recall", query: "尚未记录的关键词", count: 0, excerpts: [] },
  { name: "Resolve", action: "discard", reason: "丢弃旧主题强制转换，保留原返回类型。" },
  { name: "mcp__github_get_release", args: { repo: "agegr/pi-web", tag: "v0.8.1" }, output: { name: "v0.8.1", assets: [{ name: "notes.md", size: 2400 }], published: true } },
  { name: "read", path: "xd://read", xdev: { tool: "read", args: { path: "components/MermaidBlock.tsx" }, inner: { preview: ["const theme = getCodeTheme();"], lines: 1 }, result: "const theme = getCodeTheme();" } },
  { name: "read", path: "xd://powershell", xdev: { tool: "powershell", args: { cmd: "Get-Location" }, inner: { cwd: demoPath("omp-web"), output: demoPath("omp-web"), exit: 0 } } },
];
