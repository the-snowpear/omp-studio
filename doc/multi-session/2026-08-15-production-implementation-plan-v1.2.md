# OMP Studio 多会话生产架构实施计划 v1.2

状态：Approved implementation baseline；Phase 1/2 foundation implemented and verified
目标：将当前单 Runtime 绑定模型迁移为独立 Session Broker + per-resident-session Runtime Worker，并保持现有 Studio Bridge 单 Worker 合约。

## 1. 固定架构决策

1. Session 是长期逻辑实体，Runtime 是可替换执行资源。
2. Renderer 只连接 Broker，不持有 Runtime endpoint、token、PID 或可执行路径。
3. 一个 resident top-level Session 默认对应一个 Runtime Worker、一条 Studio Bridge 和一个 Windows failure domain。
4. dormant Session 不占用 Runtime Worker。
5. Persistent Transcript 是历史内容真值；Runtime Snapshot/Events 是当前执行真值；Broker Durable Store 是 metadata、lease、operation、routing 真值。
6. View attach 不启动 Runtime；只有 execution demand 才调用 ensureResident。
7. 现有 StudioBridgeClient 与 StudioRuntimeSessionController 保持单 Worker 语义，由 Broker 组合成多 Session 投影。

## 1.1 当前实现状态（2026-08-15）

已落地并通过项目门禁的基础能力：

- `session.transcript.readPage` typed contract、Desktop transport validation、Facade dispatch 和 Renderer archive hydrate/prepend；历史会话读取不再要求 Runtime 常驻。
- `StudioSessionArchiveReader`：持久 JSONL 读取、workspace 校验、重复 sessionId fail-closed、完整记录校验、残缺尾行处理、HMAC cursor 和敏感工具参数脱敏。
- `StudioSessionBroker` 内核：每 Session 生命周期队列、多个 resident Worker、ensureResident 合并、容量状态、身份校验、hibernate 和 Worker crash fencing。
- `FileSessionLeaseStore`：跨进程原子租约文件、单写者冲突、heartbeat、过期回收和 lease epoch 单调递增；`JsonSessionRegistry` 提供持久 registry/revision/lease 基础。
- testkit/preview fixture 已覆盖 `session.transcript.readPage`；Host API、Studio Host、Renderer、Desktop 及完整 `npm run check` 已通过。

尚未宣称生产完成的边界：

- Desktop 仍使用现有单 `DesktopRuntimeSessionPort`；Broker 尚未接入 Worker factory、durable SQLite store 或 Broker IPC server，因此真实桌面尚未开启多 Runtime 并驻。
- OMP writer 的 long-lived SessionWriterLease、`active_leaf` journal、fork staging/commit 和 `parentSessionId` canonicalization 仍是启用多 Worker 前的阻断项。
- Windows Job Object 生产默认仍需由 Desktop 注入 native containment provider；当前测试 seam 与 kill fallback 不能等同于生产 containment。

## 2. 必须先解决的生产约束

### 2.1 Broker Durable Store

独立 Broker 使用本地事务存储保存：

- broker epoch 和 schema version；
- Session registry；
- Runtime binding generation；
- Session writer lease；
- operation ledger 和 outcome_unknown；
- pending interaction；
- controller lease；
- event/checkpoint watermark。

生产实现优先 SQLite WAL。任何内存 Map 都只能是 durable state 的投影或缓存。

### 2.2 Session 单写者

每个逻辑 Session 同一时间只能有一个 execution writer。SessionLease 至少包含：

```text
sessionId
ownerId
leaseEpoch
runtimeId
acquiredAt
heartbeatAt
```

Broker 在 spawn/resume 前获得 lease；Worker handshake 必须回报 sessionId、workspace identity 和 lease epoch。外部 CLI 或第二个 Broker 不得静默获得同一个 session 的写权限。

### 2.3 Fork identity migration

`session.fork` 会令当前 AgentSession 切换到新的 sessionId。Broker 必须在一个 mutation lane 中原子完成：

```text
create SessionRecord(newId)
move RuntimeBinding oldId -> newId
close old writer lease
open new writer lease
mark old session dormant
emit identityChanged receipt/event
```

旧 session 的 transcript 和 SessionRecord 必须保留。

### 2.4 Broker IPC 安全

本地 Broker IPC 必须具有：

- 当前 Windows 用户 SID ACL；
- profile-scoped singleton identity；
- challenge/token authentication；
- protocol version negotiation；
- clientId 由 Broker 认证后分配；
- token rotation；
- Renderer 永远不直接接收 Broker/Runtime secrets。

### 2.5 Worker containment

