import type {
  ConversationContentBlock,
  ConversationItem,
  ConversationRuntimeEvent,
  RuntimeEpoch,
  SessionId,
} from "@omp-studio/studio-protocol";
import type { JsonValue } from "@omp-studio/client-contract";
import type { TimelineRow } from "../conversation/conversationViewModel";
import { isZh } from "../i18n";
import { getNativeToolGallery } from "./nativeToolGallery";
import { getPreviewThreadItems } from "./conversationScenarios";
import { getPreviewContentGalleryItems } from "./contentGallery";

const epoch = 1 as RuntimeEpoch;
const session = "preview-session" as SessionId;
const at = (second: number) => `2026-08-15T06:02:${String(second).padStart(2, "0")}.000Z`;

function outputString(card: { readonly [key: string]: JsonValue }): string {
  const output = card.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((line) => (Array.isArray(line) ? String(line[0] ?? "") : String(line))).join("\n");
  }
  if (output !== undefined) return JSON.stringify(output);
  const answer = typeof card.answer === "string" ? card.answer : undefined;
  const full = typeof card.full === "string" ? card.full : undefined;
  const report = typeof card.report === "string" ? card.report : undefined;
  return answer ?? full ?? report ?? "";
}

function blocksFromCards(cards: readonly { readonly [key: string]: JsonValue }[], idPrefix: string): ConversationContentBlock[] {
  const blocks: ConversationContentBlock[] = [];
  for (const [index, card] of cards.entries()) {
    const name = typeof card.name === "string" ? card.name : `tool-${index}`;
    const status = typeof card.status === "string" ? card.status : "done";
    const id = `${idPrefix}-${index}`;
    blocks.push({
      type: "toolCall",
      toolCallId: id,
      toolName: name,
      arguments: card,
    });
    blocks.push({
      type: "toolResult",
      toolCallId: id,
      toolName: name,
      output: outputString(card),
      isError: status === "error",
    });
  }
  return blocks;
}

function galleryBlocks(zh = isZh()): ConversationContentBlock[] {
  return blocksFromCards(getNativeToolGallery(zh), "preview-gallery");
}

const RESET: ConversationItem = {
  kind: "resetBoundary",
  itemId: "preview-reset-1",
  parentId: null,
  createdAt: at(0),
};

/**
 * Full native-tool-card gallery (scene 42). Tests and the tool-card walkthrough
 * use this; the workbench preview conversation uses a shorter project story.
 */
export function previewGalleryItems(zh = isZh()): readonly ConversationItem[] {
  return [
    RESET,
    {
      kind: "message",
      itemId: "preview-gallery-user",
      parentId: "preview-reset-1",
      createdAt: at(2),
      role: "user",
      content: [{ type: "text", text: zh ? "打开 OMP 原生工具卡图鉴" : "Open the OMP native tool card gallery" }],
    },
    {
      kind: "message",
      itemId: "preview-gallery-assistant",
      parentId: "preview-gallery-user",
      createdAt: at(4),
      role: "assistant",
      content: galleryBlocks(zh),
    },
  ];
}

