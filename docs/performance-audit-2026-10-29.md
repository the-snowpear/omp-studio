# OMP Studio 性能审查报告（2026-10-29）

面向：项目负责人
范围：Electron 桌面壳（`apps/desktop`）、渲染层（`apps/renderer`）、Host/IPC/传输层（`packages/*`）、Runtime overlay 的**启动、运行、GPU/合成、空闲功耗、低配适配**。
不在范围：流式管线的正确性与预算（见 [performance.md](performance.md) 与 [performance-report-2026-09-24.md](performance-report-2026-09-24.md)），本文只抽查其是否被绕过。

## 0. 方法与证据等级

| 等级 | 含义 | 本文用法 |
|---|---|---|
| **实测** | 本次命令直接产出的数字（构建产物字节、源码计数、`sha256` 计时、本机 Host 日志时间戳） | 用于基线与机制判定 |
| **实测（运行）** | 真实 Electron 构建启动后的进程级采样（启动阶段、分进程 CPU/RSS、CDP 4x 降速交互） | 见 §2，原始数据在 `outputs/perf-audit/bench/` |
| **推断** | 由代码结构与 Chromium/Electron 已知行为推出，未直接计时 | 用于低配放大与收益估算，均标注 |
| **对照** | 主流开源/商业应用的公开做法 | 只用于说明差距，不当作本项目基线 |

四个静态专项报告（只读、未 build、未启动应用）与一个实测报告：

| 报告 | 行数 | 覆盖 |
|---|---:|---|
| `outputs/perf-audit/startup.md` | 349 | 启动链路、首屏模块图、启动期阻塞工作 |
| `outputs/perf-audit/runtime-render.md` | 350 | 流式之外的状态/渲染/列表/输入/内存 |
| `outputs/perf-audit/gpu-idle.md` | 274 | GPU/合成层、空闲、后台、降级能力 |
| `outputs/perf-audit/host-ipc.md` | 314 | IPC 结构、每事件成本、轮询、watcher、大对象 |
| `outputs/perf-audit/bench/REPORT.md` | 256 | 真实构建实测（见 §2） |

`outputs/` 已被 `.gitignore` 忽略，报告本体不含用户路径、token、PID。本文不修改任何产品代码，也不改既有脚本；实测探针是**新增**的 `scripts/perf-audit/`（可复现用，不进 `check` 门禁、不进发布流程，可按需保留或删除）。

## 1. 结论摘要

### 1.1 一句话结论

**流式渲染这条最难的路径已经做得不错，真正的性能短板在「流式之外」：启动时后端把窗口挡住了、首屏多背了 3.2 MB 用不到的图表引擎、日常交互缺少 memo/懒加载/虚拟化/防抖这四件基础功、以及完全没有低配机降级策略。**

### 1.2 Top 10（按「用户可感知收益 ÷ 实施成本」排序）

| # | 问题 | 证据 | 影响 | 估算收益 | 成本/风险 |
|---|---|---|---|---|---|
| 1 | **mermaid 3.25 MB 被首屏 `modulepreload`**：Vite 的 `__vitePreload` helper 未被 `manualChunks` 显式归属，Rollup 把它并进了 mermaid chunk，entry 因此静态依赖整个 chunk | `apps/renderer/dist/index.html` 预加载 6 个 chunk；`dist/assets/index-*.js` 首行 `import{_ as ..}from"./mermaid-*.js"`，mermaid chunk 末尾 `export{Kt as _,..}`，`Kt` 就是 preload helper | 首屏需解析的 JS 6.76 MiB 里 46% 是绝大多数会话永远用不到的图表引擎；HDD/低配机上是纯等待 | 首屏 JS **−3.1 MiB（−47%）** | 一行 `manualChunks` 改动，低 |
| 2 | **窗口在 Host + Runtime 完全就绪后才创建**：`hostFactory.create()`（含 Runtime 探针 + 会话启动 + 4 次全文件哈希 + `whoami`/`icacls` 子进程）跑完才 `createWindow()` | `apps/desktop/src/composition.ts:184→192`；启动链路见 §3.1；实测 dev-unpackaged 形态窗口 771 ms 可见、可交互 1.4 s，真实安装态 Host 段另有 1.9–4.0 s | 点图标后先「什么都没发生」，再一次性出窗；这段是纯串行 | 冷启动关键路径 **−40%~65%** | 中：引入 lazy facade + `host-ready`，中 |
| 3 | **每次启动现场跑一遍完整 Runtime 探针，并把 173.8 MB 的 `omp.exe` 完整 SHA-256 至少 4 次** | `packages/studio-host/src/runtime-resolver.ts:319/350/359`；`packages/runtime-installer/src/installer.ts:363`；`apps/desktop/src/update-coordinator.ts:107`；实测 `omp.exe` 165.8 MiB，本机 sha256 中位 **90 ms**（快盘快 CPU） | 探针起停 0.65–1.95 s + 哈希 0.36 s（本机）；HDD/Defender 机器上哈希放大 3–10× | **−1~3 s**（低配更明显） | 中高：需安全评审，缓存签名证据 |
| 4 | **首屏 7 个 query 查两遍**：`bootstrap` 后 6 个 `allSettled`，紧接着 `resyncRuntimeModel` 又查 7 个（含 `history.list` 目录扫描） | `apps/renderer/src/App.tsx:9169-9176` 与 `:9209-9218` + `:498-518` | 首屏「数据齐」多付一次最慢 query 的 RTT | 少 7 次往返 | 低 |
| 5 | **一次击键触发 3–4 棵巨型子树重渲 + 1 次 IPC**：`setComposerDraftsBySession` 落在 AppShell（33 个 `useState`），Sidebar/Topbar/WorkbenchCanvas 均无 `memo`；`draft` 变化还会调用 `conversationViewLeases.block()` → 跨进程 IPC | `composer/ChipComposer.tsx:500/176-211`、`App.tsx:5958/6531`、`App.tsx:4397-4402`、`conversation/conversationViews.ts:20-37` | 中文/长文输入延迟；4x 降速下单键 30–80 ms，直接破帧 | 击键主线程 **−60~80%** | 中小，草稿语义要重设计 |
| 6 | **零懒加载**：全库仅 1 处 `React.lazy`；`App.tsx` 静态 import 129 个本地模块，包含全部页面；xterm(326 KiB)/codemirror(387 KiB) 被静态链拖进启动图 | `App.tsx:85-89,141-142,151`；`TerminalPane.tsx:14-16`；`ModelConfigPage.tsx:52`；`SubagentsPanel.tsx:21` | 首屏 parse/compile 多付 713 KiB 用不到的 vendor + 页面代码 | 首屏 JS **−0.7 MB**（xterm/codemirror）**+ entry −0.4~0.6 MB** | 小-中，注意模块级 intent setter |
| 7 | **终端 PTY 逐 chunk 发 IPC，零合批、零流控** | `apps/desktop/src/terminal-pty.ts:330` → `terminal-ipc.ts:52` → `terminalSessions.tsx:82` | `npm run dev` / 构建日志刷屏时每秒数百条 IPC + 渲染层长任务 | 合批 16 ms 可把消息数降 **5–20×** | 小-中，半天量级 |
| 8 | **无 GPU 能力探测、无降级开关、无「减少动效」设置** | 全库 `appendSwitch`/`disable-gpu`/`getGPUFeatureStatus`/`getGPUInfo` **0 命中** | 核显/VM/RDP 回退 SwiftShader 后，`backdrop-filter` 与 `filter: blur` 全部变 CPU 软件合成，用户只看到「卡」 | 软件合成路径渲染占用 **−40~70%** | 中：1 个 IPC + `data-gpu` + ~10 条 CSS |
| 9 | **空闲不静止**：6 条非合成无限动画（`ce-sheen` 动 `background-position` 且出现在空对话首屏、`omp-text-breath` 动 `text-shadow`）+ 3 处无 `document.hidden` 守卫的轮询 | `styles/workbench.css:6572/4013/4065`、`base.css:257`、`jobs.css:53`；`HomePage.tsx:496`、`conversation/ConversationEmpty.tsx:83`、`AgentHub.tsx:1395`；实测可见空闲 GPU 1.26% + renderer 1.05%，最小化后 0.05% | 挂机 CPU 地板 ~2.3%，笔记本续航与风扇 | 空闲 CPU **→ <0.5%** | 低 |
| 10 | **112k 行只有 12 处 `memo`、1 个虚拟列表**；8 个列表全量 `map`（诊断日志、Skills、AgentHub jobs、历史 200 条、文件树等） | `runtime-render.md §2.5`；`@tanstack/react-virtual` 唯一消费者 `ConversationVirtualList.tsx` | 装 300+ Skill / 上千条日志时开页 200–600 ms 阻塞 | Top-4 列表开页 **−150~400 ms** | 中 |

