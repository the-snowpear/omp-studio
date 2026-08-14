# 02. Studio Host Runtime

## 1. OMP patch 目标

新增 `studio-host` 模式，使同一 OMP 进程同时拥有：

- `AgentSession` 和 `SessionManager`；
- `InteractiveMode`/TUI；
- Studio Bridge Server；
- Input & Command Arbiter；
- Shared Operator Services；
- Agent/Job Control adapter；
- State Projector；
- Remote UI adapter。

不复用现有 `runRpcMode()` 作为主循环，因为 RPC mode 独占 stdin，而 Studio Host 需要 stdin/PTY 留给 TUI。基础 RPC command/event 语义可以抽取并复用到 Bridge handler。

## 2. OMP 内部模块

```text
packages/coding-agent/src/studio/
  studio-host-mode.ts
  bridge-server.ts
  bridge-dispatcher.ts
  state-projector.ts
  command-arbiter.ts
  command-manifest.ts
  remote-ui-adapter.ts
  agent-control.ts
  job-control.ts
  shutdown.ts
  services/
    plan-service.ts
    goal-service.ts
    vibe-service.ts
    loop-service.ts
    session-control-service.ts
    ephemeral-turn-service.ts
    tan-service.ts
    omfg-service.ts
    pause-service.ts
    live-service.ts
```

## 3. 启动顺序

```text
parse CLI
  -> classify studio-host protocol mode
  -> initialize settings/auth/model registry
  -> create AgentSession exactly once
  -> construct SharedServices
  -> construct StateProjector
  -> bind AgentRegistry/EventBus/AsyncJobManager feeds
  -> create InteractiveMode with service dependencies
  -> open local Bridge endpoint
  -> authenticate Host
  -> emit runtime.ready snapshot
  -> start TUI render/input loop
```

Bridge 未认证前：

- 不接受 operator mutation；
- TUI 可以显示“等待 Studio Host”；
- 超时后退出或进入显式 standalone TUI，不能默默成为另一个 binding。

## 4. 依赖注入

定义 Runtime service container：

```ts
interface StudioRuntimeServices {
  plan: PlanService;
  goal: GoalService;
  vibe: VibeService;
  loop: LoopService;
  sessionControl: SessionControlService;
  ephemeralTurn: EphemeralTurnService;
  tan: TanService;
  omfg: OmfgService;
  pause: PauseService;
  live: LiveService;
  agents: AgentControlService;
  jobs: JobControlService;
}
```

服务依赖 `AgentSession`、`SessionManager` 和明确的小接口；不得依赖完整 `InteractiveModeContext`。

## 5. TUI handler 迁移模板

修改前：

```ts
handleTui: async (command, runtime) => {
  await runtime.ctx.handleGoalModeCommand(command.args);
}
```

修改后：

```ts
handleTui: async (command, runtime) => {
  const result = await runtime.services.goal.execute(
    parseGoalOperation(command.args),
    runtime.tuiInteractionPort,
  );
  runtime.ctx.presentOperatorResult(result);
}
```

Bridge handler：

```ts
case "goal.execute":
  return services.goal.execute(operation, remoteInteractionPort);
```

验收要求：TUI contract test 与 Bridge contract test 针对相同 service fixture 运行。

## 6. Command Arbiter

Arbiter 管理三类并发：

```ts
type CommandConcurrency =
  | "read-concurrent"
  | "queue-compatible"
  | "session-exclusive"
  | "process-exclusive";
```

最低分类：

| 操作 | 并发等级 |
|---|---|
| snapshot/list/read transcript | read-concurrent |
| prompt/steer/follow-up | queue-compatible |
| clear/drop/tree/fork/mode change | session-exclusive |
| pause/live/shutdown | process-exclusive |

Arbiter 在调用 service 前检查：

- runtimeEpoch；
- expectedStateVersion；
- current interaction lease；
- streaming/compacting；
- active mode；
- pending approval/host call；
- command-specific precondition。

## 7. State Projector

StateProjector 订阅：

- AgentSession events；
- goal_updated；
- plan/vibe/loop/pause/live service state；
- AgentRegistry changes；
- subagent EventBus；
- AsyncJobManager changes；
- Remote UI interaction lifecycle；
- Runtime shutdown。

它负责递增 `stateVersion`、生成 snapshot 和结构化 event；不拥有业务 mutation。

## 8. Shutdown

```text
shutdown request
  -> reject new mutation
  -> mark quiescing
  -> resolve/cancel Host UI waits
  -> stop Live/audio
  -> drain or cancel Runtime-owned jobs according to OMP semantics
  -> settle AgentSession dispose
  -> flush SessionManager
  -> close Bridge after shutdown.complete frame
  -> stop TUI
  -> close PTY/process resources
```

超时必须返回/记录 `outcome_unknown`；Host 强杀只是最后手段。

## 9. 完成标准

- 同一个 process 中 TUI 和 Bridge 都能观察同一 session id；
- GUI 和 TUI 发起 prompt 时共享 OMP queue semantics；
- session-exclusive 操作不会交叉；
- TUI 输出断开不影响 Bridge；
- Bridge 重连通过 snapshot 恢复；
- Runtime crash 不产生伪 completed receipt；
- 不存在第二个 OMP process resume 同一 session。

