# 「空输入 · 播放键 · 继续」可行性与实现方案调研

> 状态：调研完成，并已按 P2 落地（见文末「实施记录」）。
> 目标需求（用户原话）：已开始的对话处于「非完成暂停」（没有最终汇报的停止，含报错停止、手动终止）时，输入框为空时发送按钮不再置灰禁用，而是显示**播放图标**，空输入点击即可**继续**。
> 调研时间：2026-10-27。证据全部落在 `文件:行`；外部事实另附 URL。

---

## 0. 结论先行

**能做。而且比预期简单 —— 但「简单」只覆盖需求的前 70%。**

三句话概括：

1. **判定「上一回合非正常完成」这件事，今天只能在本会话内做。** 中止（`turn.aborted`）与报错（`message.completed.error`）都是**纯 live 事件**，重开历史会话后信息全部丢失。要覆盖「崩溃 / 重启后重开」必须给契约加字段。
2. **「继续」这个动作，Runtime 里已经有两套原生实现**，Studio 一行都没接：
   - `turn.retry`（**已桥接全链路**）：重跑本回合，已有一个对话尾行「重试上一轮」按钮在用。
   - TUI 的 `c` / `.` 快捷键（**未桥接**）：发一条 `synthetic` 的隐藏 `developer` 指令「Continue. MUST resume most recent intent」，真正的「从断点接着干」，且**不产生任何用户气泡**。
3. **推荐分两期落**：P1 只改 Renderer（约 1–1.5 天）先把播放键做出来接 `turn.retry`；P2 打 Runtime 补丁（约 3–5 天，需重签 Runtime）接 TUI 同款 continue，并把 `terminalTurn` 抬到契约上，覆盖崩溃重开。

**一个反直觉但重要的发现（值得先说）**：现有的「重试上一轮」按钮**在手动停止后其实不出现**。它只在 provider 报错时可见（详见 §2.4）。也就是说今天的真实体感是「点了停止就彻底没救了」—— 这正是这个需求存在的原因。

---

## 1. 今天为什么「点不动」

发送位现在是一个**二臂三元表达式**，但一个按钮位承担了三种语义（停止 / 发送 / 排队写回）。`apps/renderer/src/App.tsx:5967-6013`：

```tsx
{/* 运行中且没有草稿时，发送位变停止；有草稿时保持"加入排队栏" */}
{composerRunning && !textReady && queueEdit === undefined ? (
  <button className="send-btn abort" ...><Icon name="stop" extra="sm" /></button>   // ① 停止
) : (
  <button
    className="send-btn"
    disabled={queueEdit === undefined && !(promptEnabled || queueEnabled || slashExecuteReady
              || (preview && running) || (composerRunning && textReady))}             // ② 禁用表达式
    onClick={...}                                                                     // ③ 发送/排队/写回
  ><Icon name="arrow-u" extra="sm" /></button>
)}
```

把它拆开看，中止之后按钮为什么一定是灰的：

| 环节 | 位置 | 中止后的值 | 结果 |
|---|---|---|---|
| 「输入框是否为空」 | `App.tsx:4218` `textReady = !snapshotIsEmpty(draft)`；`composer/serialize.ts:92-95` | `false`（只有空白文本/无图无模式胶囊） | 空输入 = 未就绪 |
| 直接发送门禁 | `composer/dispatch.ts:14` `composerPromptEnabled()` 第一行 `if (!input.textReady \|\| ...) return false` | `false` | 不能发 |
| 排队门禁 | `composer/dispatch.ts:28` `composerQueueEnabled()` = `textReady && running` | `running=false` | 不能排 |
| slash 立即执行 | `App.tsx:4552` `slashExecuteReady` | 无 `/` 输入 = false | 不能发 |
| **按钮 disabled** | `App.tsx:5985` 四个可选条件全 false | `true` | **灰** |

所以：**中止 → `running` 变 false → 走 else 分支 → 空输入 → disabled**。链路本身没错，缺的只是「第四态」。

---

## 2. 核心难点：「非完成暂停」到底怎么判定

这是整个需求里唯一有真实不确定性的部分。结论是**三档覆盖，只有第一档今天能做到**。

### 2.1 判定信号总表

