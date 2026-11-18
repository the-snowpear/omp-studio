import type { ConversationContentBlock, ConversationItem, JsonValue } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";
import { demoPath } from "./demoPaths";
import landscape from "./assets/landscape.png?url";

const text = (value: string): ConversationContentBlock => ({ type: "text", text: value });
const fence = (language: string, source: string) => `\`\`\`${language}\n${source}\n\`\`\``;
type Turn = { user: string; answer: string | readonly ConversationContentBlock[] };

/** Stable, independent stories: switching a sidebar chat changes the actual transcript. */
function conversation(id: string, turns: readonly Turn[]): readonly ConversationItem[] {
  return turns.flatMap((turn, index): ConversationItem[] => {
    const userId = `preview-${id}-user-${index}`;
    return [
      { kind: "message", itemId: userId, parentId: index ? `preview-${id}-assistant-${index - 1}` : null,
        createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2)).toISOString(), role: "user", content: [text(turn.user)] },
      { kind: "message", itemId: `preview-${id}-assistant-${index}`, parentId: userId,
        createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2 + 1)).toISOString(), role: "assistant",
        content: typeof turn.answer === "string" ? [text(turn.answer)] : turn.answer },
    ];
  });
}

function tool(id: string, name: string, args: JsonValue, data: JsonValue, output = "", isError = false): ConversationContentBlock[] {
  return [
    { type: "toolCall", toolCallId: `preview-check-${id}`, toolName: name, arguments: args },
    { type: "toolResult", toolCallId: `preview-check-${id}`, toolName: name, data, output, isError },
  ];
}