Windows 上每个 Worker 使用独立 Job Object，启用 kill-on-close，并纳入 Runtime、MCP、LSP、tool/shell 后代进程。生命周期顺序：

```text
graceful shutdown
bounded wait
Job Object terminate
verify process tree gone
release binding
```

### 2.6 Archive and fork integrity

The current OMP JSONL writer is only serialized inside one SessionManager. Before multiple Workers are enabled, the Runtime writer path must use a long-lived OS file lock keyed by canonical `sessionId`; a callback-only lock is insufficient. Archive reads must use an open-handle snapshot, fstat identity checks, strict complete-line parsing, provisional-tail handling, and immutable revision pages.

The current session format also does not durably persist the active branch leaf. Add an append-only `active_leaf` journal entry (or an equivalent atomic sidecar) and include it in the transcript/branch revision. Legacy files may use the physical-tail rule only as an explicitly best-effort compatibility mode.

Fork is not a single-file operation. JSONL, artifacts, session identity and lease ownership must be staged and committed together. A failed artifact copy cannot return a successful fork. The canonical relationship is `parentSessionId`; legacy `parentSession` values that contain paths must be resolved inside the trusted session root and never exposed to clients.

## 3. 目标组件

```text
Renderer
  -> typed Desktop IPC
Electron Main
  -> authenticated Broker IPC
Studio Session Broker
  |- DurableStore
  |- SessionRegistry
  |- SessionLeaseManager
  |- SessionArchiveReader
  |- OperationLedger
  |- InteractionRouter
  |- EventJournal / ProjectionStore
  |- WorkerSupervisor
  |- RuntimeScheduler
  |- ClientAttachmentManager
  `- Observability
       -> RuntimeBinding A -> StudioBridgeClient A -> omp.exe A
       -> RuntimeBinding B -> StudioBridgeClient B -> omp.exe B
       -> Session C dormant
```

## 4. 状态模型

### Residency

```text
dormant
waiting_capacity
starting
handshaking
hydrating
online
quiescing
hibernating
crashed
recovering
failed
```

### Execution

```text
idle
queued
running
waiting_interaction
paused
aborting
interrupted
```

### Authority

每个 Session Snapshot 同时携带：

```text
brokerEpoch
sessionRevision
transcriptRevision
runtimeId?
runtimeEpoch?
runtimeStateVersion?
leaseEpoch?
```

## 5. Request、Receipt 与 Event

Mutation request：

```text
clientId
sessionId
requestId
expectedSessionRevision?
expectedRuntimeEpoch?
expectedLeaseEpoch?
operation
payload
```

Receipt 状态：

```text
rejected
queued
accepted
completed
failed
outcome_unknown
cancelled
```

Effectful operation 不允许 blind retry。requestId 必须贯穿 Broker、Bridge、Runtime 和持久化 SessionEntry；只有端到端 durable deduplication 成立后才能自动重放。

Broker event 使用 per-session ordering：

```text
brokerEpoch
sessionId
sessionRevision
eventSequence
runtimeEpoch?
eventType
payload
```

事件分为：

- durable/replayable：状态迁移、receipt、interaction、tool completion、final message、crash/recovery；
- coalescible projection：累计 streaming buffer、replace-mode tool output、progress；
- lossy telemetry：采样 CPU、瞬时进度。

增量 token 不能直接丢弃；必须拼接成 batch 或转换为累计 replacement frame。

## 6. Transcript Read Plane

新增 Broker-facing contract：

```text
session.transcript.readPage({
  sessionId,
  cursor?,
  limit,
  direction,
  itemView
})
```

返回值不得依赖 runtimeEpoch，而使用：

```text
sessionId
transcriptRevision
branchIdentity
items
olderCursor?
newerCursor?
```

SessionArchiveReader 必须：

- 不向 Renderer暴露文件路径；
- 拒绝 symlink/reparse escape；
- 校验 session header 的 cwd/workspace grant；
- 只接受完整 JSONL record，忽略正在追加的残缺尾行；
- 使用 file identity + size + stable boundary/hash 生成 revision；
- 明确 duplicate sessionId、fork 和 branch selection；
- 复用 Runtime transcript projector 的 allow-list 和 sanitizer。

在依赖 ArchiveReader 作为严格历史真值前，OMP Session persistence 必须新增 append-only `active_leaf`（或等价、原子且可恢复的 branch pointer）记录。当前物理最后一条 entry 不能可靠代表 active branch：非活动分支追加和崩溃窗口会令 archive/resume 选择错误分支。兼容旧文件时只能采用现有 physical-tail 规则并明确标记其 branch authority 为 legacy/best-effort。

## 7. Worker 调度与 Hibernate

RuntimeBudget 支持：

```text
maxResidentWorkers
maxResidentMemory
maxWorkersPerWorkspace
maxConcurrentStreams
```

资源不足时进入 `waiting_capacity`，支持优先级、公平排队、取消、超时和 `resource_exhausted` receipt。prefetch 永远低于显式用户 execution。

Hibernate 使用两阶段协议：

```text
prepareHibernate
  -> quiescing
  -> reject new normal mutations
  -> flush/checkpoint
  -> return hibernateToken