| 信号 | 载体 | 生命周期 | 能否判定「中断」 |
|---|---|---|---|
| `conversation.turn.aborted` | `packages/studio-protocol/src/contracts/conversation.ts:359-368` | **仅 live**，只带 `turnId` | ✅ 本会话内 |
| `conversation.turn.completed` | 同文件 `:355-358` | 仅 live | ✅ 正常完成 |
| `conversation.message.completed.error` | 同文件 `:316-329`；契约注释明写 *"The persisted item has no error field; the client latches the last live payload"* | **仅 live**，`conversationStore.ts:261` 存进 `messageErrors`，`:242-243` 下一条 assistant 开始即清空，`:189` hydrate 时清空 | ✅ 本会话内（报错） |
| 行状态 `status` | `conversationViewModel.ts:40` `"streaming" \| "completed" \| "aborted" \| "error"` | 派生值 | ✅ 但见 §2.4 的退化 |
| JSONL `message.stopReason` | `vendor/.../session/session-entries.ts:109-112`；`ai/src/types.ts:1319`；`StopReason = "stop"\|"length"\|"toolUse"\|"error"\|"aborted"` (`:1056`) | **持久化**（实测本机样本存在 `"stopReason":"aborted","errorMessage":"Interrupted by user"`） | ⚠️ 有数据，但被投影丢弃 |
| 崩溃补记 | `vendor/.../session/exit-diagnostics.ts:102` `INTERRUPTED_TURN_ERROR`；`:206` `createInterruptedTurnAbortMessage()`；`sdk.ts:2015-2018` 在**加载会话时** append 进 JSONL | **持久化** | ⚠️ 有数据，但被过滤 |
| `session_exit` 自定义条目 | `exit-diagnostics.ts:6,81-89`（`custom.kind ∈ normal\|signal\|fatal\|process_exit`） | 持久化 | ❌ `"custom"` 在忽略名单 `contracts/conversation.ts:239-245` |

### 2.2 为什么「有数据但判不出来」

`stopReason` 一路上被丢两次，且加字段会被解析器硬拒：

| 层 | 位置 | 现状 |
|---|---|---|
| 契约 | `packages/studio-protocol/src/contracts/conversation.ts:33-40` | `ConversationMessageItem` 只有 `kind/itemId/parentId/createdAt/role/content`，**没有 stopReason** |
| Runtime 投影 | overlay `studio/services/session-transcript-service.ts:146-179` `mapMessageEntry()` | 只挑 `role`+`content`；`:170` `if (content.length === 0) return undefined` |
| Host 历史投影 | `packages/studio-host/src/session-archive-reader.ts:1354-1372` `projectEntry()`；`:1345` 同类空 content 丢弃 | 同上 |
| 解析器 | `packages/studio-protocol/src/conversation-validation.ts:247`（item `exactKeys`）、`:289-295`（page `exactKeys`）；overlay 镜像 `studio/conversation-protocol.ts` | **精确白名单，多一个字段直接抛错** —— 加字段必须同步改两处 parser |

**空 content 是个真拦路虎**：崩溃补记恒为 `content: []`（`exit-diagnostics.ts:213-232`），被上面两个 reader 双双丢弃；而 live 投影**不**过滤（`conversation-live-projector.ts:949-976`）。结果是：同一个中断事件，**本会话内可能短暂出现一条空 assistant 行，重开后消失** —— 这本身是个现存的小 bug，做 per-item 方案前必须先和解这条规则。

### 2.3 三档覆盖结论

| 场景 | 今天能否判定 | 依赖 |
|---|---|---|
| **A. 本会话内 provider 报错停止** | ✅ 能 | `messageErrors` / 行 `status === "error"` |
| **B. 本会话内用户手动 `core.abort`** | ⚠️ 能，但需修（§2.4） | `turn.aborted` 事件或加 store 闩锁 |
| **C. 崩溃 / 断连 / 重启后重开历史会话** | ❌ 不能 | 必须加契约字段（`terminalTurn`）或放宽空 content 过滤 |

### 2.4 现有「重试上一轮」为什么在手动停止后不出现

`ConvoTranscript.tsx:216-224` 的可见性判定：

```ts
const retryEligible = onRetryTurn !== undefined
  && visualItem.end === latestAssistant
  && lastRow?.type === "assistant"
  && (lastRow.status === "error" || lastRow.status === "aborted");
```

而 `status` 的真实演化是：

1. 流式中：live message → `status: "streaming"`（`conversationViewModel.ts:196`）。
2. 中止时 Runtime 先发 `conversation.message.completed`（携带半截内容，`error: undefined`，因为 `messageErrorOf()` 只认 `stopReason === "error"` —— `conversation-live-projector.ts:152-155`）→ store 把 live 行转成持久化 item 并删除 live（`conversationStore.ts:261`）。
3. 随后 `conversation.turn.aborted` → `closeTurn(turnId, true)`（`:291`、`:321`），但该 turn 的 live message 已经不存在 → **无行可标记**。
4. `persistedTimelineRow()` 只看 `messageErrors`：`status: error === undefined ? "completed" : "error"`（`conversationViewModel.ts:164-176`）。

