# OMP Studio Harness-Parity Architecture v4

状态：建议作为实施基线

OMP 证据基线：`can1357/oh-my-pi@45e12e5bb758198a920c6070e7e64cb33b21beac`

设计周期：3–5 年

## v4 的核心变化

v3 以 Capability Broker 为架构中心：

```text
UI -> Studio Host -> Capability Broker -> RPC/Slash/CLI/Config/... -> OMP
```

v4 改为领域优先：

```text
Shared Client
  -> Studio Host Protocol
  -> Application Services + Studio Domain
  -> OmpRuntimeGateway
  -> internal CapabilityRouter
  -> RPC/Slash/CLI/Config/Companion/Collab
  -> 用户真实安装的 OMP
```

产品和 UI 围绕以下稳定概念工作：

```text
Environment -> Project -> Workspace -> Thread -> Run
Message | AgentProjection | Tool | Approval | Change | Preview
```

RPC、Slash、CLI、Config、Companion 和 Collab 只是
`OmpRuntimeGateway` 内部的兼容实现细节。

## 最重要的边界

- 用户安装的 OMP 是唯一默认 Agent Runtime。
- Studio 不重新实现 OMP Harness、Agent loop、工具语义或 Subagent 调度。
- OMP RPC/rpc-ui 是主要实时权威通道。
- Studio Domain 保存 Studio 自有状态和 OMP 投影，不建立第二份 OMP
  transcript/session 数据库。
- Renderer 只使用 Studio opaque ID。
- 一个 Environment 同一时间只能有一个 HostAuthority。
- Desktop-only 默认使用 Named Pipe/UDS/inherited IPC，不开启 TCP 监听。
- Local WebUI 启用时，给现有 HostAuthority 增加 loopback HTTP/WS listener，
  而不是启动第二个 Host。
- SDK 是独立 RuntimeBackend，不能作为同一 Thread 的隐藏 fallback。
- private Companion route 永远不是 stable capability。
- 每个 fallback 都必须有 owner、risk、version guard 和 removeWhen。

## v4 解决的主要问题

### 身份

```text
StudioThreadId
  -> OmpSessionId / OmpSessionHandle
  -> RuntimeProcessId
  -> RuntimeEpoch
```

旧 runtime 的迟到事件不能更新新 generation。

### 事件

```text
Durable:
  authorityEpoch + commitSeq

Ephemeral:
  runtimeEpoch + streamId + streamSeq

Transport delivery:
  connection-local deliverySeq
```

不能让 token delta、terminal chunk 和 durable lifecycle 共用一个序列和
持久化策略。

### 恢复

```text
Reconnect
  -> 先建立 live subscription
  -> 获取 snapshot through commitSeq
  -> replay durable tail
  -> 返回当前 partial stream snapshot
  -> synchronization barrier
  -> live
```

不会重新播放全部 token。

### 背压

- P0 approval/security/control outcome：不丢。
- P1 durable/semantic transition：不丢，溢出时 resync。
- P2 text/thinking/tool args delta：按明确 key 合并。
- Terminal/Preview 输出：spool、tail、offset 拉取。
- Telemetry/progress：latest-wins。
- 每客户端独立的 byte-bounded queue；慢客户端不能拖住 runtime ingestion。

### Subagent

当前可稳定实现：

- lifecycle/progress/full event subscription；
- roster；
- transcript 增量读取；
- Agent Hub 观察投影。

当前不应标为稳定控制：

- message；
- kill/revive/release；
- manual spawn；
- async job cancel。

这些能力 OMP Harness 内部存在，但当前没有完整 public RPC。v4 默认等待
上游 RPC，不通过 private Companion 强行提供。

## 阅读顺序

1. `00_EXECUTIVE_DECISION.md`：最终决策。
2. `01_GOALS_AND_INVARIANTS.md`：不可破坏的约束。
3. `02_V4_TARGET_ARCHITECTURE.md`：完整架构和数据流。
4. `03_DOMAIN_MODEL.md`：Environment/Workspace/Thread/Binding。
5. `04_EVENT_AND_PROJECTION_MODEL.md`：事件和 Read Model。
6. `05_ORDERED_PUSH_AND_BACKPRESSURE.md`：推送、重连和背压。
7. `06_OMP_RUNTIME_GATEWAY.md`：OMP process/RPC 边界。
8. `07_CAPABILITY_ROUTING.md`：能力路由和兼容债务。
9. `08_RUNTIME_IDENTITY_AND_LAUNCH_PLAN.md`：身份和诊断计划。
10. `09_COMPATIBILITY_CI.md`：真实 OMP 兼容性测试。
11. `10_HOST_AUTHORITY_AND_TRANSPORT.md`：单 Host 和传输。
12. `11_SECURITY_MODEL.md`：完整安全边界。
13. `12_TERMINAL_PREVIEW_AND_PROCESS.md`：PTY/Preview/进程模型。
14. `13_IMPLEMENTATION_PHASES.md`：Phase 0–8 及测试门。
15. `14_CAPABILITY_MATRIX.md`：当前 OMP 能力基线。
16. `15_MODULE_TREE.md`：推荐代码模块树。

`contracts/` 是规范性 TypeScript 契约，`adr/` 是不可随意改变的架构
决策。文档与契约冲突时，以契约和 ADR 为准。
