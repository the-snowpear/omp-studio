import type { SwarmMessage } from "../agents/deck/comms";
import type { LaneMark } from "../agents/deck/timelineModel";
import { PREVIEW_AGENT_EPOCH } from "./agentDockPreview";

/**
 * Demo-only extras for the Agents deck, on top of the shared roster story in
 * agentDockPreview.ts (main → docs, advisor, audit, spike, deps → typecheck,
 * preview, lint). The advisor observes and does not message; nothing
 * here reaches the Host: stage trails stand in for what the recorder would have
 * seen, the rate curve for its samples, and the message thread for the IRC read
 * model the Runtime does not offer yet.
 */

const MAIN = "agent-019fac94", DOCS = "agent-019fc9d2", DEPS = "agent-019fcb01", PREVIEW = "agent-019fcb17", LINT = "agent-019fcb55", TYPECHECK = "agent-019fcb20";
const ADVISOR = "advisor-019fab10", AUDIT = "agent-019fc8a0", SPIKE = "agent-019fc77e";
const at = (secondsAgo: number) => PREVIEW_AGENT_EPOCH - secondsAgo * 1000;

const TRAILS: Record<string, readonly (readonly [number, string, string])[]> = {
  [MAIN]: [
    [1490, "读取 docs/ 与上游 CHANGELOG", "Reading docs/ and the upstream CHANGELOG"],
    [1450, "派生 docs 子 Agent 起草章节", "Spawned docs subagent to draft sections"],
    [1385, "请 advisor 评审存储层重构", "Asked the advisor to review the storage refactor"],
    [1325, "派生 audit 子 Agent 做发布前合规检查", "Spawned audit subagent for the pre-release compliance check"],
    [1245, "派生 spike 子 Agent 试验 ws 通道", "Spawned spike subagent to try a WebSocket channel"],
    [815, "派生 deps 子 Agent 审计依赖", "Spawned deps subagent for the audit"],
    [668, "派生 preview 子 Agent 验证 Mermaid", "Spawned preview subagent for Mermaid"],
    [441, "派生 lint 子 Agent 回归扫描", "Spawned lint subagent for regressions"],
    [120, "Bash · npm run typecheck", "Bash · npm run typecheck"],
  ],
  [DOCS]: [
    [1440, "读取 UPSTREAM-SYNC 现稿", "Reading the current UPSTREAM-SYNC draft"],
    [1100, "起草三阶段章节", "Drafting the three phases"],
    [760, "草稿 v2 已交付，空闲 TTL 到期自动 park", "Draft v2 delivered; auto-parked on idle TTL expiry"],
  ],
  [DEPS]: [
    [808, "扫描 lockfile 间接依赖", "Scanning lockfile for transitive deps"],
    [298, "派生 typecheck 子 Agent", "Spawned typecheck subagent"],
    [140, "对比 pi-mermaid 类型签名", "Diffing pi-mermaid type signatures"],
    [36, "Grep · \"pi-core\" in lockfile", "Grep · \"pi-core\" in lockfile"],
  ],
  [PREVIEW]: [
    [660, "打开 Mermaid 全屏预览", "Opening Mermaid fullscreen preview"],
    [410, "125% DPI 缩放截图", "Capturing zoom at 125% DPI"],
    [63, "AskUser · 缩放交互确认", "AskUser · confirm zoom interaction"],
  ],
  [LINT]: [
    [436, "eslint . 第 1 次", "eslint . run 1"],
    [418, "eslint . 第 2 次", "eslint . run 2"],
    [401, "Bash · eslint . (exit 2)", "Bash · eslint . (exit 2)"],
  ],
  [TYPECHECK]: [
    [292, "bunx tsc --noEmit", "bunx tsc --noEmit"],
    [140, "归类 renderer 类型错误", "Classifying renderer type errors"],
  ],
  [ADVISOR]: [
    [1375, "读取 session 存储层重构方案", "Reading the session storage refactor proposal"],
    [1290, "列出迁移与回滚风险点", "Listing migration and rollback risks"],
    [1205, "评审意见已交付，只读待命", "Review delivered; standing by read-only"],
  ],
  [AUDIT]: [
    [1315, "扫描 LICENSE 与 NOTICE", "Scanning LICENSE and NOTICE"],
    [1150, "审计依赖许可证", "Auditing dependency licenses"],
    [960, "生成合规报告与补丁", "Writing the compliance report and patch"],
    [910, "报告已生成，等待手动 revive", "Report ready; waiting for manual revive"],
  ],
  [SPIKE]: [
    [1236, "试验 ws 通道替代 stdio", "Trying a WebSocket channel in place of stdio"],
    [1210, "方案被否决，由用户停止", "Proposal rejected; stopped by the user"],
  ],
};