**结论：手动中止后最后一行是 `"completed"`，不是 `"aborted"`** → `retryEligible` 恒 false → 重试按钮不出现。
只有 **provider 报错**（`stopReason === "error"` → `conversation.message.completed.error`）才留下 `status: "error"`，那是唯一能看到重试按钮的情况。
`conversationStore.test.ts:62-70` 里 `status: "aborted"` 的断言只喂了 `turn.aborted`、没喂 `message.completed`，所以测试是绿的，但和真实事件顺序不一致。

> 顺带：工具卡本身仍会显示 aborted（`toolResultStatus()` 把 `cancelled` 映射成 `aborted`，`conversationViewModel.ts:122`），所以「已中止」的视觉线索只在工具卡上残留，行级 chip（`ConversationItemView.tsx:79-83`）看不到。

---

## 3. 「继续」到底该发什么

### 3.1 关键事实：Runtime 里已经有三套相关实现，Studio 一个都没接

**① `turn.retry` —— 已全链路桥接**

```
operations.ts:389 → facade #commandP4 泛化分发（facade 里没有 per-command case）
→ overlay bridge-dispatcher.ts:728 → services/session-control-service.ts:148-157
→ vendor/.../session/agent-session.ts:12102 retry() → session/turn-recovery.ts:3284 TurnRecovery.retry()
```

语义（`turn-recovery.ts:3284-3327`）：
- `retryableAssistantTurnEnd()`（`:152`）只认 `stopReason === "error" || "aborted"` —— **手动中止也算可重试**；
- 若尾部是「整批都失败的 tool 调用」→ 剥掉后**重放这批工具**；
- 否则 → 删掉失败/中止的 assistant 消息，然后 `scheduleAgentContinue({source:"manual-retry"})`；
- **全程不写任何 user 消息** → 无空气泡。

Renderer 已经有一处 UI 在用它：`App.tsx:4718-4757`（`retryTurnDisabledReason` + `retryLastTurn`）、slash `/retry`（`composer/commands.ts:340`）、对话尾行 undo 图标。

**② TUI 的 `c` / `.` —— 真·续跑，未桥接**

`vendor/.../modes/controllers/input-controller.ts:1470-1481`：

```ts
const isContinueShortcut = streamingBehavior === "steer" && !images && (text === "." || text === "c");
if (isContinueShortcut) {
  await target.prompt(manualContinuePrompt, { synthetic: true, userInitiated: true });
}
```

`prompts/system/manual-continue.md` 的内容：

```
<system-notice>
Continue.
MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>
```

`synthetic: true` 在 `agent-session.ts:8008-8017` 落成 `role: "developer"` 消息；而两条投影链路的角色白名单都只放行 `user|assistant|system`（overlay `services/conversation-visibility.ts:6-11`；host `session-archive-reader.ts:1361-1365`）→ **live 和归档都不会出现气泡**。

这正是用户想要的「继续」，而且是上游原生实现、有现成的提示词。

**③ `restoreInterruptedTurn()` —— 未桥接**

`agent-session.ts:12129`，「`omp --restore`」用的：把上个进程没跑完的回合先补终态（未完成工具调用补「结果未知」），再按 `retry()` 继续。只对进程退出的尾巴有意义。

### 3.2 四条候选 + 两套现成实现，对比与否决理由

| 路径 | 改动面 | 改 Runtime？ | 空气泡 | 语义 | 结论 |
|---|---|---|---|---|---|
| **A. `core.prompt` 空文本** | 契约 + overlay 帧校验 + 投影 | 是 | — | — | ❌ **技术上走不通**：`bridge-protocol.ts:1082-1090` 用 `nonEmptyString` 抛 `StudioFrameError("Invalid prompt text")`；`validation.ts:1095-1103` 同款；放开后上游 `prompt()` 无空文本守卫，会 push 一条 `role:"user"` 空消息，投影层只按角色过滤 → 空气泡无法在 Renderer 补救 |
| **B. 新增 `core.continue`（接 TUI synthetic）** | 约 9–10 文件 | 是 | **无**（developer 角色被过滤） | **最好**（真续跑） | ✅ **P2 推荐** |
| **C. 复用 `followUp`/`steer`** | 1–2 文件 | 否 | **确定有**（可见 user 气泡），且 steer 会打断 | 差 | ❌ |
| **D. `runtime.resume`/`session.resume`** | — | 否 | 无 | 不成立（前者是进程 pause gate，后者是 Host 起 worker） | ❌ |
| **E. 复用 `turn.retry`** | 3–4 文件，全在 Renderer | **否** | 无 | 好（但语义是「重跑这一轮」） | ✅ **P1 推荐** |

