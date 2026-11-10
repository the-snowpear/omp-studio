import type { ConversationContentBlock, ConversationItem, JsonValue } from "@omp-studio/studio-protocol";
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

const markdown = conversation("markdown", [
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
]);

const commands = conversation("commands", [
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
]);

const recovery = conversation("recovery", [
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
]);

const archive: readonly ConversationItem[] = [
  ...conversation("archive", [{ user: "整理 session 存储层重构的上下文，方便稍后恢复。", answer: "已完成会话索引与正文分离。归档内容只读；恢复时从最近的检查点继续。" }]),
  { kind: "compaction", itemId: "preview-archive-compaction", parentId: "preview-archive-assistant-0", createdAt: "2026-11-09T06:03:00.000Z",
    shortSummary: "会话索引重构 · 8 轮上下文已整理", summary: "## 已完成\n- 会话索引按工作区分组。\n- 归档正文使用游标分页。\n- 切换会话保留阅读位置。\n\n## 继续时检查\n- 长会话向上加载。\n- 恢复草稿与模型配置。\n- 归档会话仍可只读查看。" },
  { kind: "message", itemId: "preview-archive-final", parentId: "preview-archive-compaction", createdAt: "2026-11-09T06:04:00.000Z", role: "assistant",
    content: [text("上下文已整理，原始检查结论保留在摘要中。下一步检查分页与草稿恢复。\n\n- [x] 索引迁移\n- [x] 归档读取\n- [ ] 跨版本恢复")] },
];

export const PREVIEW_THREAD_ITEMS: Readonly<Record<string, readonly ConversationItem[]>> = {
  t2: conversation("audit", [{ user: "审查上游同步变更，按优先级列出问题。", answer: "## 审查结果\n\n发现 **1 个需要修复的问题**，以及 2 个待人工检查项。\n\n| 优先级 | 位置 | 问题 |\n| --- | --- | --- |\n| P1 | `lib/rpc.ts:38` | 能力协商缺失时仍使用新协议 |\n| P2 | `components/MermaidBlock.tsx` | 深色主题需核对对比度 |\n| P2 | `docs/UPSTREAM-SYNC.md` | 补齐回退步骤 |\n\n建议先修复协议回退，再处理文档与界面检查。" }, { user: "协议回退有什么具体影响？", answer: "旧服务端返回的能力列表不含 `preview.dom` 时，当前实现仍发送 v2 参数，首次预览会失败。\n\n> 修复后应继续使用旧版读取路径，并保留服务端原始错误以便诊断。\n\n请确认这次是否把旧协议兼容纳入同步范围。" }]),
  t3: conversation("plan", [{ user: "规划 Mermaid 全屏缩放与拖拽惯性的改动，先给计划。", answer: "## 待确认的实施计划\n\n1. 统一普通视图与全屏视图的缩放状态。\n2. 增加可关闭的拖拽惯性。\n3. 保留键盘重置与缩放按钮。\n4. 检查浅色、深色和窄窗口。\n\n**待定项**：惯性默认值与触控板手势优先级。下方计划卡包含实施细节，后续问题依次排队。" }]),
  t4: conversation("shell-path", [{ user: "Windows 上的 Bash 命令提示找不到 Shell，怎么检查？", answer: ["先查看当前命令解析到哪个程序，尤其注意路径中包含空格的情况。", fence("pwsh", 'Get-Command git, bash, pwsh -ErrorAction SilentlyContinue |\n  Select-Object Name, Source'), "在 Git Bash 中核对工作目录：", fence("bash", 'pwd\nprintf \'Shell: %s\\n\' "$BASH_VERSION"'), "找到解释器后，在当前工作区重试原命令；输出应进入底部独立终端。"].join("\n\n") }]),
  t5: archive,
  t6: conversation("upstream-diff", [{ user: "对比 v0.8.0 和 v0.8.1，告诉我需要同步哪些内容。", answer: "## 版本对比\n\n| 范围 | v0.8.0 | v0.8.1 | 本地处理 |\n| --- | --- | --- | --- |\n| 主题 | 字符串参数 | 明确主题类型 | 对齐类型 |\n| 会话 | 单页读取 | 支持分页游标 | 保留本地目录 |\n| 工具输出 | 纯文本 | 结构化结果 | 补齐展开视图 |\n| 文档 | 分散说明 | 同步记录入口 | 合并到 README |\n\n先同步类型和文档，再验证会话恢复；Studio Bridge 的接缝独立保留。" }]),
  t7: conversation("mermaid", [{ user: "画一下缩放状态在普通视图和全屏视图之间的关系。", answer: ["## 共享视口状态", fence("mermaid", 'flowchart LR\n  A[普通视图] --> C[共享 pan / zoom]\n  B[全屏视图] --> C\n  C --> D[拖拽与滚轮]\n  D --> E[更新视口]\n  E --> A\n  E --> B'), "两个入口读取同一份视口状态，切换全屏时保留当前位置。", "- [x] 普通视图缩放\n- [x] 全屏切换保留位置\n- [ ] 触控板惯性复查"].join("\n\n") }]),
  t8: conversation("directory", [{ user: "DirectoryPicker 需要覆盖哪些目录和文件名？", answer: ["## 目录选择检查", fence("text", 'omp-web/\n├── app/routes/session.tsx\n├── components/DirectoryPicker.tsx\n├── docs/上游同步检查记录 v0.8.1.md\n├── tests/fixtures/session with spaces.json\n└── .github/workflows/ci.yml'), "检查中文、空格、隐藏目录、空目录和深层路径。选择文件时保留原始路径，搜索过滤后仍能回到父目录。"].join("\n\n") }]),
  t9: conversation("pagination", [{ user: "会话分页有哪些容易漏掉的情况？", answer: "需要覆盖三种情况：首次打开短会话、向上加载长会话、加载过程中切换到另一场会话。\n\n| 操作 | 预期 |\n| --- | --- |\n| 向上加载 | 当前段落留在原位置 |\n| 切换会话 | 不混入上一场的工具结果 |\n| 到达最早记录 | 显示结束状态 |\n\n- [x] 连续加载两页\n- [x] 同时收到新消息\n- [ ] 窄列调整后恢复滚动位置" }, { user: "如果中间有上下文压缩呢？", answer: "压缩摘要应保留在时间线中，展开后仍可阅读完成项与待办。继续加载历史时，摘要和普通消息使用各自的稳定标识。" }]),
  t11: markdown,
  t13: commands,
  t14: recovery,
};
