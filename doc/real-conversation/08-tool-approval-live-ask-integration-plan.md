# OMP Studio 工具审批与 Live Ask 完整接入计划

## 目标与最终验收

完成后，真实 Runtime 中的以下流程必须可用：

1. OMP `ask` 工具在 Desktop 非 TTY Runtime 中向 Renderer 显示逐题交互卡。
2. Bash、Edit、Write、MCP 等工具在 `always-ask` / `write` 模式下显示真实审批卡。
3. 用户选择、输入、编辑、允许、取消后，Runtime 中原始工具调用继续或安全终止。
4. Interaction 不依赖某一个 `core.prompt` 命令，Loop、Follow-up、后台轮次也能处理。
5. Renderer reload 后，仍能恢复 Runtime 正在等待的 Interaction。
6. 输入框下方权限按钮可以切换：
   - Review → OMP `always-ask`
   - Workspace → OMP `write`
   - Full Access → OMP `yolo`
7. 权限模式持久化到 OMP 全局配置，并同步所有当前驻留 Runtime。
8. Preview 模式中的演示卡不能遮挡真实 Interaction。
9. 不泄漏 Bridge token、确认 token、密码、API key、PID、路径等敏感数据。

本计划采用“Session 级 Interaction + 单 pending 卡片”的方案：

- Interaction 不再强制依附某个 Client command。
- Runtime 仍保留真实 `commandId` 用于内部 arbiter 所有权校验。
- Renderer 每次只显示一张卡，多个问题由 Ask 工具逐题等待。
- 现有 `session.drop`、树导航、OMFG 等显式 Interaction 继续兼容，并可附带原始 command 关联。

## Phase 0：准备、备份与当前编译基线

### 0.1 工作区保护

当前工作区已有大量未提交改动。执行者必须：

1. 先运行：

   ```bash
   git status --short
   git diff --stat
   ```

2. 不回滚、不覆盖用户已有改动。
3. 修改每个已有文件前，在以下目录建立快照：

   ```text
   backup/YYYY-MM-DD/tool-approval-live-ask-HHmmss/
   ```

4. 备份目录保留原项目相对路径，并写入 `README.md`，至少包含创建时间、任务名称、文件清单、原因和恢复命令。
5. 不备份 `node_modules`、`dist`、日志、缓存或整个 vendor 子模块。

### 0.2 先修复当前 Desktop 编译阻塞

当前 Desktop 测试无法启动，存在：

- `sessionIsIdle` 未定义
- `supportsConcurrentSessions` 不在 `DesktopRuntimeSessionPort` 接口中

先检查这些错误是否来自当前未提交的多会话改动：

```bash
npm run build -w @omp-studio/desktop
```

要求：

- 不使用 `any` 掩盖类型错误。
- 如果 `supportsConcurrentSessions` 是设计中的正式能力，就补充到接口和测试替身。
- 如果只是错误残留，就删除字段及其无效消费者。
- `sessionIsIdle` 必须使用现有 Runtime 状态或明确 helper，不得伪造永远为 `true`。
- Phase 0 完成后，Studio protocol、client-contract、studio-host、host-client-api、client、renderer、desktop 都必须至少能够 build。

## Phase 1：定义 Session 级 Interaction Contract

### 1.1 Runtime Protocol 增加完整 pending 信息

将当前只有摘要的 `StudioInteractionSummary` 扩展为完整可恢复请求：

```ts
interface StudioPendingInteraction {
  readonly request: StudioRemoteInteractionRequest;
  readonly owner: "gui" | "tui";
  readonly leaseGeneration: number;
}
```

`request` 保留 interactionId、commandId、kind、title、message、options、placeholder、content、approvalType、details、destructive、secret、promptStyle。

要求：

- Runtime 到 Host 的 Bridge 通道可以携带原始请求。
- Host 映射到 Client 前必须做脱敏和字段限长。
- Renderer 永远不能看到 Bridge token 或 Host confirmation token。
- snapshot 中最多存在一个 pending Interaction；第二个请求必须 fail closed。

重点文件：

- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/bridge-protocol.ts`
- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/state-projector.ts`
- `packages/studio-protocol/src/contracts/state.ts`
- `packages/studio-protocol/src/validation.ts`

### 1.2 增加 Interaction resolved 事件

新增：

