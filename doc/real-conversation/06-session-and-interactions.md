# 执行计划 06：真实会话生命周期与 Interaction Deck

> 依赖：计划 01 生产基线、计划 04 Host/client conversation path 已合并；计划 05 至少完成真实 transcript hydrate。
> 目标：让“新对话、历史恢复、切换、reload”和 OMP 提问/审批成为真实 Runtime 操作，避免对话可读但无法继续或被 interaction 卡死。
> 文件 owner：本计划执行时接管 `apps/desktop/src/host-composition.ts`、相关 session/catalog/binding、interaction adapter、Facade interaction mapping、Renderer InteractionDeck。开始前必须确认计划 01/05 不再修改重叠文件。

## 1. 先做产品语义确认

实现前从 OMP Runtime 现有 API确认以下事实，并在执行报告记录：

1. “新对话”应调用哪一个真实能力：创建新 session、drop当前并创建、fork空 branch，还是 clearContext。
2. `historyId/threadId/sessionId` 各自与 Runtime session文件的映射。
3. resume是否会更换 runtime epoch、sessionId、active branch leaf。
4. resume期间当前 streaming如何处理。

不得擅自把 `session.clearContext` 当“新会话”；它保留同一 session身份和历史树，用户语义不同。若 Runtime当前没有安全 create API，应先新增明确 `session.create`/`session.new` contract，或把“新对话”按钮诚实禁用并说明限制。

## 2. 真实历史恢复

### 当前问题

History点击只设置本地 `selectedHistoryId` 和路由；Desktop `session.resume` 仍是 stub。

### 实现要求

1. 从 History item取得 opaque `threadId`，不得把本机 session路径送到 Renderer。
2. Renderer点击后调用 `client.command("session.resume", { threadId })`。
3. Host使用 `ThreadBindingStore/SessionCatalog` 安全解析到当前 workspace允许的 Runtime session。
4. Runtime执行真实 resume/open session。
5. 等待 terminal completed后，以新 snapshot中的 sessionId为权威。
6. Conversation state原子清空并 query新 active branch。
7. resume失败时保留原 session和原 transcript，显示错误；不能先改标题造成假切换。
8. 禁止跨 workspace恢复未授权 session。

### 测试

- 点击 item确实调用 resume。
- completed后 identity/title/transcript一致切换。
- failed时保持旧会话。
- A请求迟到不覆盖后来选择的B。
- 同一 session重复 resume幂等或明确 no-op。
- streaming中 resume按协议拒绝或先安全 abort，不能静默丢 turn。

## 3. 新对话

基于第1节确认的 Runtime语义实施：

- 生成新 opaque thread/session binding。
- 新 session active branch为空，transcript返回空页。
- 原 session仍在 history可恢复。
- 不删除磁盘历史。
- workspace不变时不重启整个 Runtime，除非 OMP API要求且有测试。
- 创建失败时不把 UI切到空假会话。

如果需要新增 contract，由计划 02 contract owner或一个明确的后续 contract owner修改，不能在本计划直接在多层各写一个不同名字。

## 4. Reload / rebind / runtime loss

- Renderer reload：新 Facade/bootstrap后读取当前 snapshot与 transcript；不要求历史 delta replay。
- Desktop composition reload：清理旧 Facade subscriptions，绑定同一 current session并重放当前 snapshot一次。
- workspace rebind：旧 conversation和pending interaction全部作废；新 session hydrate。
- runtime epoch变化：旧 timeline只可短暂显示为离线缓存或立即清空，产品选择需一致；首版建议清空并显示正在恢复。
- runtime loss：未完成 command进入 outcome_unknown；已完成 transcript保留，恢复后用 query校准。
- 旧异步 query、event、interaction均通过 epoch/session/generation丢弃。

## 5. Interaction 真实上行

Runtime实际上已有 `interaction.required` 发射点。不要再以“若 Runtime以后发出”为前提。

### 5.1 Raw event 通路

1. controller订阅 raw `interaction.required`。
2. listener异常隔离，duplicate/transfer/conflict不得打坏 Bridge socket。
3. 只将 owner=`gui` 的请求发布到 Renderer。
4. owner=`tui` 的请求不显示为可提交；可显示“需终端处理”的只读状态。
5. 同 interactionId + 更高 generation是更新/transfer，不应被 adapter当普通 duplicate抛错后中断链路。

### 5.2 相关性

必须维护：