> **2026-10-29 晚更新**：本表 #1（mermaid 预加载）与 #2（窗口等待 Host）已由分支 `8ab613d` 修复并合并进 `0.2.0`（合并提交 `f65cf1d`）；#4 部分修复；#3、#5–#10 仍开放。复核与合并后实测见 §12。

### 1.3 值得明确保留、不要「顺手优化」的部分

这些是当前架构里已经做对的决策，改它们会引入正确性回退：

- **流式管线**：增量 replay、冻结块、高亮 Worker（生产默认）、Mermaid 预算与串行队列、有界 Store（2,000 行 / 24 MiB）、挂载行上限 120、后台 250 ms 合并、publish 帧率档位（`conversationStore.ts:541`）。真实 Chromium 门禁（2026-09-24）短历史 script p95 ≈1.4 ms、长历史 ≈14.9 ms（长历史已接近 16.7 ms 帧预算，属既有基线而非本次回归，未重复测量）。
- **可见性/租约**：Renderer pane 租约 + Main 窗口可见性双信号；`docs/performance.md` 的预算表与回滚开关是有价值的资产。
- **采集/麦克风/浏览器观察**：全部要求 `isVisible && !isMinimized`，窗口隐藏即 dispose（`main.ts:596/682-685`）。
- **three.js 图形页**：`React.lazy` + 滚入视口才加载 + `powerPreference:"low-power"` + draw-on-demand + 卸载 `forceContextLoss()`（`GraphicScene.tsx:132-174`）。
- **git 监听**：`.git` 定点 watch + 400 ms 去抖，不是工作区递归；`node_modules` 无压力。
- **大对象处理**：媒体上传 256 KiB 分块 + busy 背压、artifact 流式、诊断采样只读计数不持正文。
- **Electron 层**：`backgroundThrottling` 未关、`powerSaveBlocker` 仅 macOS 且仅 busy 时持有、preload 80 KB 只做装配、asar 已启用。
- **IPC 校验**：delta 只做一次深校验，后两次是 WeakSet 身份复用（fast-path 已落地）；全库 0 处 `sendSync`/`execSync`。

## 2. 实测基线

> 原 `doc/streaming-cpu-performance-audit.md`（2026-09-01）列的四个瓶颈里，**帧率无上限**与**逐 token 深校验**两条已经落地；**尾部 Markdown 全量重编译**保留（预算内），**Minimap 读写交替**已按文档改造。因此本节的基线只补「流式之外」。

### 2.1 实测环境

Windows 11 26300 / Intel i9-13900HX（32 逻辑核）/ 31.7 GiB / RTX 4080 Laptop + Intel UHD / Electron 43.4.0 / Playwright 1.62.1 / commit `9a371d7`。
构建形态：**dev-unpackaged**（`app.isPackaged=false`，渲染层 `dist` 于本轮重建）。测量窗口内机器基线忙 **9.2–10.7%**（其它应用与审计进程），因此下方 CPU 绝对值应视为**上界**，不是产品独占开销。

> **形态警告（重要）**：该形态**不含**打包态才执行的 `updateCoordinator.initialize()`、**不含**已安装 Runtime 的探针与 `currentManifest()` 全文件校验。也就是说，下面的启动数字是**真实用户冷启动的下界**。本机 Host 日志（同一台机器、真实安装态）里 Host 段本身就有 1.9–4.0 s（§3.1），两者要分开看。
>
> **打包形态一次性观察**（硬链接组装的 `OMP Studio.exe`，非稳态）：首次启动到 `runtime.resolve` 已花 **17.2 s**，首个 renderer 采样在 **17.45 s**；其中 `runtime.self_check smoke-test: ok` +7.84 s、`runtime.seed` +7.86 s。该样本含**首次 Runtime 播种 + 更新包下载**（隔离目录膨胀到 623 MB），不能当稳态数字，但它证明「建窗之前」还压着自检、播种、探针与更新协调器。稳态值需要在「已装好 Runtime、更新已收敛」的机器上复测。

### 2.2 启动（3 次中位数）

| 阶段 | 冷启动 | 热启动 | 口径 |
|---|---:|---:|---|
| spawn → processCreated | 103 ms | 98 ms | 原生 spawn（不含 Playwright） |
| processCreated → appReady | 461 ms | 452 ms | Main hook |
| appReady → windowCreated | 93 ms | 92 ms | Main hook |
| windowCreated → readyToShow | 222 ms | 217 ms | Main hook |
| **processCreated → readyToShow** | **771 ms** | **764 ms** | 窗口可见 |
| **spawn → readyToShow** | **872 ms** | **862 ms** | 端到端「看到窗口」 |
| processCreated → didFinishLoad | 755 ms | 749 ms | — |
| processCreated → rendererNavStart | 661 ms | 664 ms | Playwright 通道 |
| navStart → FCP | 360 ms | 352 ms | Navigation Timing |
| navStart → LCP | 756 ms | 740 ms | PerformanceObserver |
| navStart → load | 285 ms | 276 ms | Navigation Timing |
| load → interactive（3 个静默帧） | 487 ms | 469 ms | rAF 采样 |
| **spawn → interactive** | **1485 ms** | **1435 ms** | 端到端 |

两个值得注意的结论：

1. **冷热启动几乎无差异（−3%）**：`file://` 形态下没有可利用的持久缓存收益。这直接影响 §3.7 里「换 `app://` 协议」的优先级——先证明有收益再做。
2. **窗口 771 ms 就可见，但可交互要到 1.4 s**：中间是 6.76 MiB JS 的解析执行 + 首屏 16 次 IPC。S3（去掉 mermaid）与 S4（去重复 query）正好砍这一段。

> 口径说明：`processCreated → readyToShow` 来自原生 spawn 通道，`rendererNavStart → FCP` 来自 Playwright 通道；两者不是同一次运行，只能同通道横向比较（冷 vs 热、改前 vs 改后），不能把 `readyToShow` 与 `FCP` 相减当因果。

### 2.3 空闲 60 秒（每秒 `app.getAppMetrics()`，60 个样本）

| 状态 | Browser | GPU | Tab(renderer) | Utility | 合计 CPU | 合计 RSS |
|---|---:|---:|---:|---:|---:|---:|
| 可见、无操作 | 0% / 174 MB | **1.26%** / 409 MB | **1.05%** / 282 MB | 0% / 48 MB | **2.31%**（均值 2.40%） | **≈914 MB**（均值 919 MB） |
| 「失焦」可见（未成功失焦，仍 focused） | 0% / 175 MB | 1.25% / 409 MB | 1.04% / 270 MB | 0% / 48 MB | 2.29% | ≈902 MB |
| 最小化 | 0% / 176 MB | **0.04%** / 408 MB | 0.01% / 182 MB | 0% / 48 MB | **0.05%**（均值 0.07%） | ≈814 MB |

- **可见空闲 2.3–2.4% CPU，最小化后 0.05–0.07%**：Chromium 的后台节流确实在生效，问题集中在「窗口开着但没人动」这一态——与 §5.3 的无限动画一致。最小化后 renderer 工作集从 281 MB 被 trim 到 190 MB。
- `idleWakeupsPerSecond` 在 Windows 上**恒为 0**（字段不可用），不能拿来判断唤醒次数；「空闲不是被定时器唤醒」这个结论只能从 CSS 动画的合成帧机理推断，不能再拿该字段当证据。
- **空闲工作集 ≈0.9 GB**：对 8 GB 机器是显著基线。GPU 进程 409 MB 需要确认是否为「4 个显示适配器（含 2 个虚拟显示器）+ RTX 4080」环境特例，不能直接外推到普通核显机；同理 1.26% 的 GPU CPU 也可能被虚拟显示器抬高。
- **合成路径未定性**：`getGPUFeatureStatus()` 说 enabled，但 `getGPUInfo()` 显示 `gl=none,angle=none`、所有设备 `active=false`（见 §2.5）。因此 1.26% 的 GPU CPU 既可能是「硬件合成下的常驻动画」，也可能是「受限路径下的软件合成」，两种解释对应不同的修复优先级，**必须先定性**。

### 2.4 4x CPU 降速（CDP `Emulation.setCPUThrottlingRate`）

| 场景 | 墙钟 | Script | Layout | 长任务 | 掉帧率 | 最差帧 |
|---|---:|---:|---:|---:|---:|---:|
| 页面切换 / 打开技能抽屉 | 4,375 ms | 258 ms | 146 ms | 10 | 2.3% | **554 ms** |
| composer 输入 200 字符 | 4,822 ms | **1,869 ms（9.3 ms/字符）** | 296 ms | 0 | 0% | 50 ms |
| 滚动 | 1,416 ms | 24 ms | 127 ms | 0 | 0% | 20.8 ms |
| 面板开合 | 1,375 ms | 39 ms | 122 ms | 0 | 0% | 33.3 ms |

