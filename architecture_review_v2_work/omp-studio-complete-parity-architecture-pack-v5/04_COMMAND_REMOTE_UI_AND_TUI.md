# 04. Commands, Remote UI and TUI Compatibility

## 1. 目标

所有当前和未来命令必须可以被发现，并至少有一种 Studio presentation：

```text
native | generic-form | terminal
```

## 2. Manifest 生成

Runtime 从以下来源生成 manifest：

- `BUILTIN_SLASH_COMMANDS_INTERNAL`；
- extension runner registered commands；
- skills；
- prompt/file templates；
- Studio-only typed operations；
- Admin CLI manifest。

对 built-in 记录 `handle`、`handleTui` 和 shared-service route。对 extension 记录标准 UI 能力和是否声明 custom TUI。

## 3. 路由决策

```text
if shared service exists:
  presentation = native or generic-form
else if command.handle exists and deterministic schema exists:
  presentation = generic-form
else if extension command uses standard Remote UI only:
  presentation = generic-form
else:
  presentation = terminal
```

Runtime 不得把 `handleTui` 存在本身当作 typed route。

## 4. Native command services

### P0 direct primitives

| Operation | OMP primitive | Postcondition |
|---|---|---|
| `queue.enqueue` | `session.followUp()` | queued count 增加或 turn started |
| `session.clearContext` | `resetSessionContext()` | reset boundary + droppedCount |
| `session.drop` | `newSession({drop:true})` | new session identity + deletion outcome |
| `turn.retry` | `session.retry()` | retry started 或 nothing_to_retry |
| `runtime.pause` | `agentPauseGate.pause()` | pauseEpoch + paused=true |
| `runtime.resume` | `agentPauseGate.resume()` | expected pauseEpoch released |

### P1 extracted services

- Plan：enter/exit/review/respond/restore；
- Goal：create/replace/show/budget/pause/resume/drop/continuation；
- Vibe：enter/exit/worker lifecycle/tool restore；
- Loop：enable/disable/pause/prompt/limit/tick；
- Tree：snapshot/navigate/summarize/ask re-answer；
- Fork：preflight/flush/fork/rebind。

### P2 composite services

- BTW：ephemeral stream、copy payload、opaque branch token；
- TAN：fork clone、AsyncJob、AgentRegistry adoption、delivery；
- OMFG：generate、validate、amend、scope selection、commit、live register；
- Live：device/auth/session/audio/delegation。

## 5. Argument schema

Native/Generic GUI 不解析 Slash 字符串。每个 command manifest 绑定 JSON Schema 和 canonical operation builder。

例如：

```ts
interface GoalCreateOperation {
  kind: "goal.create";
  objective: string;
  tokenBudget?: number;
}
```

Renderer 表单输出 domain command；Host 再构建 Studio operation，Runtime 最终校验一次。

## 6. Remote UI

Runtime 提供 `InteractionPort`：

```ts
interface InteractionPort {
  confirm(input: ConfirmInput): Promise<boolean>;
  select(input: SelectInput): Promise<string | string[] | undefined>;
  input(input: TextInput): Promise<string | undefined>;
  editor(input: EditorInput): Promise<string | undefined>;
  approve(input: ApprovalInput): Promise<ApprovalResult>;
  notify(input: NotificationInput): void;
}
```

实现：

- `TuiInteractionPort`：调用现有 overlay/editor；
- `RemoteInteractionPort`：发 Bridge interaction request；
- service 测试使用 `ScriptedInteractionPort`。

## 7. Interaction transfer

GUI 发起命令却遇到 unsupported custom UI 时：

1. service/extension 返回 `terminal_required`，且尚未执行 mutation；
2. Host 打开 PTY；
3. 用户确认 transfer；
4. Runtime 将 control lease 转给 TUI；
5. 用户在 TUI 手动重新发起或继续明确可转移的 interaction；
6. structured state events 继续更新 GUI。

禁止先执行一半 mutation，再以无 token 的方式要求用户猜测 TUI 状态。

## 8. TUI 安全边界

- TUI input 只接受真实用户键盘/粘贴；
- Studio 不自动发送按键序列；
- PTY output 只用于 terminal renderer；
- ANSI/OSC 过滤规则适用于非终端复制/日志；
- semantic success 来自 Runtime service/event；
- custom TUI 的不可结构化结果只影响 OMP 本身，Studio 通过后续 snapshot 观察，不从屏幕推断。

## 9. 新命令接入清单

每个新增 command 必须提交：

- manifest entry；
- operation/schema 或 terminal-only 分类；
- risk/effect；
- precondition；
- receipt/postcondition；
- Native/Generic UI 或 terminal launch action；
- TUI contract fixture；
- Bridge contract fixture；
- capability matrix 更新。

