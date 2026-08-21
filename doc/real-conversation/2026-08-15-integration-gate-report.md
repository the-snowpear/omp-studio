# 真实对话集成门禁报告（计划 07）

- 日期：2026-08-15
- 执行者：Agent G（计划 07 / integration gate）
- 权威规格：`doc/real-conversation/07-integration-verification.md`
- 总控：`doc/real-conversation/00-master-plan.md` 第 2 节用户验收、第 9 节 Definition of Done

## 目标阶段

| 阶段 | 结论 | 说明 |
|---|---|---|
| **MVP-A（fake/embedded Runtime 全链）** | **可宣称** | Desktop composition + Host facade + Client + Renderer hydrate 均用隔离临时目录与 fake Runtime 跑通。禁止把它写成「真 OMP Desktop E2E」。 |
| **MVP-B（fake Runtime 数据路径）** | **数据合同可宣称；滚动与真模型流不可宣称 Desktop E2E** | 单一 assistant、单一 tool、completed 替换 live、eventSeq 单调、reload 从 history 恢复：testkit / desktop gate / renderer gate 通过。**scroll-follow 仅 renderer 单测**（`shouldFollow` / `distanceFromBottom`）。 |
| **完整闭环** | **不可宣称** | 无 `session.create`（新对话按钮诚实禁用）；真 Runtime Desktop E2E **未跑通**（勿改写成已通过）。`npm run check` 已于 2026-08-15 14:52 重跑通过。`omp:verify:patches` 因 vendor 脏树未按原脚本通过（干净 worktree apply-check 0001–0017 替代通过）。 |

## 基线与最终 commit

| 项 | 值 |
|---|---|
| 基线 HEAD | `6778fd3502f818a55a6d2fbbf66d569167e57ba6`（短 `6778fd3`） |
| 最终 commit | **无新 commit**（任务禁止 git commit / reset / push）。工作区相对 `6778fd3` 仍含计划 01–06 未提交改动 + 本计划 07 改动。 |
| 真 Runtime pin | `omp-patch/upstream.json` → `45e12e5bb758198a920c6070e7e64cb33b21beac`（`runtime:verify-source` 已核对 HEAD 与 pin 一致） |

不记录 token、用户主目录、真实项目路径或 OMP 配置内容。

## 修改文件与 owner

本计划 **未改产品实现**。仅 testkit、跨包门禁测试、测试配置、E2E 骨架、本报告。

### 计划 07 新增

| 路径 | 用途 |
|---|---|
| `packages/testkit/src/conversation-fixtures.ts` | 统一 conversation fixtures，经 `parseConversationTranscriptPage` / `parseConversationRuntimeEvent` + `assertConversationPublicSafe` |
| `packages/testkit/src/conversation-safety.ts` | 公共载荷安全扫描 |
| `packages/testkit/test/conversation-fixtures.test.ts` | 夹具完整性 |
| `packages/testkit/test/conversation-mvp.test.ts` | Host facade + Client MVP-A/B |
| `packages/testkit/test/conversation-fault.test.ts` | 故障注入；4 条 skip 带原因 |
| `packages/testkit/test/conversation-security.test.ts` | secret / 路径 / oversize / prototype / frame |
| `packages/testkit/test/conversation-perf.test.ts` | 100 tool updates、分页 cap、20 reload、10k 字符 delta |
| `apps/desktop/test/conversation-gate.test.ts` | Desktop composition MVP-A/B（fake Runtime） |
| `apps/renderer/src/conversation/conversation-gate.test.tsx` | Renderer 共享夹具 hydrate / HTML 文本 / scroll-follow 单测 |
| `scripts/real-conversation-e2e.mjs` | 真 Runtime Desktop E2E 骨架 |
| `doc/real-conversation/2026-08-15-integration-gate-report.md` | 本报告 |

### 计划 07 修改的既有文件

