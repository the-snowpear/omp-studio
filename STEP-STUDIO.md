# Step Studio

在 [`the-snowpear/omp-studio`](https://github.com/the-snowpear/omp-studio) 基础上把
运行时从 OMP 换成 **Step Code**（[`stepfun-ai/Step-Code`](https://github.com/stepfun-ai/Step-Code)）
的可视化智能体平台。OMP 的 Studio Bridge 协议、host、客户端、Electron 壳全部复用；
换掉的只有"runtime 进程"这一层。

`README.md` 仍然是 OMP Studio 的说明书——它描述的复用部分依然准确。本文件只写这个
fork 的状态与差异。

## 已可用

**运行时链路已端到端跑通**（真实 Step CLI + 真实模型，不是 mock）：

```
Renderer → @omp-studio/client → transport-desktop → apps/desktop (IPC)
  → @omp-studio/host-client-api → studio-host
  → [STUDIO_RUNTIME_EXECUTABLE] → @step-studio/runtime-stepcode
  → step --mode rpc --include-live-events
```

- Studio Bridge 握手（HMAC challenge proof）、`runtime.snapshot`、`core.prompt`、
  `core.abort`、`runtime.shutdown`
- 流式正文与思考分 block 走 `conversation.message.delta`，全部经
  `parseConversationRuntimeEvent` 校验
- provider 报错时立刻返回 failed receipt 并带上 CLI 原始错误（Step 之后还会自动重试
  很久，不等它）
- 整个 `npm run check` 门禁通过：架构约束、全部包编译（含 renderer）、核心测试

## 跑起来

```bash
git submodule update --init omp-patch/vendor/oh-my-pi   # 首次
npm install
npm run omp:overlay:apply                                # 首次
npm run check                                            # 全量门禁

# 只验证运行时链路（不需要 Electron / 显示器）
cd packages/runtime-stepcode && npm run demo -- "hello"
```

接真实 Step CLI 与自定义 provider 的完整步骤见
[`packages/runtime-stepcode/README.md`](packages/runtime-stepcode/README.md)，
坑点记录在 [`packages/runtime-stepcode/docs/step-rpc-integration.md`](packages/runtime-stepcode/docs/step-rpc-integration.md)。

桌面壳启动适配器：

```bash
STUDIO_RUNTIME_EXECUTABLE=/path/to/step-studio-runtime npm run preview
```

不设该变量时行为与 OMP Studio 完全一致（仍走 managed 安装的 OMP 运行时）。

## 尚未完成

- **Windows 命名管道与打包实测**：适配器只在 Linux 上验过 Unix domain socket；
  `npm run pack:win` 未跑
- **品牌替换**：窗口标题、关于对话框、`%APPDATA%\<name>`、安装器产品名仍是
  `omp-studio`。包名（`@omp-studio/*`）不改——它们是复用的依赖，改名会破坏整个
  依赖图和架构约束
- **其余命令映射**：`session.model`、`session.thinking`、fork、usage、interaction
  在 capability manifest 里已声明，但适配器还没实现
- **Step 没有的能力**：`tui.transfer`、`vibe.mode`、`omfg.commit`、`prewalk`、
  `operator`、`tan` 标为 `unavailable`，Renderer 会隐藏它们
- **Agent Hub / Skills / MCP 的真实数据**：目前这些面板读的是 OMP 侧的 read model，
  接 Step 需要各自的适配器

## 结构差异

| 路径 | 说明 |
|---|---|
| `packages/runtime-stepcode/` | 新增：Step Code 的 Studio Bridge 适配器 |
| `apps/desktop/src/host-composition.ts` | 改：`STUDIO_RUNTIME_EXECUTABLE` 选择 custom runtime 源，并让显式指定的 limited 运行时获得 session controller |
| `package-lock.json` | 改：登记 `@step-studio/runtime-stepcode` workspace 链接 |
| 其余 | 与上游一致 |