function buildMarkdown(zh: boolean): readonly ConversationItem[] {
  return conversation("markdown", zh ? [
    {
      user: "整理这次上游同步的检查报告。把结论、变更表和未完成项写清楚，我还想看看窄窗口下的正文排版。",
      answer: [
        "# 上游同步检查报告",
        "",
        "已完成依赖对齐和文档整理。**类型检查通过**，但预览缩放仍有一个待确认的交互项。本文覆盖中文、English、数字 `0 / 1 / 100%` 和带空格的文件名。",
        "",
        "## 变更范围",
        "",
        "| 模块 | 修改 | 结果 | 后续动作 |",
        "| :--- | :--- | :---: | :--- |",
        "| 依赖 | 对齐上游 v0.8.1 | 通过 | 保留锁文件 |",
        "| 会话 | 分页游标与恢复路径 | 通过 | 检查切换后的滚动位置 |",
        "| Mermaid | 全屏缩放、拖拽和主题 | 待确认 | 核对深色主题文字对比度及窄窗口工具栏 |",
        "| 文档 | 中文路径与带空格文件名 | 通过 | 更新 `docs/上游同步检查记录 v0.8.1.md` |",
        "",
        "> **需要确认**：松开鼠标后是否保留拖拽惯性？目前采用松手即停。",
        ">",
        "> 验收时分别使用触控板和鼠标滚轮，避免只覆盖一种输入方式。",
        "",
        "### 验收顺序",
        "",
        "1. 打开已有会话，确认中文标题与文件引用。",
        "2. 切换主题并调整窗口宽度。",
        "   - 观察表格是否能横向滚动。",
        "   - 观察段落、行内代码和工具按钮是否互相遮挡。",
        "3. 展开工具结果，再回到正文继续阅读。",
        "",
        "- [x] 保留 Studio Bridge 与本地会话目录",
        "- [x] 补充依赖与文档差异",
        "- [ ] 确认全屏拖拽惯性",
        "- [ ] 检查 400px 阅读列的长内容",
        "",
        "旧方案 ~~在每次滚动时重建图表~~ 已移除。现在只更新 *视口变换*，并保留 **Ctrl + 滚轮** 的缩放入口。",
        "",
        "---",
        "",
        "参考：[GFM 格式说明](https://github.github.com/gfm/)。特殊字符 `a < b && c > d`、转义符 \\* 和长标识符 `conversation_workspace_preview_retain_reading_position_after_switch_and_resize` 应完整保留。",
      ].join("\n"),
    },
    {
      user: "把代码、结构化数据和图片也放进来，方便核对不同内容块之间的间距。",
      answer: [
        "## 类型与结构化数据",
        "下面的 TypeScript 是代码片段，JSON 是检查结果记录。",
        fence("ts", 'type CheckResult = { name: string; passed: boolean; durationMs: number };\n\nexport function summarize(results: CheckResult[]) {\n  const passed = results.filter(result => result.passed).length;\n  return { passed, total: results.length, ready: passed === results.length };\n}'),
        fence("json", '{\n  "project": "omp-web",\n  "checks": ["types", "markdown", "terminal"],\n  "result": { "passed": 18, "failed": 0 },\n  "pending": null\n}'),
        "### 图片与说明",
        `![预览布局参考：山峦、湖面与天空](${landscape})`,
        "图片沿用本地素材，可以检查宽高比、正文留白和深色主题下的边界。",
        "### 最终结论",
        "实现部分已完成。交互确认仍保留在检查列表中；确认后即可补充验收记录。",
      ].join("\n\n"),
    },
  ] : [
    {
      user: "Write up the upstream sync verification report. Make the conclusion, change table, and open items clear — I also want to check body typography in a narrow pane.",
      answer: [
        "# Upstream Sync Verification Report",
        "",
        "Dependency alignment and docs cleanup are complete. **Type checks pass**, with one zoom-interaction detail left to confirm. This note covers tables, inline code, numbers `0 / 1 / 100%`, and filenames with spaces.",
        "",
        "## Scope of Changes",
        "",
        "| Module | Change | Result | Follow-up |",
        "| :--- | :--- | :---: | :--- |",
        "| Dependencies | Align upstream v0.8.1 | Passed | Keep lockfile pinned |",
        "| Sessions | Pagination cursor & restore path | Passed | Verify scroll position after switch |",
        "| Mermaid | Fullscreen zoom, pan & theme | Pending | Check dark-theme contrast and narrow toolbar |",
        "| Docs | Quoted paths & spaced filenames | Passed | Update `docs/upstream sync notes v0.8.1.md` |",
        "",
        "> **Needs confirmation**: Should pan inertia continue after mouse release? Currently pan stops immediately on release.",
        ">",
        "> Test with both trackpad gestures and a mouse wheel during sign-off so neither input path is missed.",
        "",
        "### Sign-off Order",
        "",
        "1. Open an existing session and confirm titles and file references.",
        "2. Switch themes and resize the window width.",
        "   - Check that wide tables scroll horizontally.",
        "   - Check that paragraphs, inline code, and toolbar buttons do not overlap.",
        "3. Expand a tool result, then return to reading the main response.",
        "",
        "- [x] Keep Studio Bridge and the local sessions directory intact",
        "- [x] Document dependency and guide diffs",
        "- [ ] Confirm fullscreen drag inertia behavior",
        "- [ ] Inspect long content inside a 400px reading column",
        "",
        "The old approach of ~~rebuilding diagrams on every scroll~~ is removed. Only the *viewport transform* updates now, keeping **Ctrl + wheel** zoom.",
        "",
        "---",
        "",
        "Reference: [GFM Specification](https://github.github.com/gfm/). Special tokens `a < b && c > d`, escaped \\*, and long identifiers `conversation_workspace_preview_retain_reading_position_after_switch_and_resize` must render intact.",
      ].join("\n"),
    },
    {
      user: "Include code, structured data, and an image too so we can inspect spacing across block types.",
      answer: [
        "## Types & Structured Data",
        "Below is a TypeScript helper alongside a JSON check summary.",
        fence("ts", 'type CheckResult = { name: string; passed: boolean; durationMs: number };\n\nexport function summarize(results: CheckResult[]) {\n  const passed = results.filter(result => result.passed).length;\n  return { passed, total: results.length, ready: passed === results.length };\n}'),
        fence("json", '{\n  "project": "omp-web",\n  "checks": ["types", "markdown", "terminal"],\n  "result": { "passed": 18, "failed": 0 },\n  "pending": null\n}'),
        "### Image & Caption",
        `![Preview layout reference: mountains, lake, and sky](${landscape})`,
        "The image uses a local asset so aspect ratio, margins, and dark-theme borders can be verified offline.",
        "### Final Conclusion",
        "Implementation is complete. The interaction question remains on the checklist and will be recorded once signed off.",
      ].join("\n\n"),
    },
  ]);
}

