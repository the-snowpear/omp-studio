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
  `core.steer`/`core.followUp`、`core.abort`、`runtime.shutdown`
- `session.model.set` / `session.thinking.set` / `session.fork` /
  `session.transcript.read`，映射到 Step 的 `set_model`、`set_thinking_level`、
  `fork`、`get_entries`
- 流式正文与思考分 block 走 `conversation.message.delta`，全部经
  `parseConversationRuntimeEvent` 校验
- provider 报错时立刻返回 failed receipt 并带上 CLI 原始错误（Step 之后还会自动重试
  很久，不等它）
- 通过 Host 的**真实探针**（hello + snapshot smoke + shutdown 后干净退出）；
  shutdown 失败会被判 rejected 而不是 limited，所以这条最硬
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
STUDIO_RUNTIME_EXECUTABLE=$PWD/packages/runtime-stepcode/bin/step-studio-runtime npm run preview
```

Host 直接 spawn 这个可执行文件并传 `--mode studio-host ...`，所以它不能是 Node 脚本。

不设该变量时行为与 OMP Studio 完全一致（仍走 managed 安装的 OMP 运行时）。

## 原生 Rust 壳（无 webview）

Electron 的 Chromium 进程占整个应用 280–470 MB。`crates/` 下新增 egui/winit 壳把它们
全部去掉：无 webview、无 Electron，release 二进制 16 MB。

分工是故意的：**协议、平台、壳、适配器全部 Rust**，TypeScript 只剩 Renderer。此前
端到端跑通的 TypeScript 适配器保留为回退，壳优先用 Rust 版本，没构建出来时才落到 Node。

```
crates/studio-bridge/       wire 协议：帧编解码、HMAC 握手、会话客户端
crates/step-studio-runtime/ Studio Bridge 适配器：驱动 step --mode rpc
crates/step-studio-shell/   应用：后台桥接线程 + 纯归约器 + egui 视图
```

```bash
cargo build --release
./target/release/step-studio-shell            # step 自己从 PATH 或 ~/.stepcode/bin 找
./target/release/step-studio-shell --prompt "hello"
```

壳已经是可以直接用的聊天界面，不是协议探针：

| 能力 | 状态 |
|---|---|
| 流式正文 / 思考分块 | 实时逐字，不等到回合结束 |
| markdown | 标题、列表、代码块、行内 `**粗体**` / `` `代码` `` 都有真实样式（egui 没有 markdown 控件） |
| 模型切换 | 顶栏下拉，来自 CLI 的实时 catalog |
| 停止 | 流式中 Send 变 Stop，发 `core.abort` |
| 新会话 | 顶栏 New，调 Step 的 `new_session` |
| 会话续接 | 重启后自动 `--continue`，从 transcript 重建历史 |
|  thinking 档位 | **没有 UI**：当前模型只报 `off` 一个档位，manifest 里已如实标 limited |

`cargo test` 25 个测试，含对真实适配器与真实 CLI 的端到端。

帧编解码与 `@omp-studio/studio-protocol` 逐字节兼容（大端长度前缀、五键帧头、HMAC
challenge proof）。第一版我写成了小端 + 只含 body 的长度 + 两键头——对着 mock 全能过，
是对着真实适配器的端到端测试抓出来的。

实测（release，Linux，**官方安装的真实 `step` 0.1.7**）：

| 进程 | RSS |
|---|---|
| 壳（Rust/egui） | 118.0 MB |
| 适配器（Rust） | 2.8 MB |
| step CLI（真实二进制） | 167.1 MB |
| steppage-mcp（Step 自己拉的） | 84.9 MB |
| **应用合计** | **372.8 MB** |

同一链路换回 TypeScript 适配器是 118 + 64.4 + 167 + 85 = **434 MB**，即 Rust 适配器
省掉 61 MB（14%）。壳在 `target/{release,debug}/step-studio-runtime` 存在时优先用它，
否则回退 Node 适配器。

（另加 Xvfb 67 MB，仅无头测试需要，Windows 上没有。）

性能开销方面 CPU 几乎为零：一次回合 5.7 秒里整个进程树只用 0.2 秒 CPU（单核
3%），瓶颈完全在等模型返回。冷启动到首个快照 3.4 秒，绝大部分是 step 自己启动。

> 数字订正过两次，都记下来以免再犯：
> - 322 MB 是 `pnpm step` 走 tsx 现编 TypeScript 的**开发路径**，tsx + pnpm 的纯开发
>   开销 225 MB。
> - 257 MB 是**源码 clone 构建出 dist** 后跑 `node dist/main.js` 的路径。
> - **160 MB 才是官方安装的真实二进制**——打包成单文件可执行文件（114 MB），
>   比 node + 一堆模块文件省 100 MB。

Electron 那 280–470 MB 是实打实省掉了。剩下的 373 MB 里运行时占 68%，且已经榨到
底：

- **适配器 2.8 MB**：原来是 64 MB 的 Node 进程，只做帧编解码 + JSONL 转发，约 600 行
  逻辑，已用 `crates/step-studio-runtime/` 重写。
- **step CLI 167 MB + MCP 85 MB**：Step Code 自身，要动就得改上游。
- **壳 118 MB**：egui/winit 加 Mesa 软件光栅化（无头 Xvfb 下）。真实 GPU 上更低。

Windows 还需要命名管道传输（`std` 不支持），这台机器无法验证那一半。

### 续接是怎么接上的

Step 按 project 存 session，所以壳传给 agent 的工作目录**必须跨启动稳定**——
最初用的是 per-PID 临时目录，每次启动都是新 project，`--continue` 永远找不到上一个
session。现在用 repo 根目录。

适配器通过 `STEP_STUDIO_SESSION=continue` 选择性开启；桌面 Host spawn 时不带这个变量，
行为不变。

## 尚未完成

- **Windows 命名管道与打包实测**：适配器只在 Linux 上验过 Unix domain socket；
  `npm run pack:win` 未跑
- **品牌替换**：窗口标题、关于对话框、`%APPDATA%\<name>`、安装器产品名仍是
  `omp-studio`。包名（`@omp-studio/*`）不改——它们是复用的依赖，改名会破坏整个
  依赖图和架构约束
- **其余命令映射**：`turn.retry`、`session.drop`、`session.clearContext`、
  `session.handoff`、`mode.plan.*` 未实现
- **Agent Hub / Skills / MCP / 用量面板**：需要各自的 Step 适配器
- **Step 没有的能力**：`tui.transfer`、`vibe.mode`、`omfg.commit`、`prewalk`、
  `operator`、`tan` 标为 `unavailable`，Renderer 会隐藏它们
- **Agent Hub / Skills / MCP 的真实数据**：目前这些面板读的是 OMP 侧的 read model，
  接 Step 需要各自的适配器

## 结构差异

| 路径 | 说明 |
|---|---|
| `packages/runtime-stepcode/` | 新增：Step Code 的 Studio Bridge 适配器（TypeScript，现为回退路径） |
| `crates/step-studio-runtime/` | 新增：同一适配器的 Rust 实现，壳优先使用 |
| `crates/step-studio-shell/src/markdown.rs` | 新增：markdown 行分类，与渲染分开以便无窗口测试 |
| `apps/desktop/src/host-composition.ts` | 改：`STUDIO_RUNTIME_EXECUTABLE` 选择 custom runtime 源，并让显式指定的 limited 运行时获得 session controller |
| `package-lock.json` | 改：登记 `@step-studio/runtime-stepcode` workspace 链接 |
| 其余 | 与上游一致 |
