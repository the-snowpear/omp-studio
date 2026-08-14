# 00. Execution Baseline

## 1. 开工前冻结的决策

| 编号 | 决策 | 实现含义 |
|---|---|---|
| D-01 | Managed Studio Host Runtime 是默认 Runtime | Desktop 不以用户全局 OMP 作为功能完整性的前提 |
| D-02 | Full Parity 只允许 `studio-host` backend | `rpc-ui`/ACP 只能作为 Limited backend 或测试参考 |
| D-03 | GUI 与 TUI 共用一个 OMP process/AgentSession | 不实现 RPC↔TUI hot switch，不允许 session 双写 |
| D-04 | 所有 GUI mutation 使用 typed operation | 不通过 `prompt("/command")` 调用 TUI-only command |
| D-05 | 所有 built-in command 必须进入 Command Manifest | 未分类的新命令阻止 Runtime 发布 |
| D-06 | Agent Hub 复用 Registry/Lifecycle/IRC/Task/Job 语义 | Studio 不重写 agent/job 生命周期 |
| D-07 | Unknown custom TUI 通过内嵌终端人工使用 | 不做屏幕 scraping 或键盘宏自动化 |
| D-08 | Runtime 多版本并存 | 活跃 Thread 绑定旧版本；新版本用于新 Thread |
| D-09 | System OMP 通过能力握手分类 | 不能按路径、文件名或版本号猜测 Compatible |
| D-10 | `outcome_unknown` 是合法终态 | 副作用未知时禁止自动 retry |

## 2. Full Parity 最低能力集

Runtime 必须同时支持：

```text
core.prompt
core.steer
core.followUp
core.abort
core.stream
session.state
session.history
session.tree
session.fork
session.clearContext
session.drop
turn.retry
operator.manifest
operator.invoke
interaction.respond
agent.list/get/subscribe/transcript
agent.send/spawn/kill/revive/release
job.list/get/cancel/subscribe
remoteUi.standard
tui.manualCompatibility
runtime.pause/resume
runtime.snapshot
```

Live 在第一版可以标记 `experimental`，但必须有明确 capability grade，不能假装 stable。

## 3. 工程边界

### Desktop Renderer

只调用 Studio Host domain API；不接触 OMP pipe、token、session path、PID、AgentSession 或文件系统 mutation。

### Studio Host

拥有 Runtime process、transport、Command Ledger、projection、workspace/security authority 和 Runtime installer。

### Managed OMP Runtime

拥有 OMP semantic truth、shared operator services、Agent Hub/Job adapter、Remote UI 和 TUI。

## 4. 首个可运行切片

第一个 vertical slice 必须完成：

```text
Desktop button
  -> Host command
  -> Studio Bridge request
  -> Runtime receipt accepted
  -> OMP AgentSession mutation
  -> Runtime state event
  -> Host projection
  -> Renderer update
```

建议首个命令为 `runtime.pause/resume` 或 `session.clearContext`，因为底层 primitive 已存在且 postcondition 明确。

## 5. Definition of Ready

进入实现前必须具备：

- contracts 被 Host 与 Runtime 两端引用；
- runtimeEpoch/stateVersion/eventSeq 生成规则确定；
- 本机 endpoint 和 token 方案确定；
- Runtime build 能从固定 OMP commit 重现；
- 至少一个 smoke fixture session；
- Windows Job Object 与 ConPTY 生命周期测试骨架；
- Runtime crash 后 `outcome_unknown` 测试。

