# OMP 真实对话接入代码审查报告

> 审查日期：2026-08-15  
> 对比基线：`6778fd3502f818a55a6d2fbbf66d569167e57ba6`（`feat: expand models/MCP/agents host bridge and renderer workbench UI`）  
> 审查范围：基线提交之后的全部已跟踪修改与未跟踪新增文件  
> 目标：关闭预览模式后，用户能够在 OMP Studio 中创建/恢复真实会话、发送消息、看到历史和实时输出、处理工具与审批，并在断线或切换会话后正确恢复。

## 1. 执行摘要

本次修改已经搭出了真实对话的大部分纵向结构：主会话 transcript contract、历史分页、Runtime live conversation event、Host/Facade/Client 投影、Renderer 对话 UI、会话恢复和 Interaction Deck 都已有实现，类型检查、单元测试和构建也能通过。

但当前版本仍不建议提交为“真实对话可用”。审查确认有 3 个 P0 阻断项，它们会分别导致：第一轮对话后下一条命令被 Runtime 拒绝、Renderer 永久持有空或旧 snapshot、首次选择工作区后输入框一直禁用。另有若干 P1 会造成工具执行过程不可见、正常事件被误判为丢包、审批无法关联、启动失败泄漏进程以及命令失败不反馈。

当前判断：

- 协议与数据模型：已基本成形。
- 历史读取与 live event：实现较完整，但时序和状态同步仍有阻断问题。
- Renderer：预览/真实双源已接入，但生命周期刷新与工具 live 合并仍不正确。
- 会话与审批：基础路径已接，但 requestId、receipt 和新建会话语义不完整。
- 交付验证：测试覆盖面较广，但尚未完成真实 OMP + Electron 自动化闭环，也未验证补丁可从干净 vendor 重放。

## 2. 严重级别定义

| 级别 | 含义 |
|---|---|
| P0 | 阻断真实对话主路径；必须在合并或宣称可用前修复。 |
| P1 | 重要正确性、恢复性或安全性问题；主路径可能在特定时序下失败。 |
| P2 | 产品语义、仓库卫生或体验问题；不一定阻断最小闭环，但应在发布前处理。 |

## 3. P0 阻断项

### P0-1：Conversation 事件推进了 Runtime `stateVersion`，但 Host snapshot 没有同步推进

位置：

- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/state-projector.ts:208-213`
- `packages/studio-host/src/runtime-projection.ts:63-75`

现状：`#emitConversation()` 对部分对话事件递增 `#stateVersion` 并更新 Runtime 内部 snapshot，随后只发 conversation event；Host 的 `RuntimeProjection` 只在收到 `state.changed` 时替换 snapshot。

影响：Host 继续持有旧 `stateVersion` 和旧 `isStreaming`。Desktop 下一次调用 Runtime 时用这个旧版本作为 `expectedStateVersion`，Runtime command arbiter 会严格拒绝不匹配的请求。典型表现是第一轮 assistant/tool/turn 完成后，第二条消息或其他控制命令收到 `STATE_VERSION_CONFLICT`；Abort、running 和 pending 状态也可能滞后。

修改建议：

1. 规定唯一的 authoritative 状态推进规则。凡 `conversationAdvancesStateVersion()` 返回 `true`，必须在同一顺序流中发布可供 Host 应用的最新 snapshot。
2. 推荐由 Runtime 紧随 conversation event 发 `state.changed`，或者扩展事件使 conversation envelope 携带可验证的新 snapshot/version；不要让 Host 自行猜测状态。
3. 保证同一事件序列中 conversation update 与 snapshot 的先后次序确定，并继续使用 Bridge 的全局 `eventSeq` 做 gap 检测。
4. 增加真实时序测试：`core.prompt -> message/tool/turn completed -> 第二次 core.prompt`，断言第二次命令使用最新版本并成功受理。

验收标准：

- 连续发送至少 20 轮消息不出现 `STATE_VERSION_CONFLICT`。
- `isStreaming`、`pendingMessages`、Abort 按钮状态在 turn 开始/结束后及时更新。
- Host publication 的 snapshot version 与 Runtime 最后已提交 snapshot 一致。

