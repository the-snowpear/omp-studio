# 执行计划 04：Host / Client Conversation 读模型与实时投影

> 依赖：计划 02 contract-only commit。
> 可并行：可与计划 03、05 同时执行，先用 protocol/testkit fixtures。
> 目标：让 transcript query 和 live conversation events 从 Bridge 安全穿过 Host Facade、Desktop transport 和 Client，形成可测试的当前会话 timeline state。
> 文件 owner：`packages/studio-host/**`、`packages/host-client-api/**`、`packages/client-contract/**` 的 query/event 映射、`packages/client/**`、`packages/testkit/**`。不得修改 vendor、Desktop composition、Renderer。

并发限制：`packages/studio-host/src/bridge-client.ts` 在计划01完成manifest接线前归计划01所有。本计划可先实现client-contract、client projector、Facade/testkit fixtures，待01释放后再增加transcript read API。

## 1. 设计约束

- transcript 是 query/read model，不是 command log。
- live delta 是独立的 conversation event，不应塞进 `state.changed`。
- RuntimePublication 的 snapshot/terminal receipt 与高频 conversation event 生命周期不同；不要把所有 token delta永久积在 publication replay 中。
- reload/reconnect 恢复依赖 transcript query，而不是重放无限 live event。
- 所有状态都以 `runtimeEpoch + sessionId` 隔离。
- Client 收到 unknown session/epoch event 时丢弃并触发必要的 resync，不得串会话。

## 2. Studio Host：Runtime query API

为 `StudioBridgeClient`/`StudioRuntimeSessionController` 增加类型化 transcript read 方法：

```ts
readTranscript(input: { cursor?: OpaqueCursor; limit?: number }): Promise<ConversationTranscriptPage>
```

要求：

1. 构造 `session.transcript.read` Studio request。
2. 使用当前 runtime epoch。
3. receipt 必须 completed 且 result 通过严格 parser。
4. 不把该只读操作登记成用户可见的 Composer command。
5. Runtime loss/epoch change 时返回可分类错误。
6. 并发历史翻页允许，但响应回来时 Host/Client 仍要检查 session identity。

## 3. Studio Host：Raw conversation event channel

当前 controller 只订阅 `onProjectionChanged`。增加独立订阅：

- 只筛选 contract 定义的 `conversation.*` events。
- 保持 envelope 的 eventSeq/stateVersion/occurredAt。
- listener 异常隔离；单个映射失败记 diagnostic并丢该事件，不能从 socket handler 冒泡。
- dispose 时取消 raw event listener。
- gap/resync 时发出明确的 resync signal，促使 Client重新 query transcript head；不要尝试猜缺失 delta。

建议新增类型化接口，例如：

```ts
interface RuntimeConversationEvent {
  envelope: StudioEventEnvelope<ConversationRuntimeEvent>;
}

onConversationEvent(listener: (event: RuntimeConversationEvent) => void): Unsubscribe;
```

不要在 `RuntimePublicationStore.current()` 中永久保存每个 delta。若为统一调度新增 event batch，必须只消费一次并有测试证明 reload 不重复 append。

## 4. Client contract

### 4.1 Query

在 `QueryInputMap/QueryResultMap` 增加：

```ts
"session.transcript.read": { cursor?: OpaqueCursor; limit?: number };
"session.transcript.read": ConversationTranscriptPage;
```

Public 类型应直接复用 protocol 已脱敏的 conversation 类型，或做等价的只读 public mirror。禁止使用 `unknown[]`。

### 4.2 Client events

增加明确 event kind，例如：

```ts
{
  kind: "conversation.changed";
  runtimeEpoch: RuntimeEpoch;
  sessionId: SessionId;
  eventSeq: EventCursor;
  update: ConversationRuntimeEvent;
}
```

如果 ClientEvent envelope 已统一携带 cursor，不要重复定义相互冲突的 seq；必须写注释说明 Bridge eventSeq 到 Client EventCursor 的映射。

### 4.3 Bootstrap

不把整段 transcript 塞进 `ClientBootstrap`。Bootstrap 可新增/保留 `messagesCursor` 作为 head hint，但 Renderer/Client仍必须显式 query 最新页。

原因：避免 bootstrap 无限增长，也便于独立分页、reload 和 resync。

## 5. Host Facade query 实现

1. `session.transcript.read` 从当前 `sessionRef` 动态调用 controller/bridge。
2. Runtime 不可用返回 typed public error，不返回 preview fixture或空假页。
3. 返回前再次校验 page runtimeEpoch/sessionId 与当前 snapshot 匹配。
4. cursor/limit错误保持 Runtime 分类，Desktop transport不能吞成 generic success。
5. query 不记录为 mutation receipt。
6. Facade reload 后 query 仍指向当前 session。

## 6. Host Facade live event 映射

1. 给 FacadeContext 增加独立 runtime-event forwarder，或让当前 session可订阅 typed conversation events。
2. 映射必须是 allow-list；不接受任意 `event.kind.startsWith("conversation")` 后 blind cast。
3. 发到 Client前再次验证：
   - runtime epoch
   - session id
   - required booleans/ids
   - payload size
   - plain JSON