export function previewStageMarks(agentId: string, zh: boolean): readonly LaneMark[] | undefined {
  return TRAILS[agentId]?.map(([seconds, zhText, enText]) => ({ at: at(seconds), text: zh ? zhText : enText }));
}

/** The swarm's generation rate at `instant`: three running agents, breathing. */
export function previewRate(instant: number): number {
  const t = instant / 1000;
  return Math.max(0, 145 + 16 * Math.sin(t / 7) + 9 * Math.sin(t / 2.3 + 1) + 5 * Math.sin(t / 1.1 + 2));
}

let firstOpen: number | undefined;

type Script = readonly [from: string, to: string | "all", zh: string, en: string, when: number, extra?: { progress?: boolean; replyTo?: string }];
/** Negative `when`: seconds before the epoch. Positive: seconds after the deck first opened. */
const THREAD: readonly Script[] = [
  [MAIN, DOCS, "先按「准备 / 同步 / 验证」三阶段起草 `UPSTREAM-SYNC.md`，引用现有 CI 步骤。", "Draft `UPSTREAM-SYNC.md` in three phases (prepare / sync / verify) and cite the existing CI steps.", -1432],
  [DOCS, MAIN, "草稿 v2 已写入 `docs/UPSTREAM-SYNC.md`（+214 行）。第三阶段的回滚步骤需要你确认。", "Draft v2 is in `docs/UPSTREAM-SYNC.md` (+214 lines). The rollback steps in phase three need your call.", -768],
  [MAIN, DEPS, "审计 `@earendil-works/pi-*` 0.82.1，重点看 pi-mermaid 的类型签名有没有破坏性变更。", "Audit `@earendil-works/pi-*` 0.82.1. Focus on breaking changes in the pi-mermaid type signatures.", -806],
  [LINT, "all", "`.eslintrc` 里有合并冲突标记，eslint 两次都 exit 2。我先停下，别依赖这轮 lint 结果。", "`.eslintrc` still has merge-conflict markers and eslint exited 2 twice. Stopping here; don't rely on this lint run.", -404],
  [MAIN, LINT, "收到，冲突我来处理，你停在这里就好。", "Got it. I'll resolve the conflict; stay parked.", -396, { replyTo: "m4" }],
  [DEPS, TYPECHECK, "帮我跑一遍 `bunx tsc --noEmit`，把 renderer 的错误按包归类后回给我。", "Run `bunx tsc --noEmit` and send me the renderer errors grouped by package.", -296],
  [TYPECHECK, DEPS, "进度：已归类 14 个错误，其中 11 个来自 `MermaidBlock.tsx` 的新签名。", "Progress: 14 errors grouped so far; 11 come from the new signature in `MermaidBlock.tsx`.", -118, { progress: true, replyTo: "m6" }],
  [PREVIEW, MAIN, "Mermaid 全屏在 125% DPI 下拖拽会抖动。继续之前需要先确认平移要不要保留惯性。", "Mermaid fullscreen jitters while panning at 125% DPI. Before I go on: should panning keep inertia?", -66],
  [DEPS, MAIN, "pi-mermaid 0.82.1 把 `render()` 改成了异步签名，这是唯一的破坏性变更。", "pi-mermaid 0.82.1 made `render()` async. That is the only breaking change.", -38],
  [TYPECHECK, DEPS, "类型检查完成：14 个错误都指向 `MermaidBlock.tsx`，补丁已生成 `agent-019fcb20.patch`。", "Typecheck done: all 14 errors point at `MermaidBlock.tsx`. Patch ready in `agent-019fcb20.patch`.", 7, { replyTo: "m7" }],
  [DEPS, MAIN, "建议先合并 typecheck 的补丁再跑一次全量检查。我这边审计结束。", "Suggest merging the typecheck patch, then one more full check. My audit is done.", 16],
  [MAIN, "all", "开始合并补丁，各位先暂停写入 `renderer/`。", "Merging the patch now. Hold any writes to `renderer/` for a moment.", 27],
];

const EVERYONE = [MAIN, DOCS, DEPS, PREVIEW, LINT, TYPECHECK];

export function previewSwarmMessages(zh: boolean): readonly SwarmMessage[] {
  firstOpen ??= Date.now();
  return THREAD.map(([from, to, zhText, enText, when, extra], index) => ({
    id: `m${index + 1}`,
    from,
    to: to === "all" ? EVERYONE.filter(id => id !== from) : [to],
    body: zh ? zhText : enText,
    at: when < 0 ? at(-when) : firstOpen! + when * 1000,
    ...(to === "all" ? { peer: true, peerInstance: "agent://peers/reviewer", broadcast: true } : {}),
    ...(extra?.progress ? { progress: true } : {}),
    ...(extra?.replyTo ? { replyTo: extra.replyTo } : {}),
  })).sort((a, b) => a.at - b.at);
}