- 输入路径在 4x 降速下每字符 **9.3 ms 脚本时间**，已吃掉半帧预算；这与 §4.1 的「一次击键 3–4 棵树重渲」互为证据。1x 下约 2.3 ms/字符，正常机器上「能用但会有粘滞感」。
- 页面切换场景有 **10 个长任务（最长 495 ms）+ 最差帧 554 ms + 2.3% 掉帧**，与 §4.4「切换会整体卸载工作台」、§4.2「Agent Hub 未拆分未虚拟化」的机理一致。
- 口径限制：该场景的导航元素发现不完整（首页/设置/模型配置/会话未命中，实际只点到 Agent Hub 与技能抽屉），因此它更像「点菜单/开抽屉」，不是真正的页面往返；真实页面往返成本仍需按 §10 的 `interaction-perf-gate` 复测。

### 2.5 GPU 状态：feature status 与 GPUInfo 互相矛盾

`app.getGPUFeatureStatus()`：`gpu_compositing=enabled`、`2d_canvas=enabled`、`rasterization=enabled`、`multiple_raster_threads=enabled_on`、`video_decode=enabled`、`webgl=enabled`、`webgpu=enabled`；`direct_rendering_display_compositor=disabled_off_ok`、`skia_graphite=disabled_off`。

但 `app.getGPUInfo('basic')` 给出相反的证据：`glImplementationParts=(gl=none,angle=none)`、`skiaBackendType=None`、`inProcessGpu=true`、`sandboxed=false`、`directComposition=false`，且 `gpuDevice[]` 里**所有适配器 `active=false`**（RTX 4080 Laptop / Intel UHD ×3 / Microsoft Basic Render Driver）。

判断：本会话**不能断言是硬件合成**。结合本机存在 GameViewer / MuMu 两个虚拟显示适配器，GPU 进程 408 MB RSS、空闲 1.26% CPU 更像是走到了受限/软件路径。这条矛盾本身就是 G1 最有力的论据——**连 13900HX + RTX 4080 的机器都可能在没有 active GL 设备的情况下跑，而产品对此一无所知**。要定性，需要在本地交互桌面（非远程/虚拟显示）重跑同一探针，并对照 `chrome://gpu` 的 `GL_RENDERER` 与 feature status。

## 3. 启动性能

### 3.1 时序：窗口排在整条后端引导之后

```
Electron main 加载
├─ module 顶层：protocol.registerSchemesAsPrivileged            main.ts:126
├─ module 顶层：createRequire()("node-pty/package.json") 同步读盘 main.ts:130
├─ await app.whenReady()                                       main.ts:206
├─ await loadInstallerTrustedKeys(4 个候选目录)                 main.ts:222
├─ nativeImage.createFromPath(icon.ico)（同步读+解码）           main.ts:228-232
├─ await application.start()                                   main.ts:1016
│   ├─ requestSingleInstanceLock()（重启场景最坏 10×200ms）      composition.ts:164-175
│   ├─ await hostFactory.create()                              composition.ts:184
│   │   ├─ await beforeCreate() → updateCoordinator.initialize()
│   │   │     └─ currentManifest() → 校验 173.8MB 入口文件        update-coordinator.ts:107
│   │   ├─ authorityLock.acquire()                             host-composition.ts:1293
│   │   ├─ privateEndpoint.createCurrentUserOnly()
│   │   │     └─ whoami.exe + icacls.exe 子进程                  host-factory.ts:387-423
│   │   ├─ backend.resolve() → 探针 Runtime #1
│   │   │     ├─ sha256(omp.exe) 173.8MB                        runtime-resolver.ts:319
│   │   │     ├─ spawn → hello → snapshot → manifest → shutdown  runtime-resolver.ts:350/768-808
│   │   │     └─ sha256(omp.exe) 再来一次                        runtime-resolver.ts:359
│   │   └─ runtimeSession.start() → Runtime #2
│   │         └─ currentManifest() → 再次校验 173.8MB 入口文件    runtime-session.ts:1323
│   └─ await createWindow()                                    composition.ts:192
│       ├─ await resolveAppResourceLayout()（热更新负载激活时哈希整个 payload）
│       ├─ createSecureWindow({show:false}) + ready-to-show      security.ts:297-316
│       ├─ ≈30 个 register*Ipc（同步）
│       └─ loadRendererTarget() → 导航开始                       main.ts:861
└─ createTray()（窗口之后，不阻塞）
```

**可并行但当前串行的点**：① 窗口创建与 Host/Runtime 引导（最大）；② 渲染层资源加载与 Host 引导；③ `whoami`/`icacls` 与锁/注册表读盘；④ exe 哈希（resolve 内 2 次 + 两次 `currentManifest()` 校验）与探针启动。

**本机 Host 日志实测**（`%APPDATA%\omp-studio\logs\host-2026-10-2*.log`，13900HX + NVMe，属「快机」样本）：

| 区段 | 5 次采样 | 含义 |
|---|---|---|
| `runtime.resolve` → `runtime.launch.begin` | **1.19 / 1.27 / 2.08 / 2.34 / 2.63 s** | 探针之后到会话启动之间（含 `currentManifest()` 全文件校验、workspace 检查、HostBackend 初始化） |
| `runtime.launch.begin` → `runtime.handshake.ok` | **0.65 / 0.80 / 1.32 / 1.50 / 1.95 s** | Runtime 进程启动 + Bridge 握手 |
| `runtime.resolve` → `runtime.launch.ready` | **1.85 / 2.92 / 3.20 / 3.85 / 3.95 s** | 仅 Host 引导段，尚未计窗口创建与渲染层 |

这组数字与静态链一致：**窗口出现前至少有 1.9–4.0 s 花在 Host 引导上**（还不含 `runtime.resolve` 日志之前的那次完整 Runtime 探针），其中相当一部分是「验一遍已经验过的东西」。

### 3.2 S1【P0】窗口先建、Host 后接

`composition.ts:183-196` 先 `await hostFactory.create()` 再 `createWindow()`，而 `createWindow` 只需要 `host?.transport ?? null`——fail-closed 分支已经允许 transport 为 `null`（`types.ts:74-78`），说明「无 Host 也能开窗」是既有契约。缺的只是「Host 就绪后换入真 facade」的中间层。

修法：
1. `start()` 里先 `createWindow({ transport: lazyTransport })`，再 `void hostFactory.create()`；
2. `lazyTransport` 在 Host 未就绪时**挂起**请求（而不是拒绝），就绪后换入 `host.transport` 并 `webContents.send("host-ready")`；
3. `isBusy()`/`updateRestartBlocker()` 已是 `?.` 安全访问，`payloadHealth.noteBootSuccess` 挪到 Host 就绪后。

收益：关键路径从 `Host + 渲染` 变成 `max(Host, 渲染)`；本机日志下相当于砍掉 1.9–4.0 s 中的大部分（渲染层首帧只需 ~0.3–0.8 s，见 §2）。

风险：中。必须确认 `bootstrap()` 在 Host 未就绪时不会把界面锁死在错误态（`App.tsx:9188-9192` 的 catch 分支），并用「挂起」而非「拒绝」避免错误提示闪现。

### 3.3 S2【P0】启动期重复验证：探针 + 4 次全文件哈希

- 探针：`resolveRuntime` 每次启动都会 spawn 一个完整 Runtime、等 hello、请求 snapshot 与 commandManifest、再 `shutdown()` 等退出（grace 10 s），且**不缓存结论**（`runtime-resolver.ts:296-380`、`:642-837`）。
- 哈希：`fingerprintExecutable` 是**整文件流式 sha256**（`:231-235`）；启动路径上至少 4 次：探针前后各 1 次、`runtimeSession.launch` 的 `currentManifest()` 1 次、`updateCoordinator.initialize()` 1 次。实测 `omp.exe` 165.8 MiB，本机 sha256 中位 90 ms（`node:crypto`，NVMe）→ 本机 ~0.36 s，但这是**快机快盘**；HDD + Defender 实时扫描下 4×173 MB 的顺序读可达 2–5 s。

修法（VS Code `product.json`/`--status` 思路：信任安装时证据，而不是每次启动重验）：
1. `activate()` 成功时把探针证据（hello 关键字段 + commandManifest 哈希 + exe sha256 + platform/arch + runtimeVersion）写成签名文件；
2. 启动时只要「签名证据有效 + exe 摘要与签名 manifest 一致」就直接 `managed`，跳过 probe；
3. 两次 `fingerprintExecutable` 合成一次；`currentManifest()` 的入口文件校验用缓存摘要代替重新哈希；
4. 证据不匹配/过期才跑现场探针。