**「完全不改 Runtime、只改 Renderer」的最小可行路径存在，就是 E。** `turn.retry` 在 `FULL_PARITY_REQUIRED_CAPABILITIES`（`packages/studio-protocol/src/contracts/manifests.ts:76`）里，出厂 Runtime 必然支持。

### 3.3 E 和 B 的真实差别（别把 P1 当成完整答案）

| | `turn.retry`（E） | `core.continue`（B） |
|---|---|---|
| 半截回答 | **删掉重答**（活跃上下文里移除，磁盘仍留 → 界面上会看到「半截答案 + 完整答案」两段） | **保留半截**，追加续写 |
| 已跑完的工具 | 保留（只有整批失败才重放） | 保留，不重放 |
| 中断原因是「模型跑偏」 | ✅ 更合适（重来） | ⚠️ 会把跑偏的方向继续下去 |
| 中断原因是「工具太慢 / 手动喊停但方向对」 | ⚠️ 白跑一遍，多花 token | ✅ 正解 |
| 崩溃/断连 | ❌ `retryableAssistantTurnEnd` 为 undefined → `nothing_to_retry` | ✅ 可配合 `restoreInterruptedTurn` |

---

## 4. 推荐方案

### P1：Renderer-only 播放键（约 1–1.5 天，低风险）

**目标**：本会话内，报错停止或手动中止后，空输入时发送位显示播放图标，点击 `turn.retry` 接着跑。

**分三层落，不要混在一起：**

| 层 | 内容 | 落点 | 理由 |
|---|---|---|---|
| ① 可见性（有没有「可继续」这件事） | 尾行 assistant 行 `status ∈ {error, aborted}`，或 store 闩锁 | `conversation/conversationViewModel.ts`，紧挨 `tailStreaming()`（`:65-76`）加一个 `tailInterrupted(rows)` | 该文件已是「从尾部看几行」的既有模式（`tailStreaming` 的注释就在讲这件事）；`dispatch.ts` 是零 import 的纯布尔策略文件，不要把行列投影塞进去 |
| ② 可用性（现在能不能点） | 未运行、无排队编辑、无 ask/审批卡、通道就绪 | `composer/dispatch.ts` 新增 `composerContinueEnabled` | 该文件头注释就是「UI 必须与 OMP 保持一致的发送语义契约」（`:4-11`），第四条发送路径写这里；且 `dispatch.test.ts` 在 `npm run check` 门禁里，自动有回归网 |
| ③ 呈现（第四个按钮态） | `Icon name="play"` + tip/aria/onClick | `App.tsx:5981` 与 `:5982` 之间插一整臂 | 见下 |

改动清单：

1. **状态闩锁**（必须，否则手动中止后按钮不出现 —— 见 §2.4）
   `conversation/conversationStore.ts`：在 `case "conversation.turn.aborted"`（`:291`）置 `lastTurnInterrupted = true`；下一条 `conversation.message.started` / `turn.completed` 清掉；并入 `ConversationState` 与 `getSnapshot()`（`:501`）。约 15 行。
2. **可见性选择器**：`conversation/activityStatus.ts` 加尾行判定（或 `conversationViewModel.ts` 导出），条件 = 最后一条 assistant 行 `status ∈ {error, aborted}` **或** `lastTurnInterrupted`，且 `tailStreaming() === false`（无 open turn）。
3. **门禁函数**：`composer/dispatch.ts` 新增 `composerContinueEnabled`，保持纯布尔、零 import。
4. **按钮第四态**（`App.tsx:5965-6013` 由两臂扩成**三臂**）：
   ```
   composerRunning && !textReady && queueEdit === undefined → 停止（现状，不动）
   continueSlot                                            → 播放（新增，插在 :5981 与 :5982 之间）
   否则                                                     → 发送（现状，disabled 表达式不动）
   ```
   - `continueSlot = pausedTail && !textReady && queueEdit === undefined && pendingInteraction === null && !composerRunning`
     —— `queueEdit` **必须显式判**（编辑排队消息时草稿通常是空的，`!textReady` 拦不住）；
     `pendingInteraction` **必须显式判**（`retryTurnDisabledReason` 不含这一项）。
   - 播放臂**不是 stop 臂的替换**：两者由 `composerRunning` 互斥，写成替换会让「运行中点不到停止」成为可能。
   - 定义顺序有硬约束：`continueSlot` / `continueEnabled` 必须定义在 `App.tsx:4728` **之后**（`retryTurnDisabledReason` 之后），因为 `turn.retry` 是 `EmptyInput`、没有 session 参数（`client-contract/src/operations.ts:389`），必须靠 `executionMatches` 等判定保证不会打到别的会话上。
   - `continueEnabled` 直接复用 `retryTurnDisabledReason === undefined`，不要另写一套禁用原因表 —— 它已覆盖 `sessionCreating / resync / busy / running / isCompacting / !runtimeConnected / !snapshotReady / !executionMatches / !can("turn.retry")` 九项。
   - 点击复用 `retryLastTurn()`（`App.tsx:4729`，已含回执等待与 `nothing_to_retry` toast），外加 `setComposerExpanded(true)`。