```text
Client CommandRequestId
  ↔ Runtime requestId
  ↔ Runtime commandId
  ↔ interactionId + leaseGeneration
```

- receipt后 ledger会从 provisional id rebind到 Runtime commandId。
- Facade发 `command.interactionRequired` 时必须带原 Client requestId，否则 reducer会丢 unknown request。
- 不能用 operationKind猜 commandId。
- 修正 vendor OMFG overwrite硬编码 `commandId: "omfg.commit"` 的上游问题，使每条interaction路径都传真实 dispatcher commandId。

### 5.3 Contract mapper

逐 kind显式映射，不能 blind `details -> detail`：

- confirm：`destructive ?? false`
- select：`multiple ?? false`
- input：`secret ?? false`
- editor：明确 content/language与promptStyle丢弃规则
- approval：任意 scalar details先规范化为安全 plain record，执行 allow-list/脱敏/限长

Runtime title在现有 ClientInteraction里无字段。两种合法选择：

1. 扩 contract、validators、transport/tests支持安全 title；或
2. 明确丢弃 title并让 Deck使用 kind-specific固定标题。

不得在 mapper里临时塞未知字段。

## 6. Interaction respond 与确认 token

1. Renderer只提交 `submit|cancel` + value，不持有 Host secret token。
2. 高风险 token不能在收到任意 submit后“现场 issue再consume”，否则安全门退化为自签通行证。
3. 若 token只留Host，必须在展示特定 challenge/operation/value前预签并绑定：
   - interactionId
   - generation
   - exact operation/decision/value hash
   - session/runtime epoch
   - expiry/one-shot
4. Renderer变更 value后，旧 challenge失效并重新签发或回到等待确认状态。
5. adapter.respond成功后才从Deck移除；失败保留并显示可重试错误。
6. cancel是否需要token按现有风险模型决定并写测试。

如果现有 HostConfirmationRegistry无法支持“token不出Host但绑定一次用户确认”，先写设计说明和测试再实现，不能降低 fail-closed测试。

## 7. Pending/队列语义

当前 RemoteInteractionAdapter只保存单个 pending。Renderer原计划的1/N队列不能先于Host能力实现。

- 首版按单 pending Deck实现。
- 若Runtime/Host以后支持多个，先扩 adapter/store contract并测试，再加导航。
- duplicate interaction、same-id higher generation、transfer、resolved/cancelled都必须有明确状态机。
- Deck使用当前 interaction identity，不继续 `.find()` 某个旧 command的第一条。

## 8. Deck UI

- approval：真实标题/风险/命令/原因，缺字段就省略；拒绝=cancel，允许一次=submit。
- “始终允许”：contract无持久策略时保留禁用并解释，或直接不显示。
- select：单/多选严格按 contract；自定义值只有 contract允许时提交。
- input/confirm：submit/cancel。
- editor：没有安全提交schema时只允许Cancel，不能伪装可编辑成功。
- submit中禁重复点击；失败恢复按钮。
- interaction resolved/transfer/session切换后立即撤掉旧 Deck。

## 9. 测试矩阵

### Session

- new/resume/switch/reload/rebind/runtime loss。
- old query/event不污染new session。
- history item与真实 transcript一致。

### Interaction

- 5 kinds及可选boolean默认值。
- approval scalar/object details规范化与脱敏。
- owner=tui不发布可提交Deck。
- same-id generation更新。
- duplicate/replay不崩Bridge。
- submit/cancel回到原 interaction commandId。
- 高风险缺token/错误value/过期/replay均fail closed。
- respond失败后pending保留。
- reload/rebind/runtime loss清理或恢复pending。
- 原 command receipt和 `interaction.respond` 自身receipt都正确。
- OMFG/session.drop每条真实interaction路径使用实际commandId。

## 10. 验收命令

```bash
npm test -w @omp-studio/studio-host
npm test -w @omp-studio/host-client-api
npm test -w @omp-studio/client
npm test -w @omp-studio/desktop
npm test -w @omp-studio/renderer
npm run omp:verify:patches
```

## 11. 完成条件

- [ ] History点击真正 resume并加载对应 transcript。
- [ ] 新对话使用明确Runtime语义，不是假路由。
- [ ] reload/rebind/runtime loss不串会话。
- [ ] GUI-owned interaction真实显示并respond。
- [ ] command/request/interaction相关性完整。
- [ ] owner/generation/duplicate状态机可靠。
- [ ] 高风险确认保持fail closed。
- [ ] Deck不伪造多pending队列或“始终允许”。