| 路径 | 变更 |
|---|---|
| `package.json` | 根 `npm test` 在 client-contract build 之后纳入 `host-client-api`；新增 `conversation:e2e` |
| `packages/testkit/package.json` | 依赖 `client`、`host-client-api`、`studio-host` |
| `packages/testkit/src/index.ts` | 导出 conversation fixtures / safety |
| `packages/testkit/src/fixtures.ts` | `session.transcript.read` 与 `conversation.changed` 改走统一夹具 |
| `packages/testkit/src/suite.ts` | transport 合同套件增加 transcript query + conversation event |
| `apps/desktop/package.json` | devDependency `@omp-studio/testkit` |
| `apps/renderer/package.json` | 仅增加 devDependency `@omp-studio/testkit`（vitest / testing-library 为计划 05 既有未提交改动，07 未改那些行） |

未修改 `App.tsx`、`host-composition.ts`、protocol contract、vendor 产品代码。04/05 包内仍有本地 page 构造函数；**未跨界迁移**，请求后续复用 testkit。

## 备份目录

1. `backup/2026-08-15/real-conversation-p07-142901/`  
   改前副本：根 `package.json`、`packages/testkit/{package.json,src/index.ts,src/fixtures.ts}`、`apps/renderer/package.json`、`apps/desktop/package.json`。
2. `backup/2026-08-15/real-conversation-p07-suite-144532/`  
   补备份：`packages/testkit/src/suite.ts` 的 HEAD（`6778fd3`）版本。第一份备份遗漏该文件后才改 transport 套件。
3. `backup/2026-08-15/real-conversation-p07-report-145356/`  
   本报告在 06 typecheck 修复后重跑门禁、更新结论前的副本。

恢复：按相对路径复制回仓库根；不要原地改 `backup/`。

## 命令结果

| 命令 | 结果 | 原因 |
|---|---|---|
| `npm test -w @omp-studio/studio-protocol` | **通过** | 36 tests |
| `npm test -w @omp-studio/studio-host` | **通过** | 118 tests |
| `npm test -w @omp-studio/host-client-api` | **通过** | 134 tests |
| `npm test -w @omp-studio/client` | **通过** | 初跑 37；2026-08-15 14:52 重跑 **38**（含 04 `message.completed` after abort 保留 aborted view） |
| `npm test -w @omp-studio/transport-desktop` | **通过** | 40 tests（含 suite 新增 transcript/conversation 断言） |
| `npm test -w @omp-studio/testkit` | **通过** | 71 pass / **4 skip**（见故障矩阵） |
| `npm test -w @omp-studio/desktop` | **通过** | 初跑与 14:52 重跑均为 **100**（含 2 条 conversation-gate） |
| `npm test -w @omp-studio/renderer` | **通过** | 初跑 32；14:52 重跑 **36**（含 7 条 conversation-gate + 06 sessionLifecycle + 05 truncated DOM） |
| `npm run omp:verify:patches` | **失败** | vendor `omp-patch/vendor/oh-my-pi` 工作树不干净。任务禁止 reset。脚本在 apply 前要求 porcelain empty。 |
| 替代：干净 worktree 对 0001–0017 `git apply --check` 再 apply | **通过** | detached HEAD `45e12e5`；`ALL_PATCHES_OK`；随后 `worktree remove --force`。**未**跑 vendor `bun test` / 根 `check`（那是原脚本后半段）。 |
| `npm run runtime:verify-source` | **通过** | `Verified OMP source commit 45e12e5bb758198a920c6070e7e64cb33b21beac` |
| `npm run conversation:e2e` | **未跑通（exit 2）** | Electron/desktop entry 存在；未设置可用的 `OMP_RUNTIME_EXECUTABLE`。骨架不宣称成功。 |
| `npm run typecheck -w @omp-studio/desktop` | **通过** | 含 conversation-gate |
| `npm run typecheck -w @omp-studio/testkit` | **通过** | 含于 `npm run check` 前半段 |
| `npm run typecheck -w @omp-studio/renderer` | **通过** | 2026-08-15 14:52 重跑：06 已修 `sessionLifecycle.test.ts` 品牌类型与 `SessionHistoryEntry` 字段 |
| `npm run check` | **通过** | 2026-08-15 14:52 重跑 exit 0。typecheck 全包通过后根 `npm test` 跑完（desktop 100 pass）。**不**等于真 Runtime E2E 通过，也 **不**等于完整闭环。 |

