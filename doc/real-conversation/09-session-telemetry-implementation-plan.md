# OMP Studio 对话实时 Token / Context 数据接入计划

日期：2026-08-15
目标：把右上角 telemetry 从“预览数字 / 真实模式 `—`”改成真实 Runtime 数据，并让 Context 构成严格使用 OMP 当前已有的五类统计字段。

## 1. 已锁定的产品决策

- 实时刷新：流式期间最多每 250ms 推送一次，采用 latest-wins 合并。
- 展示范围：只展示 Runtime 能可靠提供的字段；不保留无法证明的重试、Fallback、子 Agent 消耗、耗时等占位项。
- Context 分类：使用 OMP 原生五类字段，不再显示“文件内容”和“子 Agent 汇总”。
- 不传输 provider payload、prompt 原文、文件路径、认证信息或任何 token secret。
- 当前工作区的对话正文链路保持不变；本计划只增加 telemetry 数据面。

## 2. 公共数据合同

新增独立的 `SessionTelemetrySnapshot` 类型，建议形状如下：

```ts
interface SessionTelemetrySnapshot {
  sessionId: SessionId;
  capturedAt: string;

  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };

  lastCompletedTurn?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
    completedAt: string;
  };

  context: {
    contextWindow: number;
    usedTokens: number;
    percent: number;
    anchored: boolean;

    systemPromptTokens: number;
    systemContextTokens: number;
    systemToolsTokens: number;
    skillsTokens: number;
    messagesTokens: number;
  } | null;

  unavailableReason?: "runtime_not_ready" | "model_context_unknown";
}
```

字段来源必须固定：

- `tokens` 来自 `AgentSession.getSessionStats().tokens` 与 `.cost`。
- `lastCompletedTurn` 只取最近一个已完成 assistant message 的 usage；不要把流式 delta 估算成“本轮用量”。
- `context` 来自 `getContextBreakdown()` / `getContextUsage()`。
- Context 五类显示名称固定为：
  - 系统提示词 → `systemPromptTokens`
  - 系统上下文 → `systemContextTokens`
  - 工具定义 → `systemToolsTokens`
  - Skills → `skillsTokens`
  - 对话消息 → `messagesTokens`
- `anchored` 必须显示为“Provider anchor”或“Estimated”，不能把估算值伪装成精确值。
- `cost` 不要擅自加 `$` 或 `¥`；当前 Runtime 合同没有明确货币单位，UI 使用中性 `Cost` 标签。

在 Studio Protocol 中新增：

- `SessionTelemetrySnapshot` 类型文件。
- `session.telemetry.changed` Runtime event。
- `OperatorStateSnapshot.telemetry?: SessionTelemetrySnapshot`，用于初始快照和重连恢复。
- 对新增 event 增加严格 `exactKeys` 校验、非负整数校验、有限数字校验、session/runtime identity 校验。

不要把 telemetry 塞进 `ConversationMessageItem` 或现有 conversation reducer；它属于独立的 latest-value 数据流。

## 3. Runtime 与 OMP patch

按照现有 patch 工作流新增：

```text
omp-patch/patches/0019-studio-session-telemetry.patch
```

并更新 `omp-patch/patches/series.json`。不要只直接修改 vendor 工作树。

Runtime 侧实现要求：

1. 在 Studio state projector 中增加 telemetry 计算函数：
   - 调用 `runtime.session.getSessionStats()`。
   - 调用 `runtime.session.getContextBreakdown()` 与 `getContextUsage()`。
   - 从 session message 列表中取最近一个已完成 assistant usage，填入 `lastCompletedTurn`。
   - 任何缺失数据都返回 `null` 或明确 `unavailableReason`，不得填演示值。

2. 在初始 `StudioOperatorStateSnapshot` 中附带 telemetry。

3. 增加 `session.telemetry.changed` event：
   - 流式 event 触发后只标记 dirty，不立即重复计算。
   - 250ms 定时器到期时计算并发送最新值。
   - 同一时间最多允许一个 telemetry 计算任务运行；新请求覆盖旧请求。
   - `conversation.turn.completed`、`conversation.turn.aborted`、`conversation.compaction.completed`、session create/resume/reconnect 时立即 flush。
   - telemetry event 不增加 `stateVersion`，但增加 `eventSeq`，继续受现有 Runtime gap 检测保护。
   - 不把每个 token 作为单独 telemetry event 发出。

4. Runtime Projection 收到 telemetry event 后，只更新本地 snapshot 中的 telemetry，不改变其它 snapshot 字段。

5. Runtime 关闭、session 切换或 runtime epoch 变化时清除旧 telemetry，避免旧会话数据短暂显示在新会话上。

## 4. Host Bridge、Facade 与 Client

### Host Bridge / Facade

增加独立的 telemetry fanout，或等价的 typed event forwarder：

- `StudioRuntimeSessionController` 监听并转发 `session.telemetry.changed`。
- Host facade 增加对应的 `HostEventSeed`。
- event 必须检查 runtime epoch 匹配。
- event 必须检查 `telemetry.sessionId` 与当前 snapshot.sessionId 匹配。
- 不匹配时丢弃并记录 diagnostics，不更新 Renderer。
- runtime lost 时向 Client 发送清空/不可用状态，不能继续保留旧数字。

### Client Contract / Reducer

在 `ClientEntitiesState` 增加：