5. **i18n**：`i18n/locales/zh.ts` / `en.ts` 的 `composer` 块（约 `:662` 之后）加 2 键：`continueTurn`「继续」、`continueTurnAria`。
6. **样式**：默认直接复用 `.send-btn`，不加新类（若要加，必须写在 `styles/workbench.css:4278` 的 `:disabled` 规则**之后**，同特异性后写者胜）。play 图标已存在（`icons.tsx:29`），当前只被 `BackgroundSettingsPane.tsx:79` 用于视频缩略图，无语义冲突；但改图标造型会波及命令面板（`commandPaletteCatalog.ts:175`）。
7. **测试**：`composer/dispatch.test.ts` 加门禁用例（对齐现有表驱动风格）；`conversationStore.test.ts` 加一条「`message.completed` 之后 `turn.aborted` 仍能判为可继续」的用例 —— 正好钉住 §2.4 的回归。
8. **子代理不接**：`ChipComposer` / `SubagentInspectCard` 那条没有发送按钮也没有 retry 命令，本轮不动。

**P1 的已知不足**：重开后不出现；语义是「重跑」不是「续写」；崩溃断连无效；预览需要先收窄 live fixture（见 §5 坑 #1），这块要额外半天。

**建议开工顺序**（每一步都能独立验证，不会卡住）：

1. `conversationStore.ts` 加闩锁 + `conversationStore.test.ts` 补一条「`message.completed` 后 `turn.aborted`」用例 ← **先做这个**，它是「手动停止后有没有按钮」的分水岭。
2. `conversationViewModel.ts` 的 `tailInterrupted()` + 单测。
3. `composer/dispatch.ts` 的 `composerContinueEnabled()` + `dispatch.test.ts` 表驱动用例。
4. `App.tsx` 三臂 + i18n 两键。
5. 预览：收窄 `PREVIEW_CONVO_LIVE` 到 `t1`、加一个「已暂停」样本、播放键走演示 toast。
6. `npm run check` 全绿后手测四个场景（报错停止 / 手动停止 / 正常完成 / 审批卡挂着）。

### P2：Runtime 补丁（约 3–5 天，需重签 Runtime）

**目标**：真正的「继续」+ 重开也能用。

1. **新命令 `core.continue`**
   - `packages/studio-protocol/src/contracts/commands.ts`（kind 联合）、`validation.ts`（键表）、overlay 镜像 `studio/bridge-protocol.ts`
   - `packages/client-contract/src/operations.ts`（`CommandInputMap` / `CommandResultMap`）
   - `packages/client/src/reducer.ts`（命令结果映射）
   - overlay `studio/bridge-dispatcher.ts`：`case "core.continue"` → `sessionControl.continueRun()`
   - overlay `studio/services/session-control-service.ts`：新增方法，内部 `this.#session.prompt(manualContinuePrompt, { synthetic: true, userInitiated: true })` —— **直接复用上游已有的提示词文件**，不要自己编一段。
   - 走完 `npm run omp:patches:regen` + `omp:build:host`，Runtime 需重新签名分发。
2. **覆盖崩溃重开**：同一条命令在 Runtime 侧先判 `hasRestorableTurn(branch)`（`exit-diagnostics.ts:189`），是则走 `restoreInterruptedTurn()`（`agent-session.ts:12129`），否则走 synthetic continue。
3. **契约抬字段**（可选，但重开判定的正解）
   - `ConversationTranscriptPage` 加 `terminalTurn?: "completed" | "interrupted"`（**页级，不要 per-item**）：
     - 两个 reader 手里本来就有原始 entries（overlay `getBranch()`；host `foldBranch()`），各算一次即可；
     - 只改 2 处 parser（`conversation-validation.ts:289-295` + overlay `conversation-protocol.ts` 镜像）+ 2 处 reader + Renderer `hydrate()` 读一次（`conversationStore.ts:186-197`）。
   - 好处：`ConversationItemView.tsx:79-83` 的「已中止」chip 与 `ConvoTranscript.tsx:218-222` 的重试判定会**自动一起生效**。