function buildCommands(zh: boolean): readonly ConversationItem[] {
  return conversation("commands", zh ? [
    {
      user: "给我一组可以检查命令块的例子，包括一行命令、多行命令、引号、变量和普通代码。",
      answer: [
        "## Bash · 单行与长参数",
        "先查看当前分支及工作区变更：",
        fence("bash", "git status --short --branch"),
        "多个检查切片放在同一行，窄列中应自然换行，复制后仍是一条命令：",
        fence("bash", "npm run check -- --only renderer --suite CommandBlock --suite markdownWorker --suite markdownBlocks --suite TerminalPane --suite terminalSessions"),
        "## Bash · 变量、管道与多行",
        fence("bash", '# 目录名包含空格，保留引号与换行\nreport_dir="docs/check reports"\nprintf \'Checking: %s\\n\' "$report_dir"\ngit diff --name-only | sort\n\nif [ -d "$report_dir" ]; then\n  find "$report_dir" -maxdepth 1 -type f\nfi'),
        "多行续行符也应随原文复制：",
        fence("bash", 'npm run check -- \\\n  --only renderer \\\n  --suite CommandBlock \\\n  --suite markdownWorker'),
      ].join("\n\n"),
    },
    {
      user: "Windows 的 PowerShell 也给一组，并放一段看起来像命令的普通文本作对照。",
      answer: [
        "## PowerShell · 路径、管道与中文",
        fence("pwsh", '# 只查看目录和文件，不修改内容\n$root = Join-Path (Get-Location) "apps/renderer/src"\nGet-ChildItem -LiteralPath $root -Filter "*.tsx" |\n  Select-Object -First 5 Name, Length\nWrite-Output "检查完成：中文路径与空格"'),
        "`powershell` 与 `ps1` 标签同样表示 PowerShell 命令：",
        fence("powershell", 'Get-Location\nGet-Command git | Select-Object Name, Source'),
        fence("ps1", '$items = @("浅色主题", "深色主题", "窄窗口")\n$items | ForEach-Object { Write-Output "检查：$_" }'),
        "### 其他 Shell",
        fence("sh", 'printf \'%s\\n\' "ready"'),
        fence("zsh", 'printf \'%s\\n\' "zsh ready"'),
        "### 普通代码与日志",
        "下面两块分别是 TypeScript 与文本日志，适合对照代码框和命令框的功能差异。",
        fence("ts", 'const command = "npm run check -- --only renderer";\nconsole.log({ command, shell: "bash" });'),
        fence("text", '$ npm run check -- --only renderer\n✓ TypeScript compiled\n✓ 18 checks passed\nexit 0'),
        "复制按钮应保留原始文本；命令块中的参数、注释、变量和字符串应能清楚区分。",
      ].join("\n\n"),
    },
  ] : [
    {
      user: "Give me a set of examples to test command blocks: single-line, multi-line, quotes, variables, and plain code.",
      answer: [
        "## Bash · Single-line & Long Flags",
        "Inspect the current branch and working tree status first:",
        fence("bash", "git status --short --branch"),
        "Long single-line check invocations should wrap cleanly in narrow columns while copying as one command:",
        fence("bash", "npm run check -- --only renderer --suite CommandBlock --suite markdownWorker --suite markdownBlocks --suite TerminalPane --suite terminalSessions"),
        "## Bash · Variables, Pipes & Multi-line",
        fence("bash", '# Preserve quotes and newlines around spaced directory names\nreport_dir="docs/check reports"\nprintf \'Checking: %s\\n\' "$report_dir"\ngit diff --name-only | sort\n\nif [ -d "$report_dir" ]; then\n  find "$report_dir" -maxdepth 1 -type f\nfi'),
        "Line continuations should also be preserved when copied:",
        fence("bash", 'npm run check -- \\\n  --only renderer \\\n  --suite CommandBlock \\\n  --suite markdownWorker'),
      ].join("\n\n"),
    },
    {
      user: "Include a Windows PowerShell set as well, plus plain text and code blocks for comparison.",
      answer: [
        "## PowerShell · Paths, Pipelines & Unicode",
        fence("pwsh", '# Read-only directory inspection\n$root = Join-Path (Get-Location) "apps/renderer/src"\nGet-ChildItem -LiteralPath $root -Filter "*.tsx" |\n  Select-Object -First 5 Name, Length\nWrite-Output "Check finished: spaced and nested paths"'),
        "`powershell` and `ps1` fences are also recognized as PowerShell commands:",
        fence("powershell", 'Get-Location\nGet-Command git | Select-Object Name, Source'),
        fence("ps1", '$items = @("Light theme", "Dark theme", "Narrow window")\n$items | ForEach-Object { Write-Output "Checking: $_" }'),
        "### Other Shells",
        fence("sh", 'printf \'%s\\n\' "ready"'),
        fence("zsh", 'printf \'%s\\n\' "zsh ready"'),
        "### Regular Code & Logs",
        "Below are TypeScript and plain text blocks to contrast code fences against executable command blocks.",
        fence("ts", 'const command = "npm run check -- --only renderer";\nconsole.log({ command, shell: "bash" });'),
        fence("text", '$ npm run check -- --only renderer\n✓ TypeScript compiled\n✓ 18 checks passed\nexit 0'),
        "Copying must keep the raw text intact, while flags, comments, variables, and strings remain visually distinct.",
      ].join("\n\n"),
    },
  ]);
}