```ts
telemetry: SessionTelemetrySnapshot | null;
```

行为要求：

- bootstrap/snapshot 从 `OperatorStateSnapshot.telemetry` 初始化。
- `session.telemetry.changed` 更新 telemetry。
- authority/runtime epoch 变化时清空。
- cursor gap 仍触发现有 `resync.required`。
- stale session、stale epoch、重复 cursor 必须幂等忽略。
- 提供纯 selector，例如 `selectSessionTelemetry(state)`，Renderer 不直接复制 reducer 逻辑。

## 5. Renderer 顶栏

修改 `AppTopbar`：

- 真实模式读取 Client telemetry。
- 预览模式仍使用 fixture，但 fixture 必须改成上述五类 Context 字段。
- 预览关闭时绝不回退到 fixture。
- 没有 telemetry 时显示诚实空态，并标注原因。

### Token 面板

只显示：

- Session total：input、output、reasoning、cache read、cache write、total、Cost。
- 最近一次完成的 turn：使用 `lastCompletedTurn`，标签必须是“最近完成”，不能写“本轮”。

删除或不再显示没有真实来源的：

- 本轮耗时
- 会话总耗时
- 子 Agent 消耗
- 重试 / Fallback
- 缓存已省百分比

### Context 面板

只显示：

- 已使用：`usedTokens / contextWindow / percent`
- 五个真实分类及各自 token 数
- `Provider anchor` / `Estimated`
- 当前 `isCompacting` 状态可以复用现有 snapshot；不要显示“上次 Compact 日期”等虚构信息。

同时删除旧的两类预览字段和 UI 文案：

- 文件内容
- 子 Agent 汇总

## 6. 备份与实施顺序

执行 agent 必须先创建规范备份：

```text
backup/2026-08-15/session-telemetry-HHmmss/
```

备份所有将修改的源码、协议、测试和 patch 文件，并附 `README.md`，说明恢复方式。不要覆盖已有备份，不要触碰用户其它未提交改动。

建议按以下顺序实现：

1. Protocol 类型、校验、fixture。
2. OMP patch：Runtime telemetry 计算、节流、snapshot/event。
3. Studio Host / Bridge / Facade 转发。
4. Client contract / reducer / selector。
5. Renderer 顶栏和 preview fixture。
6. 各层测试与集成测试。
7. 最后执行 patch verification 和完整检查。

执行 agent 不应：

- 复用首页 `usage.get` 作为当前会话 telemetry。
- 从 transcript 文本反推 token。
- 把 provider 原始 usage 对象直接透传。
- 为缺失字段填入 0、演示数字或估算文字。
- 改动现有 Compact、Conversation、Agent Hub 的无关行为。

## 7. 测试与验收标准

### Protocol

- telemetry snapshot 合法数据可解析。
- 负数、NaN、Infinity、未知字段、错误 sessionId、错误 Context 分类均被拒绝。
- telemetry event 不改变 stateVersion，但 eventSeq 连续。
- snapshot 中 telemetry 缺失时仍兼容旧 Runtime。

### Runtime / OMP patch

- `getSessionStats()` 正确映射 input/output/reasoning/cache/cost。
- `getContextBreakdown()` 正确映射五类字段。
- streaming 高频 event 在 250ms 内合并为最新值。
- turn completed / aborted / compaction 会立即刷新。
- 没有 context window 时返回 `context: null` 和明确原因。
- runtime disconnect、session switch 不泄漏旧 session telemetry。

### Host / Client

- 初始 snapshot 能恢复 telemetry。
- telemetry event 能实时更新 Client state。
- stale epoch/session 被忽略。
- cursor gap 触发 resync。
- runtime loss 后 telemetry 清空。
- 重复 event 不会造成重复状态变化。

### Renderer

- Preview 开启时显示演示标记和五类字段。
- Preview 关闭时只显示真实 telemetry。
- 真实模式永远不出现旧 fixture 的六类字段。
- 无 Runtime、无 context window、流式中尚未有 completed turn 时均显示诚实状态。
- UI 不显示 provider secret、原始 prompt、路径或未经筛选对象。

### 必跑命令

```bash
npm run typecheck
npm test
npm run omp:verify:patches
npm run check
```

最终验收必须包含一个模拟 Runtime 场景：Runtime 提供真实 stats，连续发送 streaming、turn-completed、compaction event，确认右上角数字在 250ms 节流规则下更新，且关闭预览模式后不再读取 fixture。

## 8. 关键参考实现位置

- 右上角顶栏：[apps/renderer/src/App.tsx](../../apps/renderer/src/App.tsx)
- 预览 telemetry：[apps/renderer/src/preview/surfaces.tsx](../../apps/renderer/src/preview/surfaces.tsx)、[apps/renderer/src/preview/fixtures.ts](../../apps/renderer/src/preview/fixtures.ts)
- Runtime 统计 API：[omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/agent-session.ts](../../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/agent-session.ts)
- Context 统计实现：[omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/session-stats.ts](../../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/session-stats.ts)
- Studio Protocol：[packages/studio-protocol/src](../../packages/studio-protocol/src)
- Client reducer：[packages/client/src/reducer.ts](../../packages/client/src/reducer.ts)
- Host facade：[packages/host-client-api/src/facade.ts](../../packages/host-client-api/src/facade.ts)