### P0-2：Facade 只发布版本通知，不向 Client 发布新 snapshot；epoch 切换也没有重置版本域

位置：

- `packages/host-client-api/src/facade.ts:787-797`
- `packages/client/src/reducer.ts:478-483`
- `packages/client/src/reducer.ts:536-566`
- `packages/client/src/reducer.ts:698-719`
- `apps/renderer/src/App.tsx:1528-1535`

现状：Facade 的 `#onPublication()` 只发 `state.changed`，Client reducer 对该事件只推进连接游标；真正更新 `entities.snapshot` 的只有 `snapshot` 事件。同时，Facade 的 `#lastPublishedVersion` 跨 Runtime epoch 保留，Client 切换 epoch 时也没有清空旧 `stateVersion` 和旧 snapshot。新 Runtime 的 version 通常从较小值重新开始，随后可能被 reducer 的“版本不可回退”规则丢弃。

影响：

- 首次启动没有 active workspace 时，bootstrap snapshot 为空；选择工作区后 Renderer 仍没有 snapshot，composer 永久 gated。
- prompt 之后 `isStreaming`/`pendingMessages` 停留在 bootstrap 值，running strip、Abort 和发送门控失真。
- workspace/session resume 后仍可能显示旧 session 的 snapshot 和 identity。
- 新 Runtime 的 snapshot version 小于旧 Runtime 时会被直接拒绝。

修改建议：

1. Facade 在 publication snapshot 变化时发完整 `snapshot` ClientEvent，而不是只发版本提示。
2. 将版本单调性限定在同一个 `runtimeEpoch` 内。epoch 变化或 runtime lost 时，清空旧 `stateVersion`、cursor 相关状态、`entities.snapshot` 和 session-scoped conversation。
3. Facade 识别 epoch 变化时重置 `#lastPublishedVersion`，随后无条件发新 epoch 的首个完整 snapshot。
4. 为 bootstrap 空态、首次 workspace pick、workspace switch、session resume、disconnect/reconnect 分别加 reducer + facade 集成测试。

验收标准：

- 从无 workspace 启动，选择目录后不重载窗口即可发送消息。
- 切换 session 后 Renderer identity、snapshot 和 transcript 同时切换，不残留旧数据。
- 新 epoch 的较小 stateVersion 可被接受，旧 epoch 的迟到事件会被忽略。

### P0-3：首次激活工作区后没有刷新 capability/command manifest，`core.prompt` 仍不可用

位置：

- `apps/renderer/src/App.tsx:1493-1501`
- `apps/renderer/src/App.tsx:1944-1960`
- `apps/renderer/src/App.tsx:1965-1983`

现状：无 workspace 的首次 bootstrap 会得到 neutral manifest。用户执行 `workspace.open` 或 `workspace.pick` 后，Renderer 只刷新 `projects.list`，没有重新获取 `capabilities.get`、`commands.getManifest` 或执行完整 resync。Workbench 的 `can()` 优先读取此前保存的 neutral capabilities。

影响：Runtime 已成功连接，Renderer 仍认为 `core.prompt` 不存在，发送按钮和 Enter 永久禁用，直到整个窗口重载。

修改建议：

1. 将 manifest 视为 Runtime lifecycle 数据，随 runtime epoch/connection transition 主动刷新。
2. workspace open/pick/resume 完成后执行统一的 `resyncRuntimeModel()`，一次性刷新 snapshot、capabilities、command manifest 和 conversation identity。
3. 避免在多个按钮回调里分别补 query；应由 Runtime 生命周期事件触发统一刷新，防止 session switch 再次遗漏。
4. 增加“首次无 workspace -> pick -> Runtime connected -> prompt enabled”的 Renderer 集成测试。

验收标准：

- 首次选择工作区后，无需重载即可看到真实 capabilities 并发送消息。
- workspace/session 切换后 manifest 与当前 Runtime epoch 一致。

## 4. P1 重要问题

### P1-1：真实工具执行更新没有合并到已持久化的 assistant 行

位置：

- `apps/renderer/src/conversation/conversationViewModel.ts:814-825`
- `packages/client/src/conversation-reducer.ts:135-140`
- `packages/testkit/src/conversation-fixtures.ts:204-269`