function buildRecovery(zh: boolean): readonly ConversationItem[] {
  return conversation("recovery", zh ? [
    {
      user: "检查 MermaidBlock 的类型错误，展示定位、失败输出和修复后的复查结果。",
      answer: [
        { type: "thinking", text: "先读主题配置，再检索 Mermaid 初始化入口；保留第一次失败的输出，才能对照修复是否覆盖了原问题。" },
        ...tool("read", "read", { path: "components/MermaidBlock.tsx", offset: 142, limit: 8 }, {
          offset: 142, lines: 5, encoding: "UTF-8", size: "6.2 KB",
          preview: ['const codeTheme: string = getCodeTheme();', 'mermaid.initialize({', '  theme: codeTheme,', '  securityLevel: "strict",', '});'],
        }),
        ...tool("grep", "grep", { pattern: "getCodeTheme|MermaidTheme", path: "components" }, {
          matchCount: 3, fileCount: 2, matches: [
            { file: "components/MermaidBlock.tsx", line: "144", text: "const codeTheme: string = getCodeTheme();" },
            { file: "components/MermaidBlock.tsx", line: "147", text: "theme: codeTheme," },
            { file: "hooks/useCodeTheme.ts", line: "8", text: "export function getCodeTheme(): MermaidTheme {" },
          ],
        }),
        ...tool("failed", "bash", { command: "npm run typecheck", cwd: demoPath("omp-web") }, { exit: 2, wallTimeMs: 1240 },
          '\u001b[33m> tsc --noEmit\u001b[0m\ncomponents/MermaidBlock.tsx(147,7): error TS2322:\n  Type \'string\' is not assignable to type \'MermaidTheme\'.\n\nFound 1 error.\n', true),
        text("已定位：局部变量被标成宽泛的 `string`，丢失了 `getCodeTheme()` 返回的主题联合类型。修复只需保留原返回类型。"),
      ],
    },
    {
      user: "修掉它，再确认没有遗漏其他入口。",
      answer: [
        ...tool("edit", "edit", { path: "components/MermaidBlock.tsx" }, { diff: [
          [" ", "143", "143", "const mermaid = await import(\"mermaid\");"],
          ["-", "144", "", "const codeTheme: string = getCodeTheme();"],
          ["+", "", "144", "const codeTheme = getCodeTheme();"],
          [" ", "145", "145", "mermaid.initialize({ theme: codeTheme });"],
        ] }),
        ...tool("passed", "bash", { command: "npm run typecheck", cwd: demoPath("omp-web") }, { exit: 0, wallTimeMs: 980 },
          '\u001b[32m✓ TypeScript compiled\u001b[0m\n0 errors\n'),
        ...tool("empty", "grep", { pattern: "codeTheme: string", path: "components" }, { matchCount: 0, fileCount: 0, matches: [] }, "No matches found."),
        text("**复查通过**：类型检查为 0 错误，旧写法检索为 0 命中。第一次失败记录保留在上一轮，可对照错误卡、Diff 和成功输出。"),
      ],
    },
    {
      user: "再给我完整的检查日志和结构化摘要，长输出也要能检查。",
      answer: [
        ...tool("long-output", "bash", { command: "npm run check -- --only renderer", cwd: demoPath("omp-web") }, { exit: 0, wallTimeMs: 18420 },
          Array.from({ length: 72 }, (_, i) => `${String(i + 1).padStart(2, "0")}  PASS  ${["conversation", "composer", "dock", "files", "terminal", "preview"][i % 6]}/${["render", "keyboard", "selection", "scroll", "restore", "theme"][Math.floor(i / 6) % 6]}.test.tsx  (${i % 5 + 1} checks)`).join("\n") + "\n\n72 suites passed · 213 checks passed · 18.42s"),
        ...tool("summary", "eval", { code: "summarize(checks)" }, { cells: [{ code: "summarize(checks)", status: "ok", stdout: '{"passed":72,"failed":0}', views: [{ text: "检查结果", view: { kind: "json", value: { passed: 72, failed: 0, repaired: ["MermaidBlock.tsx:144"], platforms: { windows: "passed", macOS: "pending" } } } }] }] }),
        text("检查记录已整理。长日志可在工具卡内部滚动，结构化摘要可展开字段；macOS 复查仍标为待完成。"),
      ],
    },
  ] : [
    {
      user: "Inspect the MermaidBlock type error and show the location, failing output, and post-fix verification.",
      answer: [
        { type: "thinking", text: "Read the theme helper first, then grep for Mermaid initialization; keep the initial failing output so the fix can be verified against the original error." },
        ...tool("read", "read", { path: "components/MermaidBlock.tsx", offset: 142, limit: 8 }, {
          offset: 142, lines: 5, encoding: "UTF-8", size: "6.2 KB",
          preview: ['const codeTheme: string = getCodeTheme();', 'mermaid.initialize({', '  theme: codeTheme,', '  securityLevel: "strict",', '});'],
        }),
        ...tool("grep", "grep", { pattern: "getCodeTheme|MermaidTheme", path: "components" }, {
          matchCount: 3, fileCount: 2, matches: [
            { file: "components/MermaidBlock.tsx", line: "144", text: "const codeTheme: string = getCodeTheme();" },
            { file: "components/MermaidBlock.tsx", line: "147", text: "theme: codeTheme," },
            { file: "hooks/useCodeTheme.ts", line: "8", text: "export function getCodeTheme(): MermaidTheme {" },
          ],
        }),
        ...tool("failed", "bash", { command: "npm run typecheck", cwd: demoPath("omp-web") }, { exit: 2, wallTimeMs: 1240 },
          '\u001b[33m> tsc --noEmit\u001b[0m\ncomponents/MermaidBlock.tsx(147,7): error TS2322:\n  Type \'string\' is not assignable to type \'MermaidTheme\'.\n\nFound 1 error.\n', true),
        text("Root cause found: the local variable was widened to `string`, dropping the `MermaidTheme` union returned by `getCodeTheme()`. Keeping the inferred return type resolves it."),
      ],
    },
    {
      user: "Fix it and confirm no other call sites remain.",
      answer: [
        ...tool("edit", "edit", { path: "components/MermaidBlock.tsx" }, { diff: [
          [" ", "143", "143", "const mermaid = await import(\"mermaid\");"],
          ["-", "144", "", "const codeTheme: string = getCodeTheme();"],
          ["+", "", "144", "const codeTheme = getCodeTheme();"],
          [" ", "145", "145", "mermaid.initialize({ theme: codeTheme });"],
        ] }),
        ...tool("passed", "bash", { command: "npm run typecheck", cwd: demoPath("omp-web") }, { exit: 0, wallTimeMs: 980 },
          '\u001b[32m✓ TypeScript compiled\u001b[0m\n0 errors\n'),
        ...tool("empty", "grep", { pattern: "codeTheme: string", path: "components" }, { matchCount: 0, fileCount: 0, matches: [] }, "No matches found."),
        text("**Re-check passed**: typecheck reports 0 errors and grep for the old annotation returned 0 matches. The initial failure stays visible above for before/after comparison."),
      ],
    },
    {
      user: "Also give me the full check log and a structured summary so we can verify long outputs.",
      answer: [
        ...tool("long-output", "bash", { command: "npm run check -- --only renderer", cwd: demoPath("omp-web") }, { exit: 0, wallTimeMs: 18420 },
          Array.from({ length: 72 }, (_, i) => `${String(i + 1).padStart(2, "0")}  PASS  ${["conversation", "composer", "dock", "files", "terminal", "preview"][i % 6]}/${["render", "keyboard", "selection", "scroll", "restore", "theme"][Math.floor(i / 6) % 6]}.test.tsx  (${i % 5 + 1} checks)`).join("\n") + "\n\n72 suites passed · 213 checks passed · 18.42s"),
        ...tool("summary", "eval", { code: "summarize(checks)" }, { cells: [{ code: "summarize(checks)", status: "ok", stdout: '{"passed":72,"failed":0}', views: [{ text: "Check summary", view: { kind: "json", value: { passed: 72, failed: 0, repaired: ["MermaidBlock.tsx:144"], platforms: { windows: "passed", macOS: "pending" } } } }] }] }),
        text("Verification log recorded. The full output scrolls inside the tool card, structured fields expand inline, and the macOS check remains marked pending."),
      ],
    },
  ]);
}