收益：**−1~3 s**（本机），低配更明显。风险：中高，直接削弱「Runtime 被换掉」的防线，需要安全负责人签字；建议保留 exe 摘要与签名 manifest 比对作为硬约束。

**打包形态的一次性证据**（`outputs/perf-audit/bench/raw/startup-packaged-smoke.json`）：首次启动到 `runtime.resolve` **+17.2 s**，首个 renderer 采样 **+17.45 s**；其中 `runtime.self_check smoke-test: ok` **+7.84 s**、`runtime.seed` **+7.86 s**，之后才是 `runtime.resolve` 与 Runtime 会话。该样本含首次 Runtime 播种与两个更新包下载（隔离目录 623 MB），**不能当稳态数字**；但它说明「建窗前」除了探针与哈希，还压着首启自检与播种。稳态值必须在「已装好 Runtime、更新已收敛」的机器上复测。

### 3.4 S3【P0】mermaid 误入首屏（一行改动，−3.1 MB）

根因已用产物验证：entry 需要 Vite 的 `__vitePreload` helper；`manualChunks` 对 helper 的 id 返回 `undefined`，Rollup 按主导 importer 把它并进了 mermaid chunk：

```js
// dist/assets/index-*.js 首行
import{_ as zg}from"./mermaid-rh6nfw38.js";
// dist/assets/mermaid-rh6nfw38.js 末尾
export{Kt as _,But as m};      // Kt = function(e,r,n){...modulepreload...}
```

产品里 mermaid 只有动态引用（`conversation/LazyMermaid.tsx:9`、`conversation/markdown.tsx:43`），所以这是纯构建配置事故。

修法（`apps/renderer/vite.config.ts:56` 的 `manualChunks`，在 `if (!id.includes("node_modules")) return;` 之前）：

```ts
if (id.includes("preload-helper")) return "vendor";   // 或 return undefined 让它进 entry
```

验收：`dist/index.html` 的 `modulepreload` 集合只剩 react/vendor/codemirror/xterm + entry（codemirror/xterm 随后由 S5 移出）。建议同时加一条只读 dist 的门禁（见 §9）。

### 3.5 S4【P0】首屏重复的 7 个 query

`resyncRuntimeModel` 的语义是「runtime epoch 变了，重建 client 模型」，但 `useEffect` 依赖里含 `state.loading`，首次 ready 会额外触发一次，把刚查过的 capabilities/commands/projects/history/environment/diagnostics/home 全查一遍。`history.list` 会扫会话目录，是这里最贵的一项。

修法：`lastResyncedEpoch` ref 守卫，只在 `runtimeEpoch` 真正变化时 resync；`projects.list` 同理去重。收益：少 7 次往返，首屏「数据齐」少一次最慢 RTT。

### 3.6 S5【P1】渲染层首屏闸门与无懒加载

- `workspaces/ExecutionTargets.tsx:46/152/160`：`ready = !api`，desktop 下恒为 false，必须先 `await api.list()` 才挂载 App，期间显示「正在恢复工作位置…」。本地用户从未配 SSH 也走这条。修法：无存档/无激活远端时同步判定 ready。
- `App.tsx` 静态 import 全部页面（129 个本地模块）；`AgentHubPage`(3353 行)/`ModelConfigPage`(4478)/`CapabilitiesPage`/`DiagnosticsPage`/`SettingsPage`/`TerminalPane` 全在 entry。修法：页面级 `React.lazy` + `Suspense`，把 `setCapIntent` 这类模块级 intent setter 抽到小模块；`TerminalPane` 首次打开底部终端 tab 时才 `import()`。
- `i18n` 同时静态加载 zh + en（合计 280,114 B 源码），实际只用一种；`preview` fixtures 25 个文件 / 203,890 B 静态进主 chunk，预览关闭时纯属死重。修法：按语言 `import()`；fixture 改成按需 `await import()`。

### 3.7 S6【P2】启动期杂项

| 项 | 位置 | 建议 |
|---|---|---|
| 启动期长驻定时器 6 个（host 采样 60 s、renderer 采样 60 s、MediaUpload 10 s、update 15 s/4 h、App Nap guard） | `desktop-performance.ts:46`、`rendererPerformance.ts:11`、`media-upload.ts:34`、`update-coordinator.ts:562`、`app-nap.ts:25` | 统一 `desktopDefer(fn)`：`did-finish-load` 之后 + `setTimeout 0`；全仓 0 处 `requestIdleCallback` |
| 同步 fs/解码 | `main.ts:130`（node-pty version）、`main.ts:228-232`（icon 同步读解码）、`app-icon.ts` 多次 `existsSync` | 惰性读；icon 交给 Electron 异步加载 |
| 单实例锁重试 | `composition.ts:164-175` 最坏 2 s | 改 `second-instance` 事件 + 短退避，重试窗口内先建窗 |
| 无 splash / 静态骨架 | `security.ts:301-316` 只有 `ready-to-show` | 可选：静态 HTML splash（VS Code `window.loadingTpl` 思路）覆盖 S1 空档 |
| `file://` 无 HTTP 压缩/缓存 | `security.ts:288` | 先实测 V8 code cache 是否生效；再考虑 `app://` 自定义协议 |
| Main 未打包：128 个 JS / 3.4 MB，Node ESM 逐个解析 | `apps/desktop/dist/src`（`tsc` 输出） | 用 esbuild 打包 Main（native/electron external），对齐 VS Code 产物形态 |

## 4. 运行期：渲染与交互（流式之外）

### 4.1 R1【P0】击键穿透整树 + 每键一次 IPC

一次可见字符的完整路径：`ChipComposer.onInput` → `emit()`（3–5 次 `setState` + 全 DOM `snapshotOf` + 两次 DOM 走查）→ `App.tsx:5958 setDraft` → `App.tsx:5963` → `App.tsx:6531 setComposerDraftsBySession`（**AppShell 的 useState**）→ AppShell 重渲 → 无 `memo` 的 `AppSidebar`/`AppTopbar`/`WorkbenchCanvas` 全部重渲；同时 `App.tsx:4397-4402` 的 effect（依赖 `draft`）调用 `conversationViewLeases.block()` → microtask 里 `setConversationViewState` IPC（`conversationViews.ts:20-37`，每次 block 新 token，**不去重**）。

修法：
1. 草稿改 `useRef` 存，仅在会话切换/卸载时写回，不再驱动 AppShell；
2. `AppSidebar`/`AppTopbar` 加 `React.memo`（props 里的内联箭头函数一并 `useCallback`）；
3. `emit()` 拆「立即发布的轻量快照」与「rAF 合并的缩略图/截断同步」；
4. `block()` 只在 blocked 布尔翻转时调用。

收益：击键主线程 −60~80%，首字符 <8 ms（4x 降速下从 30–80 ms 回到帧预算内）。风险：草稿跨会话恢复语义需重新设计。

### 4.2 R2【P1】零懒加载（与 S5 同一根因，收益在运行期同样成立）

每个新窗口都重复付出 730 KB 的 xterm/codemirror parse；`ModelConfigPage` 打开时还有 codemirror 初始化。与 S5 合并处理。

### 4.3 R3【P1】虚拟化覆盖极低

`@tanstack/react-virtual` 已装，但只有对话流用；`React.memo` 全库 12 处。未虚拟化清单：诊断原始日志（可达 1,000+ div）、Agent Hub job 树（500–2,000 节点）、Skills 抽屉（300×6）、历史会话（服务端上限 200）、子代理、Judgments、Annotations、文件树、模型目录、Context Inspector。

修法：抽通用 `<VirtualRows>`，先接「定高、最痛」的诊断日志 → Skills → Agent Hub jobs → 历史；文件树沿用现有 `flattenVisibleWorkspaceNodes` 扁平化后虚拟化。

### 4.4 R4【P2】页面切换整体卸载工作台

`App.tsx:6640` + `:8747` 二选一渲染：进设置/模型/Agent Hub 时 `WorkbenchCanvas`（含 engine、文件树、终端、composer）整体卸载，返回时重新 `conversation.open` + hydrate。修法：工作台常驻 + 二级页面覆盖（`position: fixed` + `visibility`，或 `content-visibility: hidden` 保活）；注意隐藏 ≠ 卸载期间的租约与可见性上报（现有 `conversationViews.ts` 的 IntersectionObserver 逻辑可复用）。

### 4.5 R5【P1】搜索零防抖 + 文件树搜索全展开