```ts
interface StudioInteractionResolvedEvent {
  readonly kind: "interaction.resolved";
  readonly interactionId: string;
  readonly commandId: string;
  readonly leaseGeneration: number;
  readonly outcome: "submitted" | "cancelled" | "aborted" | "expired";
}
```

发送时机：

- GUI submit：`submitted`
- GUI cancel：`cancelled`
- TUI 响应：对应结果
- Runtime dispose / Bridge 关闭：`aborted`
- Ask timeout：`expired`

要求：

- 事件必须带 interactionId 和 leaseGeneration。
- 迟到旧 generation 不能清除新 Interaction。
- 重复 resolved 必须幂等。
- resolved 事件不携带用户输入原文。

重点文件：

- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/services/interaction-port.ts`
- `packages/studio-host/src/interaction-events.ts`
- `packages/studio-host/src/runtime-session-controller.ts`
- `packages/studio-protocol/src/contracts/protocol.ts`
- `packages/studio-protocol/src/validation.ts`

### 1.3 Client Contract 改为可选 command 关联

将 `ClientInteraction.requestId` 改为可选，并增加：

```ts
interface ClientInteractionBase {
  readonly interactionId: InteractionId;
  readonly sessionId: SessionId;
  readonly leaseGeneration: number;
  readonly title: string;
  readonly requestId?: CommandRequestId;
}
```

规则：

- `requestId` 只用于关联 `core.prompt`、`session.drop` 等已有命令。
- 没有 `requestId` 的 Interaction 仍必须进入独立 pending 状态。
- `title` 必须保留，不再丢弃。
- `interaction.required` 总是写入 `state.interaction.pending`。
- 有 requestId 且命令仍为 accepted 时，同时关联原命令状态。
- 无 requestId 时不能丢弃事件。
- `interaction.resolved` 只清除相同 interactionId + generation 的 pending。
- 原命令最终 receipt 仍是命令完成的唯一证据。

新增 Client events：

```ts
type ClientEvent =
  | { kind: "interaction.required"; interaction: ClientInteraction }
  | {
      kind: "interaction.resolved";
      interactionId: InteractionId;
      leaseGeneration: number;
      outcome: "submitted" | "cancelled" | "aborted" | "expired";
    };
```

最终 Renderer 必须读取 `state.interaction.pending`，不能再通过遍历 commands 查找卡片。

重点文件：

- `packages/client-contract/src/lifecycle.ts`
- `packages/client-contract/src/index.ts`
- `packages/client/src/reducer.ts`
- `packages/client/src/studio-client.ts`

### 1.4 Bootstrap 恢复 pending Interaction

`ClientBootstrap` 增加：

```ts
readonly pendingInteraction?: ClientInteraction;
```

Facade bootstrap 时：

1. 从当前 Runtime snapshot 读取完整 pending Interaction。
2. 使用同一套 mapper 做脱敏。
3. owner 不是 `gui` 时不提供可提交卡片。
4. owner 是 `gui` 时返回 pending。
5. Client reducer 在 `bootstrap.set` 时恢复 pending。
6. Runtime 没有 pending 时清空旧 Client pending。

## Phase 2：接通 OMP Ask 工具到 Remote Interaction

### 2.1 新增 Remote Extension UI Adapter

新增 `StudioRemoteExtensionUiContext`，实现：

- `select`
- `input`
- `editor`
- `approveTool`

首版不要实现 `askDialog`，让 `AskTool` 自动走现有逐题 fallback。

非阻塞 UI 能力（notify、status、widget、custom、terminal input）必须安全 no-op 或明确不支持。

### 2.2 Ask 逐题映射

Select：

```ts
{
  kind: "select",
  title: question.question,
  options: [
    { id: "option:0", label: "...", description: "..." },
    { id: "custom-input", label: "Other (type your own)" }
  ],
  multiple: question.multi === true
}
```

Adapter 将 Runtime option id 转回 Extension UI 需要的 label；未知 id 必须报 `INVALID_ARGUMENT`。

Input：保留 title、placeholder、secret。

Editor：保留 title、content、language、promptStyle；返回编辑后的字符串。

Timeout / Abort：调用 Remote cancel，等待 pending Promise 收敛，发出 resolved，不能残留旧卡片。

### 2.3 Tool Call 内部 commandId

每个 Tool Call 生成：

```text
studio-tool:<toolCallId>
```

要求：

- 只用于 Runtime arbiter ownership。
- 不映射为 Client requestId。
- 不在 Renderer 显示。
- 不要求 Host ledger 存在对应命令。
- 同一 Tool Call 的多题复用该 ID。

### 2.4 ToolContextStore UI factory

支持：

```ts
type ToolUiFactory = (toolCall?: ToolCallContext) => ExtensionUIContext;
```

规则：

- 普通交互式 TUI 继续使用原 UIContext。
- Studio headless Runtime 使用 Remote UI factory。
- factory 根据 `toolCall.id` 生成内部 commandId。
- 普通 print / ACP / 非 Studio headless 模式继续 fail closed。

重点文件：

- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/tools/context.ts`
- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/sdk.ts`
- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/main.ts`
- `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/studio-host-mode.ts`

