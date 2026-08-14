# 08. Implementation Work Packages

本文件按依赖顺序定义可直接进入 issue tracker 的工作包。每个 WP 应拆成一个或多个小 PR，但不得跨越未满足的 gate。

## Milestone M0：Build and Contract Foundation

### WP-001 Shared contract package

**Owner**：Studio Host/Runtime shared  
**输出**：`packages/studio-protocol`  
**工作**：

- 导入 `contracts/` 的 ids/runtime/protocol/commands/interactions/agents-jobs/manifests/state；
- 加 runtime schema validation；
- canonical JSON fixtures；
- protocol version constants。

**验收**：Host 和 OMP patch 两端 typecheck；fixture 双向解析；未知 mutation 字段 fail closed。

### WP-002 Reproducible OMP Runtime build

**依赖**：WP-001  
**工作**：

- 固定 upstream commit；
- 建 patch stack；
- 输出 upstream/patchset version；
- Windows 首个平台构建；
- 生成初始 runtime-manifest。

**验收**：干净机器两次构建 manifest 一致；二进制可运行 `--version`。

### WP-003 Runtime installer skeleton

**依赖**：WP-002  
**工作**：版本目录、checksums、自检、`current.json`、rollback。

**验收**：安装 v1/v2、切换、回滚、拒绝 checksum 错误。

## Milestone M1：Studio Host Vertical Slice

### WP-010 `studio-host` CLI mode

**OMP 修改**：CLI args/main/runtime startup。  
**工作**：

- 新 mode；
- 创建一次 AgentSession；
- 同进程启动 InteractiveMode；
- 注入 service container；
- 建 Bridge endpoint 生命周期。

**验收**：Bridge 与 TUI 报告同一 session/runtime identity。

### WP-011 Bridge transport/auth/hello

**依赖**：WP-010  
**工作**：Named Pipe/UDS abstraction、token、frame codec、hello/profile/capabilities。

**验收**：认证成功/失败、oversize、协议不兼容、reconnect tests。

### WP-012 StateProjector and snapshot

**依赖**：WP-011  
**工作**：runtimeEpoch/stateVersion/eventSeq、session basics、snapshot、gap recovery。

**验收**：event gap 后 snapshot 恢复一致状态。

### WP-013 Host RuntimeActor and Command Ledger

**依赖**：WP-011/012  
**工作**：spawn/contain/stop、request correlation、receipt ledger、projection publication。

**验收**：Runtime crash 后 accepted command 变 `outcome_unknown`；Renderer refresh 不丢 terminal outcome。

### WP-014 Input & Command Arbiter

**依赖**：WP-012  
**工作**：lease、concurrency class、precondition、interaction owner。

**验收**：GUI/TUI 并发 destructive command 只有一个进入 service。

## Milestone M2：Core Commands

### WP-020 Pause/Resume vertical command

**依赖**：M1  
**工作**：typed operation、public gate、pauseEpoch、GUI Pause Bar。

**验收**：完整 request→receipt→state→GUI；stale pauseEpoch 拒绝。

### WP-021 Queue

`followUp` typed wrapper、queued state、drain test。

### WP-022 Clear Context

`resetSessionContext` wrapper、busy precondition、droppedCount/reset boundary receipt。

### WP-023 Drop Session

`newSession({drop:true})` wrapper、destructive approval、新 identity/deletion outcome。

### WP-024 Manual Retry

`session.retry()` wrapper、nothing-to-retry、failed-tail resume tests。

### WP-025 Core RPC semantic extraction

复用 prompt/steer/follow-up/abort/model/thinking/fast/session/history/tool events，而不是在 Bridge 中复制现有 RPC switch。

**M2 gate**：以上 commands 在 TUI 和 Bridge 共用 primitive，GUI 无 Slash/PTY 自动化。

## Milestone M3：Mode and Session Services

### WP-030 PlanService