现状：真实 AgentSession 的顺序通常是 assistant `message_end` 先发生，随后才有 `tool_execution_start/update/end`。工具事件关联已持久化的 assistant messageId，但 `rowsFromConversationViews()` 对持久 item 固定传入空的 `liveTools`，reducer 又会过滤已经对应持久 item 的 live tool。现有 fixture 使用了工具事件先于 `message.completed` 的非真实顺序，因此没有暴露问题。

影响：Bash、Read、Task 等工具运行中和结束结果不会实时显示，只能等下一次 transcript reload 后才出现。

修改建议：

1. Conversation selector/view 应允许 persisted item 关联同 messageId 的 live tools。
2. 工具完成并进入 authoritative transcript 后再清除 live tool，避免重复显示。
3. fixture 改成 AgentSession 的真实事件顺序，并覆盖并行 tool call、partial result、error result。

### P1-2：Conversation reducer 把全局 `eventSeq` 误当成对话专用连续序列

位置：`packages/client/src/conversation-reducer.ts:143-157`

现状：reducer 要求每个 conversation event 的 `eventSeq` 必须恰好为前一个加一。但该序号是整个 Runtime 事件流共享的；两个 conversation event 之间合法出现 `state.changed`、`interaction.required` 或其他事件时，对话 fanout 不会把中间事件交给 reducer。

影响：正常的事件交错会被误判为 gap，触发不必要的 transcript resync，造成闪烁、额外 I/O，严重时 live 更新长期停在 resync 状态。

修改建议：

- Bridge 层已经检查全局序列连续性，conversation reducer 只需检查单调递增和去重；或者协议新增独立的 `conversationSeq`。
- 增加 `conversation seq=10 -> 非对话 seq=11 -> conversation seq=12` 用例，断言不会 resync。

### P1-3：`session.drop` 使用新生成的 Runtime requestId，Interaction 无法回到原 Client command

位置：

- `apps/desktop/src/session-commands.ts:70-94`
- `packages/client/src/reducer.ts:612-620`

现状：Desktop 执行 `session.drop` 时生成新的随机 Runtime requestId，而 Client ledger 跟踪的是 Facade 收到的原 requestId。Runtime 发 destructive confirmation 时携带随机 id，Client reducer 找不到对应 command，因而丢弃 Interaction。

影响：真实的 drop 审批不会出现在 Deck，命令可能一直等待或失败。

修改建议：

- 与通用 invoke 路径一致，将原 Client requestId 明确传入 drop service 并原样送入 Runtime；不要用 operation kind 或 interactionId 猜关联。
- 增加 `session.drop -> interaction.required -> submit/cancel -> 原 command terminal receipt` 端到端测试。

### P1-4：Runtime 启动中途失败时 `stopCurrent()` 可能不清理已启动进程和 socket

位置：`apps/desktop/src/runtime-session.ts:146-163`

现状：`stopCurrent()` 在 `bundle` 尚未赋值时直接返回。但 launch 在 bundle 建立前已经创建 Bridge、启动 process port 并执行 refresh/hello/manifest。中间任一步失败，switchSession catch 调用 `stopCurrent()` 仍会直接返回。

影响：残留 omp 进程、socket 和 listener；下一次重试可能形成重复 Runtime 或端口冲突。

修改建议：

1. 清理条件基于各资源本身是否存在，而不是 `bundle` 是否存在。
2. launch 使用分阶段资源所有权或 `try/finally` rollback。
3. 增加 spawn 后 refresh 失败、hello 失败、manifest 失败三组测试，并断言 port stop、bridge close、controller dispose 各执行一次。

### P1-5：Terminal receipt 的发布与状态保真不完整，Renderer 多处把 accepted 当 completed

位置：

- `packages/studio-host/src/runtime-session-controller.ts:58-69`
- `apps/desktop/src/runtime-session.ts:323-330`
- `apps/desktop/src/session-commands.ts:121-131`
- `apps/renderer/src/App.tsx:1515-1526`
- `apps/renderer/src/App.tsx:1592-1605`

