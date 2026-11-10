import { serializeBrowserReference } from "../composer/browserReference";
import { serializeGitCommitReference } from "../composer/gitCommitReference";
import { serializeGithubReference } from "../composer/githubReference";
import { demoPath } from "./demoPaths";

export const galleryFence = (language: string, source: string) => `\`\`\`${language}\n${source}\n\`\`\``;

export const CONTENT_GALLERY_REFERENCES = [
  '检查文件 @components/MermaidBlock.tsx 、目录 @docs/ 和带空格路径 @"docs/上游同步检查记录 v0.8.1.md" 。',
  "引用技能 /skill:upstream-sync 、命名空间技能 /skill:studio/review 、Agent @scout 、模型 ^openai/gpt-5 和图片 [图1] @docs/mermaid-zoom.png 。",
  serializeGithubReference({ key: "github.com/agegr/pi-web/pr/812", kind: "pr", number: 812, title: "DirectoryPicker 与会话分页", url: "https://github.com/agegr/pi-web/pull/812", updatedAt: "2026-11-09T06:00:00Z", text: "# PR #812\n\n- 对齐目录选择器\n- 保留会话分页\n\n```diff\n+retainReadingAnchor();\n```" }),
  serializeGithubReference({ key: "github.com/agegr/pi-web/issue/813", kind: "issue", number: 813, title: "窄窗口长路径布局", url: "https://github.com/agegr/pi-web/issues/813", updatedAt: "2026-11-09T06:00:00Z", text: "# Issue #813\n\n检查中文路径和含空格文件名的省略效果。" }),
  serializeGitCommitReference({ kind: "commit", key: "content-gallery-commit", oid: "c12f9a1".padEnd(40, "0"), title: "保留会话阅读位置", text: "# Git commit\n\n修改 conversation/useConversationScroll.ts，保留切换时的段落锚点。" }),
  serializeBrowserReference({ kind: "browser", key: "browser:content-gallery", title: "BUTTON · OMP Studio", url: "https://example.com/studio", text: "Page: OMP Studio\nElement: BUTTON\nText: 打开会话", element: { id: "content-gallery-browser", pageId: "gallery-tab", note: "核对按钮引用胶囊", title: "OMP Studio", url: "https://example.com/studio", frameUrl: "https://example.com/studio", selector: "button.open-session", tagName: "BUTTON", text: "打开会话", capturedAt: "2026-11-09T06:00:00Z", rect: { x: 32, y: 48, width: 120, height: 36 } } }),
  "关键词：ultrathink · chillax · orchestrate · workflowz。",
].join("\n\n");

export const CONTENT_GALLERY_MARKDOWN = [
  "# 一级标题 · 内容图鉴", "## 二级标题", "### 三级标题", "#### 四级标题", "##### 五级标题", "###### 六级标题",
  "Setext 一级标题\n================", "Setext 二级标题\n----------------",
  "普通段落包含中文、English、数字 0 / 1 / 100%、emoji 🧭 和标点。**粗体**、__另一种粗体__、*斜体*、_另一种斜体_、***粗斜体***、~~删除线~~ 与 `行内代码`。",
  "软换行第一行\n软换行第二行\n\n硬换行第一行  \n硬换行第二行\\\n反斜杠换行第三行",
  "> 引用段落，包含 **强调** 和 `代码`。\n>\n> > 嵌套引用。\n> >\n> > - 引用中的列表\n> > - 第二项",
  "- 无序列表\n  - 嵌套项\n    1. 混合有序项\n    2. 另一个有序项\n- 第二项\n\n+ 加号列表\n\n* 星号列表",
  "1. 有序列表第一项\n2. 第二项\n\n   松散列表的第二段，保留缩进。\n\n   ```ts\n   const nested = true;\n   ```\n\n3. 第三项",
  "- [x] 已完成任务\n- [ ] 未完成任务\n  - [x] 嵌套任务",
  "| 左对齐 | 居中 | 右对齐 | 长内容 |\n| :--- | :---: | ---: | --- |\n| **文本** | `code` | 12 | conversation_workspace_preview_retain_reading_position_after_switch_and_resize |\n| 转义管道 \\| | ~~旧值~~ | 34 | 中文路径：docs/上游同步检查记录 v0.8.1.md |",
  "| 轮次 | 输入 tokens | 输出 tokens |\n| --- | ---: | ---: |\n| 1 | 240 | 120 |\n| 2 | 380 | 180 |\n| 3 | 290 | 250 |\n| 4 | 450 | 310 |",
  "下面的分类数值表会生成图表，可检查表格与图形之间的间距。\n\n| Model | Latency |\n| --- | ---: |\n| Primary | 10 ms |\n| Fallback | 20 ms |\n| Scout | 40 ms |\n| Reviewer | 60 ms |",
  "---\n\n***\n\n___",
  '链接：[GFM](https://github.github.com/gfm/ "格式说明")、<https://example.com>、www.example.com、<studio@example.com> 与 [引用式链接][gfm]。\n\n[gfm]: https://github.github.com/gfm/ "GitHub Flavored Markdown"',
  "文件链接：[相对文件](components/MermaidBlock.tsx:147)、[行与列](components/MermaidBlock.tsx#L147C7)、[file URI](file:///D:/Project/omp-web/README.md)、[带空格文件](<docs/上游同步检查记录 v0.8.1.md>)、[绝对路径](<" + demoPath("omp-web", "README.md") + ">) 与 `components/MermaidBlock.tsx:147`。",
  "扩展链接：[查看检查记录](studio-demo://checks/renderer)。",
  '![本地图片：正文宽度与比例](docs/mermaid-zoom.png)\n\n![引用式图片][shot]\n\n[shot]: docs/mermaid-zoom.png "预览截图"',
  "转义：\\*字面星号\\*、\\[字面方括号\\]、a &lt; b &amp;&amp; c &gt; d、&copy;。",
  '    // 缩进代码块\n    const message = "四个空格开启代码块";\n\n~~~json\n{"fence": "tilde"}\n~~~',
  "四反引号围栏内保留三反引号：\n\n````markdown\n```ts\nconst nestedFence = true;\n```\n````",
  "HTML 标签保留为文本：<details><summary>说明</summary>内容</details>。当前正文没有启用原始 HTML 或数学公式插件，`$x^2$` 与 `[^note]` 保留原文。",
].join("\n\n");

export const CONTENT_GALLERY_SHELL = [
  "## Shell 命令块", "### Bash · 单行", galleryFence("bash", "git status --short --branch"),
  "### Bash · 多行、变量、引号、管道与续行",
  galleryFence("bash", '# 保留中文、空格与引号\nreport_dir="docs/check reports"\nprintf \'Checking: %s\\n\' "$report_dir"\ngit diff --name-only | sort\nnpm run check -- \\\n  --only renderer'),
  ...["sh", "zsh"].map(lang => `### ${lang}\n\n${galleryFence(lang, "printf '%s\\n' 'ready'")}`),
  ...["pwsh", "powershell", "ps1"].map(lang => `### ${lang}\n\n${galleryFence(lang, '# 查看文件，不修改内容\n$root = Join-Path (Get-Location) "apps/renderer/src"\nGet-ChildItem -LiteralPath $root -Filter "*.tsx" |\n  Select-Object -First 5 Name, Length\nWrite-Output "检查完成：中文与空格"')}`),
  "`shell` 是终端会话记录高亮，`text` 是日志；它们使用普通代码框。",
  galleryFence("shell", "$ git status --short\n M README.md"), galleryFence("text", "PASS renderer\n0 errors · exit 0"),
].join("\n\n");