根 `npm test` 现已包含 `@omp-studio/host-client-api` 与 `@omp-studio/renderer`。`check` = typecheck && test；本回合二者均通过。

## 统一 fixtures（交付 1）

全部经同一 contract validator。包应 import `@omp-studio/testkit`，不要再复制形状不同的对象。

| 类别 | 导出 |
|---|---|
| identities | `conversationIdentities` / `CONVERSATION_FIXTURE_IDS`（epoch=3，`sess-0001`，与既有 testkit snapshot 对齐以免 `CURSOR_STALE`） |
| 空页 | `conversationPages.empty` |
| user/assistant | `conversationPages.userAssistant` |
| thinking+tool | `conversationPages.thinkingTool` |
| compaction/reset | `conversationPages.compactionReset` |
| live 序列 | `conversationLiveSequence`（started → delta → tool start/update/end → delta → completed → turn.completed） |
| duplicate/late/gap/epoch | `conversationFaultEvents` |
| 四种 terminal receipt | `conversationReceipts`：completed / failed / rejected / outcome_unknown |
| interaction 五类 | `conversationInteractions`：confirm / select / input / editor / approval |

负例 `conversationUnsafe` 只用于安全扫描，从不作为成功夹具。

## MVP-A（交付 2）— fake Runtime，可宣称

覆盖链（隔离 temp profile / exe / workspace，不写用户项目，不读用户 OMP 配置）：

1. Desktop composition 注入 persisted workspace  
2. hello 真 capability/command manifest（`core.prompt` 在清单中）  
3. bootstrap identity（sessionId = fixture）  
4. `session.transcript.read` 空页  
5. `core.prompt`  
6. accepted 到达且 **不是** completed  
7. persist user/assistant  
8. query 两条  
9. Client / Renderer 各一条 user + 一条 assistant  
10. reload hydrate 仍两条、itemId 不重复  

证明位置：`apps/desktop/test/conversation-gate.test.ts`、`packages/testkit/test/conversation-mvp.test.ts`、`apps/renderer/src/conversation/conversation-gate.test.tsx`。

**不可**据此宣称「Composer 在真 Electron 窗口里把 prompt 打进真 omp.exe」。

## MVP-B（交付 3）— 数据路径可宣称；滚动仅 renderer 单测

断言已绿：

- 单一 assistant 节点，文本收敛为完整内容  
- 单一 tool 行 running → completed  
- `message.completed` 替换 live buffer（`liveMessages[assistantId]` 为空）  
- eventSeq 严格递增  
- reload 后从 transcript history 恢复一条 assistant  

**scroll-follow：仅 renderer 单测。Desktop E2E 未测滚动。禁止对外说「窗口里上滚不抢滚动已 E2E」。**

## 故障注入（交付 4）

