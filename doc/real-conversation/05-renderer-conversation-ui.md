# 执行计划 05：Renderer 真实对话区与 Composer 反馈

> 依赖：计划 02 contract-only commit；计划 04 提供最终 query/event API 后完成真接线。
> 可并行：contract 冻结后，可先用 typed fixture 实现纯组件。
> 目标：预览关闭时显示真实 OMP conversation；预览开启时用同一视图组件展示 fixture。提供可靠流式合并、工具状态、分页、滚动和发送失败反馈。
> 文件 owner：`apps/renderer/src/App.tsx`、`apps/renderer/src/conversation/**`、`apps/renderer/src/preview/**` 对话 fixture、`apps/renderer/src/styles/workbench.css` 及 Renderer tests/config。其他 Agent 不得同时修改这些文件。

## 1. 开工与备份

`App.tsx`、preview surfaces、workbench.css 当前已有用户改动。执行前必须：

1. `git status --short` 并记录基线。
2. 备份所有将修改的既有文件到规范 backup 目录。
3. 阅读 `apps/renderer/package.json`、PreviewContext、现有 Workbench/InteractionDeck、ver1 reference。
4. 不覆盖未提交改动，不格式化整个 App.tsx/CSS。

## 2. 模块拆分

建议新增：

```text
apps/renderer/src/conversation/
  ConversationPane.tsx
  ConvoTranscript.tsx
  ConversationItemView.tsx
  BatchChain.tsx
  ToolBody.tsx
  useConversation.ts
  useConversationScroll.ts
  conversationViewModel.ts
  conversation.test.tsx
```

原则：

- 数据 hydrate/live merge 主要由计划 04 的 client projector负责；Renderer hook只编排 query/subscription/loading。
- Renderer view model可以把真实连续 tool items分组为 batch，但不能修改权威数据或发明工具结果。
- `App.tsx` 只保留路由/布局和轻量 props wiring，不继续堆对话渲染细节。
- PreviewTranscript是薄封装，调用同一 `ConvoTranscript`。

## 3. useConversation 生命周期

输入至少包括：`client`、当前 bootstrap/snapshot identity、preview flag。

### 真实模式

1. 检测到可用 `runtimeEpoch + sessionId`。
2. 创建新的本地 load generation并清空旧 timeline。
3. 调 `client.query("session.transcript.read", { limit: 50 })`。
4. 只接受 identity 与 generation均匹配的 response。
5. 订阅 conversation events；若 query 与 subscribe存在竞态，采用“先订阅再 query + cursor/event去重”或其他经过测试的无缝方案。
6. 收到 gap/resync：停止宣称完整、重新读取最新页并合并权威 completed items。
7. runtime/session切换、组件卸载时取消 listener并使旧 promise失效。

### 预览模式

- 使用 `PREVIEW_CONVO_EVENTS` 或等价 typed fixture。
- 不调用 transcript query。
- 演示按钮只更新本地 UI。
- 必须显示“演示”标记。

### 无 Runtime/无 capability

显示诚实状态：Runtime未连接、当前 Runtime不支持 `session.history/core.stream`，或加载失败。不得回退 preview fixture。

## 4. 持久消息渲染

### user

- 清晰的用户消息样式。
- 保留换行。
- 文本只作为 React text/安全 Markdown输入，不注入 HTML。

### assistant

- text block支持 Markdown/code fence；若项目没有已审查 Markdown renderer，MVP先纯文本/`white-space: pre-wrap`，不要临时引入高风险 HTML库。
- thinking block按产品规则折叠显示；没有真实 thinking则不显示空壳。
- completed/aborted/error状态有轻量提示，不制造模型内容。

### compaction/reset

- compaction显示真实 summary/warning。
- resetBoundary显示上下文边界。
- 不从时间或 token 数猜 checkpoint。

## 5. 工具与 batch

真实数据先渲染为语义正确的工具行，再做 ver1 外观。

### 分组规则

- 同一 assistant turn内连续的 tool calls可组成一个 batch。
- 遇到 user message、新 assistant正文段或 turn boundary结束 batch。
- 分组只影响显示，不改变 item/tool id。

### 状态

- queued/running/succeeded/failed/aborted（只展示上游能证明的状态）。
- live update更新同一 toolCallId。
- completed结果权威覆盖 partial。

### 工具体

- Read：路径/范围若 contract提供则显示；不猜。
- Bash：命令、stdout/stderr摘要、exit code若真实存在；命令不能由字符串日志反推。
- Ask：真实 prompt/options/selected result；未提供selected时不显示“已选择”。
- Task：真实 goal/constraints/subagent状态；没有字段则省略。
- 其他工具：通用安全 JSON/text viewer。

任何 Host/Runtime数据都不得传给 `dangerouslySetInnerHTML`。

## 6. Streaming 渲染

