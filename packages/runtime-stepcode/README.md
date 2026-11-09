# @step-studio/runtime-stepcode

Step Code 的 Studio Bridge 适配器。它接受与 OMP 运行时相同的启动参数，对
`studio-host` 说 Studio Bridge 协议，内部驱动 `step --mode rpc`。

## 当前状态

可运行的最小版本（spike），已用**真实的 `@omp-studio/studio-host` 客户端**验证：

- hello 握手（HMAC challenge proof）
- `runtime.snapshot`（host 进入 ready 状态所需）
- `core.prompt` → 流式 `conversation.message.delta` → 完成 receipt
- `core.abort`、`runtime.shutdown`

真实 Step Code CLI 已接入：适配器启动 `step --mode rpc`，快照里的
sessionId 来自 CLI 的 `get_state`；prompt 在没有 provider 凭据时会把
CLI 的原始错误作为 failed receipt 返回。

已知上游限制：`models.json` 里的自定义 provider 能被 `ModelRuntime.getAvailable()`
读到，但 RPC 的 `get_available_models` / `set_model` 走的是
`getAvailableSnapshot()`，自定义模型不会出现在该快照里，因此
`--mode rpc` 目前无法选中自定义 provider 的模型。绕开方式是用 SDK
in-process（`createStepAgentSession`）或给 Step 上游提 issue。

尚未完成：provider 登录/凭据（本机无账号）、Windows 命名管道实测、
模型/思考/fork/用量等其余命令、Electron 界面。

## 运行

```bash
npm install
npm run build
npm test          # 协议级测试 + 真实 studio-host 客户端集成测试
npm run demo -- "hello from step studio"
```

默认用 `test/fake-step.mjs` 冒充 Step 运行时；接入真实 CLI：

```bash
STEP_STUDIO_RUNTIME_CMD=/path/to/step npm run demo -- "hello"
```

真实 CLI 的 `get_state` 会给出真实 sessionId；没有 provider 凭据时
prompt 会返回 CLI 的 "No API key found" 错误（属于环境限制，不是桥接问题）。

## 结构

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 参数解析、握手、命令分发 |
| `src/bridge.ts` | 帧编解码、HMAC 证明、receipt/event |
| `src/step-rpc.ts` | `step --mode rpc` 的 JSONL 客户端 |
| `src/demo.ts` | 端到端演示 |
| `test/spike.test.ts` | 协议级测试（mock host） |
| `test/host-integration.test.ts` | 真实 studio-host 客户端集成测试 |