- 抽取 enter/exit/restore；
- tool/model/guard；
- plan proposal handler；
- draft list/read；
- review/respond；
- TUI handler forwarding；
- ACP behavior parity fixture。

### WP-031 GoalService

- create/replace/show/budget/pause/resume/drop；
- goal tool lifecycle；
- continuation scheduler；
- mode journal restore；
- Guided Goal start。

### WP-032 VibeService

- tool activation/restore；
- VibeSessionRegistry scope；
- worker kill/suspend；
- mode journal restore；
- exit cleanup。

### WP-033 LoopService

- enable/disable/pause；
- prompt capture；
- count/time/token limit；
- resubmit scheduling；
- state events；
- Runtime shutdown cleanup。

### WP-034 TreeService

- getTree snapshot；
- navigate；
- branch summary；
- `ask` re-answer protocol；
- leaf persistence/reconcile；
- GUI tree。

### WP-035 ForkService

- preflight；
- flush/advisor/bash/job semantics；
- fork/rebind；
- new SessionBinding event。

**M3 gate**：Plan/Goal/Vibe/Loop active 时 crash/restart contract 明确；TUI/GUI state 一致。

## Milestone M4：Remote UI and Composite Commands

### WP-040 InteractionPort

TUI/Remote/Scripted 三实现，confirm/select/input/editor/approval。

### WP-041 BTW

ephemeral stream、abort、copy、opaque branch token、branch postcondition。

### WP-042 TAN

复用 forkFrom/createAgentSession/AsyncJob/Registry adoption，禁止 Studio 重新实现。

### WP-043 OMFG

generate/validate/amend/target/overwrite/commit/live register；文件 mutation 全在 Runtime。

### WP-044 Extension commands and standard Remote UI

manifest、typed args、ExtensionCommandContext、标准 UI bridge。

### WP-045 Skill/template/file commands

发现、参数、展示和执行结果分类。

### WP-046 TUI compatibility panel

PTY attach ticket、terminal renderer、manual control lease、interaction transfer、no semantic parsing tests。

**M4 gate**：全部当前 built-in commands 有 Native/Generic route；未知 custom TUI 有 manual terminal route。

## Milestone M5：Agent Hub and Jobs

### WP-050 Agent observation

Registry snapshot、lifecycle/progress/events、transcript opaque cursor。

### WP-051 Agent message

IrcBus/Lifecycle ensureLive、prompt/steer/follow-up、generation CAS。

### WP-052 Agent spawn

抽取 TaskTool shared spawn service，覆盖 sync/async、policy、adoption、delivery。

### WP-053 Agent kill/revive/release

Lifecycle service、tombstone、generation、owner scope。

### WP-054 Job API

AsyncJobManager snapshot/list/get/cancel/subscribe，复用 Hub owner rules。

### WP-055 Agent Hub GUI

tree/table/transcript/message/spawn/kill/revive/release/job controls、Limited states。

**M5 gate**：TUI Agent Hub 的用户可操作语义在 GUI 全部可用且 contract 等价。

## Milestone M6：Live and Distribution

### WP-060 LiveService

从 TUI controller 抽取状态/transport/delegation；不包含 Desktop audio device。

### WP-061 Audio sideband

Electron permission/device、authenticated media channel、backpressure、stop/reconnect。

### WP-062 System Runtime Resolver

Managed/System/Custom 设置、probe、Compatible/Limited/Rejected 分类、UI。

### WP-063 Compatibility CI

surface extraction、command gate、OS matrix、fixtures、manifest diff。

### WP-064 Signed update/rollback

candidate channels、signing、atomic activation、referenced version retention。

## Milestone M7：Upstreaming

- 拆出通用 shared service PR；
- 提交 public Agent/Job control API；
- 提交 Studio/host protocol 或可扩展 transport hooks；
- 上游合并后，Compatible System OMP 逐步替代专用 patch；
- Managed Runtime 继续作为已验证默认。