| 项 | 结果 | 位置 |
|---|---|---|
| eventSeq duplicate | 通过（忽略，状态引用不变） | conversation-fault |
| eventSeq gap | 通过（`resyncRequired`，不发明 delta） | conversation-fault |
| 乱序 late delta after completed | 通过（忽略） | conversation-fault |
| epoch/session switch | 通过（丢弃，不合并 timeline） | conversation-fault |
| 旧 hydrate generation / 迟到 query | 通过（clear 后丢弃） | conversation-fault |
| abort 后 late delta | 通过（保留「正在」，不追加） | conversation-fault |
| 四种 terminal receipt；accepted 非 receipt | 通过 | conversation-fault |
| listener throw | 通过（`ConversationEventFanout` 隔离，第二 listener 仍收到） | conversation-fault |
| oversize tool output | 通过（validator 拒绝） | conversation-fault / security |
| 循环 JSON / 过深 JSON | 通过 | conversation-fault |
| socket 重连 | **skip** | 无 in-process Desktop socket harness；gap resync 已覆盖 |
| 真 Runtime crash after prompt | **skip** | 需杀 omp.exe；`outcome_unknown` receipt 已覆盖 |
| 旧 cursor / branch navigate | **skip** | 需计划 02 Runtime cursor signing |
| compaction-during-read | **skip** | 需真 SessionManager |
| abort 后再来 `message.completed` | **通过（04 已合入）** | `completeMessage` 在 turn 已 abort 时收敛文本但 **保留 aborted view**；client 测试 `message.completed after abort converges text but keeps the aborted view` 通过。真窗口 Abort 仍未测。 |
| GUI vs TUI owner、generation、duplicate required、token 缺失/过期/replay、respond 失败重试、reload/rebind 清 interaction | **未测** | 属计划 06 交互生命周期；07 只证明五类 map 且不泄漏 title/secret |

未删断言掩盖缺口。

## 安全（交付 5）

已测：

- 夹具不含 apiKey / authorization / cookie / token / password / providerPayload / home 路径 / script/onerror  
- `redactText` / `redactDetail` 剥离 home 与 token-like  
- 非 plain prototype 参数被 contract 拒绝  
- oversize 无 `truncated` 被拒绝；带 `truncated: true` 的 toolResult 可解析  
- Bridge `encodeFrame` 超 control-frame 预算拒绝  
- Renderer 把 HTML/script **当文本**渲染，DOM 无 `<script>` / `<img>`  
- approval `details` 经 `mapRemoteInteractionToClient` 后 JSON 不含 `sk-live-secret`

未宣称 / 回派：

- Host **不会**对 transcript `arguments` 再做一层 redact（信任 Runtime sanitizer）。若 Runtime 泄漏嵌套 `apiKey`，会穿过 Host。回派 **02/04** defense-in-depth。  
- JSON 自有属性 `__proto__` 可能被 parser 当作普通 key 接受；非 plain prototype 对象会拒。回派 **02**。  
- 计划 07「截断有显式 DOM 标记」：**05 已合入**。`ToolBody` / `ConversationItemView` 渲染 `已截断` note；renderer gate `truncated tool result shows a visible 已截断 mark` 与 `conversation.test.tsx` truncated display 通过。真窗口未测。

## 性能（计划 07 §7）

| 压测 | 结果 |
|---|---|
| 100 连续 tool updates | 单一 tool 行，output 长度 100 |
| 1,000 条 item 按 50 分页 prepend | client `CONVERSATION_STATE_ITEM_CAP=500`，最终 **500** 且 id 唯一（不是 1000）。回派 **04** 是否接受该 cap。 |
| 20 次 reload hydrate | 仍 2 条，不重复 |
| 1000×10 字符 delta（约 10k 字符，不是 10k token） | 单一 live block，views.length=1 |
| workspace/session 快速切换 20 次 | **未测**（无 session 切换 harness） |
| 内存 / listener 基线 / 毫秒阈值 | **未在 CI 机器冻结**；本次只做逻辑上界 |

## 真 Runtime Desktop E2E（交付 7）— **未跑通**

脚本：`npm run conversation:e2e` → `scripts/real-conversation-e2e.mjs`  
预览模式：**禁止**。骨架不启用 preview。

本次环境：

- 隔离临时 workspace 已创建（例：`%TEMP%\omp-studio-conversation-e2e-*`，含无害 `package.json` / README）  
- `node_modules/electron/cli.js` 与 `apps/desktop/dist/src/main.js` 存在  
- `OMP_RUNTIME_EXECUTABLE` 未配置 → **exit 2**  
- 即使配置了 omp.exe，骨架也 **没有** 接好自动化驱动 Electron；仍须人工。不要把 fixture 测试写成真 E2E。

### 人工步骤