function buildArchive(zh: boolean): readonly ConversationItem[] {
  return [
    ...conversation("archive", [{
      user: zh ? "整理 session 存储层重构的上下文，方便稍后恢复。" : "Summarize context for the session storage refactor so it can be resumed later.",
      answer: zh ? "已完成会话索引与正文分离。归档内容只读；恢复时从最近的检查点继续。" : "Separated the session index from transcript bodies. Archive entries remain read-only; resuming continues from the latest checkpoint.",
    }]),
    {
      kind: "compaction",
      itemId: "preview-archive-compaction",
      parentId: "preview-archive-assistant-0",
      createdAt: "2026-11-09T06:03:00.000Z",
      shortSummary: zh ? "会话索引重构 · 8 轮上下文已整理" : "Session index refactor · 8 turns compacted",
      summary: zh
        ? "## 已完成\n- 会话索引按工作区分组。\n- 归档正文使用游标分页。\n- 切换会话保留阅读位置。\n\n## 继续时检查\n- 长会话向上加载。\n- 恢复草稿与模型配置。\n- 归档会话仍可只读查看。"
        : "## Completed\n- Grouped session indexes by workspace.\n- Added cursor pagination for archived transcripts.\n- Preserved scroll position across session switches.\n\n## Check when resuming\n- Load older pages on long transcripts.\n- Restore composer drafts and model settings.\n- Keep archived sessions readable in read-only mode.",
    },
    {
      kind: "message",
      itemId: "preview-archive-final",
      parentId: "preview-archive-compaction",
      createdAt: "2026-11-09T06:04:00.000Z",
      role: "assistant",
      content: [text(zh
        ? "上下文已整理，原始检查结论保留在摘要中。下一步检查分页与草稿恢复。\n\n- [x] 索引迁移\n- [x] 归档读取\n- [ ] 跨版本恢复"
        : "Context compacted with prior findings preserved in the summary above. Next step: verify pagination and draft restoration.\n\n- [x] Index migration\n- [x] Archive reader\n- [ ] Cross-version recovery")],
    },
  ];
}