4. runtime loss/epoch change：先发 `runtime.changed`，清除当前 timeline identity；迟到旧事件被拒绝。
5. gap：发 `resync.required` 或 conversation-specific resync reason；下游重新读 transcript。
6. reload：不重放旧 delta。新的 Facade通过 transcript hydrate 获取已完成消息，再接收后续 live event。

## 7. Desktop transport validation

如果 transport 对 query/event 有 strict allow-list，同步增加：

- transcript query input validation；
- transcript page outbound validation；
- conversation event outbound validation。

必须测试 extra keys、错误 type、过大内容、非 plain object 被拒绝。不能为了赶进度放宽成任意 object。

## 8. Client conversation state

建议在 `packages/client` 新建独立模块而不是继续膨胀单个 reducer switch，例如：

- `src/conversation-state.ts`
- `src/conversation-reducer.ts`

它可以挂到现有 `ClientState.entities`，也可以作为官方 helper 由 Renderer hook 使用；选择必须满足统一测试和 reload/reset 语义。

### 8.1 状态建议

```ts
interface ConversationState {
  identity?: { runtimeEpoch: RuntimeEpoch; sessionId: SessionId };
  itemsById: ReadonlyMap<string, ConversationItemView>;
  order: readonly string[];
  liveMessages: ...;
  liveTools: ...;
  olderCursor?: OpaqueCursor;
  headCursor?: OpaqueCursor;
  hasMoreBefore: boolean;
  hydrateStatus: "idle" | "loading" | "ready" | "error";
  resyncRequired: boolean;
  error?: ClientError;
}
```

实际 state 必须可序列化；若项目 reducer 使用 plain object，不要引入 Map。

### 8.2 Page merge

- 首次 hydrate 原子设置 identity 和最新页。
- older page prepend，按 itemId 去重并保持顺序。
- page identity不匹配则拒绝。
- session/epoch切换先清空后加载，旧异步 query 响应通过 generation/request token 丢弃。
- reset boundary/branch change遵循 Runtime page 语义。

### 8.3 Live merge

- started 创建 live item。
- delta 只更新指定 message/block。
- tool events 按 toolCallId 更新。
- completed权威替换 live节点并重排到稳定 itemId。
- duplicate completed 幂等。
- completed后迟到 delta忽略。
- gap将 `resyncRequired` 设 true；不得继续假装 timeline 完整。

### 8.4 边界与内存

- 首屏只持有最新页；加载更早页有明确上限或虚拟化策略。
- 不把无限 conversation history 放入事件日志。
- 高速 delta只保留合并后当前文本。

## 9. Composer receipt selector/helper

为 Renderer 提供不依赖 UI 的 selector/helper：给定 requestId 查询 accepted/terminal 状态。

要求：

- accepted 与 completed 分开。
- terminal failed/rejected/outcome_unknown 保留安全原因。
- 同一 requestId只 terminal一次。
- 可供 optimistic user item reconcile；不要在 client package直接制造 UI 文案。

## 10. 测试

### Host query

- 最新页与 older page正常映射。
- Runtime不可用、stale cursor、epoch切换。
- 响应 identity 与当前 session不匹配时拒绝。

### Event forwarder

- message/tool完整事件序列。
- duplicate/late/gap。
- reload不重放旧 delta。
- subscriber抛错隔离。
- runtime loss后旧 event丢弃。

### Client reducer/projector

- hydrate、prepend、去重、排序。
- start/delta/completed同节点收敛。
- tool start/update/end。
- session/epoch切换原子清空。
- 旧 query response不污染新 session。
- gap→resync→rehydrate。
- terminal receipt四种状态。

### Testkit contract suite

把 transcript query 和 conversation events加入 transport-neutral suite，使 Desktop/Web adapter都必须符合公开合同。

## 11. 验收命令

```bash
npm run typecheck -w @omp-studio/studio-host
npm test -w @omp-studio/studio-host
npm run typecheck -w @omp-studio/host-client-api
npm test -w @omp-studio/host-client-api
npm run typecheck -w @omp-studio/client-contract
npm run typecheck -w @omp-studio/client
npm test -w @omp-studio/client
npm run typecheck -w @omp-studio/transport-desktop
npm test -w @omp-studio/transport-desktop
npm test -w @omp-studio/testkit
```

注意根 `npm test` 当前不一定覆盖 `host-client-api`；必须显式运行上面的 package test。

## 12. 完成条件

- [ ] Client可 query真实 transcript page。
- [ ] live events不经 snapshot日志绕路。
- [ ] conversation state能hydrate/paginate/live merge/resync。
- [ ] runtime/session切换不会串消息。
- [ ] accepted与terminal receipt语义清晰。
- [ ] strict transport validation已覆盖。
- [ ] reload不重放旧 delta。
- [ ] 未修改 vendor、Desktop composition或Renderer。