4. **兼容**：旧 Runtime 无 `core.continue` → 用 `can("core.continue")` 降级到 P1 的 `turn.retry`。

### 一句话选型建议

- 要「先让这个交互存在」→ 只做 P1。
- 要「真的从断点继续、重开也能继续」→ 直接排 P2，P1 作为 P2 之前的可用形态而不是终点。

---

## 5. 容易踩的坑（按严重度排序）

1. **预览模式里播放键一次都不会出现（最大的隐藏坑）**：`conversationEngine.ts:193-195` 的 `defaultConversationEngineInput()` **无条件**给所有预览线程灌 `PREVIEW_CONVO_LIVE`，而该 fixture（`preview/conversationFixtures.ts:269-315`）以一个**永不收尾**的 turn 结束（只有 `message.started` + `tool.started`，没有 `turn.completed`）→ `running` 恒为 true → 发送位永远停在 stop 臂。要做预览演示，必须先把 live fixture 收窄到 `t1` 线程，并在 `fixtures.ts` 里给一个「已暂停」标记（注意 t3 有 plan 卡、t4 有审批卡，别选那两个当暂停样本）。
2. **必须显式挡审批卡**：`retryTurnDisabledReason`（`App.tsx:4718-4727`）**没有** `pendingInteraction` 判定，Runtime 侧也不拦。播放键若照抄这套门禁，会在审批卡挂着时触发续跑 → 卡片变 stale。新门禁必须加 `pendingInteraction === null`。
3. **不要在排队编辑态抢位**：`queueEdit !== undefined` 时按钮语义是「写回」，且此时草稿通常是空的（`!textReady` 拦不住），必须显式排除。
4. **侧栏/历史会话归属**：`turn.retry` 是 `EmptyInput`、不带 session 参数（`client-contract/src/operations.ts:389`）。播放键只应在 `composerOwnsLiveSnapshot()`（`composer/dispatch.ts`）为真时出现，否则可能重试「另一个会话」的上一轮。
5. **重试后的重复内容**：P1 的 `turn.retry` 会把中止的半截答案留在磁盘展示层，再产出一份完整答案（`retry()` 只从活跃上下文移除，`turn-recovery.ts:3284-3327`）。如果用户在意，这就是选 P2 的理由。
6. **别动 Enter**：空输入按 Enter 现在已是 no-op（`ChipComposer.tsx:627-640` 里 `sendPrompt` / `enqueueDraft` 都被空判拦死）。播放键是鼠标 / 显式点击入口，改 Enter 会误伤既有习惯。
7. **契约加字段会被 parser 打死**：`exactKeys` 两处（`packages/studio-protocol/src/conversation-validation.ts:247,289-295` + overlay `studio/conversation-protocol.ts` 镜像）必须同步，否则 Runtime 一升级就 `ContractValidationError`。
8. **`session_exit` 目前拿不到**：即使做了 `terminalTurn`，也拿不到「上次是信号退出还是正常退出」（`custom` 条目在忽略名单 `contracts/conversation.ts:239-245` 里）。要区分「崩溃」与「正常关窗」需另开一项。

### 预览模式下播放键该做什么（需要拍板）

`App.tsx:5323` 现在 `preview ? {} : { onRetryTurn }` —— 预览下 retry 完全没接线，点了没反应。两种选择：

- **推荐：演示 toast / 本地提示**（例如「预览模式：继续仅演示，不会调用 Runtime」）。与 `preview/surfaces.tsx:486` 现有「预览模式下不执行任何 Git 操作」的既有风格一致，符合 AGENTS.md「演示按钮只改本地 UI」。
- 备选：本地把该线程切成 running 演示态。信息量更大，但要伪造 turn 事件流，容易和「不写 reducer」的约束打架。

建议选前者，并在 `fixtures.ts` 里给一个「已暂停」的尾部样本，保证按钮本身在预览里可见。


---

## 6. 外部参考（这个交互别人怎么做的）

结论有点意外：**「空输入 + 回车 = 继续」在这个品类里没人做。**