/** omp-web upstream sync: realistic project turn used for workbench preview conversation. */
function buildStoryCards(zh: boolean): readonly { readonly [key: string]: JsonValue }[] {
  return [
    {
      kind: "think",
      name: "Think",
      status: "done",
      dur: "6s",
      preview: zh
        ? "先核对 package.json 钉住的上游版本，再扫 docs 里现有同步说明。本地 Studio Bridge 和会话目录不要写回 pi-web。"
        : "Check the pinned upstream version in package.json first, then scan docs for existing sync notes. Keep Studio Bridge and the session directory out of pi-web.",
      full: zh
        ? "目标：把 pi-web v0.8.1 合进 omp-web。\n保留 packages/studio-bridge 与 ~/.omp/agent/sessions。\n文档落到 docs/UPSTREAM-SYNC.md，README 加入口。"
        : "Goal: merge pi-web v0.8.1 into omp-web.\nPreserve packages/studio-bridge and ~/.omp/agent/sessions.\nWrite docs to docs/UPSTREAM-SYNC.md and add a link in README.",
    },
    {
      kind: "read",
      name: "Read",
      target: "package.json",
      status: "done",
      dur: "0.2s",
      lines: 42,
      encoding: "UTF-8",
      size: "1.4 KB",
      offset: 1,
      preview: [
        "{",
        "  \"name\": \"omp-web\",",
        "  \"version\": \"0.8.0\",",
        "  \"dependencies\": {",
        "    \"@earendil-works/pi-web\": \"0.8.0\"",
        "  }",
        "}",
      ],
    },
    {
      kind: "grep",
      name: "Grep",
      target: "UPSTREAM in docs/",
      status: "done",
      dur: "0.3s",
      pattern: "UPSTREAM|Studio Bridge",
      paths: "docs/",
      count: "3 matches · 2 files",
      matches: [
        { file: "docs/README.md", line: "12", text: zh ? "- 上游同步尚未成文" : "- Upstream sync notes TBD" },
        { file: "docs/ARCH.md", line: "40", text: zh ? "Studio Bridge 不随 pi-web 路径迁移" : "Studio Bridge does not follow pi-web path moves" },
      ],
    },
    {
      kind: "write",
      name: "Write",
      target: "docs/UPSTREAM-SYNC.md",
      status: "done",
      dur: "1.4s",
      created: true,
      lines: 86,
      encoding: "UTF-8",
      preview: zh
        ? ["# 上游同步记录", "", "## v0.8.1", "", "- 保留 Studio Bridge", "- 会话目录仍走 ~/.omp"]
        : ["# Upstream Sync Log", "", "## v0.8.1", "", "- Preserve Studio Bridge", "- Keep session directory at ~/.omp"],
    },
    {
      kind: "edit",
      name: "Edit",
      target: "README.md",
      status: "done",
      dur: "0.5s",
      diff: [
        [" ", "46", "46", zh ? "- [更新日志](docs/CHANGELOG.md)" : "- [Changelog](docs/CHANGELOG.md)"],
        ["+", "", "47", zh ? "- [上游同步](docs/UPSTREAM-SYNC.md)" : "- [Upstream Sync](docs/UPSTREAM-SYNC.md)"],
        [" ", "47", "48", zh ? "- [架构说明](docs/ARCH.md)" : "- [Architecture](docs/ARCH.md)"],
      ],
    },
    {
      kind: "todo",
      name: "Todo",
      target: zh ? "update phase 验证" : "update phase verification",
      status: "done",
      dur: "0.1s",
      op: "done",
      phases: [
        {
          name: zh ? "文档" : "Docs",
          tasks: [
            { content: zh ? "阅读 docs 与 package.json" : "Read docs and package.json", status: "completed" },
            { content: zh ? "写 UPSTREAM-SYNC.md" : "Write UPSTREAM-SYNC.md", status: "completed" },
          ],
        },
        {
          name: zh ? "验证" : "Verification",
          tasks: [
            { content: "typecheck / lint", status: "in_progress" },
            { content: zh ? "核对 Studio Bridge 路径未回写" : "Verify Studio Bridge paths stay isolated", status: "pending" },
          ],
        },
      ],
    },
    {
      kind: "task",
      name: "Task",
      status: "done",
      dur: "42s",
      spawn: {
        agent: "scout",
        isolated: true,
        context: zh
          ? "# Goal\n并行调研上游 v0.8.1：依赖钉住点与 Release Notes。不要改工作区。"
          : "# Goal\nInspect upstream v0.8.1 in parallel: dependency pins and Release Notes. Do not edit the workspace.",
        tasks: [
          { name: "deps", agent: "scout", task: zh ? "审计 @earendil-works/pi-* 0.8.1 变更" : "Audit @earendil-works/pi-* 0.8.1 changes" },
          { name: "docs", agent: "scout", task: zh ? "提取 v0.8.1 Release Notes 要点" : "Summarize key points from v0.8.1 Release Notes" },
        ],
      },
      agents: [
        {
          id: "agent-019fcb01",
          name: "deps",
          status: "done",
          activity: "done",
          dur: "38s",
          resolvedModel: "gemini-3.6-flash",
          thinking: "max",
          tokens: "12.6k",
          tools: 8,
          requests: 4,
          cost: zh ? "¥ 0.51" : "$ 0.51",
          files: 6,
          lastTool: "Grep · \"pi-core\" in lockfile",
        },
        {
          id: "agent-019fc9d2",
          name: "docs",
          status: "done",
          activity: "done",
          dur: "41s",
          resolvedModel: "claude-sonnet-4.5",
          thinking: "high",
          tokens: "9.8k",
          tools: 5,
          requests: 3,
          cost: zh ? "¥ 0.36" : "$ 0.36",
          files: 2,
          lastTool: "Web Search · v0.8.1 notes",
        },
      ],
    },
  ];
}