- `message.started`只创建一个 assistant占位节点。
- delta按 messageId/blockId append；React key稳定。
- 多个小 delta在 state层已合并，Renderer不为每 token创建新 DOM节点。
- message.completed替换 live内容，不额外追加重复气泡。
- tool start/update/end同理。
- completed后迟到 delta不回滚。
- abort后保留部分文本并标明中止。
- resync时可以显示“正在同步”，但不能清空后长期闪烁；hydrate完成原子替换。

## 7. 历史分页

- 顶部显示“加载更早消息”或滚到顶部触发显式加载。
- 调 `olderCursor`，加载期间禁用重复请求。
- prepend后保持当前视口锚点，页面不能突然跳到顶部/底部。
- `hasMoreBefore=false`时停止请求。
- stale cursor触发最新页重新 hydrate并给非侵入提示。

首版不要求无限虚拟化，但至少保证数百条消息不会因每次 delta重渲染整棵树。完整版本可加虚拟化。

## 8. 滚动策略

实现独立 `useConversationScroll` 并测试：

1. 初次打开默认定位最新消息。
2. 用户距离底部在阈值内时，新消息/delta自动跟随。
3. 用户主动上滚超过阈值后停止跟随。
4. 此时显示“有新内容/回到最新”。
5. 点击后滚到底并恢复跟随。
6. prepend历史页保持原可见 item锚点。
7. session切换重置到新会话最新位置。

不在每个 delta直接调用无条件 `scrollIntoView`。

## 9. Composer 与 optimistic user item

### 发送

- 发送前保留 draft副本。
- 可选创建明确 `pending` 的 optimistic user item；必须用 requestId关联。
- `client.command()` 返回 local/accepted不等于完成。
- Runtime completed或真实 transcript item到达后 reconcile pending item，不能出现两条 user消息。

### 失败

- transport立即失败：保留/恢复 draft，显示错误。
- terminal failed/rejected/outcome_unknown：pending item标为失败并提供“恢复到输入框”或重试入口。
- 错误不得被通用 `run()` 空 catch吞掉。
- 发送中防重复点击，但不能永久锁死。

### streaming期间 Enter

必须做明确产品映射，不静默继续发 `core.prompt`：

- 若选择 `core.steer`，UI标识“调整当前回复”。
- 若选择 `core.followUp`/`queue.enqueue`，UI标识“排队下一条”。
- 若本轮只保留现有 Steer按钮，普通 Enter在 streaming时应禁用并给原因。

不要擅自混用三种语义。最小实现可继续保留显式 Steer + Abort，普通 prompt在 streaming时禁用。

## 10. Interaction Deck 边界

计划 05 只负责保证 Deck布局不被对话区改坏；真实 interaction接线由计划 06 完成。

- Deck仍浮在 Composer上方。
- 对话区高度/滚动不因 Deck开合失控。
- 不新增虚假 approval fixture到真实模式。
- 不在本计划把多 pending队列做成假功能。

## 11. 可访问性和安全

- timeline使用语义列表或 `role="log"`，live region避免每 token朗读；只在消息完成时适度通知。
- 工具展开按钮有 `aria-expanded/controls`。
- 错误不仅靠颜色。
- code/tool输出可键盘滚动和复制。
- secret input不写入 timeline。
- 无任意 HTML。

## 12. Renderer 测试基础

Renderer 当前没有 test script。添加最小 Vitest或项目统一的 React测试配置，但不要引入大而无关的测试框架迁移。

必测：

- preview/real严格分流。
- initial hydrate success/empty/error。
- 旧 session query迟到被丢弃。
- start→delta→completed只有一个assistant节点。
- tool start/update/end只有一个工具行。
- older page prepend不重复。
- scroll在底部跟随、上滚后不抢。
- prompt accepted不标完成；terminal失败恢复draft。
- runtime loss显示同步/不可用状态。
- Host文本以文字显示，注入字符串不产生 DOM script/html。

## 13. 目视验收

使用 `npm run preview`：

### 预览开

- 新 batch/tool UI正常。
- 有演示标记。
- 演示交互不写 Host。

### 预览关

- 有真 transcript时显示真数据。
- 无 Runtime时诚实空态。
- 不出现 preview故事、PID、路径、token数字。
- 真实 prompt/assistant/tool/abort/error流程可视。

## 14. 验收命令

```bash
npm run typecheck -w @omp-studio/renderer
npm run build -w @omp-studio/renderer
npm test -w @omp-studio/renderer
npm run preview
```

若新增 test script，更新根 `npm test` 使其真正覆盖 Renderer。

## 15. 完成条件

- [ ] 真实模式读取并显示真 transcript。
- [ ] preview和真实共用视图组件但数据严格隔离。
- [ ] live message/tool不重复。
- [ ] history分页和滚动锚点可靠。
- [ ] accepted/terminal错误语义正确。
- [ ] 无 `dangerouslySetInnerHTML` Host数据路径。
- [ ] Renderer测试进入根门禁。
- [ ] 未修改 Desktop、Host或vendor。