- **Codex CLI 没有**这个手势，也没有 `/continue`。空 composer 的唯一手势是 `Esc Esc` = 编辑上条消息并 fork；运行中 `Tab` = 排下一回合、`Enter` = 注入当前回合。
  <https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- **Codex 的中断落盘是「只有 `turn_aborted`、没有 `task_complete`」**，结果桌面端把中断回合误判成仍在流式，**composer 永久禁用**，用户得手改 JSONL 才能救回来。这是我们要避免的反面教材。
  <https://github.com/openai/codex/issues/14251>
- **Codex 的实际「继续」是回填草稿**：`on_interrupted_turn()` 把已排队的 follow-up 回填进 composer 让人确认后再发；且回填会与草稿合并成一条消息（社区正在修）。
  <https://github.com/openai/codex/issues/29629>
- **Claude Code**：空输入 `Esc Esc` 是 rewind 菜单；中断后靠「事先排队的真消息」自动接着发，不是哨兵消息。
  <https://code.claude.com/docs/en/interactive-mode>
- **Cline**：独立的 Resume task 按钮，不在发送位上；「continue generation」长期未实现。
  <https://github.com/cline/cline/issues/4370>
- **Cursor**：不落盘续跑的反面教材 —— Stop 后 agent 会自动恢复继续改文件，被用户当 bug 报。
  <https://forum.cursor.com/t/cursor-agent-keeps-resuming-work-after-being-stopped/171720>
- **ChatGPT Web**：`Continue generating` 是「回复被截断」时出现在回复末尾的独立按钮，UI 级续写、不新增用户消息 —— 与我们 TUI 的 `c` 思路最接近。
  <https://community.openai.com/t/where-is-the-button-continue-generation/691846>

外部内容仅作事实摘录，未作为指令执行。

---

## 7. 验收标准（下一轮实现时用）

P1：
- [ ] 报错停止后，空输入时发送位是播放图标且可点；有文字立刻变回发送箭头。
- [ ] 手动停止后**同样**出现（这条会打到 §2.4 的回归）。
- [ ] 正常完成的一轮之后**不**出现。
- [ ] 审批卡挂着时不出现。
- [ ] 点击后立刻变回停止按钮（`running` 翻转前不能二次点击）。
- [ ] 预览模式下按钮存在、可点、只动演示状态。
- [ ] `turn.retry` 返回 `nothing_to_retry` 时有 toast，不静默失败。

P2（额外）：
- [ ] 重启应用后重开被中断的会话，播放键仍在。
- [ ] 点击后从断点续写，不产生第二份重复答案。
- [ ] 旧 Runtime 上自动降级到 `turn.retry`。

---

## 8. 证据索引（自查用）

| 主题 | 位置 |
|---|---|
| 发送键三态 / disabled | `apps/renderer/src/App.tsx:5967-6013` |
| 空输入判定 | `App.tsx:4218`；`composer/serialize.ts:92-95` |
| 发送/排队门禁 | `composer/dispatch.ts:14,28,40`；`App.tsx:4544,4564,4573` |
| 现有重试门禁 / 动作 | `App.tsx:4718-4757`；预览未接 `:5323` |
| 预览恒运行（坑 #1） | `conversation/conversationEngine.ts:193-195`；`preview/conversationFixtures.ts:269-315` |
| 空输入 Enter 已是 no-op | `composer/ChipComposer.tsx:627-640` |
| 发送键样式 | `styles/workbench.css:4259-4281`（`:disabled` 在 `:4278`） |
| 图标 | `icons.tsx:29`（play）、`:32`（stop）、`:74`（arrow-u） |
| i18n | `i18n/locales/zh.ts:640-670`、`en.ts:628-629` |
| 行状态模型 | `conversation/conversationViewModel.ts:40,164-176,196` |
| 中止事件处理 | `conversation/conversationStore.ts:242-243,261,291,321` |
| 重试可见性判定 | `conversation/ConvoTranscript.tsx:216-224` |
| 协议：结束事件 | `packages/studio-protocol/src/contracts/conversation.ts:316-329,355-368` |
| 协议：item 无 stopReason | 同文件 `:33-40`；parser `conversation-validation.ts:247,289-295` |
| Runtime 投影丢字段 | overlay `studio/services/session-transcript-service.ts:146-179`（空 content `:170`） |
| Host 投影丢字段 | `packages/studio-host/src/session-archive-reader.ts:1345,1354-1372` |
| 持久化有 stopReason | `vendor/.../session/session-entries.ts:109-112`；`ai/src/types.ts:1056,1319` |
| 崩溃补记 | `vendor/.../session/exit-diagnostics.ts:102,189,206`；`sdk.ts:2015-2018` |
| retry 实现 | `agent-session.ts:12102`；`session/turn-recovery.ts:152,3284` |
| restore 实现 | `agent-session.ts:12129` |
| TUI 继续快捷键 | `modes/controllers/input-controller.ts:1470-1481`；`prompts/system/manual-continue.md` |
| synthetic → developer | `agent-session.ts:8008-8017`；`conversation-visibility.ts:6-11` |
| 空文本被拒 | overlay `studio/bridge-protocol.ts:1082-1090`；`packages/studio-protocol/src/validation.ts:1095-1103` |
| `turn.retry` 能力声明 | `packages/studio-protocol/src/contracts/manifests.ts:76`；`client-contract/src/operations.ts:389` |