/**
 * Preview-only transcript. Types are the frozen studio-protocol conversation
 * contract — not a parallel PreviewEvent story. Real mode must never import this.
 */
export function getPreviewConvoItems(zh = isZh()): readonly ConversationItem[] {
  return [
    RESET,
    {
      kind: "message", itemId: "preview-extension-notice", parentId: "preview-reset-1", createdAt: at(1), role: "extension",
      content: [{ type: "text", text: zh ? "同步扩展已加载。[查看扩展说明](studio-demo:details)" : "Sync extension loaded. [View extension details](studio-demo:details)" }],
    },
    {
      kind: "message",
      itemId: "preview-user-1",
      parentId: "preview-reset-1",
      createdAt: at(2),
      role: "user",
      content: [{
        type: "text",
        text: zh
          ? "用 /skill:upstream-sync 把上游 pi-web v0.8.1 同步进 omp-web。保留本地 Studio Bridge 和会话目录，不要写回 pi-web 路径。先读 @docs/ 和 @package.json，再出文档。"
          : "Run /skill:upstream-sync to merge pi-web v0.8.1 into omp-web. Keep local Studio Bridge and session paths intact without writing back to pi-web paths. Read @docs/ and @package.json first, then update the docs.",
      }],
    },
    {
      kind: "message",
      itemId: "preview-advisor-1",
      parentId: "preview-user-1",
      createdAt: at(3),
      role: "advisor",
      content: [{ type: "text", advisor: "upstream-sync", severity: "concern", text: zh
        ? "请核对同步后的 Studio Bridge 路径，再运行类型检查。"
        : "Check the Studio Bridge path after the sync, then run the type check." }],
    },
    {
      kind: "message",
      itemId: "preview-advisor-batch",
      parentId: "preview-advisor-1",
      createdAt: at(3),
      role: "advisor",
      content: [
        { type: "text", advisor: "upstream-sync", severity: "concern", text: zh
          ? "同步完成后，确认本地 Studio Bridge 能力仍可正常调用。"
          : "After syncing, confirm the local Studio Bridge capabilities still work." },
        { type: "text", advisor: "docs", severity: "nit", text: zh
          ? "同步文档里的复查命令应与 package.json 保持一致。"
          : "Keep the verification commands in the sync notes aligned with package.json." },
        { type: "text", advisor: "upstream-sync", severity: "concern", text: zh
          ? "回放历史会话，核对同步前后的消息顺序。"
          : "Replay a historical session and compare message ordering before and after the sync." },
        { type: "text", advisor: "docs", text: zh
          ? "在同步记录中注明已经验证的平台。"
          : "Record the platforms actually verified in the sync notes." },
      ],
    },
    {
      kind: "message",
      itemId: "preview-assistant-1",
      parentId: "preview-advisor-batch",
      createdAt: at(4),
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "preview-mid-reply", toolName: "write", presentation: "reply", arguments: { path: "out://", content: zh ? "上游差异已核对，接着运行类型检查。[查看扩展说明](studio-demo:details)" : "Upstream diffs reviewed; running typecheck next. [View extension details](studio-demo:details)" } },
        { type: "toolResult", toolCallId: "preview-mid-reply", toolName: "write", isError: false },
        ...blocksFromCards(buildStoryCards(zh), "preview-story"),
        {
          type: "text",
          text: (zh ? [
            "## 同步结果",
            "文档已经写到 `docs/UPSTREAM-SYNC.md`，README 加了入口。Studio Bridge 和会话目录保持原路径。",
            "| 检查项 | 状态 | 说明 |\n| --- | --- | --- |\n| 依赖版本 | 已核对 | 对齐上游 v0.8.1 |\n| 同步文档 | 已完成 | 补充变更与回退步骤 |\n| 类型检查 | 待复查 | Mermaid 主题参数需要确认 |",
            "> 接下来先处理类型错误，再检查全屏缩放；文档完成不代表验收完成。",
            "### 复查命令",
            "```bash\n# 类型与对话渲染回归\nnpm run check -- --only renderer --suite CommandBlock --suite markdownWorker --suite markdownBlocks\n```",
            "PowerShell 可以先核对工作目录和可用解释器：",
            "```pwsh\nGet-Location\nGet-Command git, pwsh | Select-Object Name, Source\n```",
            "- [x] 更新同步记录与 README\n- [x] 核对本地路径\n- [ ] 复查类型错误\n- [ ] 确认缩放交互",
          ] : [
            "## Sync Summary",
            "Wrote the sync log to `docs/UPSTREAM-SYNC.md` and added the link in README. Studio Bridge and session paths remain unchanged.",
            "| Check | Status | Notes |\n| --- | --- | --- |\n| Dependency version | Verified | Aligned with upstream v0.8.1 |\n| Sync documentation | Complete | Added changes and rollback steps |\n| Type check | Needs review | Confirm Mermaid theme parameter |",
            "> Next step: fix the type errors before checking fullscreen zoom; completed docs alone do not finish verification.",
            "### Verification Commands",
            "```bash\n# Type and conversation rendering regression suite\nnpm run check -- --only renderer --suite CommandBlock --suite markdownWorker --suite markdownBlocks\n```",
            "Verify the working directory and available shells in PowerShell first:",
            "```pwsh\nGet-Location\nGet-Command git, pwsh | Select-Object Name, Source\n```",
            "- [x] Update sync notes and README\n- [x] Verify local paths\n- [ ] Recheck type errors\n- [ ] Confirm zoom interaction",
          ]).join("\n\n"),
        },
      ],
    },
    {
      kind: "message",
      itemId: "preview-advisor-blocker",
      parentId: "preview-assistant-1",
      createdAt: at(5),
      role: "advisor",
      content: [
        { type: "text", advisor: "upstream-sync", severity: "blocker", text: zh
          ? "类型检查仍未通过，完成修复前不要将本次同步标记为已验收。"
          : "The type check is still failing. Fix it before marking this sync as verified." },
        { type: "text", advisor: "upstream-sync", severity: "concern", text: zh
          ? "修复后重新检查全屏缩放，并将结果补入同步记录。"
          : "Recheck fullscreen zoom after the fix and add the result to the sync notes." },
      ],
    },
  ];
}