全库 0 处 debounce/`useDeferredValue`/`startTransition`。最重的是 `App.tsx:1362 expandedWorkspacePathsForSearch`：搜索非空时把所有含子项的目录都加入 expanded，`App.tsx:1657` 随即全量 flatten + 渲染 ⇒ **敲第一个字符 = 展开全部目录 + 渲染整棵树**。修法：只展开命中节点的祖先链；8 个搜索框加 150 ms 防抖 + `startTransition`。

### 4.6 R6【P1】长助手正文没有 `content-visibility` 分块

`content-visibility: auto` 只覆盖工具卡/思考块（`ToolBody.tsx:202/419`、`BatchChain.tsx:167`、`workbench.css:1471-1474`）；助手正文走 `MarkdownText`（`conversation/markdown.tsx:140-168`），没有分块。一条 5,000 行消息 ⇒ 一次全量解析 + 数千 DOM 全量进布局。修法：把已有 `.cv-chunk`/`--cv-lines:64` 机制套到 `MarkdownBlockList` 的冻结块外层（现成预算模型，改动最小）。

### 4.7 R7【P1】定时器未按可见性门控

renderer 的 22 个 `setInterval` 中只有 2 处按 `document.hidden` 门控（Main 侧另有 8 个，其中 host 采样 60 s 属设计如此）。确认无守卫的：`HomePage.tsx:496`（30 s `usage.get`）、`ConversationEmpty.tsx:83`（同）、`AgentHub.tsx:1395`（5 s `setNow` ⇒ 3353 行页面整页重渲）、`BrowserPane.tsx:47`（2 s 递归链隐藏时仍自续，IPC 有守卫）。`useSessionTitles.ts:86` 的 15 s 轮询在 `refresh()` 内有 `document.hidden` 提前返回（`useSessionTitles.ts:49`），可保留。修法：统一 `useIntervalWhenVisible`（照抄 `SessionCompressionPane.tsx:33`），`setNow` 只在真正需要相对时间的子树订阅。

### 4.8 R8【P2】`useAppSettings` 无选择器

`settings/appSettings.ts:221` 直接返回整个 `settings` 对象，10 个消费者任一设置变化全部重渲；其中 `App.tsx:6586` 的 `useLayoutEffect` 依赖 6 个字体字段，改字号会重跑 `applyTypography` 写 CSS 变量 ⇒ 全文档样式重算。修法：`useAppSettingsSelector(selector)`（浅比较缓存）或把字体字段独立成 store。

### 4.9 R9【P2】布局属性过渡 24 处

`transition: width/left/top/margin-left/min-width`（`sidebar.css:21/407/589/711`、`components.css:370/746`、`pages.css:78/91/760/770`、`models-roles.css:104/117`、`AppUpdateDialog.tsx:267`）每帧触发 layout。修法：能改 `transform` 的改；必须变高的容器动画期间加 `contain: layout paint`；进度条改 `scaleX`。

## 5. GPU / 合成层 / 空闲功耗

### 5.1 G1【P0】零 GPU 探测、零降级

全库 `appendSwitch`/`disableHardwareAcceleration`/`disable-gpu`/`use-angle`/`enable-features`/`js-flags`/`getGPUFeatureStatus`/`getGPUInfo` **0 命中**；renderer 侧也没有 WebGL/`navigator.gpu`/`deviceMemory` 探测；唯一的硬件自适应是高亮 Worker 的 `hardwareConcurrency`。

后果：核显/VM/RDP/旧驱动回退 SwiftShader 时，`backdrop-filter` 与 `filter: blur` 从 GPU 采样变成 CPU 逐像素高斯，本项目恰好重度依赖这两者。用户只会说「卡」，没有诊断信息可给。

修法：
1. `ready` 后取一次 `app.getGPUFeatureStatus()`，`gpu_compositing !== "enabled"` 或 `webgl !== "enabled"` 时经 preload 下发 `data-gpu="software"`；
2. CSS 用 `:root[data-gpu="software"]` 关 `backdrop-filter`、把 `--bd-blur` 归零、`box-shadow` 换 `outline`、暂停装饰动画；
3. 诊断页显示真实 feature status；设置页给「强制启用/禁用」逃生口；
4. **不要**自动 `disableHardwareAcceleration`（那是更差的选择）。

### 5.2 G2【P1】背景媒体的重组合（注意：默认关闭，但开启后无降级）

需要纠正一处：`backgroundSettings.ts:58` 的 `enabled` **默认 false**，所以「视频背景 + 毛玻璃」不是默认态，而是**用户可选的一组昂贵组合**，且开启后没有任何降级：
- `BackgroundMedia.tsx:60-64`：`autoPlay muted loop preload="auto"`；
- `background.css:49`：全屏 `filter: blur(var(--bd-blur))`，默认 8 px（范围 0–60）；
- `[data-backdrop="on"]` 下给 `.composer`/`.codeblock`/`.menu`/`.modal` 挂 `backdrop-filter: blur(16px)`（`background.css:113-118`）——长对话视口内 5–15 个代码块。

修法：`prefers-reduced-motion`、G1 软件合成、电池供电（`powerMonitor.onBatteryPower`）时把 `--bd-blur` 归零、视频换 poster（`BackgroundMedia.tsx:49-52` 已有 poster 分支，扩触发条件）；`.codeblock` 从 backdrop 名单移出（代码块要的是不透明度，不是模糊）。

### 5.3 G3【P1】6 条非合成无限动画

`ce-sheen` 动 `background-position`（`workbench.css:6572`，7.5 s infinite，**空对话首屏就有**，且无 reduced-motion 覆盖）、`omp-shimmer`（`base.css:257`）、`al-sweep`（`workbench.css:2281`、`btw.css:95`）、`omp-text-breath` 动 `text-shadow`（`workbench.css:4013/4065`）、`magic-kw-shimmer` 动 `filter: hue-rotate`（`workbench.css:3959`）、`tc-progress-slide` 动 `left`（`jobs.css:53`）。

一条 `background-position` 无限动画会让 renderer 每个 vsync 都产生合成帧，Chromium「无变化即跳过出帧」优化失效。修法：扫光改 `transform: translateX` 伪元素；`text-shadow` 呼吸改 `opacity`；页面不可见时 `animation-play-state: paused`；补齐 reduced-motion。收益：可见空闲 CPU 从实测 **2.3–2.4%** 压到 <0.5%。

### 5.4 G4【P1】低配可观测性缺口

`chrome-metrics-shared.ts:19-38` 已投影 `GPU` 进程类型，但只取工作集；无显存/feature status；`getProcessMemoryInfo` 0 命中。8 GB 机器上「是渲染进程涨了还是 GPU 进程涨了」目前答不出来。修法：采样时补 GPU 行 `privateBytes/sharedBytes`（缺失就省略，不填 0）+ feature status，诊断页加两列。

## 6. Host / IPC / 传输层

先说三个需要纠正的既有假设（`doc/streaming-cpu-performance-audit.md` 的表述已过时）：

1. `packages/transport-desktop` 全包仅 258 行，**不存在** `validate-outbound.ts`；Main→Renderer 出口零 schema 校验。
2. **不存在** `assertClientEvent`/`validateOutbound`；delta 只在 `studio-protocol` 深校验 1 次，后两次是 WeakSet 身份复用（fast-path 已落地）。
3. 全库 **0 处** `sendSync`/`ipcMain.on`/`ipcRenderer.send`/`MessagePort`；单窗口 + 每窗口 1 条 transport 订阅，**不存在多窗口或按 scope 的扇出放大**。

### 6.1 H1【P0】终端 PTY 零合批、零流控

`terminal-pty.ts:330` 每个 chunk 直接 `send` → `terminal-ipc.ts:52` → `terminalSessions.tsx:82` 逐条写入 xterm。构建/`npm run dev` 刷屏时每秒数百条 IPC + 渲染层长任务。修法：16 ms 合批 + 单条上限（例如 ≤64 KiB/条），必要时按 `xterm.write` 回调做流控。

### 6.2 H2【P1】隐藏/最小化窗口照收全量事件

`ipc.ts:142-146` 只判 `isDestroyed`，可见性只喂给 Host 合流（`conversationViews`），没有回流到 IPC 出口。修法：Main 依据窗口可见性对非关键事件降采样/丢弃（保留控制类事件），最小化时事件量可降 90%+。

### 6.3 H3【P1】Bridge 解帧大帧 O(n²) 拷贝

`frame-codec.ts:66-68/85-89` 两次全量 `Buffer.concat` + `toString` + `JSON.parse`；对 768 KiB transcript 页、2 MiB replay 有放大。修法：增量解码器（记录已扫描偏移，不在每次 read 重拼全缓冲），或对超过阈值的大帧走「长度前缀 + 直接切片」。

