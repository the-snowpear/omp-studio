# 10. OMP Source Change Map

审计基线：`45e12e5bb758198a920c6070e7e64cb33b21beac`。

本表给出首轮实现的源码入口。实际修改前应重新跑 surface extraction，确认行号和符号仍存在。

## 1. CLI 和 Runtime 启动

| 当前文件 | 当前职责 | v5 修改 |
|---|---|---|
| `packages/coding-agent/src/cli/args.ts` | Mode union | 增加 `studio-host` |
| `packages/coding-agent/src/cli/flag-tables.ts` | `--mode` 解析 | 接受 `studio-host` 及 endpoint/token args |
| `packages/coding-agent/src/main.ts` | Runtime 分支、stdin ownership | 新增 studio-host startup；TUI owns stdin，Bridge 使用 side channel |
| `packages/coding-agent/src/modes/interactive-mode.ts` | TUI 与大量业务状态 | 注入 shared services；逐步移出 Plan/Goal/Vibe/Loop/BTW 等业务逻辑 |

## 2. Command registry

| 当前文件 | v5 动作 |
|---|---|
| `slash-commands/types.ts` | 保留 `handle/handleTui`；增加可选 service route metadata 或在 Studio manifest adapter 映射 |
| `slash-commands/builtin-registry.ts` | 提供全部 built-in snapshot 给 manifest generator |
| `slash-commands/acp-builtins.ts` | 不改为 TUI fallback；复用 `handle` 语义测试 |
| `slash-commands/available-commands.ts` | 与 Studio full manifest 分离；不要把现有 headless list 冒充 full list |
| `slash-commands/builtin-modes.ts` | 转发 Plan/Goal/Vibe/Loop service |
| `slash-commands/builtin-lifecycle.ts` | 转发 Clear/Drop/BTW/TAN/OMFG/Retry service |
| `slash-commands/builtin-session.ts` | 转发 Tree/Fork/Agent/Job相关 service |
| `slash-commands/builtin-control.ts` | 转发 Pause/Live service |

## 3. Direct primitives

| 能力 | 当前符号 | v5 wrapper |
|---|---|---|
| Queue | `AgentSession.followUp` / RPC follow_up | `SessionControlService.enqueue` |
| Clear | `AgentSession.resetSessionContext` | `SessionControlService.clearContext` |
| Drop | `AgentSession.newSession({drop:true})` | `SessionControlService.drop` |
| Retry | `AgentSession.retry` | `SessionControlService.retryLastFailed` |
| Fork | `AgentSession.fork` | `SessionControlService.fork` |
| Tree | `AgentSession.navigateTree`, `SessionManager.getTree` | `TreeService` |
| Pause | `@oh-my-pi/pi-agent-core.agentPauseGate` | `PauseService` |

## 4. Mode extraction

### Plan

当前主要位于 `interactive-mode.ts` 的 enter/exit/reconcile/approval 和 plan file helpers；ACP `modes/acp/acp-agent.ts` 有独立 Plan mode 实现。

执行顺序：

1. 定义 `PlanServiceHost` 小接口；
2. 抽取文件/artifact resolution；
3. 抽取 enter/exit 和 tool/model state；
4. 抽取 proposal/review/approval；
5. TUI/ACP/Studio 三入口调用共享层；
6. 删除重复但保留各 transport presentation。

### Goal

复用 `goals/runtime.ts`，将 TUI menu/continuation/tool enablement 组织成 `GoalService`；mode restore 从 `InteractiveMode` 下沉。

### Vibe

复用 `vibe/runtime.ts`、`VibeSessionRegistry`、AgentSession activate/deactivate tools；service 必须拥有 exit cleanup。

### Loop

将 `InteractiveMode.loopModeEnabled/Paused/Prompt/Limit` 和 auto-submit scheduler 移入 `LoopService`，通过 port 请求正常 prompt submission。

## 5. Composite command extraction

| 当前文件 | v5 service |
|---|---|
| `modes/controllers/btw-controller.ts` | `EphemeralTurnService` + presentation adapter |
| `modes/controllers/tan-command-controller.ts` | `TanService`，复用 session fork/job/sdk/adoption |
| `modes/controllers/omfg-controller.ts` | `OmfgService` + Remote UI steps |
| `modes/controllers/live-command-controller.ts` | `LiveService` + TUI/Studio media adapter |
| `modes/components/pause-screen.ts` | TUI Pause presentation；gate mutation移到 PauseService |

## 6. Agent Hub/Job

| 当前文件 | v5 adapter |
|---|---|
| `registry/agent-registry.ts` | Agent snapshot/read subscription |
| `registry/agent-lifecycle.ts` | ensureLive/kill/revive/release shared control |
| `irc/bus.ts` | agent message routing |
| `task/index.ts`、`task/executor.ts` | 抽取 operator spawn shared service，不复制 TaskTool |
| `async/job-manager.ts` | Job snapshot/cancel subscription |
| `tools/hub/*` | 提取 owner/jobless-agent 规则为 Hub shared service |
| `modes/components/agent-hub.ts` | TUI presentation 调 shared control；不再是唯一 control consumer |
| `modes/rpc/rpc-subagents.ts` | 复用 transcript/event projection逻辑 |

## 7. Extension/Remote UI

| 当前文件 | v5 动作 |
|---|---|
| `extensibility/extensions/types.ts` | 尽量不扩大第三方 public API；Runtime 内新增 RemoteInteractionPort adapter |
| `extensibility/extensions/runner.ts` | command execution 接收明确 InteractionPort/host actions |
| `modes/controllers/extension-ui-controller.ts` | TUI adapter；标准 UI 逻辑与 presentation 解耦 |
| `modes/rpc/*` rpc-ui handlers | 作为现有标准 UI 行为参考和兼容测试 |

## 8. Persistence 和状态

| 当前文件 | v5 动作 |
|---|---|
| `session/session-manager.ts` | 不由 Studio 直接调用；Runtime service 统一 mutation/flush/postcondition |
| `session/agent-session.ts` | service facade、state hooks、Agent/Job access 在 Runtime 内收敛 |
| `session/session-entries.ts` | manifest/schema diff；必要时增加明确 mode/service entry |
| `session/prewalk.ts` | 验证 Plan/Goal/Vibe restore，避免只在 InteractiveMode reconcile |

## 9. 新文件最小集

首个 vertical slice 只需：

```text
src/studio/studio-host-mode.ts
src/studio/bridge-server.ts
src/studio/bridge-dispatcher.ts
src/studio/state-projector.ts
src/studio/command-arbiter.ts
src/studio/services/session-control-service.ts
src/studio/services/pause-service.ts
```

后续按 Work Packages 增加，不先创建空抽象。

## 10. 修改纪律

- 每次只抽一个 semantic service；
- 先给原 TUI handler 写 characterization test；
- 抽取后同一测试对 TUI adapter 和 Studio adapter 运行；
- 不在抽取 PR 同时重命名/格式化无关代码；
- 不直接公开 InteractiveModeContext；
- 不从 Desktop deep import上述 OMP 文件；
- OMP internal adapter 只存在于 Managed Runtime 编译边界。