现状：Runtime receipt callback 会更新 controller store，但 Desktop 只在 projection changed 时 emit publication；若 terminal receipt 不伴随 projection event，Facade 看不到 terminal outcome。Desktop semantic invoke 又把所有 non-completed 状态统一转换为 `INTERNAL_ERROR`。Renderer 的 steer、abort 和 interaction.respond 只等待 `client.command()` 返回 accepted；steer 随后立即清空草稿。

影响：真实的 rejected、failed、outcome_unknown 可能丢失或被错误归类；Steer 失败会丢用户输入；Abort/审批失败没有可靠反馈。

修改建议：

1. controller publication store 变化本身应触发 Desktop publication，不依赖 projection event。
2. Facade 保留 Runtime receipt 的原始 terminal status 和 error code，不要把 rejected/outcome_unknown 全部折叠成 INTERNAL_ERROR。
3. Renderer 所有关键写命令复用统一的 `accepted -> wait terminal receipt -> 更新 UI` helper；失败时恢复 draft/interaction 并显示 Host 错误。
4. 测试所有 terminal 状态，以及 receipt 不伴随 state.changed 的情况。

### P1-6：`waitReceipt()` 存在先返回 accepted、后订阅的竞态

位置：`apps/renderer/src/hostError.ts:20-38`

现状：调用者在 `client.command()` 返回后才调用 `waitReceipt()`；如果 terminal receipt 很快到达，可能在订阅安装前已经进入 reducer。helper 又不读取现有 command state，只能等待到 120 秒超时。

修改建议：

- 优先在发 command 前准备 terminal waiter；或让 StudioClient 提供原子的 `commandAndWait()`。
- 若保留当前 helper，应先查询 reducer 中已有 receipt，再订阅，并在订阅后复查一次以关闭竞态窗口。
- 增加同步/同 tick terminal receipt 测试。

### P1-7：生产安装 seam 未接入，干净机器无法在应用内安装 managed Runtime

位置：

- `apps/desktop/src/host-factory.ts:599-614`
- `apps/desktop/src/host-composition.ts:300-305`

现状：当前 production composition 支持已有 managed Runtime 或 compatible system OMP；但 host factory 没有注入 install service，fallback 固定抛错。

影响：机器上既没有兼容 system OMP、也没有 managed manifest 时，应用无法自行完成真实对话所需 Runtime 安装。

修改建议：

- 如果本轮交付要求 clean install 可用，接入受信 installer service，并测试下载/校验/安装/失败回滚。
- 如果本轮只支持预装 Runtime，应在 UI 和交付说明中明确前置条件，安装按钮保持禁用并说明原因。

## 5. P2 产品与仓库问题

### P2-1：“新建对话”仍有入口只执行导航，不创建新 session

部分侧栏和菜单入口仍只打开 workbench，和 `sessionLifecycle.ts` 中“当前不可新建”的定义不一致。用户会以为已经开启新会话，实际继续写入旧 session。

建议所有入口统一调用同一个 `startNewChat`；若 contract 尚不可用，所有入口统一禁用并显示原因，不能只修 command palette。

### P2-2：流式期间没有 follow-up/queue 提交入口

当前 running 时 Enter 被直接吞掉，普通发送按钮禁用，只能 Steer 或 Abort；协议和 Runtime 已有 follow-up/queue 能力，但 Renderer 未接入。若产品目标包含 OMP 原生跟进队列，应在后续任务接入；若本轮不做，UI 文案应明确这是能力缺口。

### P2-3：提交范围包含疑似工作文件和二进制归档

当前未跟踪内容包括 `.omp/agents/*.md`、`architecture_review_v2_work/...rar`、`skills-lock.json` 等。它们未必属于真实对话产品代码。

建议提交前逐项分类：

- 产品源码、正式文档、patch 和测试：按功能提交。
- Agent 临时配置、压缩归档和重复架构包：默认排除，除非仓库明确需要。
- 不要把本地执行产物或个人环境锁文件混入真实对话功能提交。

## 6. 验证结果