### 2.5 Studio Host 启动时安装 Remote UI

`runStudioHostMode` 创建 Runtime 后：

1. 创建 `StudioInteractionGateway`。
2. 创建 Remote UI factory。
3. 通过 `setToolUIContext(factory, true)` 注入 ToolContextStore。
4. Runtime dispose 时撤销或失效 factory。
5. 非 TTY 分支仍只等待 Bridge，不启动 TUI editor，不读取 stdin。

## Phase 3：接通真实工具审批

### 3.1 ExtensionUIContext 增加可选审批接口

```ts
approveTool?(
  input: {
    toolName: string;
    toolCallId: string;
    title: string;
    reason?: string;
    details: unknown;
    approvalMode: "always-ask" | "write" | "yolo";
  },
  options?: ExtensionUIDialogOptions,
): Promise<boolean>;
```

普通 TUI 不实现时继续走旧 `select("Approve", "Deny")`。

### 3.2 ExtensionToolWrapper 审批优先级

1. `approvalCheck.required === false`：直接执行。
2. `context.ui?.approveTool` 存在：使用 Studio Remote approval。
3. 否则 `runner.hasUI()`：使用旧 TUI approval。
4. 两者都没有：fail closed。

details 使用安全结构：

```ts
{
  toolName,
  toolCallId,
  reason,
  summary,
  risk: "low" | "medium" | "high",
  scope?
}
```

不把完整环境变量、认证头、token、密码放入 details。

### 3.3 Approval submit 必须是 boolean true

统一协议：

- 允许一次：`decision: "submit", value: true`
- 拒绝：`decision: "cancel"`

`StudioInteractionPort.approve()` 返回 `Promise<boolean>`，结果严格判断 `value === true`。

同步修改：

- `interaction-port.ts`
- `DesktopInteractionHost`
- confirmation token 签名内容
- Renderer approval submit
- approval 测试

### 3.4 高风险 Token

Host token 必须绑定：

- interactionId
- leaseGeneration
- Runtime epoch
- commandId
- decision = submit
- value = true
- expiry
- one-shot 状态

Renderer 不接触 token。响应失败时保留 pending 卡片；旧 token 失效后必须重新进入安全确认流程。

## Phase 4：Host / Desktop Interaction 生命周期

### 4.1 InteractionEventFanout

`clientRequestId` 改为可选：

- 无 requestId 仍 forward。
- required/resolved 都 forward。
- listener 异常隔离。
- duplicate / higher generation 不打断 Bridge。

### 4.2 Facade 映射

`mapRemoteInteractionToClient`：

- 保留 title、sessionId、leaseGeneration。
- requestId 有则带上，无则省略。
- approval details allow-list、限长、脱敏。
- owner = tui 不发可提交 GUI Interaction。
- unknown kind 丢弃并记录 diagnostics。

`#onInteractionForward` 不能因为缺 requestId 直接 return：

- 有 requestId：更新独立 Interaction 并关联原 command。
- 无 requestId：只更新独立 Interaction。
- resolved 必须发到 Client。

### 4.3 DesktopInteractionHost

- required：adopt、预签 token、forward。
- resolved：按 id/generation 清理 adapter 和 token。
- rebind：清理旧 Interaction。
- Runtime loss：清理 pending、撤销 token、发布 resync。
- GUI response：等待 Runtime resolved，不只依赖本地 optimistic 删除。

### 4.4 reload / rebind / runtime loss

