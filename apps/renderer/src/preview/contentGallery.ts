import type { ConversationContentBlock, ConversationItem } from "@omp-studio/studio-protocol";
import { CONTENT_GALLERY_GRAPHICS } from "./contentGalleryGraphics";
import { CONTENT_GALLERY_CODE } from "./contentGalleryCode";
import { CONTENT_GALLERY_MARKDOWN, CONTENT_GALLERY_REFERENCES, CONTENT_GALLERY_SHELL, galleryFence } from "./contentGalleryMarkdown";
import { CONTENT_GALLERY_TOOLS, CONTENT_GALLERY_VARIANTS, galleryToolBlocks } from "./contentGalleryTools";

type Chapter = { title: string; user?: string; content: readonly ConversationContentBlock[] };
const text = (value: string): ConversationContentBlock => ({ type: "text", text: value });

function toolChapter(title: string, kinds: readonly string[], id: string): Chapter {
  return { title, content: [text(`## ${title}`), ...galleryToolBlocks(CONTENT_GALLERY_TOOLS.filter(card => kinds.includes(String(card.kind))), id)] };
}

const chapters: readonly Chapter[] = [
  { title: "内容图鉴 · 目录", content: [text("# 内容图鉴\n\n逐章查看正文与工具卡，检查展开、复制、内部滚动及不同阅读列宽度。\n\n1. 用户消息与引用胶囊\n2. Markdown / GFM 完整排版\n3. Shell 命令块\n4. 全部已注册的代码高亮语言\n5. SVG、Mermaid、Chart 与三维格式\n6. 文件、搜索、执行与诊断工具\n7. Agent、协调、记忆与扩展工具\n8. 结构化结果、空结果、失败与长输出\n9. 思考、系统消息、扩展消息与上下文摘要")] },
  { title: "用户消息与引用胶囊", user: CONTENT_GALLERY_REFERENCES, content: [text("## 用户消息与引用胶囊\n\n上方包含文件、目录、技能、Agent、模型、图片、PR、Issue、Git commit、浏览器元素及四种关键词。引用胶囊的复制文本保留原序列化格式。")] },
  { title: "Markdown / GFM", content: [text(CONTENT_GALLERY_MARKDOWN)] },
  { title: "Shell 命令块", content: [text(CONTENT_GALLERY_SHELL)] },
  ...Array.from({ length: Math.ceil(CONTENT_GALLERY_CODE.length / 7) }, (_, index): Chapter => ({
    title: `代码高亮 ${index + 1}`, content: [text(`## 代码高亮 ${index + 1}\n\n` + CONTENT_GALLERY_CODE.slice(index * 7, index * 7 + 7).map(([language, source]) => `### ${language || "无语言标签"}\n\n${galleryFence(language, source)}`).join("\n\n"))],
  })),
  ...CONTENT_GALLERY_GRAPHICS.map(({ language, source }): Chapter => ({ title: `图形格式 · ${language}`, content: [text(`## 图形格式 · ${language}\n\n${galleryFence(language, source)}`)] })),
  { title: "二进制 GLB", content: [text("## 二进制 GLB\n\nGLB 使用二进制块，完整三维预览放在图鉴末尾；其余图形格式在上方正文围栏中直接展示。")] },
  toolChapter("文件与搜索工具", ["read", "write", "edit", "grep", "glob", "ast_grep", "ast_edit", "find", "documentation"], "files"),
  toolChapter("执行、诊断与媒体工具", ["bash", "process", "debug", "eval", "lsp", "inspect_image", "browser", "computer", "generate_image", "tts"], "execution"),
  toolChapter("Agent、作业与协调工具", ["task", "hub", "wait", "agent_message", "todo", "goal", "vibe", "yield"], "agents"),
  toolChapter("记忆、检查点与扩展工具", ["retain", "recall", "reflect", "memory_edit", "learn", "manage_skill", "checkpoint", "rewind", "security_scan", "github", "web_search", "web", "mcp", "resolve", "report_issue", "extension_tool"], "extensions"),
  { title: "结果与状态变体", content: [text("## 结果与状态变体\n\nMarkdown 读取、覆盖写入、空搜索、失败、ANSI / 回车日志、长输出、LSP 引用、Eval 三种结构化视图、内核重启、进度、作业 widget、MCP 原生命名与 xdev 封装。"), ...galleryToolBlocks(CONTENT_GALLERY_VARIANTS, "variants")] },
  { title: "思考与正文交替", content: [{ type: "thinking", text: "先查看格式和工具种类，再分别核对窄列、浅色与深色。\n\n工具链前后都保留正文，避免格式检查只覆盖连续工具结果。" }, text("## 思考与正文交替\n\n思考块进入链中，正文保持独立段落。"), ...galleryToolBlocks([{ name: "Read", path: "README.md", preview: ["# OMP Studio", "", "内容与工具检查入口"] }], "interleaved"), text("读取后继续正文：**结果已整理**，下面保留系统消息、扩展消息与上下文摘要。"), { type: "thinking", text: "最终检查：所有章节均可以独立展开，正文与工具结果使用现有组件。" }] },
];

const galleryItems = chapters.flatMap((chapter, index): ConversationItem[] => {
  const userId = `content-gallery-user-${index}`;
  return [
    { kind: "message", itemId: userId, parentId: index ? `content-gallery-assistant-${index - 1}` : "content-gallery-boundary", createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2)).toISOString(), role: "user", content: [text(chapter.user ?? chapter.title)] },
    { kind: "message", itemId: `content-gallery-assistant-${index}`, parentId: userId, createdAt: new Date(Date.UTC(2026, 10, 9, 6, index * 2 + 1)).toISOString(), role: "assistant", content: chapter.content },
  ];
});

export const PREVIEW_CONTENT_GALLERY_ITEMS: readonly ConversationItem[] = [
  { kind: "resetBoundary", itemId: "content-gallery-boundary", parentId: null, createdAt: "2026-11-09T06:00:00.000Z" },
  ...galleryItems,
  { kind: "message", itemId: "content-gallery-system", parentId: galleryItems.at(-1)!.itemId, createdAt: "2026-11-09T07:10:00.000Z", role: "system", content: [text("系统消息：检查记录已保存。\n\n- 正文格式已覆盖\n- 工具链内容已整理")] },
  { kind: "message", itemId: "content-gallery-extension", parentId: "content-gallery-system", createdAt: "2026-11-09T07:11:00.000Z", role: "extension", content: [text("### 扩展消息\n\n检查摘要：**完成** · [查看记录](studio-demo://checks/renderer)")] },
  { kind: "compaction", itemId: "content-gallery-compaction", parentId: "content-gallery-extension", createdAt: "2026-11-09T07:12:00.000Z", shortSummary: "内容图鉴 · 正文、工具与结构化结果", summary: "## 已覆盖\n\n- Markdown / GFM 与引用胶囊\n- 命令、代码高亮及图形格式\n- 工具卡与结构化结果\n\n## 检查记录\n\n| 阅读列 | 结果 |\n| --- | --- |\n| 标准 | 已检查 |\n| 窄列 | 待检查 |", warning: "窄阅读列和主题切换仍需逐项核对。" },
];
