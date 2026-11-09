# @step-studio/runtime-stepcode

Step Code 的 Studio Bridge 适配器。它接受与 OMP 运行时相同的启动参数，对
`studio-host` 说 Studio Bridge 协议，内部驱动 `step --mode rpc`。

## 当前状态

已用**真实的 `@omp-studio/studio-host` 客户端** + **真实的 Step Code CLI** +
**真实模型**跑通端到端：

- hello 握手（HMAC challenge proof）
- `runtime.snapshot`（host 进入 ready 状态所需）
- `core.prompt` → 流式 `conversation.message.delta` → 完成 receipt
- 失败回合：provider 报错时立刻返回 failed receipt，带上 CLI 的原始错误
- `core.abort`（附 `conversation.turn.aborted`）、`runtime.shutdown`

对话事件全部经 `parseConversationRuntimeEvent` 校验后发出；`message.completed`
的 `item.itemId` 与 `message.started` 的 `messageId` 一致。思考与正文是不同
block，不会混进答案文本。

### 让真实 CLI 看到自定义 provider

Step 的**产品入口**（`apps/cli`）与**库默认值**读的不是同一个 models.json：
入口用 `resolveStepConfigRoot()`，即 `STEP_CODING_AGENT_DIR` 的**父目录**；
`ModelRuntime.create()` 的库默认值是 agent 目录本身。所以自定义 provider 要放：

```
$STEP_CODING_AGENT_DIR/../models.json     # ← CLI 真正读的位置
$STEP_CODING_AGENT_DIR/../auth.json
$STEP_CODING_AGENT_DIR/agent/             # 会话、技能等仍在这里
```

放错位置时 CLI 静默返回 0 个模型，库直读却能读到——这是定位这个问题时最容易
踩的坑。详见 `docs/step-rpc-integration.md`。

## 运行

```bash
npm install
npm run build
npm test          # 协议级测试 + 真实 studio-host 客户端集成测试
npm run demo -- "hello from step studio"
```

默认用 `test/fake-step.mjs` 冒充 Step 运行时（它复刻真实 RPC 事件形状，不是
另造一套协议）；接入真实 CLI：

```bash
STEP_STUDIO_RUNTIME_CMD=/path/to/step npm run demo -- "hello"
```

### 接真实模型的完整例子

```bash
export HOME=/tmp/step-home
export STEP_CODING_AGENT_DIR=/tmp/step-home/.stepcode/agent
mkdir -p "$STEP_CODING_AGENT_DIR"
cat > "$(dirname "$STEP_CODING_AGENT_DIR")/models.json" <<'JSON'
{
  "providers": {
    "local-gateway": {
      "baseUrl": "http://127.0.0.1:3425/v1",
      "api": "openai-completions",
      "apiKey": "magpie",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "stepfun-cn/step-3.7-flash", "name": "Step 3.7 Flash" }]
    }
  }
}
JSON
echo '{"local-gateway":{"type":"api_key","key":"magpie"}}' \
  > "$(dirname "$STEP_CODING_AGENT_DIR")/auth.json"

STEP_STUDIO_RUNTIME_CMD=/path/to/step npm run demo -- "reply with exactly: PONG"
```

## 已实现的命令

| Studio 操作 | Step RPC | 说明 |
|---|---|---|
| `core.prompt` | `prompt` | `accepted` receipt，回合结束才 `completed` |
| `core.steer` / `core.followUp` | `steer` / `follow_up` | 入队即回 `completed` |
| `core.abort` | `abort` | 附 `conversation.turn.aborted` |
| `runtime.snapshot` | `get_state` | 含 `model`（selector/provider/id）与思考等级 |
| `session.model.set` | `set_model` | `provider/id` 或裸 id（走 catalog 解析） |
| `session.thinking.set` | `set_thinking_level` | `auto` 映射到模型第一个可用等级 |
| `session.fork` | `fork` | 在当前 leaf 上fork |
| `session.transcript.read` | `get_entries` | 单页；异代 cursor 返回 `CURSOR_STALE` |
| `runtime.shutdown` | — | 结束 CLI 进程 |

manifest 只声明**真正实现**的 capability id，grade 如实标注；没声明的一律按
unavailable 处理，Renderer 会隐藏。

## 尚未完成

- Windows 命名管道实测（当前只验证过 Unix domain socket）
- `turn.retry`、`session.drop`、`session.clearContext`、`session.handoff`、
  `mode.plan.*` 等命令映射
- Agent Hub / Skills / MCP / 用量面板的真实数据（Step 侧没有对应 read model）
- Electron 界面与品牌替换（工作区里其余部分仍是 OMP 的壳）
- `tui.transfer`、`vibe.mode`、`omfg.commit`、`prewalk`、`operator`、`tan`
  未声明：Step Code 没有对应能力

## 结构

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 参数解析、握手、命令分发、RPC 事件 → 对话事件映射 |
| `src/bridge.ts` | 帧编解码、HMAC 证明、receipt/event |
| `src/step-rpc.ts` | `step --mode rpc` 的 JSONL 客户端 |
| `src/demo.ts` | 端到端演示 |
| `test/spike.test.ts` | 协议级测试（mock host） |
| `test/host-integration.test.ts` | 真实 studio-host 客户端集成测试 |
| `test/fake-step.mjs` | 复刻真实 RPC 事件形状的假运行时 |