### 6.4 H4【P1】`conversation.open` 单 tick 排空 500 事件/1 MiB

`conversation-coalescer.ts:104-124` 一次性 flush，点开会话时主线程一次性处理。修法：分片 flush（每 tick ≤64 事件 / 256 KiB），控制类事件优先。

### 6.5 H5【P2】结构性缺背压

无 `MessageChannelMain`、无 ACK。修法：只对「终端 + 对话流」两条最高频通道开 MessagePort，其余保持现状；排在最后。

### 6.6 正面基线（不必再查）

空闲 1 分钟 ≈ 7 次 IPC 往返 / ≈ 10 次 Bridge 往返 / 0 子进程 / 0 目录扫描；git 用 `.git` 定点 watch + 400 ms 去抖；payload-health 事件驱动无轮询；媒体上传 256 KiB 分块 + busy 背压；artifact 流式；大对象处理已达参照水平。

## 7. 低配机专项

### 7.1 四类目标机型与放大模型

| 机型 | 主要放大因子 | 命中的问题 | 预期体验（当前） |
|---|---|---|---|
| **A. 主流办公本**（4C/8G/核显/SSD） | 单核性能、核显带宽 | S1/S2/S3、R1、R3、G1 | 启动 3–6 s；输入偶有粘滞；大列表开页卡一下 |
| **B. 老机器**（2C/4G/HDD/无独显） | 磁盘顺序读、单核 | S1/S2/S3/S5、R2/R5/R6、G1/G3 | 启动 8–20 s；首屏长白；搜索/大消息明显卡顿；风扇常转 |
| **C. 远程/虚拟**（RDP/VM/SwiftShader） | 强制软件合成 | G1/G2/G3、R9 | 滚动/流式掉到 5–15 fps，无提示 |
| **D. 高刷游戏本**（本机 13900HX/独显/高刷） | 帧率越高每帧预算越小 | R9、G3（publish 已按档位限流） | 基本流畅，长对话与设置页仍有掉帧 |

### 7.2 分级降级（L0–L3）

| 级别 | 触发 | 动作 |
|---|---|---|
| **L0 正常** | 默认 | 现状 |
| **L1 减动效** | 用户开启「减少动效」/`prefers-reduced-motion` | 暂停装饰无限动画；页面切换/面板过渡改瞬时；`ce-sheen`/`text-breath` 停 |
| **L2 减模糊** | G1 检测到软件合成；或电池供电 | `--bd-blur: 0`；关 `backdrop-filter`；`box-shadow` → `outline`；视频背景停用 poster |
| **L3 降载** | 内存 < 8 GB 或用户手动 | Store 窗口/mermaid 并发/高亮缓存按现有预算表再降一档（不改变流式语义）；关闭 3D 预览自动加载 |

原则：降级只动**显示层与缓存预算**，不动流式正确性、不删 IPC 校验、不改持久 transcript。每级都要有「强制开启/关闭」逃生口，并在诊断页可见。

### 7.3 低配机最差路径（组合命中）

「预览关闭 + 大仓库文件树搜索 + 一条 5,000 行助手消息 + 底部日志 200 条 + 最小化后流式继续」会同时命中 R5/R6/H2/G3，是当前最坏组合，建议作为低配专项的固定验收场景。

## 8. 与主流方案对照

| 维度 | 主流成熟做法 | 本项目现状 | 差距 |
|---|---|---|---|
| 窗口 vs 后端顺序 | VS Code 先建 `BrowserWindow` 显示 loading，extension host 后连；Slack/Discord「splash → 主窗 → 后端异步」 | Host+Runtime 全就绪才建窗（`composition.ts:184→192`） | **最大** |
| 启动期验证 | VS Code 正常启动只做轻量自检，`--prof-startup` 是诊断手段；扩展激活延迟 | 每次启动现场 probe + 4 次全文件 sha256 | **大** |
| 首屏产物 | 路由级/视图级 chunk 按需；Electron 官方「avoid preloading everything」 | 全页面进 entry；mermaid 误 preload | **大** |
| 输入路径 | React `useDeferredValue`/`startTransition`；VS Code 独立输入循环 + 防抖 | 0 处 debounce/transition；击键穿透 AppShell | **大** |
| 列表 | Slack/VS Code 消息与资源管理器虚拟化 + 行高缓存 | 1 个虚拟列表 + 12 处 memo | **中大** |
| GPU 回退 | VS Code 提供 GPU 加速开关与文档；Obsidian 有安全模式 | 零探测、零开关、零提示 | **大** |
| 空闲功耗 | Discord/Slack 目标 <0.5% CPU、空闲不产生合成帧 | 可见空闲实测 2.3–2.4%（无限动画 + 轮询）；最小化后 0.05% | **中** |
| 长文本布局 | Chrome 官方 `content-visibility: auto`；Slack/Linear 按块 | 工具卡有、正文没有 | **中** |
| 高频流 | Electron `MessagePort` / LSP 增量 / xterm `write` 合批 + flow control | PTY 逐 chunk 发；无 MessagePort | **中** |
| 构建形态 | VS Code Main 打包成少数文件；asar | Main 128 个 ESM 文件（tsc 输出） | **中** |

## 9. 优化路线图

### P0（本迭代，收益最大且风险可控）

> 状态（2026-10-29 晚）：第 1、2 项已由 `8ab613d` 完成并合并；第 3 项部分完成；其余仍开放。复核见 §12。

| # | 动作 | 预估收益 | 成本 | 验收 |
|---|---|---|---|---|
| 1 | `manualChunks` 修 mermaid helper | 首屏 JS −3.1 MB | 一行 | `dist/index.html` 无 mermaid preload |
| 2 | 窗口先建 + lazy facade | 冷启动 −1.5~4 s（本机基线） | 中 | `window.show` 不再等 Host 就绪；日志出现 `host-ready`，且 Host 就绪前的请求被挂起而非拒绝 |
| 3 | 去掉首屏重复 7 query | 少 7 次往返 | 低 | 启动日志 query 计数 |
| 4 | Runtime 探针证据签名缓存 + 哈希去重 | −1~3 s | 中高（安全评审） | 二次启动无 probe 日志、exe 摘要仍比对 |
| 5 | `ExecutionTargets` 首屏闸门 | 少 1 RTT + 去误导文案 | 低 | 无 SSH 存档时首帧即挂载 |
| 6 | 终端 PTY 16 ms 合批 | IPC 消息 −5~20× | 小-中 | 大输出时 Main→Renderer 消息数 |
| 7 | composer 击键路径（ref + memo + block 翻转） | −60~80% 主线程 | 中小 | 击键 p95 < 16 ms（4x 降速） |
| 8 | 轮询加 `document.hidden` 守卫 | 空闲唤醒 −60% | 低 | 隐藏 5 分钟 CPU |

### P1（本迭代或下一迭代）

9. 页面级 `React.lazy`（TerminalPane / ModelConfigPage / AgentHubPage 优先）+ i18n 单语言 + preview fixture 懒加载
10. 通用虚拟列表接 Top-4（诊断日志 / Skills / AgentHub jobs / 历史）
11. GPU feature 探测 + `data-gpu` 降级 + 诊断页展示
12. 无限动画改合成器属性 + reduced-motion 补齐
13. `FrameDecoder` 大帧解码去拷贝
14. 隐藏窗口事件降采样
15. 助手正文 `content-visibility` 分块
16. 搜索防抖 + 文件树祖先链展开
17. `useAppSettings` 选择器化

### P2（结构调整，回归面大）

18. 工作台保活（隐藏而不卸载）
19. MessagePort 背压（终端 + 对话流）
20. 布局属性过渡改 `transform`/`contain`
21. `app://` 协议替代 `file://`（先验证 code cache 收益）
22. splash / 静态骨架
23. Main 用 esbuild 打包
24. GPU 进程显存与 feature status 进诊断

## 10. 门禁与回归建议

现有门禁（`npm run perf:streaming`、`render-work-bench.mjs`）只覆盖流式帧代价与高亮 Worker。建议补四条**低成本、防回归**的检查，仍放在手动触发的性能 workflow 里，不进日常 CI：