1. `npm run conversation:e2e` 打印隔离目录，或自建一次性文件夹。不要用用户真实仓库当写目标。  
2. 启动 Desktop，**预览关闭**（顶栏「预览」）。  
3. 打开该临时文件夹为工作区。  
4. 发送：读取 `package.json` 并以固定短语 `STUDIO_E2E_OK` 回复。  
5. 确认一条 user、流式 assistant、至少一个 Read 工具。  
6. 再发长 prompt，点 Abort；已收到文本保留并标明中止。  
7. reload 窗口；已完成消息从 transcript 恢复。  
8. History 点击应 `session.resume` 同一 session。  
9. **不要点「新对话」当已完成功能**——按钮禁用，等待 `session.create` 合同。

### 失败诊断位置（不要把秘密贴进报告）

- Desktop：Electron console / Studio profile logs  
- Host：`session.transcript.read` 的 `CURSOR_STALE` / `UNAVAILABLE`  
- Runtime：omp 日日志（用户日志目录）  
- Renderer：`hydrateStatus` / `resyncRequired`

## 总控第 2 节：12 条用户验收（预览关闭的 Desktop 真应用）

必须用真窗口逐条验证。本门禁 **没有** 跑通真 Electron+OMP，因此默认 **未测**。下表把 fake 层证据与真应用分开，避免把夹具测试写成用户验收通过。

| # | 场景 | 真 Desktop+OMP | fake / 单测证据 |
|---|---|---|---|
| 1 | 工作区恢复，Runtime 启动，Composer 可发送 | **未测** | Desktop composition：persisted workspace + hello + `core.prompt` 可发（fake） |
| 2 | 发送「读取 package.json 并说明项目结构」 | **未测** | 无真模型；夹具 Read 工具名存在 |
| 3 | user 立即出现；accepted 非最终成功 | **未测** | MVP-A gate：accepted 非 completed |
| 4 | 同一 assistant 增量，不重复气泡 | **未测** | MVP-B fake：单一 assistant |
| 5 | 工具名/状态/脱敏/限长；失败工具可见 | **未测** | sanitizer 合同 + 安全扫描通过；Host 不对 transcript args 二次脱敏 |
| 6 | failed / rejected / outcome_unknown 可见，不丢草稿 | **未测 UI** | client receipt 四种 terminal 通过；Composer 真窗口未测 |
| 7 | Abort 停止本轮，已收文本保留并标明中止 | **未测** | client：abort 保留文本；随后 `message.completed` 收敛文本并保持 aborted view（04 已合入）。真窗口未测。 |
| 8 | 上滚不抢滚动；回底恢复跟随 | **未测（非 Desktop E2E）** | **仅** renderer `shouldFollow` 单测 |
| 9 | reload / 短暂重连后从真实 transcript 恢复，不串 epoch | reload fake **通过**；真 socket 重连 **skip** | |
| 10 | History 点击真实 resume，标题与 transcript 切换 | **未测 E2E** | 计划 06 已落地 `session.resume`；07 未跑真窗口 |
| 11 | GUI-owned Deck 提交回同一 Runtime interaction | **未测** | 五类 map 通过；TUI owner / token / generation 未测 |
| 12 | 预览开 fixture；预览关不回退 mock | **未测真应用** | renderer gate：真实 hydrate 无「演示」banner / `data-demo` |

**新对话：** 按钮 **诚实禁用**，等待 `session.create` 合同。`clearContext` 不得冒充新对话。不得写成已完成。

## 总控第 9 节 Definition of Done

### MVP-A

- [x] fake：persisted workspace 启动 composition（非真 omp.exe）  
- [x] fake：manifest 来自 hello 视图  
- [ ] **真** `core.prompt` 到达 OMP — 未测  
- [x] fake：`session.transcript.read` 空页/两页  
- [x] fake：真实模式（非 preview）显示 user/assistant  
- [x] fake reload hydrate  

### MVP-B

- [x] fake delta 同一消息  
- [x] fake 同一工具行  
- [x] completed 替换 live  
- [~] gap 走 resyncRequired；真重连 skip  
- [x] 四种 receipt 在 client 不静默；真 UI 未测  
- [~] scroll-follow 仅单测  
- [x] 预览/真实隔离的组件级证明；真应用未测  