- Renderer reload：从 bootstrap.pendingInteraction 恢复。
- workspace rebind：旧 Interaction 全部作废。
- Runtime epoch 变化：旧 Interaction 全清。
- Runtime loss：显示 Runtime 断开，禁止提交旧响应。
- 同 id 高 generation：替换旧卡。
- 同 id 同 generation：幂等忽略。

## Phase 5：权限模式命令与 UI

### 5.1 类型和映射

```ts
type ApprovalMode = "always-ask" | "write" | "yolo";
```

```text
Review       -> always-ask
Workspace    -> write
Full Access  -> yolo
```

### 5.2 Runtime operation

新增：

```ts
{
  kind: "permissions.mode.set";
  mode: ApprovalMode;
  persist: boolean;
}
```

当前 Runtime 使用 `persist: true`，其他驻留 Runtime 使用 `persist: false`。

持久更新：

```ts
session.settings.set("tools.approvalMode", mode);
await session.settings.flush();
```

snapshot 必须包含新的 `approvalMode`。

### 5.3 全局持久并同步驻留 Runtime

扩展 `DesktopRuntimeSessionPort`，提供 `applyApprovalMode(mode)`：

1. 读取旧模式。
2. 当前 Runtime 持久写入。
3. 其他驻留 Runtime 使用非持久 override。
4. 统计成功/失败数量。
5. 失败时返回 `syncStatus: "partial"`，不得伪报 complete。
6. 下次 activate / rebind 重新同步失败 Runtime。

测试必须验证当前 Runtime 持久写入一次、sibling 使用 override、部分失败可见。

### 5.4 Client command

新增 `permissions.mode.set`：

输入：

```ts
{ mode: ApprovalMode }
```

结果：

```ts
{
  mode: ApprovalMode;
  syncStatus: "complete" | "partial";
  appliedSessions: number;
  failedSessions: number;
}
```

命令为 `session-exclusive`；Runtime streaming 或存在 pending Interaction 时拒绝。

更新：

- `packages/client-contract/src/operations.ts`
- `packages/studio-protocol/src/contracts/commands.ts`
- `packages/studio-protocol/src/contracts/manifests.ts`
- protocol / transport validators
- Host facade semantic service
- Desktop semantic service

### 5.5 输入框下方权限 pill

修改当前 disabled 的 `default` pill：

- 从 snapshot 读取 approvalMode。
- 显示 Review / Workspace / Full Access。
- 点击打开三项菜单。
- Runtime 不可用、streaming、busy、resync、pending Interaction 时禁用。
- 不做 optimistic 状态切换。
- 只在 receipt / snapshot 更新后显示新模式。
- 失败显示 composer error。

### 5.6 Settings → Permissions

当前静态选择器接入同一个真实 handler：

- Review → `always-ask`
- Workspace → `write`
- Full Access → `yolo`

“始终允许”规则本轮继续保持 disabled，除非另行扩展持久规则 contract。

## Phase 6：Renderer InteractionDeck

### 6.1 真实 Interaction 优先于 Preview

改为：

```tsx
{pendingInteraction ? (
  <InteractionDeck ... />
) : preview ? (
  <PreviewDeck />
) : null}
```

真实 pending 永远优先；没有真实 pending 时 Preview 才显示演示卡。

### 6.2 Prompt 文案

真实卡片使用 `interaction.title`：

- select：真实问题标题
- input：问题标题和 placeholder
- editor：标题、预填内容、language
- approval：标题、approvalType、reason、summary、risk、scope
- confirm：message

不得再用 `Runtime requests select` 作为真实主文案。

### 6.3 Editor

- controlled textarea
- 初始值来自 interaction.content
- Submit 返回字符串
- Cancel 返回 cancel
- language 保留
- 长度受 Client / Transport 限制
- 禁止 HTML 注入

### 6.4 响应失败

- submit 后防重复点击。
- respond 失败保留卡片。
- 显示 Retry。
- 只有收到 resolved 或明确 terminal 状态才移除卡片。
- 使用 interactionId + leaseGeneration 作为 key。

## Phase 7：Patch、Manifest 与上游同步

vendor 修改必须走现有 patch 流程，建议新增：

```text
omp-patch/patches/0018-studio-interaction-ui-bridge.patch
```

内容包括：