1. **产物门禁（秒级，只读 dist）**：`dist/index.html` 的 `modulepreload` 集合必须等于白名单（react/vendor/entry + 显式允许项）；首屏 JS 字节设上限——修掉 mermaid 后应约 **3.5 MiB raw**，再懒加载 xterm/codemirror 后约 **2.8 MiB**，建议把门禁定在 3.6 MiB 并随优化阶梯下调。这条能直接拦住本次的 mermaid 事故。
2. **启动门禁**：在 Main 埋 6 个 mark（`main.entry`/`whenReady`/`host.ready`/`window.show`/`did-finish-load`/`first-interactive`），写入 host 日志；门禁取「窗口 show」与「first-interactive」的中位数，阈值按参考机 baseline +10% 判定（沿用现有「比值不回退」哲学，不写死绝对毫秒）。
3. **交互门禁**：`scripts/interaction-perf-gate.mjs`，覆盖「击键 p95」「页面切换往返」「500 条列表开页」三项；4x CPU 降速下取中位数，不回退 10%。
4. **空闲门禁**：可见静置 60 s 与最小化 60 s 的 Browser/Renderer/GPU 三进程 CPU 均值必须 <0.5%，且最小化后 <0.2%；同时断言无持续合成帧（CDP）。

同时建议把 `runtime.resolve` → `launch.begin`、`launch.begin` → `handshake.ok` 两段日志做成诊断页可见的「最近一次启动耗时」，这样低配用户报障时不用装 Profiler。

## 11. 局限与未验证事项

**形态与口径**

- **启动数字是下界**：`app.isPackaged=false`、隔离 profile 中无 Runtime，不含 Runtime 探针、播种、`currentManifest()` 与更新协调器。打包形态只拿到一次非稳态观察（17.45 s，含首启自检 + 播种 + 更新下载），**未得到打包稳态分段**——需要在「已装好 Runtime、更新已收敛」的机器上复测（建议用 Host 日志时间戳对齐，或产品侧加一次性埋点）。
- **「冷启动」不是真冷**：没有权限清 OS 文件缓存，「冷」只代表全新 profile；重启后首次启动会更慢。每形态 n=3，只报中位/最差，未做显著性检验。
- **背景负载 7–10%**：测量时机器上还有 4 个只读审计代理，空闲 CPU 是**含背景负载的上界**，不是产品独占开销。
- **失焦态不可信**：`win.blur()` 在本机未真正移走前台焦点（`isFocused()` 仍为 true），「失焦」样本应视作正常态重复；真正失焦需在交互桌面用另一窗口抢占前台后采样。
- **4x 降速覆盖不全**：新 profile 下 Runtime 未连接、未选项目，首页/设置/模型配置/会话四页不可达；只测了 Agent Hub、技能抽屉、composer、列表滚动。打开大对话、长 transcript、图片/媒体、终端等重场景未测。
- **JS 成本是 reload 口径**：`file://` 不暴露 Resource Timing，首屏字节数来自 CDP Network 的 reload 复测（热、无压缩）；冷启动首屏的 `ScriptDuration` 拿不到。
- **`idleWakeupsPerSecond` 在 Windows 恒为 0**，字段不可用。

**结论边界**

- **探针区段解释**：`runtime.resolve` → `launch.begin` 的 1.2–2.6 s 里，静态可解释的只有一次 `currentManifest()` 全文件校验（本机 ≈90 ms）+ workspace 检查 + HostBackend 初始化；剩余部分需要 Main 分段 marks 才能归因，**不要把它当成已确证的哈希成本**。同理，4 次哈希的「低配 2–5 s」是机理估算，不是实测。
- **GPU 软/硬合成未定性**：feature status 与 GPUInfo 互相矛盾（§2.5），本机还有两个虚拟显示适配器；SwiftShader 路径的掉帧数字必须由本地桌面 / RDP / VM 补测。
- **低配机是推算**：本轮没有真实 2C/4G/HDD/核显机器；4x CPU 降速只近似 CPU 维度，不模拟磁盘与 GPU 带宽。§7 的收益区间来自机理，需真机复核。
- **没有覆盖真实供应商长会话**：`conversation.open` 的真实 transcript 规模（MB 级）与 SSH 远程工作区未做端到端计时。
- **未做**：Windows 安装包/更新包体积对比（`graphics-xite` 24 MB + mermaid 3.2 MB 的影响）、macOS 路径、Runtime 内部启动序列（`omp-patch/overlay` 的 `studio-host-mode.ts`）、`graphics-xite` 是否应随包分发。

## 12. 性能分支合并复核（2026-10-29 17:00）

分支 `claude/vibrant-tu-4f59f1` 的改动原本是 worktree 里的未提交状态；先提交为 `8ab613d`（74 文件，+2690/−666），再合并进 `0.2.0`。

- **合并**：`git merge-tree` 预检**零文本冲突**；合并提交 `f65cf1d`，`0.2.0` 由 `9a371d7` 前进。合并后 `0.2.0` 为当前分支，`main` 仍停在 `9a371d7`。
- **验证**：`npm run check` 全绿（arch/selects、12 包编译、client/host-client-api/studio-host/runtime-installer/studio-protocol/testkit/desktop/renderer 核心测试，77.5s）；另单跑 `runtime-session` / `runtime-multi-session` / `desktop-composition` 三个测试 **86/86**。
- **独立审查**：Desktop、Renderer、测量核验三份只读审查均**无阻断项**；`0.2.0` 新增的「Bridge 断连拒绝启动」在合并后仍生效（守卫 `runtime-session.ts:1416`、拒绝抛错 `:1542`，分支新增赋值在其后）。报告见 `outputs/perf-audit/branch-{desktop,renderer}-review.md`、`branch-verify.md`。

### 12.1 它修掉了什么（对照 §1.2 / §9）

| 审查项 | 状态 | 复核证据 |
|---|---|---|
| P0-1 mermaid 首屏预加载 | ✅ 修复（比一行 hack 更正确） | 合并后用 `onlyExplicitManualChunks` 根治；`dist/index.html` 只剩 polyfill/react/commonjsHelpers/vendor 四个预加载，mermaid/xterm/codemirror 仅动态可达 |
| P0-2 窗口等待 Host+Runtime | ✅ 修复 | 基础 Host 就绪即建窗，Runtime 播种/验签/探针/启动转后台；准备期 `connecting`、失败 `unavailable`，不伪造 ready；退出等待在途启动，更新试运行仍等终态 |
| P0-4 首屏重复 query | ◐ 部分修复 | 初始加载与 resync 合并、按域提交，projects/env/commands 由两次变一次；history 保持独立读取 |
| P1 页面级懒加载 | ✅ 完成 | 模型/能力/设置/诊断/Agent Hub/媒体/评测 + 终端 + 录制播放器全部按需；入口 chunk 2.13→1.42 MiB |
| P1 git/录制/队列空闲工作 | ✅ 完成 | git 共享订阅（失效通知而非快照）、隐藏录制停查、回退队列按需轮询 |
| 图形库瘦身 | ✅ 完成 | 删除 26 个重复/未压缩文件 12.29 MiB，许可证齐全；dist 33→20 MB |
| P0-3 Runtime 探针/哈希缓存 | ❌ 未做 | 分支未改 `runtime-resolver.ts` |
| P0-5 composer 击键路径 | ❌ 未做 | `setComposerDraftsBySession` 仍在；4x 实测见 §12.2 |
| P0-6 终端 PTY 合批 | ❌ 未做 | — |
| P0-8 GPU 探测/降级 | ❌ 未做 | 全库仍 0 命中 `getGPUFeatureStatus`/`appendSwitch` |
| P0-9 空闲无限动画 | ❌ 未做 | 实测空闲仍有 3 条无限动画在跑（`pi-breathe`、`ce-sheen`、`omp-text-breath`） |

### 12.2 合并后实测（同机、dev-unpackaged、隔离 profile、无 Runtime）

**启动（5 次冷 + 5 次热）**

| 指标 | 合并前（3 次） | 合并后（5 次） | 变化 |
|---|---:|---:|---:|
| spawn → 可交互（冷） | 1,485 ms | 1,552 ms（1,370–1,612） | +4.5%，后段漂移，见下 |
| spawn → 可交互（热） | 1,435 ms | **1,331 ms**（1,319–1,338） | **−7.2%** |
| navStart → FCP | 360 ms | **284 ms** | **−21%** |
| navStart → LCP | 756 ms | 732 ms | −3% |
| processCreated → did-finish-load | 755 ms | **684 ms** | **−9%** |
| processCreated → ready-to-show | 771 ms | 824 ms | +7%（冷启动样本含 2 次慢跑） |
| 入口 chunk | 2,235,142 B | 1,491,344 B | **−33%** |

- **渲染首帧确实变快**：FCP −21%、did-finish-load −9%，与「首屏少 3.2 MB JS」一致。
- **热启动 −7%** 是本轮最干净的可比数字（同 profile、5 次方差 19 ms）；冷启动后三次出现 1.55–1.61 s 漂移（前两次 1.37/1.45 s），更像机器负载/杀软扫描而非代码，需在固定机器复测。
- **窗口前置在本形态没有可测收益**：隔离 profile 没有 Runtime，基线本来就在 ~50 ms 内失败返回；真实收益只可能出现在「已装 Runtime 的打包态」，本轮无法验证（§11）。
- 分支自述的 **−21.9% 是合成 fixture 口径**（`scripts/startup-perf.mjs` 无 Host/Runtime），不能当产品启动收益；核验报告已确认其 6 个数字可复算、未夸大。