commitHibernate(token)
  -> runtime.shutdown
  -> verify exit
  -> dormant
```

新 execution demand 可在 commit 前取消 hibernate。running、tool-running、waiting interaction、non-interruptible job、pinned session 不得回收。

## 8. 分阶段执行

### Phase 0：契约与门禁

- 固定 Broker/Session/Lease/Receipt/Event 类型；
- 建立状态机 transition tests；
- 建立旧 Runtime late-event fencing tests；
- 建立 fork identity migration tests；
- 建立 transcript concurrent append tests；
- 建立 Broker restart recovery tests。

完成条件：新契约可在不改变现有 UI 行为的情况下编译并通过测试。

### Phase 1：Conversation Read 与 Runtime Resume 解耦

- 新建 SessionArchiveReader；
- 添加显式 sessionId 的 transcript readPage query；
- Renderer activeSessionId 只切换 View；
- dormant/offline Session 可以读取历史；
- 保留现有 singleton Runtime 作为 execution backend。

完成条件：关闭 Runtime 后仍可打开历史；选择 Session 不产生 runtime.launch 日志。

### Phase 2：In-process Broker

- SessionRegistry 与 per-session projection；
- 显式 sessionId command routing；
- per-session lifecycle/mutation/urgent lanes；
- RuntimeBinding Map；
- WorkerBudget 与 admission control；
- foreground/background subscriptions。

完成条件：两个 Session 可同时 resident 和 streaming，切换 View 不停止任一 Worker。

### Phase 3：Durability 与一致性

- SQLite WAL DurableStore；
- SessionLease；
- durable operation ledger；
- outcome reconciliation；
- event journal/checkpoint；
- two-phase hibernate；
- fork identity migration。
- long-lived SessionWriterLease backed by the native OS file lock;
- durable active-leaf journal and strict archive revision;
- staged fork/artifact commit marker and old/new session identity reconciliation。

完成条件：Broker crash/restart 后不会双写 Session，不会盲目重放 effectful operation。

### Phase 4：独立 Broker Process

- Broker 从 Electron Main 移到独立进程；
- 安全 named pipe、ACL、authentication、protocol negotiation；
- Electron Main 只保留 launcher/client 与 Renderer IPC adapter；
- Broker singleton、upgrade/schema migration。

完成条件：Renderer reload、窗口关闭和 Electron Main 重启不停止后台 Session。

### Phase 5：Containment 与恢复

- Windows Job Object per Worker；
- crash loop protection；
- worker adoption/termination；
- orphan detection；
- runtime epoch + lease epoch fencing。

完成条件：杀死 Runtime/Broker 后无孤儿 MCP/LSP/tool 进程，其他 Session 不受影响。

### Phase 6：Multi-window

- authenticated clientId；
- observer subscriptions；
- controller lease + CAS；
- session-scoped interaction map；
- lease expiry/transfer。

完成条件：两个窗口可观察同一 Session，只有 controller 能提交受控 mutation。

### Phase 7：Runtime Domains 与性能优化

- local Windows、WSL、container、remote placement；
- benchmark 驱动的 shared LSP/discovery cache；
- 保持 maxSessionsPerWorker=1 为默认安全策略。

## 9. 验证矩阵

必须覆盖：

- dormant transcript read；
- concurrent JSONL append；
- duplicate sessionId；
- fork sessionId migration；
- two sessions concurrent streaming；
- background stream + foreground switch；
- urgent abort 不被 prompt lane 阻塞；
- Runtime crash before/after accepted receipt；
- stale runtime/lease epoch event；
- Broker crash and restart；
- capacity exhausted/cancelled queue；
- hibernate race；
- multi-window controller lease；
- named-pipe unauthorized client；
- Worker descendant containment；
- Preview 不创建 Broker truth 或 Runtime。

## 10. 发布策略

所有阶段使用 feature flag 和兼容 facade。旧 singleton 路径在新路径达到等价门禁前保留。迁移采用 shadow projection：Broker 先旁路计算并比对 snapshot/receipt/event，不立即接管写流量；比对稳定后再切换 authority。

禁止在同一发布中同时切换 transcript truth、worker ownership 和 IPC process boundary。