### 完整闭环

- [ ] History resume 真 E2E  
- [ ] 新对话 — **禁用，等待 session.create**  
- [ ] GUI interaction 真 OMP  
- [ ] reload/rebind 清旧 interaction 真路径  
- [ ] Desktop + 真 Runtime E2E  
- [~] `npm run check` **已通过**（2026-08-15 14:52）；原脚本 `omp:verify:patches` 仍因脏 vendor 失败（apply-check 0001–0017 替代通过） |

计划 07 自身 DoD（§11）：Contract/Runtime/Host/Client/Renderer/Desktop **各层均有测试**（Runtime 层依赖 02/03 已有单测 + 本门禁夹具，无新的真 SessionManager 测试）。根门禁 script **已纳入** host-client-api 与 renderer。真 E2E **未通过**。Preview 关闭无 mock 回填：组件级通过，真窗口未测。

## 回派总控（最小变更请求）

07 **不自行修改**下列 owner 文件。

### 计划 06 — 已解除 `check` 阻塞

`sessionLifecycle.test.ts` 品牌类型与 `SessionHistoryEntry` 字段已修。`npm run typecheck -w @omp-studio/renderer` 与根 `npm run check` 已通过。新对话仍禁用，等待 `session.create`。

### 计划 04

- abort 与 `message.completed` 竞态：**已合入**（保留 aborted view）。  
- `CONVERSATION_STATE_ITEM_CAP=500` 与「1000 条分页仍全保留」的计划表述不一致。  
- transcript 路径无第二层 secret redact（若要 Host defense-in-depth）。  
- 可选：测试改为复用 `@omp-studio/testkit` conversation fixtures。

### 计划 05

- `truncated: true` 显式 DOM 标记：**已合入**（`已截断` note）。  
- 可选：测试改为复用 testkit 夹具。

### 计划 02

- stale cursor signing、compaction-during-read 仍只能在真 Runtime reader 上测。  
- nested secret / `__proto__` 自有属性是否由 sanitizer 剥离。

### 计划 01

- `runtime.install` 仍是 clean-install blocker，不伪装 ready。

### 计划 03

- live projector 已接线；真模型流式与工具失败 UI 仍待 E2E。

## 已知限制与下一步

1. 在干净 vendor 上重跑完整 `omp:verify:patches`（含 bun vendor tests）；当前仅 apply-check 0001–0017。  
2. 配置 `OMP_RUNTIME_EXECUTABLE` 后补 Electron 驱动，跑通 `conversation:e2e`；通过前不得宣称对话区 E2E。  
3. 06 已修 `sessionLifecycle.test.ts`；`npm run check` 已通过。  
4. 各包本地 page 工厂收敛到 testkit。  
5. 冻结 CI 性能阈值（本次未采毫秒数）。  
6. 新对话保持禁用，直到存在 `session.create` / `session.new` 合同。

## 明确结论

- **MVP-A（fake 全链）：通过，可宣称。**  
- **MVP-B（fake 数据路径）：通过；scroll-follow 仅 renderer 单测；真模型流 / Desktop 滚动：未测。**  
- **完整闭环：仍不可宣称**（无 `session.create`；真 Runtime Desktop E2E **未跑通**；原脚本 `omp:verify:patches` 未通过）。`npm run check` 通过 **不能** 改写为完整闭环或真 E2E 通过。  
- **总控第 2 节 12 条用户验收：真 Desktop 应用全部未测或仅部分有 fake 旁证；新对话必须写「按钮禁用，等待 session.create」。**  
- **真 Runtime Desktop E2E：未跑通。**  
- 07 范围内测试已执行；不存在「代码已写但未跑测试」的完成声明。
- 2026-08-15 14:52 重跑：renderer typecheck / renderer 36 / client 38 / desktop 100 / `npm run check` 全部通过。