**空闲（60 s × 60 样本）**

| 指标 | 合并前 | 合并后 | 备注 |
|---|---:|---:|---|
| 可见空闲 CPU 合计 | 2.31%（宿主 7.1%） | 2.99 / 3.85%（宿主 14.7 / 15.8%） | **不可比**：宿主负载翻倍 |
| 最小化 CPU 合计 | 0.05% | 0.08% | 噪声级，后台节流仍生效 |
| 空闲 RSS 合计 | 914 MB | **856 / 873 MB** | **−4~6%** |
| renderer RSS | 282 MB | **226 MB** | **−20%**（懒加载减少常驻 chunk） |

- 空闲 CPU 无法从本轮数据判断升降；两条 after 轮的宿主负载都显著高于基线。**RSS 下降是可确认的收益**。
- 空闲时仍有 3 条无限动画（`pi-breathe` / `ce-sheen` / `omp-text-breath`）在默认「Studio 未连接」界面持续运行——§5.3 的 G3 依旧成立。

**4x CPU 降速（取 3 次可用轮次的中位方向；after3/after5 出现 58–65% 掉帧，判为环境干扰，已排除）**

| 场景 | 合并前 | 合并后 | 判读 |
|---|---:|---:|---|
| 切 Agent Hub：script / 长任务 / 最差帧 | 258 ms / 10 / 554 ms | 365–390 ms / 14–15 / 708–933 ms | **首访需动态加载 AgentHub chunk**，属懒加载的首次成本；后续访问应回落，未单独测 |
| composer 输入 200 字符：script | 1,869 ms | 2,135–2,257 ms | 已用**合并前渲染层**做同机 A/B：基线包当前测得 2,146 / 2,757 ms，与合并后同量级 ⇒ **环境漂移，不是分支回退**（早前 1,869 ms 是较低负载样本） |
| 滚动：script | 24.3 ms | 12.7–15.7 ms | 变好 |
| 面板开合：script | 38.6 ms | 41–43 ms | 持平 |

**结论**：合并没有引入阻断问题，首屏体积与首帧、热启动、常驻内存都有可确认收益；但**不能宣称整体「启动快 21.9%」**——真实冷启动收益未被证明。4x 降速下唯一可归因于分支的成本是「首次进入懒加载页面要拉 chunk」，输入/滚动/面板没有可复现回退。

### 12.3 审查遗留（非阻断，建议按序处理）

> 第 1、2 项已在本次修复中处理（见 §12.4）；其余仍开放。

1. ✅ **已修：`runtimeTouched` 覆盖不全**（原 `host-composition.ts:865-881`）：`switchSession` / `evacuateResident` 现在都会置位 `context.runtimeTouched.current = true`，极端时序下 Runtime 不会漏停。
2. ✅ **已修：`shellModelLoader` 域失败静默**：每个域失败先重试一次，仍失败则 `console.warn` 且不标记 committed（下次 load 会再试）；`page()` 的可选加载失败改为告警，不再从 fire-and-forget 调用产生 unhandled rejection（`shellModelLoader.ts:40-82`）。
3. `composition.runtimeStatus` 在延后启动下成为「一次采样、永远过期」的字段（`main.ts` 不读，但属于导出面）。
4. `connecting` 期点「重启更新」会直接报「Runtime 正在准备」（`host-composition.ts:1222`），建议先 `await whenRuntimeReady()` 再判 blocker。
5. `omp-graphics://` 白名单 `^assets/...\.(js|css)$` 覆盖了整包渲染产物且 `Access-Control-Allow-Origin: null`（`graphic-protocol.ts:30/40`），建议收窄到专用子目录。
6. 会话切换时插入意图会被静默丢弃（`App.tsx:6848-6850`）；两条组合测试缺失（真实 MediaPage intent、经 lazy 的终端 ref 单建）。
7. **安全面需确认**：`security.ts` 把 CSP 注入收缩到只对 mainFrame，图形 iframe 改靠自身 meta CSP；主窗口 CSP 仍无 `unsafe-eval`，但这是一次安全行为变更，建议安全侧签字。
8. 测量证据仍不在仓库：分支 A/B 驱动 `paired-launch.mjs` 未入仓、`outputs/` 被 gitignore；本轮复测的原始 JSON 同样只在本地。

### 12.4 本次修复记录（2026-10-29 17:30）

| 修复 | 位置 | 验证 |
|---|---|---|
| Runtime 漏停 | `host-composition.ts:865-889`：`switchSession` / `evacuateResident` 置位 `runtimeTouched` | desktop 构建 + `desktop-composition`/`desktop-lifecycle` **43/43** |
| 域加载失败静默 | `shellModelLoader.ts:40-82`：失败重试一次 + 持续失败告警 + `page()` 不产生 unhandled rejection | `shellModelLoader` **8/8**（新增 3 条：失败重试一次并发布、持续失败告警且下次 load 重试、page 失败转告警） |
| 输入回退误判 | 无代码改动（A/B 证伪） | 合并前渲染层同机 2,146 / 2,757 ms vs 合并后 2,135 / 2,257 ms |

**本次未修及原因**

- **S3 `connecting` 期更新重启**：要改「等待就绪」语义与失败文案，属产品取舍，先确认再动。
- **S5 `omp-graphics` 白名单收窄**：需把 viewer 资产输出到专用子目录或建立静态闭包清单，当前不构成可利用提权（无 preload/IPC、代码非机密）。
- **S1 `composition.runtimeStatus` 过期字段**：`main.ts` 不读，属清理项，等下次触碰该类型时一并删。
- **CSP 收缩到 mainFrame**：安全行为变更，需要安全侧签字后再固化。
- **§1.2 其余 P0**（探针/哈希缓存、composer 击键路径、PTY 合批、GPU 降级、空闲动画）：属于后续优化路线，不在本次「合并审查修复」范围。

## 13. 证据索引

| 主题 | 文件 / 命令 |
|---|---|
| 启动链路、首屏模块图 | `outputs/perf-audit/startup.md` |
| 渲染/交互/列表/内存 | `outputs/perf-audit/runtime-render.md` |
| GPU/合成/空闲/降级 | `outputs/perf-audit/gpu-idle.md` |
| IPC/传输/轮询/watcher | `outputs/perf-audit/host-ipc.md` |
| 实测方法与全部原始样本 | `outputs/perf-audit/bench/REPORT.md`、`raw/startup.json`、`raw/idle.json`、`raw/throttle.json`、`raw/startup-packaged-smoke.json`、`raw/build.log` |
| 实测探针（可复现） | `scripts/perf-audit/{startup-probe,idle-probe,throttle-probe,prepare-packaged-form}.mjs`、`scripts/perf-audit/lib/{collect.mjs,main-hook.cjs}`、`scripts/perf-audit/README.md` |
| 首屏体积/预加载 | `apps/renderer/dist/index.html`、CDP Network 复测（7 个 script = 7,083,976 B），mermaid chunk = 3,246,999 B |
| 首屏 gzip 体积 | `gzip -9` 实测：index 661 KB / vendor 207 KB / mermaid 874 KB / codemirror 129 KB / xterm 84 KB / react 60 KB（合计 1.95 MiB） |
| Runtime 体积与哈希 | `%APPDATA%\omp-studio\runtimes\versions\18.0.11-studio.5\omp.exe` = 173,815,296 B；本机 sha256 中位 90 ms（3 次 86/92/90 ms） |
| 本机启动区段 | `%APPDATA%\omp-studio\logs\host-2026-10-2*.log` 的 `runtime.resolve` / `runtime.launch.begin` / `runtime.handshake.ok` / `runtime.launch.ready` |
| 分支审查（合并前） | `outputs/perf-audit/branch-desktop-review.md`、`branch-renderer-review.md`、`branch-verify.md` |
| 合并后复测原始数据 | `outputs/perf-audit/bench/raw/after2-startup.json`、`after2/after3-idle.json`、`after2/after4/after6-throttle*.json`；基线在 `raw/baseline-20261029/` |
| 输入场景 A/B（合并前渲染层对照） | `outputs/perf-audit/bench/raw/typing-check-*.json`（合并后）与 `typing-base-*.json`（合并前渲染层同机复测） |
| 既有基线 | [performance.md](performance.md)、[performance-report-2026-09-24.md](performance-report-2026-09-24.md)、`doc/streaming-cpu-performance-audit.md` |
