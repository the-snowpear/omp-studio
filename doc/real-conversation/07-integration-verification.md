# 执行计划 07：真实对话全链集成、故障注入与发布门禁

> 依赖：计划 01–06 按目标阶段完成。
> 目标：证明真实对话不是仅在各包单测中成立，而是从 Desktop Composer 到 OMP AgentSession 再回到对话区的完整闭环。
> 文件 owner：跨包 testkit、E2E脚本、必要的测试配置和最终执行报告。原则上不修改产品实现；发现失败应回派对应 owner Agent修复。

## 1. 测试层级

必须同时覆盖：

1. **Contract tests**：strict types、validation、fixtures。
2. **Runtime service tests**：active branch/cursor/live projector。
3. **Host integration tests**：Bridge→controller→Facade→Client。
4. **Renderer component tests**：hydrate/live merge/tool/scroll/error。
5. **Desktop composition tests**：workspace/manifest/publication/reload。
6. **真 Runtime E2E**：实际 OMP session回复进入真实对话区。

仅有 fixture UI截图不算 E2E；仅有 `core.prompt` completed receipt也不算对话区可用。

## 2. 统一测试夹具

在 `packages/testkit` 提供最小、严格且可复用的 conversation fixtures：

- runtime/session identities
- 空 transcript page
- user/assistant text page
- thinking + tool call/result page
- compaction/reset page
- message/tool live event序列
- duplicate/late/gap/epoch-switch序列
- completed/failed/rejected/outcome_unknown receipts
- interaction五类事件

Fixtures必须通过同一 contract validator；不要在各包复制形状相近但字段不同的对象。

## 3. MVP-A 全链测试

测试步骤：

1. Desktop composition从 persisted workspace启动 fake/embedded Runtime。
2. hello返回真实 capability/command manifest。
3. bootstrap得到 snapshot identity。
4. Renderer/Client query `session.transcript.read` 获得初始空页。
5. 发 `core.prompt`。
6. accepted到达，但不标terminal成功。
7. Runtime持久化 user/assistant entries。
8. transcript query返回两条消息。
9. Renderer只显示一条 user和一条assistant。
10. reload后再次hydrate仍为两条，不重复。

该测试通过才可宣称MVP-A完成。

## 4. MVP-B 全链测试

使用确定性 Runtime fixture或真模型替身产生：

```text
message.started
message.delta("正在")
tool.started(Read)
tool.updated(...)
tool.completed(...)
message.delta("完成")
message.completed(authoritative item)
turn.completed
```

断言：

- 单一assistant节点内容为完整文本。
- 单一tool行从running变completed。
- completed item替换live buffer，无重复。
- stateVersion/event cursor单调。
- user在底部时跟随，上滚时不抢。
- reload后从history恢复completed内容。

## 5. 故障注入矩阵

### Transport/Bridge

- delta中断、eventSeq gap。
- duplicate frame。
- frame乱序。
- oversized tool result。
- listener抛异常。
- socket断开后重连。

期望：进入resync，权威 transcript校准；Bridge不因UI映射异常崩溃。

### Runtime/session

- prompt后Runtime crash。
- runtime epoch改变。
- session resume发生在旧query未返回时。
- branch navigate后旧cursor使用。
- abort与message_end竞态。
- compaction期间读取。

期望：不串消息、不假completed、stale响应丢弃。

### Command receipts

- accepted后completed。
- accepted后failed。
- precondition rejected。
-断线 outcome_unknown。

期望：Composer draft/pending状态符合计划05，不吞错。

### Interaction

- GUI owner和TUI owner。
- generation更新。
- duplicate required。
- submit token缺失/过期/replay。
- respond失败后重试。
- reload/rebind清理。

## 6. 安全验证

构造含以下内容的 tool args/results/provider event：

- `apiKey`、`authorization`、cookie、token、password
- 用户home绝对路径
- `providerPayload`
- 超深JSON、循环对象、prototype pollution keys
- HTML/script/svg事件属性
- 巨大stdout和base64

断言：

- secret不出现在Bridge frame、ClientEvent或渲染DOM。
- 路径按既定规则脱敏。
- 非JSON/循环内容安全降级。
- DOM不产生script/事件handler。
- 截断有显式标记。

## 7. 性能与稳定性

最低压测：

- 10k token小delta。
- 100个连续tool updates。
- 1,000条持久conversation items，按50分页。
- 连续reload 20次。
- workspace/session快速切换20次。

观察并设置合理阈值：

- live event经coalescing后的数量有上界。
- 内存不随reload线性增长。
- listener数量回到基线。
- delta合并不产生O(n²)累计传输。
- Renderer交互不中断；具体毫秒阈值根据CI机器记录后冻结。

## 8. 真 Runtime Desktop E2E

准备隔离临时workspace，禁止使用用户当前项目作为写测试目标。

场景：

1. 启动已验证的managed/compatible OMP Runtime。
2. 打开临时workspace。
3. 发送一个不产生破坏的确定性prompt，例如读取测试fixture并回复固定短语。
4. 验证UI出现真实user消息、assistant流和至少一个Read工具结果。
5. Abort另一个长响应。
6. reload窗口，验证已完成消息恢复。
7. 如完成计划06，resume历史并处理一个confirm/select interaction。

需要提供自动化脚本或清晰的人工步骤、日志位置和失败诊断。E2E不得依赖preview mode。

## 9. 门禁命令

先按包运行，便于定位：

```bash
npm test -w @omp-studio/studio-protocol
npm test -w @omp-studio/studio-host
npm test -w @omp-studio/host-client-api
npm test -w @omp-studio/client
npm test -w @omp-studio/transport-desktop
npm test -w @omp-studio/testkit
npm test -w @omp-studio/desktop
npm test -w @omp-studio/renderer
npm run omp:verify:patches
npm run runtime:verify-source
npm run check
```

如果根 `npm test` 缺少 host-client-api或Renderer，更新根script纳入，而不是在报告里只说“手动跑过”。

## 10. 发布验收报告

在 `doc/real-conversation/` 新增带日期报告，至少包括：

- 目标阶段（MVP-A/MVP-B/完整闭环）。
- 基线commit和最终commit。
- 所有修改文件与owner计划。
- 备份目录。
- 每条命令的通过/失败/跳过及原因。
- 真Runtime版本/upstream commit；不记录token/path秘密。
- E2E步骤和结果。
- 已知限制与下一步。
- 明确结论：是否满足总控计划第2节用户验收场景。

## 11. 最终 Definition of Done

- [ ] Contract、Runtime、Host、Client、Renderer、Desktop各层均有测试。
- [ ] 根门禁实际覆盖Renderer和host-client-api。
- [ ] MVP-A/MVP-B全链测试通过。
- [ ] gap/reconnect/reload/session switch不串消息。
- [ ] failed/rejected/outcome_unknown不静默。
- [ ] secret/HTML/oversize测试通过。
- [ ] 真Runtime Desktop E2E通过。
- [ ] Preview关闭无任何mock回填。
- [ ] 报告列出全部已知限制，没有把未完成interaction/session功能描述成已完成。