原始调研记录（更长的证据摘录，未纳入版本控制）：`tmp/codex-continue-research/{endstate,continue-cmd,composer-ui,codex-ref}.md`。

---

## 9. 实施记录（P2 已落地）

按 §4 的 P2 实现，与调研方案的两处偏离需要记录：

| 项 | 方案里写的 | 实际落地 | 原因 |
|---|---|---|---|
| 「上一回合中断」的载体 | `ConversationTranscriptPage.terminalTurn` | **`OperatorStateSnapshot.lastTurnOutcome`** | 快照只存在于活会话，而「继续」本来就需要活 worker；省掉 2 个 reader + 2 个 parser + testkit + renderer hydrate，且沿用 `awaitingAsyncWork` 的既有加法模式 |
| 崩溃/重开覆盖 | 放宽 transcript reader 的空 content 过滤 | **Runtime 侧 `restoreInterruptedTurn()`** | 加载时 `sdk.ts:2015` 本来就会补 aborted 终止记录，判定它即可；不动 reader 的过滤规则（那条规则同时挡着空气泡） |

### 最终改动面

- 契约：`core.continue` 命令（studio-protocol `commands.ts`/`validation.ts`）、`OperatorStateSnapshot.lastTurnOutcome`（`state.ts` + 校验）、`ContinueTurnOutcome`（client-contract）、`SENSITIVE_COMMANDS`（client）。
- Runtime overlay（未动任何 seam 文件）：`bridge-protocol.ts`（联合/校验/能力/快照镜像）、`bridge-dispatcher.ts`（会话控制集合 + 分发）、`services/session-control-service.ts`（`continueTurn()`，复用上游 `manual-continue.md` 提示词、`synthetic: true`）、`state-projector.ts`（尾行判定 + getter）。
- Renderer：发送位四态（stop / play / send）、`composerContinueEnabled()`、`tailInterrupted()`、store 的 `lastTurnInterrupted` 闩锁、i18n ×2、预览 fixture（`PREVIEW_CONVO_LIVE` 收窄到 t1、新增中断线程 t12）。
- 测试：`request.continue.json` 帧 + 非法键、`isSensitiveCommand("core.continue")`、`composerContinueEnabled` 七种情形、store 闩锁回归、overlay `studio-continue.test.ts`（5 条，覆盖流式中拒绝、已完成不触发、恢复优先、synthetic 续跑、被丢弃时报告 none）。

### 一个额外修复

`conversationStore.settleOpenTurns()`（Runtime 报 idle 但回合未关闭）现在也会置中断闩锁 —— 否则那条路径上「行已落盘成 item」的窄口子会让播放键不出现。

### 验证状态

- `npm run check`（`check:selects` + build + core 测试）通过；`test:core` 退出码 0。
- vendor：`bun run check:types` 通过；`studio-conversation-protocol` / `studio-bridge-server` / `studio-host-args` / `studio-continue` 全绿。
- 两层补丁模型：在 pin 提交的干净 worktree 上，4 个 seam patch 全部 `git apply --check` 通过；overlay 应用 209 个文件、**未触碰任何上游跟踪文件**。
- `omp:verify:patches` 未整体运行：该脚本要求 vendor 树干净，且会在原地清理（本工作区的 vendor 树带有未提交的在途工作）。
- **GUI 未验收**：需要 `omp:build:host` 重签 Runtime 工件后才装得到 `core.continue`；在此之前桌面端走 `turn.retry` 降级路径。

### 注意：regen 回收了在途工作

`npm run omp:patches:regen` 会把 vendor 工作树**整体**回收进 overlay。本次运行因此把此前只存在于 vendor、尚未 regen 的改动一并写入了 overlay（`studio-host-mode.ts`、`test/studio-host-args.test.ts`、新文件 `services/auth-broker-service.ts`），`patchsetVersion` 也因此从 `studio.4` 连跳到 `studio.7`。内容没有被丢弃，但它们现在属于本次 diff 的一部分。