export function getPreviewThreadItems(zh = isZh()): Readonly<Record<string, readonly ConversationItem[]>> {
  return {
    t2: conversation("audit", zh ? [
      { user: "审查上游同步变更，按优先级列出问题。", answer: "## 审查结果\n\n发现 **1 个需要修复的问题**，以及 2 个待人工检查项。\n\n| 优先级 | 位置 | 问题 |\n| --- | --- | --- |\n| P1 | `lib/rpc.ts:38` | 能力协商缺失时仍使用新协议 |\n| P2 | `components/MermaidBlock.tsx` | 深色主题需核对对比度 |\n| P2 | `docs/UPSTREAM-SYNC.md` | 补齐回退步骤 |\n\n建议先修复协议回退，再处理文档与界面检查。" },
      { user: "协议回退有什么具体影响？", answer: "旧服务端返回的能力列表不含 `preview.dom` 时，当前实现仍发送 v2 参数，首次预览会失败。\n\n> 修复后应继续使用旧版读取路径，并保留服务端原始错误以便诊断。\n\n请确认这次是否把旧协议兼容纳入同步范围。" },
    ] : [
      { user: "Audit the upstream sync changes and list findings by priority.", answer: "## Audit Summary\n\nFound **1 issue to fix** and 2 items requiring manual verification.\n\n| Priority | Location | Finding |\n| --- | --- | --- |\n| P1 | `lib/rpc.ts:38` | Uses v2 protocol even when capability negotiation omits it |\n| P2 | `components/MermaidBlock.tsx` | Verify dark-theme text contrast |\n| P2 | `docs/UPSTREAM-SYNC.md` | Complete rollback instructions |\n\nFix the protocol fallback first, then finish the docs and UI checks." },
      { user: "What breaks without the protocol fallback?", answer: "When an older server omits `preview.dom` from its capability list, the client still sends v2 arguments and fails the initial preview.\n\n> Keep using the legacy read path after fallback and surface the raw server error for diagnostics.\n\nPlease confirm whether legacy compatibility stays in scope for this sync." },
    ]),
    t3: conversation("plan", zh ? [
      {
        user: "规划 Mermaid 全屏缩放与拖拽惯性的改动，先给计划。",
        answer: [
          { type: "thinking", text: "先核对现有 MermaidBlock 的缩放状态与拖拽手势事件，再把分阶段实施计划写入本地计划文档并提交评审。" },
          ...tool("plan-read-mermaid", "read", { path: "components/MermaidBlock.tsx", offset: 1, limit: 40 }, {
            offset: 1, lines: 40, encoding: "UTF-8", size: "6.2 KB",
            preview: ['export function MermaidBlock({ code }: { code: string }) {', '  const [zoom, setZoom] = useState(1);'],
          }),
          ...tool("plan-read-propose-doc", "read", { path: "xd://propose" }, { contentType: "text/plain", totalLines: 1 },
            "Write your plan's <slug> (matching local://<slug>-plan.md) as plain text to xd://propose."),
          ...tool("plan-write-doc", "write", { path: "local://mermaid-zoom-inertia-plan.md", content: "## 目标\n\n冻结 Preview **缩放协议**，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。" }, {},
            "[local://mermaid-zoom-inertia-plan.md] wrote 24 lines"),
          ...tool("plan-submit-propose", "write", { path: "xd://propose", content: "Preview 缩放惯性" }, {
            xdev: {
              tool: "propose",
              mode: "execute",
              args: { title: "Preview 缩放惯性" },
              inner: {
                planFilePath: "local://mermaid-zoom-inertia-plan.md",
                title: "Preview 缩放惯性",
                planExists: true,
              },
            },
          }, "Plan ready for review."),
          text("## 待确认的实施计划\n\n1. 统一普通视图与全屏视图的缩放状态。\n2. 增加可关闭的拖拽惯性。\n3. 保留键盘重置与缩放按钮。\n4. 检查浅色、深色和窄窗口。\n\n**待定项**：惯性默认值与触控板手势优先级。上方计划卡包含实施细节，后续问题依次排队。"),
        ],
      },
    ] : [
      {
        user: "Plan the changes for Mermaid fullscreen zoom and drag inertia before implementing.",
        answer: [
          { type: "thinking", text: "Inspect MermaidBlock zoom state and pointer gesture handlers first, then write the implementation plan and submit it via xd://propose." },
          ...tool("plan-read-mermaid", "read", { path: "components/MermaidBlock.tsx", offset: 1, limit: 40 }, {
            offset: 1, lines: 40, encoding: "UTF-8", size: "6.2 KB",
            preview: ['export function MermaidBlock({ code }: { code: string }) {', '  const [zoom, setZoom] = useState(1);'],
          }),
          ...tool("plan-read-propose-doc", "read", { path: "xd://propose" }, { contentType: "text/plain", totalLines: 1 },
            "Write your plan's <slug> (matching local://<slug>-plan.md) as plain text to xd://propose."),
          ...tool("plan-write-doc", "write", { path: "local://mermaid-zoom-inertia-plan.md", content: "## Goal\n\nFreeze the Preview **zoom contract**, add the drag-inertia toggle, and run type checks for fullscreen Mermaid." }, {},
            "[local://mermaid-zoom-inertia-plan.md] wrote 24 lines"),
          ...tool("plan-submit-propose", "write", { path: "xd://propose", content: "Preview zoom inertia" }, {
            xdev: {
              tool: "propose",
              mode: "execute",
              args: { title: "Preview zoom inertia" },
              inner: {
                planFilePath: "local://mermaid-zoom-inertia-plan.md",
                title: "Preview zoom inertia",
                planExists: true,
              },
            },
          }, "Plan ready for review."),
          text("## Proposed Implementation Plan\n\n1. Unify zoom state between inline and fullscreen views.\n2. Add configurable drag inertia with an opt-out.\n3. Keep keyboard reset shortcuts and toolbar zoom controls.\n4. Verify light, dark, and narrow-pane layouts.\n\n**Open items**: default inertia damping and trackpad gesture precedence. Detailed steps appear in the plan card above."),
        ],
      },
    ]),
    t4: conversation("shell-path", zh ? [
      { user: "Windows 上的 Bash 命令提示找不到 Shell，怎么检查？", answer: ["先查看当前命令解析到哪个程序，尤其注意路径中包含空格的情况。", fence("pwsh", 'Get-Command git, bash, pwsh -ErrorAction SilentlyContinue |\n  Select-Object Name, Source'), "在 Git Bash 中核对工作目录：", fence("bash", 'pwd\nprintf \'Shell: %s\\n\' "$BASH_VERSION"'), "找到解释器后，在当前工作区重试原命令；输出应进入底部独立终端。"].join("\n\n") },
    ] : [
      { user: "Bash commands on Windows report that the shell cannot be found. How should I check it?", answer: ["Inspect which executable resolves on PATH first, paying close attention to paths containing spaces.", fence("pwsh", 'Get-Command git, bash, pwsh -ErrorAction SilentlyContinue |\n  Select-Object Name, Source'), "Verify the working directory inside Git Bash:", fence("bash", 'pwd\nprintf \'Shell: %s\\n\' "$BASH_VERSION"'), "Once the executable is resolved, retry the command in the workspace; output should stream to the bottom terminal."].join("\n\n") },
    ]),
    t5: buildArchive(zh),
    t6: conversation("upstream-diff", zh ? [
      { user: "对比 v0.8.0 和 v0.8.1，告诉我需要同步哪些内容。", answer: "## 版本对比\n\n| 范围 | v0.8.0 | v0.8.1 | 本地处理 |\n| --- | --- | --- | --- |\n| 主题 | 字符串参数 | 明确主题类型 | 对齐类型 |\n| 会话 | 单页读取 | 支持分页游标 | 保留本地目录 |\n| 工具输出 | 纯文本 | 结构化结果 | 补齐展开视图 |\n| 文档 | 分散说明 | 同步记录入口 | 合并到 README |\n\n先同步类型和文档，再验证会话恢复；Studio Bridge 的接缝独立保留。" },
    ] : [
      { user: "Compare v0.8.0 and v0.8.1 and tell me what needs syncing.", answer: "## Version Comparison\n\n| Area | v0.8.0 | v0.8.1 | Local Handling |\n| --- | --- | --- | --- |\n| Themes | Untyped strings | Strict theme union | Align type signatures |\n| Sessions | Single-page load | Cursor pagination | Keep local directory layout |\n| Tool output | Plain text | Structured views | Keep expandable cards |\n| Docs | Scattered notes | Central sync log | Link from README |\n\nSync types and documentation first, then verify session resume; keep Studio Bridge seams isolated." },
    ]),
    t7: conversation("mermaid", zh ? [
      { user: "画一下缩放状态在普通视图和全屏视图之间的关系。", answer: ["## 共享视口状态", fence("mermaid", 'flowchart LR\n  A[普通视图] --> C[共享 pan / zoom]\n  B[全屏视图] --> C\n  C --> D[拖拽与滚轮]\n  D --> E[更新视口]\n  E --> A\n  E --> B'), "两个入口读取同一份视口状态，切换全屏时保留当前位置。", "- [x] 普通视图缩放\n- [x] 全屏切换保留位置\n- [ ] 触控板惯性复查"].join("\n\n") },
    ] : [
      { user: "Diagram how zoom state is shared between the inline view and fullscreen overlay.", answer: ["## Shared Viewport State", fence("mermaid", 'flowchart LR\n  A[Inline view] --> C[Shared pan / zoom]\n  B[Fullscreen view] --> C\n  C --> D[Drag & wheel]\n  D --> E[Update viewport]\n  E --> A\n  E --> B'), "Both views read the same viewport state so toggling fullscreen preserves your position.", "- [x] Inline zoom controls\n- [x] Preserve position in fullscreen\n- [ ] Trackpad inertia review"].join("\n\n") },
    ]),
    t8: conversation("directory", zh ? [
      { user: "DirectoryPicker 需要覆盖哪些目录和文件名？", answer: ["## 目录选择检查", fence("text", 'omp-web/\n├── app/routes/session.tsx\n├── components/DirectoryPicker.tsx\n├── docs/上游同步检查记录 v0.8.1.md\n├── tests/fixtures/session with spaces.json\n└── .github/workflows/ci.yml'), "检查中文、空格、隐藏目录、空目录和深层路径。选择文件时保留原始路径，搜索过滤后仍能回到父目录。"].join("\n\n") },
    ] : [
      { user: "Which folders and filename patterns should DirectoryPicker cover?", answer: ["## Directory Picker Checklist", fence("text", 'omp-web/\n├── app/routes/session.tsx\n├── components/DirectoryPicker.tsx\n├── docs/upstream sync notes v0.8.1.md\n├── tests/fixtures/session with spaces.json\n└── .github/workflows/ci.yml'), "Verify UTF-8 characters, spaces, hidden folders, empty directories, and deep nesting. Preserve verbatim paths on selection and let clearing filters return to parent folders."].join("\n\n") },
    ]),
    t9: conversation("pagination", zh ? [
      { user: "会话分页有哪些容易漏掉的情况？", answer: "需要覆盖三种情况：首次打开短会话、向上加载长会话、加载过程中切换到另一场会话。\n\n| 操作 | 预期 |\n| --- | --- |\n| 向上加载 | 当前段落留在原位置 |\n| 切换会话 | 不混入上一场的工具结果 |\n| 到达最早记录 | 显示结束状态 |\n\n- [x] 连续加载两页\n- [x] 同时收到新消息\n- [ ] 窄列调整后恢复滚动位置" },
      { user: "如果中间有上下文压缩呢？", answer: "压缩摘要应保留在时间线中，展开后仍可阅读完成项与待办。继续加载历史时，摘要和普通消息使用各自的稳定标识。" },
    ] : [
      { user: "Which session pagination edge cases are easy to miss?", answer: "Cover three cases: opening a short session for the first time, scrolling up to page a long transcript, and switching sessions mid-fetch.\n\n| Action | Expected |\n| --- | --- |\n| Load older page | Current paragraph stays anchored |\n| Switch session | Tool results never leak across sessions |\n| Reach beginning | Show end-of-history state |\n\n- [x] Page two consecutive batches\n- [x] Receive live message mid-load\n- [ ] Restore scroll after narrowing pane" },
      { user: "What if context compaction occurs mid-session?", answer: "Compaction summaries remain inline on the timeline and expand to show completed work and open tasks. Both summaries and regular turns keep stable IDs across page loads." },
    ]),
    t11: buildMarkdown(zh),
    t13: buildCommands(zh),
    t14: buildRecovery(zh),
  };
}

export const PREVIEW_THREAD_ITEMS: Readonly<Record<string, readonly ConversationItem[]>> = getPreviewThreadItems();
