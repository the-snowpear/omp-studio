# 接入 Step Code RPC 的实测记录

这些是踩过坑之后才确认的事实，不是从文档读来的。Step Code 版本：本地 clone
`stepfun-ai/Step-Code`，`stepcode@0.1.0`。

## 1. 产品入口与库默认值读不同的 models.json

这是最难定位的一条：同一个进程里，库直读能读到自定义 provider，CLI 却返回 0 个模型。

- `apps/cli/src/main.ts` 传 `modelsPath: join(resolveStepConfigRoot(), "models.json")`
  和 `authPath: getStepAuthPath()`。
- `resolveStepConfigRoot()`（`packages/coding-agent/src/step/environment.ts`）：
  设了 `STEP_CODING_AGENT_DIR` 时返回它的**父目录**，否则是
  `join(resolveStepHomeDir(), resolveStepConfigDir())`。
- 而 `ModelRuntime.create()` 的库默认值是 `join(getAgentDir(), "models.json")`，
  `getAgentDir()` 才认 `STEP_CODING_AGENT_DIR`。

结论：自定义 provider 的 `models.json` / `auth.json` 要放在 agent 目录的**上一级**。
放错位置没有任何报错，只是模型数为 0——`availabilityError` 是 `undefined`，
所以连 warning 都不会打。

会话文件仍在 `$STEP_CODING_AGENT_DIR/sessions/`，这两条路径的不一致很容易让人
以为 agent 目录整个搬错了地方。

## 2. `--include-live-events` 是流式文本的开关

`--mode rpc` 默认只发生命周期事件（`agent_start` / `message_start` /
`message_end` / `turn_end` / `agent_end` / `agent_settled`）和
`entry_appended`。`entry_appended` **不含** user/assistant 消息条目，所以默认
模式下拿不到任何正文。

`toJsonEvent()`（`modes/json-event.ts`）对 ephemeral 事件
（`message_update` / `tool_execution_update`）默认返回 `undefined`，
只有 `--include-live-events` 才放行。加上之后才有：

```json
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"PONG"}}
```

`assistantMessageEvent.type` 的取值：`thinking_start` / `thinking_delta` /
`thinking_end` / `text_start` / `text_delta` / `text_end`。按前缀分 block，
思考和正文天然分开。

注意 `message_start` / `message_end` 里的 message 对象**没有 id 字段**，
所以适配器自己合成 messageId，并保证 `completed.item.itemId` 与它一致。

## 3. prompt 的 RPC 回包只代表"已受理"

`prompt` 命令的 response 在 preflight 成功时就返回，回合还在跑。真正的结束信号是
`agent_settled`；`turn_end` / `agent_end` 更早，且 `agent_end` 带 `willRetry`。

## 4. provider 出错时 Step 会自动重试很久

provider 返回错误时，assistant 消息带 `stopReason: "error"` 和 `errorMessage`，
随后 `agent_end{willRetry:true}` + `auto_retry_start`，然后重新跑一遍。
一轮 429 从报错到最终放弃实测超过 90 秒。

因此适配器不等 `agent_settled`：看到带错误的 assistant 消息就立刻发 failed
receipt；`auto_retry_start` 清掉错误闭锁，让重试那轮有机会成功。

## 5. stdin EOF 会中断在跑的回合

RPC 模式stdin 关闭时会 abort 在途请求，assistant 消息变成
`stopReason: "aborted"` / `errorMessage: "Request aborted"`。测试和调试时要保持
stdin 打开（例如 `{ printf ...; sleep 60; } | step --mode rpc`），否则会误判成
模型或网络问题。

## 6. `get_available_models` 与 `set_model` 的自定义模型问题

`rpc-mode.ts` 的 `get_available_models` 读 `getAvailableSnapshot()`，
`set_model` 也只认这个快照；快照由 `runAvailabilityRefresh()` 填充，理论上包含
`getAvailable()` 的结果。按第 1 条放对位置后，本地实测两个命令都能返回自定义
模型，因此适配器暂不需要为此打上游补丁。

（此前记录里"自定义模型不可见"的结论，根因就是第 1 条的路径放错，不是上游缺陷。）
