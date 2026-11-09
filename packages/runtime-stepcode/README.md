# @step-studio/runtime-stepcode

Step Code 的 Studio Bridge 适配器。它接受与 OMP 运行时相同的启动参数，对
`studio-host` 说 Studio Bridge 协议，内部驱动 `step --mode rpc`。

## 当前状态

可运行的最小版本（spike），已用**真实的 `@omp-studio/studio-host` 客户端**验证：

- hello 握手（HMAC challenge proof）
- `runtime.snapshot`（host 进入 ready 状态所需）
- `core.prompt` → 流式 `conversation.message.delta` → 完成 receipt
- `core.abort`、`runtime.shutdown`

尚未接入：真实 `step` CLI（需要安装与账号）、Windows 命名管道实测、
模型/思考/fork/用量等其余命令、Electron 界面。

## 运行

```bash
npm install
npm run build
npm test          # 协议级测试 + 真实 studio-host 客户端集成测试
npm run demo -- "hello from step studio"
```

demo 会用 `test/fake-step.mjs` 冒充 Step 运行时；设置
`STEP_STUDIO_RUNTIME_CMD="step"` 可换成真实 CLI。

## 结构

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 参数解析、握手、命令分发 |
| `src/bridge.ts` | 帧编解码、HMAC 证明、receipt/event |
| `src/step-rpc.ts` | `step --mode rpc` 的 JSONL 客户端 |
| `src/demo.ts` | 端到端演示 |
| `test/spike.test.ts` | 协议级测试（mock host） |
| `test/host-integration.test.ts` | 真实 studio-host 客户端集成测试 |
