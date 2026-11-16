import type { ConversationContentBlock, ConversationItem } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";
import { getContentGalleryGraphics } from "./contentGalleryGraphics";
import { getContentGalleryCode } from "./contentGalleryCode";
import { getContentGalleryMarkdown, getContentGalleryReferences, getContentGalleryShell, galleryFence } from "./contentGalleryMarkdown";
import { getContentGalleryTools, getContentGalleryVariants, galleryToolBlocks } from "./contentGalleryTools";

type Chapter = { title: string; user?: string; content: readonly ConversationContentBlock[] };
const text = (value: string): ConversationContentBlock => ({ type: "text", text: value });

export function getPreviewContentGalleryItems(zh = isZh()): readonly ConversationItem[] {
  const tools = getContentGalleryTools(zh);
  const code = getContentGalleryCode(zh);
  const graphics = getContentGalleryGraphics(zh);
  const variants = getContentGalleryVariants(zh);

  function toolChapter(title: string, kinds: readonly string[], id: string): Chapter {
    return { title, content: [text(`## ${title}`), ...galleryToolBlocks(tools.filter(card => kinds.includes(String(card.kind))), id)] };
  }

  const chapters: readonly Chapter[] = [
    {
      title: zh ? "内容图鉴 · 目录" : "Content Gallery · Contents",
      content: [text(zh
        ? "# 内容图鉴\n\n逐章查看正文与工具卡，检查展开、复制、内部滚动及不同阅读列宽度。\n\n1. 用户消息与引用胶囊\n2. Markdown / GFM 完整排版\n3. Shell 命令块\n4. 全部已注册的代码高亮语言\n5. SVG、Mermaid、Chart 与三维格式\n6. 文件、搜索、执行与诊断工具\n7. Agent、协调、记忆与扩展工具\n8. 结构化结果、空结果、失败与长输出\n9. 思考、系统消息、扩展消息与上下文摘要"
        : "# Content Gallery\n\nBrowse prose and tool cards by chapter to inspect expansion, copying, inner scrolling, and reading column widths.\n\n1. User messages & reference chips\n2. Full Markdown / GFM typography\n3. Shell command blocks\n4. All registered syntax highlighting languages\n5. SVG, Mermaid, Chart, and 3D formats\n6. File, search, execution, and diagnostic tools\n7. Agent, coordination, memory, and extension tools\n8. Structured outputs, empty results, failures, and long logs\n9. Thinking, system, extension messages, and compaction summaries")],
    },
    {
      title: zh ? "用户消息与引用胶囊" : "User messages & reference chips",
      user: getContentGalleryReferences(zh),
      content: [text(zh
        ? "## 用户消息与引用胶囊\n\n上方包含文件、目录、技能、Agent、模型、图片、PR、Issue、Git commit、浏览器元素及四种关键词。引用胶囊的复制文本保留原序列化格式。"
        : "## User messages & reference chips\n\nAbove contains file, directory, skill, agent, model, image, PR, issue, Git commit, browser element references, and keywords. Copying reference chips preserves their serialized format.")],
    },
    { title: "Markdown / GFM", content: [text(getContentGalleryMarkdown(zh))] },
    { title: zh ? "Shell 命令块" : "Shell command blocks", content: [text(getContentGalleryShell(zh))] },
    ...Array.from({ length: Math.ceil(code.length / 7) }, (_, index): Chapter => ({
      title: zh ? `代码高亮 ${index + 1}` : `Syntax highlighting ${index + 1}`,
      content: [text((zh ? `## 代码高亮 ${index + 1}\n\n` : `## Syntax highlighting ${index + 1}\n\n`) + code.slice(index * 7, index * 7 + 7).map(([language, source]) => `### ${language || (zh ? "无语言标签" : "No language tag")}\n\n${galleryFence(language, source)}`).join("\n\n"))],
    })),
    ...graphics.map(({ language, source }): Chapter => ({
      title: zh ? `图形格式 · ${language}` : `Graphics format · ${language}`,
      content: [text((zh ? `## 图形格式 · ${language}\n\n` : `## Graphics format · ${language}\n\n`) + galleryFence(language, source))],
    })),
    {
      title: zh ? "二进制 GLB" : "Binary GLB",
      content: [text(zh
        ? "## 二进制 GLB\n\nGLB 使用二进制块，完整三维预览放在图鉴末尾；其余图形格式在上方正文围栏中直接展示。"
        : "## Binary GLB\n\nGLB uses binary chunks so the full 3D preview sits at the end of the gallery; other graphic formats render inline in fenced blocks above.")],
    },
    toolChapter(zh ? "文件与搜索工具" : "File & search tools", ["read", "write", "edit", "grep", "glob", "ast_grep", "ast_edit", "find", "documentation"], "files"),
    toolChapter(zh ? "执行、诊断与媒体工具" : "Execution, diagnostics & media tools", ["bash", "process", "debug", "eval", "lsp", "inspect_image", "browser", "computer", "generate_image", "tts"], "execution"),
    toolChapter(zh ? "Agent、作业与协调工具" : "Agent, job & coordination tools", ["task", "hub", "wait", "agent_message", "todo", "goal", "vibe", "yield"], "agents"),
    toolChapter(zh ? "记忆、检查点与扩展工具" : "Memory, checkpoint & extension tools", ["retain", "recall", "reflect", "memory_edit", "learn", "manage_skill", "checkpoint", "rewind", "security_scan", "github", "web_search", "web", "mcp", "resolve", "report_issue", "extension_tool"], "extensions"),
    {
      title: zh ? "结果与状态变体" : "Result & status variants",
      content: [text(zh
        ? "## 结果与状态变体\n\nMarkdown 读取、覆盖写入、空搜索、失败、ANSI / 回车日志、长输出、LSP 引用、Eval 三种结构化视图、内核重启、进度、作业 widget、MCP 原生命名与 xdev 封装。"
        : "## Result & status variants\n\nMarkdown read, overwrite write, empty search, failure, ANSI / CR logs, long output, LSP references, three structured Eval views, kernel restart, progress, job widget, native MCP names, and xdev wrappers."), ...galleryToolBlocks(variants, "variants")],
    },
    {
      title: zh ? "思考与正文交替" : "Interleaved thinking & prose",
      content: [
        { type: "thinking", text: zh ? "先查看格式和工具种类，再分别核对窄列、浅色与深色。\n\n工具链前后都保留正文，避免格式检查只覆盖连续工具结果。" : "Inspect formats and tool kinds first, then check narrow column, light, and dark themes.\n\nKeep prose before and after tool chains so formatting checks cover interleaved flow." },
        text(zh ? "## 思考与正文交替\n\n思考块进入链中，正文保持独立段落。" : "## Interleaved thinking & prose\n\nThinking blocks join the chain while prose stays as independent paragraphs."),
        ...galleryToolBlocks([{ name: "Read", path: "README.md", preview: ["# OMP Studio", "", zh ? "内容与工具检查入口" : "Content and tool inspection entry"] }], "interleaved"),
        text(zh ? "读取后继续正文：**结果已整理**，下面保留系统消息、扩展消息与上下文摘要。" : "Continuing prose after reading: **results are organized**, followed by system, extension, and compaction items."),
        { type: "thinking", text: zh ? "最终检查：所有章节均可以独立展开，正文与工具结果使用现有组件。" : "Final check: all chapters expand independently, and prose/tool outputs reuse existing components." },
      ],
    },
  ];

  const galleryItems = chapters.flatMap((chapter, index): ConversationItem[] => {
    const userId = `content-gallery-user-${index}`;
    return [
      { kind: "message", itemId: userId, parentId: index ? `content-gallery-assistant-${index - 1}` : "content-gallery-boundary", createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2)).toISOString(), role: "user", content: [text(chapter.user ?? chapter.title)] },
      { kind: "message", itemId: `content-gallery-assistant-${index}`, parentId: userId, createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2 + 1)).toISOString(), role: "assistant", content: chapter.content },
    ];
  });

  return [
    { kind: "resetBoundary", itemId: "content-gallery-boundary", parentId: null, createdAt: "2026-11-09T06:00:00.000Z" },
    ...galleryItems,
    { kind: "message", itemId: "content-gallery-system", parentId: galleryItems.at(-1)!.itemId, createdAt: "2026-11-09T07:10:00.000Z", role: "system", content: [text(zh ? "系统消息：检查记录已保存。\n\n- 正文格式已覆盖\n- 工具链内容已整理" : "System notice: inspection log saved.\n\n- Prose formatting covered\n- Tool chain contents organized")] },
    { kind: "message", itemId: "content-gallery-extension", parentId: "content-gallery-system", createdAt: "2026-11-09T07:11:00.000Z", role: "extension", content: [text(zh ? "### 扩展消息\n\n检查摘要：**完成** · [查看记录](studio-demo://checks/renderer)" : "### Extension message\n\nCheck summary: **done** · [View log](studio-demo://checks/renderer)")] },
    {
      kind: "compaction",
      itemId: "content-gallery-compaction",
      parentId: "content-gallery-extension",
      createdAt: "2026-11-09T07:12:00.000Z",
      shortSummary: zh ? "内容图鉴 · 正文、工具与结构化结果" : "Content gallery · Prose, tools & structured results",
      summary: zh
        ? "## 已覆盖\n\n- Markdown / GFM 与引用胶囊\n- 命令、代码高亮及图形格式\n- 工具卡与结构化结果\n\n## 检查记录\n\n| 阅读列 | 结果 |\n| --- | --- |\n| 标准 | 已检查 |\n| 窄列 | 待检查 |"
        : "## Covered\n\n- Markdown / GFM and reference chips\n- Commands, syntax highlighting, and graphic formats\n- Tool cards and structured outputs\n\n## Inspection log\n\n| Column | Result |\n| --- | --- |\n| Standard | Checked |\n| Narrow | Pending |",
      warning: zh ? "窄阅读列和主题切换仍需逐项核对。" : "Narrow column and theme switching still need item-by-item review.",
    },
  ];
}

export const PREVIEW_CONTENT_GALLERY_ITEMS: readonly ConversationItem[] = getPreviewContentGalleryItems();