export const PREVIEW_CONVO_ITEMS: readonly ConversationItem[] = getPreviewConvoItems();

/**
 * A conversation whose last turn stopped without a final report. The demo story
 * is the empty-composer play button, so the tail here is a truncated answer, not
 * a finished one.
 */
export function getPreviewInterruptedItems(zh = isZh()): readonly ConversationItem[] {
  return [
    RESET,
    {
      kind: "message",
      itemId: "preview-interrupted-user",
      parentId: "preview-reset-1",
      createdAt: at(2),
      role: "user",
      content: [{ type: "text", text: zh ? "把 MermaidBlock 的 TS2322 修掉，然后重跑 typecheck 和 lint。" : "Fix TS2322 in MermaidBlock, then re-run typecheck and lint." }],
    },
    {
      kind: "message",
      itemId: "preview-interrupted-assistant",
      parentId: "preview-interrupted-user",
      createdAt: at(6),
      role: "assistant",
      content: [
        {
          type: "text",
          text: zh
            ? "已经定位到 `MermaidBlock.tsx:147` 的字面量类型问题，改成 `MermaidTheme` 之后 typecheck 只剩两条告警。接下来先把 lint 跑完，再"
            : "Located the literal type mismatch at `MermaidBlock.tsx:147`; after switching to `MermaidTheme`, typecheck leaves only two warnings. Next I'll run lint and",
        },
      ],
    },
  ];
}

