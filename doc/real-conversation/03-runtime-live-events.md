# 执行计划 03：OMP Runtime 实时消息与工具事件

> 依赖：计划 02 contract-only commit 已合并并冻结。
> 可并行：可与计划 04、05 同时执行。
> 目标：把 OMP `AgentSession` 的真实 message/tool/compaction 事件投影成安全、有限、可合并的 Studio Bridge live events。
> 文件 owner：vendor 新 live projector/service、vendor host-mode/StateProjector/bridge server 的必要接线及对应 tests。不得擅改公共 contract；不得修改 Desktop、Facade、Client、Renderer。

并发限制：在计划02 Commit B完成前，只创建独立live projector/service和测试，不修改 `state-projector.ts` 或bridge server；这些集成文件由计划02释放后再接线。

## 1. 数据源与基本原则

数据源只能是 `AgentSession.subscribe()`/等价 session event subscription。不得：

- 解析 TUI/ANSI 输出；
- 从日志字符串推断工具状态；
- 定时轮询 session 文件模拟 streaming；
- 每次 delta 都发送累计全文；
- 将 vendor `AgentEvent` 整体 cast 成公共 event。

Runtime 已有的关键源事件包括：

- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`
- retry、notice、模型变化等 session events

首版只投影对对话可见且 contract 已定义的集合；其他事件继续留在 Runtime，不得塞进 generic `unknown`。

## 2. 新建 ConversationLiveProjector

建议独立服务，职责单一：

1. 订阅 session events。
2. 维护当前 turn 中的最小 live identity/state。
3. 将 vendor event 映射为 contract event。
4. 执行内容规范化、脱敏、限长和 delta 合并。
5. 通过 StateProjector/Bridge server 的统一 `eventSeq/stateVersion` envelope 发出。

不要把复杂映射堆进 `studio-host-mode.ts` 或 bridge dispatcher switch。

## 3. 身份与合并语义

### 3.1 必需 identity

每个 live event 必须携带：

- `runtimeEpoch`
- `sessionId`
- `turnId`（若 OMP 无直接 id，projector 在 agent_start 创建，仅在当前 Runtime session 生命周期内稳定）
- message event：`messageId`
- tool event：`toolCallId`、`toolName`
- block delta：`blockId` 或能唯一确定同一 message 内 block 的稳定键

### 3.2 Live 与持久 history 收敛

- `message.started` 创建临时/实时节点。
- `message.delta` 只 append 到对应 block。
- `message.completed` 携带完整、安全、权威 item；下游以它替换 live buffer。
- 若持久 SessionEntry id 只在 message_end 后可得，completed event 必须给出最终 item id 或显式 `replacesLiveId`。
- tool completed 同理，最终结果覆盖 partial output。
- reload 只保证恢复已持久化 completed items；若 reload 发生在流中，下游可等待 completed event或重新 hydrate，不得显示已完成的假象。

### 3.3 重复与迟到

- 相同 completed event 重放必须幂等。
- completed 后到达的旧 delta 丢弃。
- runtime epoch/session 不匹配的事件不发送或由下游拒绝。
- abort 后迟到 delta 不应让 turn 回到 streaming。

## 4. Delta 和 backpressure

参考 vendor print mode 的 printable/delta 范式：去掉 providerPayload，只传真正增量，避免累计字符串导致 O(n²)。

实现要求：

- 高频 token delta按约 16–33ms 或固定字符阈值合并后发出。
- flush 顺序稳定；message completed 前必须 flush 剩余 delta。
- tool update 如果上游给的是 replacement partialResult，contract 要明确 `mode: replace`；如果是 append 才允许 append。
- 单事件超出 frame 预算时截断/分片，不能让 Bridge 断开。
- 队列有上限；consumer 慢时合并可合并的 delta，不能无限积压。
- completed/error/abort 等控制事件不得被普通 delta 挤掉。

## 5. 消息映射

### user message

若 OMP 原生事件会发 user message，则正常投影；若 prompt accepted 后直到持久化才出现 user message，不要在 Runtime端制造第二份。Renderer 可做明确标记的 optimistic user item，最终由 persisted/completed item reconcile。

### assistant message

- text 与 thinking 分 block。
- 保留 Markdown 文本，不预渲染 HTML。
- provider metadata、usage 内部结构不进入 message delta。
- message_end 生成完整权威 item。

### system/custom

只投影 contract allow-list 中的安全 notice；未知 custom message 默认忽略并记录内部 diagnostic。

## 6. 工具映射

### start

包含 toolCallId、toolName、规范化 arguments、开始时间。参数映射复用计划 02 sanitizer。

### update

只发送适合 UI 的 partial summary/progress。禁止持续发送完整 stdout 历史。Bash 可发送新增 stdout/stderr 片段或替换型摘要，语义必须测试固定。

### end

包含：

- toolCallId/toolName
- success/error 状态
- 安全、限长的最终 result
- 可选 exit code/duration 等 contract 已允许的稳定字段

工具异常必须转换为 `isError: true`，不能把异常栈或本机秘密直接显示。

## 7. Compaction、Abort、Retry、Notice

- compaction start：时间线可显示进行中状态，但不提前伪造 summary。
- compaction end：若已有持久 compaction entry，completed event使用权威映射。
- abort：发 turn aborted，保留已收到内容。
- retry：首版可用安全 notice 表示 attempt/maxAttempts；不得把完整 provider error 原文无审查下发。
- notice：仅允许 info/warning/error + 安全文本 + source allow-list。

## 8. StateProjector 与 Bridge 接线

1. live projector 产生的事件必须经过现有 `StudioEventEnvelope`，使用同一递增 `eventSeq`。
2. `stateVersion` 语义保持现有规则：纯文本 delta 是否提升 stateVersion 由 contract-only 变更明确；不可一部分事件提升、一部分不提升而无测试。
3. Bridge strict union/validation 已由计划 02 冻结；本计划只按其发事件。
4. session dispose/rebind 时取消订阅并清空 live buffer。
5. listener 调用必须异常隔离，projector/adopt/consumer 错误不能沿 socket data handler 冒泡摧毁 Bridge。

## 9. 测试矩阵

- assistant: start → 多 delta → end，字符顺序正确。
- 多 content blocks：thinking 与 text 不串。
- 两个并行/连续 tool call 各自正确关联。
- tool partial update 的 append/replace 语义。
- tool error、巨大 stdout、二进制/循环结构。
- completed 前 flush 所有 delta。
- duplicate completed 幂等；completed 后迟到 delta 丢弃。
- abort 中断，不再接受该 turn 的普通 delta。
- compaction start/end。
- runtime epoch/session rebind 后旧事件不发。
- 高频 10k 小 delta 被合并，event 数量有上界，文本无丢失。
- providerPayload/secret key 不出现在序列化 frame。
- consumer listener 抛异常时 Bridge 仍继续处理后续 frame。

至少增加一条使用真实 `AgentSession` 测试 double/event fixture 的事件序列测试，不要只测独立纯函数。

## 10. 验收命令

```bash
npm run typecheck -w @omp-studio/studio-protocol
npm test -w @omp-studio/studio-protocol
npm run omp:verify:patches
```

并执行 vendor coding-agent 的 studio/live-projector 专项测试；将精确命令和结果写入交付报告。

## 11. 完成条件

- [ ] message/tool/compaction 真实事件进入 Studio Bridge。
- [ ] delta 是增量且有 backpressure/coalescing。
- [ ] completed item 与 transcript schema 一致并可权威收敛。
- [ ] session/runtime identity 完整。
- [ ] dispose/rebind 不泄漏旧事件。
- [ ] listener 错误不打坏 socket。
- [ ] 无 providerPayload、secret、任意 HTML。
- [ ] 未修改公共 contract 或下游 UI。