本轮只读审查执行了以下验证：

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | 当前类型层可编译。 |
| `npm test` | 通过 | Renderer、Desktop、packages 测试通过；部分真实 fault scenario 明确 skipped。 |
| `npm run build` | 通过 | Vite 提示主 chunk 约 513 KB，超过 500 KB 告警线。 |
| `git diff --check HEAD` | 通过 | 仅有 Windows LF/CRLF 提示。 |
| `npm run omp:verify:patches` | 未通过 | verifier 检测到 vendor 工作树不干净，未能证明 0014-0017 可从干净 upstream 重放。 |
| 真 Runtime Desktop E2E | 未执行 | `scripts/real-conversation-e2e.mjs` 无论 executable 是否就绪都会 exit 2；脚本尚未驱动 Electron。 |

单元测试全绿不能覆盖上述 P0，主要原因是测试使用 fake Runtime 或非真实事件顺序，且缺少 workspace/runtime epoch 切换与连续多轮真命令链。

## 7. 推荐修改顺序与并行拆分

建议先冻结共享工作树，避免多个 Agent 同时修改同一条状态链。可拆成以下工作包：

### 工作包 A：Runtime/Host snapshot 生命周期（先执行，阻断其他包验收）

范围：P0-1、P0-2。

主要文件：Runtime state projector、Host runtime projection/controller、Desktop runtime session、Facade、Client reducer。

交付物：

- 每次 version 推进都有 authoritative snapshot publication。
- epoch 切换重置旧版本域和旧 session entities。
- 连续多轮命令与 session/workspace switch 测试。

### 工作包 B：Renderer lifecycle 与 capability refresh

范围：P0-3、P2-1。

主要文件：Renderer App、session lifecycle helper、Client resync/query orchestration。

交付物：

- 首次 workspace pick 后自动 resync manifests/snapshot。
- 所有“新建对话”入口行为一致。

依赖：工作包 A 定义稳定的 epoch/snapshot 语义后再完成集成。

### 工作包 C：Conversation live correctness

范围：P1-1、P1-2。

主要文件：conversation reducer、selectors/view model、fixtures/tests。

交付物：

- 持久 assistant 行可附着 live tool progress/result。
- 非对话事件交错不触发假 gap。
- 测试事件顺序与真实 AgentSession 一致。

该包可与 A 并行，但不要修改 A 所属的 Facade/reducer lifecycle 代码。

### 工作包 D：Interaction、receipt 与命令反馈

范围：P1-3、P1-5、P1-6。

主要文件：session commands、interaction host、controller publication、Facade receipts、Renderer command helper。

交付物：

- Client requestId 贯穿 drop/interaction/respond/terminal receipt。
- accepted 与 terminal 明确区分。
- rejected/failed/outcome_unknown 保真并显示。
- 无 receipt 订阅竞态。

### 工作包 E：启动恢复、安装与真实 E2E

范围：P1-4、P1-7、补丁与 E2E 门禁。

交付物：

- launch 任意阶段失败均清理进程、socket、listener。
- 明确 clean-install 支持策略。
- 在干净 vendor 上重放 patches。
- 自动启动 Electron + 真 OMP，在 preview 关闭时验证发送、流式文本、工具、审批、第二轮发送、reload、resume。

## 8. 最低合并门槛

在标记“真实对话可用”前，至少满足：

- [ ] 修复全部 P0。
- [ ] 连续两轮及以上真实 prompt 不出现版本冲突。
- [ ] 首次 workspace pick 后无需重载即可发送。
- [ ] workspace/session switch 后 snapshot、manifest、transcript 不串会话。
- [ ] 真实 AgentSession 顺序下 tool start/update/end 可见。
- [ ] 正常非对话事件交错不触发 conversation resync。
- [ ] drop 审批能够显示并完成 submit/cancel 闭环。
- [ ] steer/abort/respond 的 terminal 失败有反馈且不丢输入。
- [ ] launch 中途失败不残留 Runtime 进程。
- [ ] 0014-0017 patches 可从干净 vendor 重放。
- [ ] 真 OMP + Electron 自动 E2E 至少跑通：启动、发送、文本流、工具、第二轮发送、reload/resume。

## 9. 审查时点说明

审查期间共享工作树曾继续发生变化；本报告已按最终复核时看到的最新工作树修正结论，例如 compatible-system executable 已正确传给 Runtime，不再列为问题。后续若仍有其他 Agent 同时写入这些文件，应在工作树冻结后重新运行本报告列出的关键时序测试。