- Remote Extension UI adapter
- ToolContextStore UI factory
- Ask headless Studio UI 接入
- ExtensionToolWrapper Remote approval
- resolved event
- approval boolean response
- approval mode operation

要求：

1. 不把 vendor 临时改动当最终交付。
2. 更新 `omp-patch/patches/series.json`。
3. 保持 patch 顺序。
4. 运行：

   ```bash
   npm run omp:verify:patches
   npm run runtime:verify-source
   ```

5. 不提交无关 vendor 文件、构建产物或日志。

## 测试计划

### Runtime / vendor

必须覆盖：

1. Headless Studio UI factory 的 Ask select、input、editor。
2. 多题逐题且单 pending。
3. cancel、timeout、dispose 的 resolved outcome。
4. Studio approval 优先于 TUI approval。
5. 无 Studio UI 时保留旧 TUI 行为。
6. yolo 不创建普通 tier approval。
7. provider safety check 必须显式批准。
8. approval submit 严格返回 true。
9. toolCallId 生成稳定内部 commandId。
10. pending snapshot 含完整 request。
11. resolved 事件按 id/generation 幂等。

### Protocol / transport

覆盖：

- 五种 Interaction 的 title 和可选 requestId。
- approval details 脱敏、限长。
- resolved outcome 枚举。
- editor value 字符串限制。
- `permissions.mode.set` 三个合法模式。
- 不泄漏路径、token、认证字段。

### Host / Desktop

覆盖：

- 无 requestId required 仍 forward。
- 有 requestId 时关联原 command。
- resolved 清理 Desktop adapter。
- GUI/TUI owner、duplicate、高 generation、stale response。
- token 缺失、错误、过期、重放全部 fail closed。
- respond 失败保留 pending。
- bootstrap 恢复、rebind 清理、Runtime loss 失效。
- applyApprovalMode 全驻留同步、持久写入和 partial 状态。

### Client / reducer

覆盖：

- 无 requestId 不丢弃。
- correlated 和 independent Interaction 同时可用。
- required / resolved / bootstrap / generation / epoch 行为。
- 原 command receipt 不误清其他 Interaction。

### Renderer

覆盖：

- select 显示 title。
- input 显示 title 和 placeholder。
- editor 可编辑提交。
- approval submit 发送 `value: true`。
- respond 失败保留卡片。
- 真实 pending 优先于 Preview。
- 权限 pill 和 Settings 发送正确 mode command。
- 无 Runtime 时权限控件禁用。

### 集成验收场景

至少完成：

1. Review 模式触发 Bash approval，允许一次后工具继续。
2. 取消 Bash approval 后工具不执行。
3. Live Ask select 逐题返回正确 label。
4. Live Ask input / editor 返回用户文本。
5. Loop 第二轮无父 command 时仍能显示 Ask。
6. Runtime 等待期间 reload 后卡片恢复。
7. 两个驻留 Runtime 同步 Review / Full Access。
8. TUI owner 不显示可提交 GUI 卡。

## 验收命令与完成条件

```bash
npm run build -w @omp-studio/studio-protocol
npm run build -w @omp-studio/client-contract
npm run build -w @omp-studio/studio-host
npm run build -w @omp-studio/host-client-api
npm run build -w @omp-studio/client
npm run build -w @omp-studio/renderer
npm run build -w @omp-studio/desktop

npm test -w @omp-studio/studio-protocol
npm test -w @omp-studio/studio-host
npm test -w @omp-studio/host-client-api
npm test -w @omp-studio/client
npm test -w @omp-studio/renderer
npm test -w @omp-studio/desktop

npm run omp:verify:patches
npm run runtime:verify-source
npm run check
```

只有以下条件全部满足才算完成：

- Desktop 编译无错误。
- 所有新增和既有测试通过。
- `omp:verify:patches` 通过。
- `npm run check` 通过。
- 至少一条真实工具审批 E2E 通过。
- 至少一条真实 Ask E2E 通过。
- reload、Loop、TUI owner、token fail-closed 场景均有测试。
- 权限模式能持久化并同步所有驻留 Runtime。
- Preview 不再遮挡真实 Interaction。

任何关键链路失败时，必须停止并报告失败文件、命令、已完成阶段、未提交改动和是否需要恢复 backup；不得用 mock 成功、强制完成 receipt、默认自动批准或隐藏错误来通过验收。