export const PREVIEW_INTERRUPTED_ITEMS: readonly ConversationItem[] = getPreviewInterruptedItems();

/** Threads whose preview tail stands for an interrupted turn (`core.continue` demo). */
const PREVIEW_INTERRUPTED_THREADS: ReadonlySet<string> = new Set(["t12"]);

export function previewTailInterrupted(threadId: string | undefined): boolean {
  return threadId !== undefined && PREVIEW_INTERRUPTED_THREADS.has(threadId);
}

/** Independent transcripts, selected through the existing preview sidebar. */
export function previewConversationItems(threadId = "t1", zh = isZh()): readonly ConversationItem[] {
  if (threadId === "t0") return [];
  if (previewTailInterrupted(threadId)) return getPreviewInterruptedItems(zh);
  if (threadId === "t10") return previewGalleryItems(zh);
  if (threadId === "t15") return getPreviewContentGalleryItems(zh);
  return getPreviewThreadItems(zh)[threadId] ?? getPreviewConvoItems(zh);
}

export function getPreviewConvoLive(zh = isZh()): readonly ConversationRuntimeEvent[] {
  return [
    {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "preview-live-turn",
      messageId: "preview-live-user",
      role: "user",
      createdAt: at(18),
    },
    {
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "preview-live-turn",
      messageId: "preview-live-user",
      item: {
        kind: "message",
        itemId: "preview-live-user",
        parentId: "preview-assistant-1",
        createdAt: at(18),
        role: "user",
        content: [{ type: "text", text: zh ? "文档写完了。再跑一遍 typecheck，输出盯着，TS2322 一并修掉。" : "Docs are done. Re-run typecheck, watch the output, and fix TS2322 as well." }],
      },
    },
    {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "preview-live-turn",
      messageId: "preview-live-assistant",
      role: "assistant",
      createdAt: at(20),
    },
    {
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "preview-live-turn",
      messageId: "preview-live-assistant",
      toolCallId: "preview-read-live",
      toolName: "Read",
      arguments: { path: "src/index.ts:1-18" },
      startedAt: at(20),
    },
    {
      kind: "conversation.tool.completed",
      sessionId: session,
      turnId: "preview-live-turn",
      toolCallId: "preview-read-live",
      completedAt: at(21),
      result: {
        type: "toolResult",
        toolCallId: "preview-read-live",
        toolName: "Read",
        isError: false,
        data: {
          offset: 1,
          lines: 4,
          encoding: "UTF-8",
          preview: [
            "export interface ServerConfig {",
            "  readonly port: number;",
            "}",
            "export const port: number = \"30141\";",
          ],
        },
      },
    },
    {
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "preview-live-turn",
      messageId: "preview-live-assistant",
      toolCallId: "preview-bash-live",
      toolName: "Bash",
      arguments: { command: "npm run typecheck", cwd: "D:/Project/omp-web" },
      startedAt: at(21),
    },
    {
      kind: "conversation.tool.updated",
      sessionId: session,
      turnId: "preview-live-turn",
      toolCallId: "preview-bash-live",
      updateMode: "replace",
      output: "\u001b[33m> tsc --noEmit\u001b[0m\n\nsrc/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    },
  ];
}

export const PREVIEW_CONVO_LIVE: readonly ConversationRuntimeEvent[] = getPreviewConvoLive();

export const PREVIEW_CONVO_IDENTITY = { runtimeEpoch: epoch, sessionId: session };

// TODO: applyLiveEvent / buildTimeline removed — fixture generation needs reimplementation
export function previewConversationRows(): TimelineRow[] {
  return [];
}
