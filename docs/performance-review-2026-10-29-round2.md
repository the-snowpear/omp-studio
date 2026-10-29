# OMP Studio 性能综合审查（第二轮，2026-10-29）

面向：项目负责人
基线：`0.2.0` 分支，HEAD `3c6cbdc`（已合并第一轮性能分支 `8ab613d` / `f65cf1d`，其上再叠一个 `runtimeTouched` 修复）
范围：Electron 桌面壳（`apps/desktop`）、渲染层（`apps/renderer`）、Host / IPC / 传输（`packages/*`）、Runtime overlay，覆盖**启动、运行、CPU/GPU、空闲功耗、低配适配、可观测性与门禁**。
与第一轮的关系：第一轮 [`performance-audit-2026-10-29.md`](performance-audit-2026-10-29.md) 是静态审查 + 单形态实测；本轮在**同一 HEAD 上重测**，并补齐第一轮明确列为「未验证」的四块空白：**打包安装形态、GPU 软件合成对照、6× CPU 降速（低配代理）、动画 A/B 与内存增长**。本轮**未修改任何产品代码**，只新增报告与测量探针。

---

## 0. 方法与证据等级

| 等级 | 含义 | 本轮用法 |
|---|---|---|
| **实测（本轮）** | 本机命令直接产出，原始 JSON 在工作区 `outputs/perf-audit-round2/raw/` | 启动、空闲、降速、增长、打包形态、动画清单 |
| **代码** | 直接读到的 `file:line`，机理可复核 | 结构性判断（哈希调用点、快照克隆点、动画声明） |
| **推断** | 由代码常量 + 实测单价推算，均标注假设 | 低配放大、收益区间 |
| **对照** | 主流应用/开源项目的公开做法与数字 | 只用于说明差距，不当基线 |

**实测环境**：Windows 11 26300 / Intel i9-13900HX（32 逻辑核）/ 31.7 GiB / RTX 4080 Laptop + Intel UHD / Electron 43.4.0 / commit `3c6cbdc`。
**口径警告**：测量窗口内宿主 CPU 基线 **10–17%（均值约 13%）**，比第一轮的 7–10% 更忙（本轮同时跑 5 个只读审计代理与构建）。因此**本轮 CPU 绝对值应视为上界**；跨轮比较只能看同轮内的 A/B（本轮所有关键结论都是同轮 A/B，不依赖跨轮数字）。

**本轮产物**（`outputs/` 已 gitignore，可用 §11 命令复跑）：

- 主报告：本文
- 五份专项子报告：`outputs/perf-audit-round2/{desktop-startup,renderer-runtime,host-ipc-runtime,gpu-lowspec,mainstream}.md`
- 原始数据：`raw/r2-startup.json`、`raw/r2-idle-{baseline,gpuoff}.json`、`raw/r2-anim-l2.json`、`raw/r2-throttle-6x.json`、`raw/r2-growth.json`、`raw/r2-packaged{,2}.json`
- 本轮新增探针：`outputs/perf-audit-round2/probes/{idle-variants,anim-l2-probe,growth-probe,packaged-playwright}.mjs`（复用 `scripts/perf-audit/lib/collect.mjs` 的隔离与采样设施）

---

## 1. 结论摘要

### 1.1 一句话结论

**「首屏体积 / 懒加载 / Runtime 后置」这三件结构性欠账已经收敛（首屏 JS 实测 2.36 MB、页面级懒加载完成、窗口不再等 Runtime）；现在真正决定体验与低配可用性的是另外三条：**

1. **空闲 CPU 的 91% 是一条 `text-shadow` 无限动画**（实测 2.87% → 0.25%）；
2. **每次启动、以及运行期每 30 秒，都要对 173.8 MB 的 `omp.exe` 做全文件 `sha256` + 验签**（启动 3–5 次、`usage.get` 1 次/30 s）；
3. **每条流式事件克隆 2 次整包 operator 快照**（重快照会话 ≈10% Main 单核 + 32 MB/s 垃圾），叠加 `conversation.open` 双投递，构成「流式之外」最大的常量成本。

再加上**低配/软件合成路径完全没有探测与降级**（`--disable-gpu` 实测总 CPU +62%），以及**击键路径一次按键重渲 58 处 state 的 AppShell**（6× 降速下 17.6 ms/字符），构成了第二轮的五项 P0。

### 1.2 Top 10（按「用户可感知收益 ÷ 实施成本」排序）

| # | 问题 | 证据 | 影响 | 预估收益 | 成本/风险 |
|---|---|---|---|---|---|
| 1 | **空闲动画**：默认界面 3 条无限动画，其中 `omp-text-breath` 动 `text-shadow`（逐帧重绘）；L2 覆盖块只关掉另外 2 条后仍留 2.30% CPU，全关才 0.25% | 实测 A/B（§2.3、§5.1）；`workbench.css:4013/4065`、`:6572`、`:6457` | 挂机 CPU 地板 2.3–4.7%、笔记本续航 | 可见空闲 **−91%（→ <0.5%）**，且**只改 CSS** | 极低：无判定逻辑、无回滚风险 |
| 2 | **每 30 s 一次 173.8 MB 全文件哈希**：`usage.get` → `locateOmp` → `installer.currentManifest()` → `verifyFileChecksums(entrypoint)` | 代码链 `HomePage.tsx:496`/`ConversationEmpty.tsx:83` → `omp-usage-adapter.ts:376` → `host-composition.ts:971` → `installer.ts:340-366` → `signed-artifact.ts:99` | 稳态 **5.8 MB/s 磁盘顺序读**；HDD/Defender 每 30 s 卡 0.5–2 s | 磁盘读 −100%，卡顿消失 | 低：给 entrypoint 路径/摘要加 memo，安全语义不变 |
| 3 | **每次启动 3–5 次全量 `sha256` + Runtime 探针无缓存**：resolver 前后各指纹一次 + `currentManifest()` + Host backend resolve + update coordinator | `runtime-resolver.ts:319/359`、`installer.ts:344-363`、`host-backend.ts:46`、`update-coordinator.ts:107` | 启动 **−0.1~2 s**（快盘）；HDD/Defender 3–10× 放大 | 冷启动关键路径 −10~40%（低配更明显） | 中高：要安全评审「证据缓存」，建议按 `(path,size,mtime,fileId)` 复用 |
| 4 | **每条流式事件克隆 2 次整包快照**（一次只为判 `undefined`，一次只为读 `runtimeEpoch`） | `host-client-api/src/facade.ts:1447`（克隆点）、`:1507`、`:1840` | 重快照（120 agent/200 job）**≈10% Main 单核 + 32 MB/s 垃圾**；`conversation.open` 排空 500 事件单 tick **0.8 s** | Main CPU −10 pp，长会话拖动/切会话明显变顺 | 中：加零拷贝只读 seam，改动面小但需覆盖并发语义 |
| 5 | **击键穿透 AppShell**：一次击键 5–6 次 setState → AppShell（**58 处 state**）→ 3 棵大树重渲 + 每键 1 次 forced layout + 1 次 IPC | `ChipComposer.tsx:177-212,500`、`App.tsx:3477/6511/6526-6541`、`useComposerCollisionCollapse` `App.tsx:3325-3388` | 6× 降速 **17.6 ms 脚本/字符**（≈1× 2.9 ms），中文长输入有粘滞 | 击键主线程 **−60~80%** | 中：要重设草稿状态归宿（局部化 + transition） |
| 6 | **GPU/动效零探测、零降级**：全库 0 处 `getGPUFeatureStatus`/`appendSwitch`；`--disable-gpu` 下空闲 CPU 4.66% | 实测 A/B（§5.2）；`main.ts`/`security.ts` 无相关调用 | 核显/VM/RDP 上 `backdrop-filter`+动画全走软件合成，用户只看到「卡」 | 软合成机器 idle **−62%+**（配合 #1） | 中：1 个 IPC + `data-gpu`/`data-motion` + ~20 行 CSS |
| 7 | **PTY 逐 chunk 一条 IPC、零合批、零流控** | `terminal-pty.ts:330` → `terminal-ipc.ts:52`；录制时每 chunk 多一次 `JSON.stringify` | `npm run dev`/构建日志刷屏时每秒数百条 IPC + 长任务 | 消息数 **−5~20×** | 低-中：VS Code 默认 5 ms 合批可抄，流控算错会卡死流 |
| 8 | **首屏仍背用不到/过大的数据**：i18n 中英双份 171,690 B（entry 的 11.5%）、preview fixture 71 KB 在发布态仍静态入 entry、`icon.png` 342 KB 未压缩 | `renderer-runtime.md` §N1/N2；`vite.config.ts:43-45`；`renderer/index.html:6` + `icons.tsx:130` | 首屏白付 **≈140 KB JS（min）/ 82 KB gzip + 327 KB 图片** | 首屏传输 **−15%** | 低：i18n 按语言动态 import、fixture 改动态、图标压到 ~15 KB |
| 9 | **`conversation.open` 单 tick 排空 ≤500 事件且同批事件双投递** | `conversation-coalescer.ts:94-113`、`conversation-events.ts:135`、`runtime-session-controller.ts:307-321` | 打开大对话首个 tick **数百 ms 阻塞** | 开大对话 **−150~400 ms** | 中：需要一次「打开即订阅」的协议收敛 |
| 10 | **零虚拟化覆盖（1 个真虚拟列表 + 8 个全量 map）+ 长文无 `content-visibility`** | `renderer-runtime.md` §R3；`conversation/ConversationVirtualList.tsx` 唯一消费者 | 装 300+ Skill / 上千条日志时开页 200–600 ms 阻塞 | Top-4 列表开页 **−150~400 ms** | 中：改结构，回归面较大 |

### 1.3 值得明确保留、不要「顺手优化」

- **流式管线**：增量 replay、有界 Store（2,000 行 / 24 MiB）、挂载行上限 120、后台 250 ms 合并、生产高亮 Worker、Mermaid 预算与串行队列。本轮**未发现被绕过**，唯一边界是 `conversationSource.ts:22`。
- **页面级懒加载**：`DeferredPanel` + 10 个 `lazyPanel` + 1 个 `React.lazy`，首访 chunk 9.5–263 KB；`dist/index.html` 只剩 4 个 `modulepreload`（polyfill/react/commonjsHelpers/vendor），mermaid 仅动态可达。
- **内存卫生**：模块级缓存全部有界（`rowHeightCache` 8,192 LRU 等）、Engine/Store dispose 完整、监听 167 add / 163 remove 基本平衡；本轮 20 轮压力后 listeners 408→409。
- **图形页**：`React.lazy` + 滚入视口才加载 + `powerPreference:"low-power"` + 卸载 `forceContextLoss()`。
- **git 监听**：`.git` 定点 watch + 400 ms 去抖，不是工作区递归。
- **诊断采样**：只读计数、不持正文；`performance.sample` 60 s 一次、变化才写日志。
- **正例**：零 `@font-face` / 零字体文件（`gpu-lowspec.md` §3.8），焦点环走 `outline`（所以 `box-shadow:none` 是安全的降级杠杆）。

---

## 2. 本轮实测基线（新增）

### 2.1 启动：dev-unpackaged（隔离 profile，无 Runtime）

| 阶段 | 冷启动（3 次中位） | 热启动（3 次中位） | 通道 |
|---|---:|---:|---|
| spawn → processCreated | 114 ms | 149 ms | native |
| processCreated → appReady | 521 ms | 599 ms | native |
| appReady → windowCreated | 118 ms | 116 ms | native |
| windowCreated → readyToShow | 194 ms | 208 ms | native |
| **spawn → readyToShow（看到窗口）** | **941 ms** | **1,029 ms** | native |
| processCreated → didFinishLoad | 742 ms | 775 ms | native |
| navStart → FCP | 276 ms | 264 ms | Playwright |
| navStart → LCP | 828 ms | 812 ms | Playwright |
| **spawn → 可交互（3 个静默帧）** | **1,842 ms** | **1,755 ms** | Playwright |

- 与第一轮（`f65cf1d` 后 1,331–1,552 ms 可交互）相比**看起来慢了 15–30%**，但本轮宿主负载从 7–10% 升到 10–17%，且两轮不是同一次会话。**不要据此判断回归**；跨轮比较要用固定机器 + 比值门禁（§10）。
- **冷/热差异仍然很小**（FCP 差 12 ms）：`file://` 形态没有可利用的持久缓存收益。这与第一轮结论一致，也意味着「换 `app://` 协议」的优先级不应高于「减少首屏字节」。

### 2.2 打包安装形态（真实用户形状，补齐第一轮空白）

用 `scripts/perf-audit/prepare-packaged-form.mjs` 组装 `app.isPackaged === true` 的硬链接树（Electron dist + 重命名 exe + `runtime/versions/18.12.6-studio.9` + `runtime-keys`），隔离 profile，Chromium 内 DNS 映射到 NOTFOUND 以阻止更新下载。

四次运行（`r2-packaged*`，隔离 profile；窗口与可交互是 Playwright 口径，阶段是应用自身 `desktop.startup` 日志口径）：

| 运行 | 窗口出现 | 可交互（静默帧） | FCP | Runtime 相关阶段（应用日志，spawn 起） |
|---|---:|---:|---:|---|
| 首启 A（全新 profile） | **856 ms** | 1,507 ms | 228 ms | `smoke-test: ok` +10.8 s → `runtime.seed` +10.8 s |
| 首启 B（另一全新 profile） | 901 ms | 1,558 ms | 236 ms | `runtime.seed` +9.0 s → `runtime.resolve` **+17.6 s** |
| 首启 C（全新 profile） | 1,029 ms | 2,183 ms | 296 ms | `stage=host 73.7 ms` → `stage=window-load 234 ms` → `stage=seed 8,441 ms` |
| 二次启动 D（C 的同一 profile） | 2,220 ms* | 3,120 ms* | 228 ms | `stage=host 57.7 ms` → `window-load 164 ms` → `stage=seed 2,856 ms` → `runtime.resolve` 日志 @**+19.6 s** |

\* D 的窗口/可交互被「前一次运行仍在退出」的进程回收干扰（本机 n=1），**不要当作稳态**；D 的日志阶段仍可用。

**读法（重要）**：

- **好消息**：`deferredRuntime` 生效，**窗口不再等 Runtime**，打包形态窗口 **0.86–1.03 s** 就能出现（第一轮观察到的 17.2 s 是「整条后端就绪」口径，不是窗口口径）。
- **坏消息**：**managed Runtime 就绪仍在 ~18–20 s 量级**（本机、隔离 profile）：首启 `seed`（拷贝 219 MB 载荷 + 跑一次 `omp.exe` smoke test）约 8.4 s；二次启动仍观察到 2.9 s 的 seed 与 19.6 s 的 resolve。
- **归因与保留**：本形态没有真实安装记录（隔离 profile），`seed` 是否在真实安装态重复执行、`resolve` 的 19.6 s 里有多少是「冷文件缓存 + Defender 扫描 173.8 MB ×3–5 次」尚不能完全拆分；**这一项需要在真实安装机复测**（§9 局限）。但它与 §6 的「每次启动 3–5 次全文件哈希 + 探针」机理一致，方向可信。
- **对产品的含义**：窗口快了，但用户在「窗口已出现、Runtime 还在转」的十几秒里看到的是一个**连接中界面**（本机实测 `showsConnecting=true`）。这十几秒的「半可用」比「先白屏再出窗」更容易被感知为故障，需要 §8 的「分段就绪 + 轻量骨架 + 阶段文案」。

### 2.3 空闲 60 s：动画 A/B（同一会话内切换 CSS，机器负载恒定）

`app.getAppMetrics()` 每秒 1 次，30 s/相位；`anim-off` = `animation:none;transition:none`；`effects-off` = 再去掉 `backdrop-filter/filter/box-shadow`。

| 相位 | 总 CPU（各进程求和） | GPU 进程 CPU | Renderer(Tab) CPU | 总 RSS | 宿主 busy |
|---|---:|---:|---:|---:|---:|
| 出厂态（可见、无操作） | **2.87%** | 1.51% | 1.31% | 860 MB | 16.0% |
| 动画全关 | **0.25%（−91%）** | 0.08% | 0.14% | 798 MB | 10.2% |
| 动画 + 滤镜/阴影全关 | 0.26% | 0.08% | 0.15% | 782 MB | 13.7% |

**结论**：可见空闲的 CPU **91% 来自 CSS 动画**，且几乎全部落在 GPU 进程（合成）与 Renderer（逐帧重绘）；把动画停掉，内存还顺带降 60–80 MB。

### 2.4 动画清单与「L2 真实收益」

用 `document.getAnimations()` 在首屏（全新 profile 的默认界面）实测：

- 出厂态：**10 个动画，其中 3 个无限**：`pi-breathe`、`ce-sheen`、`omp-text-breath`。
- 按 GPU 审计给出的 **L2 覆盖块**（只关 `backdrop-filter`/`box-shadow`/`background-filter` 与热力图扫光，不动其它动画）：无限动画 3 → 1（只剩 `omp-text-breath`），**同一会话内 CPU 3.53% → 2.30%（−35%）**。该轮的出厂态相位测得 3.53%，比 §2.3 的 2.87% 高（run-to-run 波动），所以这里只读同轮相对变化。
- 全部动画停掉：0.25%。

**关键洞察**：**留下唯一那条 `omp-text-breath`（动 `text-shadow`，非合成属性，逐帧重绘）就吃掉了约 2 pp**，即空闲 CPU 的大头是**一条**动画。修它比修「所有动画」划算得多：把 `text-shadow` 动画改成 `opacity`/`transform`（或空闲 2 s 后停），预计可直接从 2.87% 降到 **0.5–0.8%**，无需牺牲视觉。

> 说明：`gpu-lowspec.md` 的「首屏 380 个动画目标」是**会话空态**（`ConversationEmpty`，371 格热力图 + 扫光 + 呼吸），与本轮「全新 profile 默认界面」不是同一屏；两屏都需要改，但**默认界面这条 `text-shadow` 是所有用户每次启动都会看到的**，优先级更高。

### 2.5 6× CPU 降速（低配代理，CDP `Emulation.setCPUThrottlingRate{rate:6}`）

| 场景 | 墙钟 | Script | Layout | 长任务 | 掉帧率 | 最差帧 |
|---|---:|---:|---:|---:|---:|---:|
| 切页面 / 开 Agent Hub 与技能抽屉 | 5,190 ms | 565 ms | 239 ms | **21** | 4.0% | **1,008 ms** |
| composer 输入 200 字符 | 8,864 ms | **3,529 ms（17.6 ms/字符）** | 542 ms | 0 | 6.0% | 112 ms |
| 滚动 | 1,671 ms | 20 ms | 163 ms | 0 | 0% | 29 ms |
| 面板开合 | 1,428 ms | 68 ms | 141 ms | 0 | 0% | 67 ms |

- 6× 大致对应「4 核低压 / 老双核」的单核水平。**输入路径是低配机最疼的一条**：200 字符要 3.5 s 脚本时间，键盘回显必然粘滞；页面切换有 1 s 的最差帧。
- 滚动与面板开合在 6× 下仍然健康（脚本 20/68 ms），说明**列表滚动不是当前瓶颈**，瓶颈在「输入」与「首访页面」。

### 2.6 交互增长与内存（20 轮 × 11 个动作，每 5 轮强制 GC 后取样）

| 检查点 | JS Heap | DOM Nodes | Event Listeners | LayoutObjects |
|---|---:|---:|---:|---:|
| baseline（GC 后） | 8.87 MB | 1,377 | 408 | 1,149 |
| cycle 5 | 10.67 MB | 1,519 | 409 | 1,255 |
| cycle 20 | 13.56 MB | 1,624 | 409 | 1,255 |
| idle 15 s（GC 后） | 13.47 MB | 1,615 | 409 | 1,246 |

- **无泄漏迹象**：listeners 恒定、LayoutObjects 恒定、idle 后回落。`+4.7 MB / +247 nodes` 与「每轮 `Ctrl+Shift+O` 新建一个会话、侧栏多一行」一致，不是无界增长。
- 但**「每轮新建会话」会让侧栏与历史列表线性变长**，300+ 会话后是 §1.2 #10 的虚拟化问题，不是内存问题。

### 2.7 GPU 判定：第一轮的「矛盾」已解

| 判据 | 硬件合成（正常） | 软件合成（`--disable-gpu`） |
|---|---|---|
| `app.getGPUFeatureStatus()` | `gpu_compositing: enabled`、`2d_canvas: enabled` | **`gpu_compositing: disabled_software`**、`2d_canvas: unavailable_software` |
| `app.getGPUInfo("basic")` | `gl=none, angle=none`、`skiaBackendType=None`、全部 `active=false` | **逐字段完全相同** |
| `app.getGPUInfo("complete")` | 可区分（D3D11 / GaneshGL / WARP） | 可区分 |

**结论**：第一轮 §2.5 的「feature status 与 GPUInfo 互相矛盾」是因为**用错了字段**——`basic` 不区分软/硬合成。判据应取 **`featureStatus` 的 `gpu_compositing`/`2d_canvas` 是否带 `_software` 后缀**（或 `complete`）。据此，第一轮观测到的 GPU 进程 1.26% CPU 是「硬件合成在跑动画」，不是软合成。
**实测软件合成代价**：总 CPU 2.87% → **4.66%（+62%）**，GPU 进程 1.51% → 3.11%（×2.06），GPU 进程 RSS 407 MB → 122 MB，总 RSS 反降 266 MB（动画停掉后渲染层内存也降）。→ **降级策略只能是「少画」，不是「退回软件渲染」**。

---

## 3. 启动性能

### 3.1 建窗前仍在付的成本（`composition.ts:190-192` 仍 `await hostFactory.create()`）

第一轮的 S1「窗口先建 + lazy transport」**只落地了一半**：分支把 **Runtime 段**延迟（`host-factory.ts:676` `deferredRuntime:true` + `host-composition.ts:1521` 不 await `startup.ready()`），但 **Host 壳段仍挡在窗口前**。建窗前串行链（`desktop-startup.md` §0.1，逐行核对）：

| 建窗前项 | 位置 | 代价（实测/推断） | 形态 |
|---|---|---|---|
| `updateCoordinator.initialize()` → `currentManifest()` → **173.8 MB 全量 sha256** | `update-coordinator.ts:107,202` → `installer.ts:344-363` | 本机 ~90 ms（快盘）；HDD/Defender **0.5–3 s** | 仅打包态 |
| `whoami.exe` + `icacls.exe` 两个子进程 | `host-factory.ts:391-426` | 22–29 ms + 19–22 ms（实测） | 全部 |
| `awaitLoginEnvironment()`（macOS 登录 shell） | `host-factory.ts:700` → `platform/login-env.ts:185` | 超时 **10 s**；慢 profile（nvm/conda）1–10 s | 仅 macOS |
| trusted-key 目录扫描 ×2（main + composition 重复） | `main.ts:221-227`、`host-composition.ts:1442-1447` | 数百 µs–数 ms | 全部 |
| `workspaces.json` / thread-bindings 读盘 | `host-factory.ts:704`、`host-backend.ts:43` | 小 | 全部 |
| `await import("electron-update-adapter.js")` | `main.ts:260` | 73 个 CJS 模块 / 245 KB | 仅打包态 |

**结论**：dev 形态下这段 ≈0.15–0.25 s；**打包 + 已装 Runtime 的机器上 0.3–1.5 s**（macOS 慢 profile 可到 1–10 s）。`§2.2` 的打包实测窗口 856–1,029 ms 与此一致。

### 3.2 首屏产物：实测 2.36 MB JS（不是 3.5 MB）

`startup-probe` 的 `reloadCost` 用 CDP Network 统计同一文档 reload 的真实传输字节：

| 资源 | 字节 | gzip |
|---|---:|---:|
| `index-*.js`（entry） | 1,491,553 | 469,305 |
| `vendor-*.js` | 677,282 | 207,834 |
| `react-*.js` | 193,701 | 60,199 |
| `modulepreload-polyfill` + `_commonjsHelpers` | 827 | 591 |
| **首屏 JS 合计（5 个 script）** | **2,363,363（2.25 MiB）** | **≈738 KB** |
| `index-*.css` | 424,249 | 69,523 |
| `icon.png`（favicon + 品牌图，未压缩 342 KB） | 342,071 | 342,071 |
| **首屏总传输（8 请求）** | **3,130,995** | **≈1.12 MB** |

- 第一轮 §10 建议的「首屏 JS 上限 3.6 MiB」是按 **3.5 MiB 估计**定的，**本轮实测只有 2.25 MiB**；门禁应按实测重定（§10）。
- 仍可削减：i18n 中英双份 **171,690 B**（entry 的 11.5%）+ preview fixture **71 KB**（发布态开关 false 仍入 entry），合计约 **−140 KB min / −82 KB gzip**（`renderer-runtime.md` §N1/N2）；另有 `icon.png` **342,071 B** 被 favicon 与品牌图同时引用，压到 64–128 px WebP/PNG 约 15 KB，**−327 KB**（首屏传输的 10.5%）。
- **CSS 424 KB / 4,123 条规则 / 50 个 `@keyframes`** 全量首屏生效（`gpu-lowspec.md` §1.6）：不是当前瓶颈，但它是动画整改的「成本池」，值得按 L1 方案裁剪。

### 3.3 Runtime 段：探针 + 验签是启动后半段的主要成本

- **探针**：`runtime.probe` 每次 resolve 都起一次 `omp.exe`，本机 probe stderr 从 `cli:load:launch:start` 到 `:done` **≈1.2 s**（打包实测日志，`r2-packaged2` run2）；打包/播种路径另有一次 `smoke-test`（`runtime.self_check`）。
- **哈希**：`resolveRuntime` 在 probe 前后各 `fingerprintExecutable` 一次（`runtime-resolver.ts:319/359`），`currentManifest()` 再对 entrypoint 做一次 `verifyFileChecksums`（`installer.ts:363`），`host-backend.resolve` 又调 `currentManifest()`（`host-backend.ts:46`）。**一次 resolve = 3 次 173.8 MB 读了**；打包态叠加 update coordinator 与 `usage.get` 的同类调用，第一轮与本轮都观察到**每次启动 3–5 次**。
- **块大小**：本机快盘 sha256 173.8 MB ≈ 90 ms；**HDD 顺序读 100–150 MB/s + Defender 实时扫描**，单次 1.2–1.8 s，5 次即 **6–9 s**——这是低配机启动不可用的主要来源之一。

---

## 4. 运行性能（渲染与交互）

### 4.1 一次击键的成本（R1 复核：比第一轮更重）

链路（`renderer-runtime.md` §R1）：`ChipComposer.emit()` 5–6 次 setState + 3 次 DOM 走查 + 1 个 rAF（`ChipComposer.tsx:177-212,500`）→ `WorkbenchCanvas setDraft`（`App.tsx:3477`）→ `AppShell setComposerDraftsBySession`（`App.tsx:6511,6526-6541`，比较函数永不相等）→ **AppShell 58 处 state**、约 **7,240 行**组件体重渲（`AppSidebar`/`AppTopbar`/`WorkbenchCanvas` 均无 `memo`）。

- 新增成本：`useComposerCollisionCollapse`（`App.tsx:3325-3388`）用 `MutationObserver(characterData)` + rAF + **写后读 forced layout**，**每键一次**。
- 修正第一轮：租约 `block()` 仍跨进程，但 Main 侧按签名去重（`conversation-views.ts:47-48`），**每键只有 1 次 IPC**，不是 2 次。
- 实测：6× 降速 **17.6 ms 脚本/字符**（≈1× 2.9 ms），掉帧 6%。中英文长输入在低配机上必然粘滞。

### 4.2 页面切换与懒加载

- 页面级懒加载**已完成**：10 个 `lazyPanel` + 1 个 `React.lazy`，首访 chunk 9.5–263 KB；mermaid 不再预加载。
- 6× 下「切页面 + 开 Agent Hub/技能抽屉」有 **21 个长任务、最差帧 1,008 ms、4% 掉帧**：首访要动态拉 chunk + 挂载整页（Agent Hub 未拆分未虚拟化），**低配机每个新页面第一次打开都会明显卡一下**。
- 建议给 `DeferredPanel` 的 `Suspense` 回退加**静态骨架**（CSS only，无 JS），把「白一下」变成「骨架一下」。

### 4.3 列表、长文与定时器

- 真虚拟列表仍只有 1 个（对话流）+ 1 个手写窗口（`App.tsx:1111-1128`）；8 个列表全量 `map`（诊断日志、Skills、AgentHub jobs、历史 200 条、文件树等）。
- 助手正文无 `content-visibility`；长 transcript 首屏布局成本随行数线性增长。
- **8 处未按 `document.hidden` 门控的定时器**，最值得先改：`AgentHub.tsx:1377`（5 s 整页重渲 3,335 行）、`HomePage.tsx:496` / `ConversationEmpty.tsx:83`（30 s，见 §6.2）、`jobs.css` 相关的轮询。
- `memo` 仍 12 处、`useDeferredValue`/`startTransition`/防抖**全库 0 处**——但**不要先补 memo**：`renderer-runtime.md` 的结论是「先把状态下沉 + 用 transition，再考虑 memo」，每处 memo 都是新的失效点（React 官方也是这个顺序）。

### 4.4 内存（正面基线）

Engine/Store dispose 完整、模块级缓存全部有界、监听平衡（167/163）；本轮 20 轮压力无泄漏（§2.6）。空闲 RSS 860 MB（硬件）/ 595 MB（`--disable-gpu`）——**0.9 GB 是偏松的预算**：VS Code 官方硬件要求是「1 GB 内存」整机可用（见 §7）。

---

## 5. CPU / GPU 与空闲功耗

### 5.1 空闲功耗：91% 是动画，且一条 `text-shadow` 动画占大头

| 状态 | 总 CPU | 说明 |
|---|---:|---|
| 硬件合成、出厂态 | 2.87% | GPU 1.51% + Tab 1.31% + Browser 0.05% |
| 硬件合成、动画全关 | **0.25%** | 地板 |
| 硬件合成、L2 覆盖块（只剩 `omp-text-breath`） | **2.30%** | 说明剩下那条 text-shadow 动画 ≈2 pp |
| 软件合成、出厂态 | **4.66%** | 软合成 +62% |
| 软件合成、动画全关 | 0.23% | 软合成本身不贵，贵的是动画 |

**行动**：`omp-text-breath`（`workbench.css:4013/4065`）改成 `opacity`/`transform` 或首屏 2 s 后停；`ce-sheen`（`workbench.css:6572`，动 `background-position`）改 `transform` 扫光；空态 371 格热力图 staggered 入场只对前 ~60 格 stagger；`magic-kw-shimmer`（每字符一条无限 `filter` 动画，且会话正文恒开）改静态渐变。**这四项都是 CSS-only，无判定逻辑、无回滚风险。**

### 5.2 软件合成（核显 / VM / RDP）的代价与探测

- 实测：`--disable-gpu` 下总 CPU +62%、GPU 进程 CPU ×2.06、rAF 头寸 −18%、RSS −265 MB。**降级到软件渲染不是解法，减少绘制才是。**
- 现状：零探测、零提示、零开关（全库 0 命中 `getGPUFeatureStatus`/`appendSwitch`/`disableHardwareAcceleration`）。
- 推荐实现（`gpu-lowspec.md` §5）：Main 在 `gpu-info-update` 后读 `getGPUFeatureStatus()` → 落 `data-gpu="software"`；`hardwareConcurrency` / `deviceMemory` / `powerMonitor.on-battery` 落 `data-perf="low"` / `data-motion`；首帧前读 localStorage 缓存避免闪烁；设置页给「硬件加速 / 减少动效」开关；诊断页展示最近一次探测结果。
- **判据必须是 `featureStatus`（`_software` 后缀）或 `complete`；`basic` 不可用**（§2.7）。

### 5.3 低配分级 L0–L3（可直接落地）

| 级别 | 触发 | 动作 | 预期 idle CPU |
|---|---|---|---:|
| L0 | 默认（硬件合成） | 只做「动画整改」：6 条非合成动画改合成属性、死循环动画限一次、`magic-kw` 静态 | ~0.5–0.8% |
| L1 | `data-motion="off"`（用户设置 / reduced-motion） | `animation-duration .01ms; iteration-count 1`；skeleton 静态；进度条改静态块 | <0.3% |
| L2 | `data-gpu="software"`（`*_software` / WARP / SwiftShader） | L1 + `backdrop-filter/box-shadow` 全关、`--bd-blur:0`、`.bg-media/.cmdk-glow` 去 `filter`、371 格热力图动画与扫光停、`magic-kw` 静态 | <0.25% |
| L3 | `data-perf="low"`（≤4 GB / ≤2 核 / HDD / 电池） | L2 + 长文 `content-visibility`、虚拟列表 overscan 减半、首屏 chunk 更激进懒加载、流式 publish 降档 | 目标 <0.2% |

设置页落点：外观/性能「减少动效」「硬件加速」两个开关（默认 auto）；诊断页显示探测结果与「重新探测」。**默认策略：不静默回退软件渲染，只降绘制**（Chromium 已弃用静默 SwiftShader 回退，理由同样是「回退体验差」）。

---

## 6. Host / IPC / Runtime（运行期常量成本）

线上流量本身不是问题（`host-ipc-runtime.md` 实测口径 0.03–0.5 MB/s）；问题是**每个事件被物化 6–8 次**，以及两条「与用户操作无关」的常量路径。

### 6.1 每个流式事件克隆 2 次整包快照（P0）

`facade.ts:1447` 的 `structuredClone` 被 `:1507`（只为判 `!== undefined`）与 `:1840`（只为读 `runtimeEpoch`）各调用一次；快照含 agents/jobs/telemetry，体积随 Agent Hub 库存线性增长。

- 实测单价（node v24.13.0）：13 KB → **63 µs**；254 KB（120 agent / 200 job）→ **810 µs**。
- 换算：重快照会话流式期 **≈10% Main 单核 + 32 MB/s 垃圾**；`conversation.open` 排空 500 事件时单 tick **0.8 s 纯克隆**。
- 改法：给 runtime access 加零拷贝只读 seam（只读字段直接读原对象，或提供 `epoch()`/`hasSnapshot()` 极窄接口），不改安全语义。

### 6.2 `usage.get` 每 30 s 触发 173.8 MB 哈希（P0）

链路已验证：`HomePage.tsx:496` / `ConversationEmpty.tsx:83`（`USAGE_POLL_MS = 30_000`，均无 `document.hidden` 守卫）→ `omp-usage-adapter.ts:376`（`locateOmp()` 在节流判断**之前**）→ `host-composition.ts:971` → `installer.ts:340-366` → `signed-artifact.ts:99`。

- 稳态 **5.8 MB/s 磁盘顺序读**、约 0.3% 单核（快盘）；HDD + Defender 每 30 s 卡 0.5–2 s。
- 改法：`locateOmp` 缓存 Runtime entrypoint（以 `current.json` mtime/version 失效）+ 轮询加 `document.hidden` 守卫；顺带修 §1.2 #2 与 #3 可共用一份「验签证据缓存」。

### 6.3 整包快照随 `stateVersion` 下发，隐藏窗口照收（P1）

`facade.ts:1633-1638`（`kind:"snapshot"`）→ `host-client-api/events.ts:290-315` → `ipc.ts:142-146`。每轮 5–20 次 × 13–254 KB = **0.07–5 MB/轮**；隐藏/最小化窗口同样付。第一轮 H2 只对「对话 delta」做了 250 ms 合并，**快照/telemetry/PTY 仍未降采样**。

### 6.4 `conversation.open` 双投递（P1）

`conversation-coalescer.ts:94-113` 单 tick 同步 flush ≤500 事件 / 1 MiB；`conversation-events.ts:135` 在 open 时 `flush(sessionId)`；同一批事件同时出现在**事件通道与查询结果**里，渲染层 `conversationEngine.ts:74` 才去重。每个被 flush 的事件还要走 §6.1 的 2 次克隆。

### 6.5 Runtime→Host 的「背压」是丢帧闸门（P1）

`overlay/.../bridge-server.ts:208-228` 在 `pendingBytes > 8 MiB` 时**丢帧**；丢帧 ⇒ `eventSeq` 断号（`runtime-projection.ts:86-89`）⇒ Host 强制整快照 resync（`bridge-client.ts:680-692`）。Host→Renderer 段（`ipc.ts:142-146`、`terminal-ipc.ts:52-54`）**仍无任何流控**。

### 6.6 PTY 与终端（P0 之一）

`terminal-pty.ts:330-332` 每个 chunk 直接 `sender.send` → `terminal-ipc.ts:50-59`，无 8–16 ms 合批、无 watermark、无 `xterm.write` 回调流控；录制中每 chunk 多一次 `JSON.stringify`（`terminal-recording.ts:57`）。
**可直接抄的官方默认值**：VS Code `TerminalDataBufferer` 默认 `throttleBy = 5 ms`；xterm 官方流控指南给出一帧 16 ms 预算、缓冲硬上限 50 MB、watermark HIGH ≤ 500 K。

---

## 7. 低配置运行性能

### 7.1 目标机型与放大模型

| 机型 | 假设 | 主要放大项 | 当前预期 |
|---|---|---|---|
| 主流轻薄本（4C/8G/SSD/核显） | 单核 ≈0.6× 参考机 | 动画（GPU 软合成）+ 输入 | 可用；空闲 2–3% CPU、长会话切换 200–500 ms |
| 低配（2C/4G/HDD/核显） | 单核 ≈0.25×，磁盘 10× 慢 | **5 次 173.8 MB 哈希（6–9 s）** + seed + 动画 + 输入 | **启动半可用 10–20 s；输入明显粘滞；挂机风扇转** |
| VM / RDP | 软件合成 | 动画 + `backdrop-filter` | 空闲 CPU 4.7%+，滚动掉帧 |
| macOS Apple Silicon | 单核较好、登录 shell 慢 profile | `awaitLoginEnvironment` 10 s | 启动可能被 1–10 s 拖住 |

### 7.2 6× 降速实测（低配代理）说明了什么

- **输入**：17.6 ms 脚本/字符 → 低配机每字符约 25–40 ms（按单核差 4–6× 推算），输入框会出现「打字落后」。
- **首访页面**：1 s 最差帧 → 低配机 2 s+，用户会以为卡死。
- **滚动/面板开合**：6× 下仍健康，说明这两条不需要优先优化。
- **空闲**：与机型无关，动画成本在核显/软件合成上更高（+62%）。

### 7.3 最差路径组合（固定验收场景）

「预览关 + 大仓库文件树搜索 + 一条 5,000 行助手消息 + 底部日志 200 条 + 最小化后流式继续」：同时命中 §1.2 #4（每事件克隆）、#9（open 排空）、#10（列表/长文）、§5（动画）、§6.3（隐藏窗口快照）。**建议作为低配专项固定用例**，验收指标见 §10。

### 7.4 低配机缺口

本轮**没有真实 2C/4G/HDD/核显机器**；6× 只代理 CPU，不模拟磁盘与 GPU 带宽；打包形态是隔离 profile 的近似。**建议采购/借用一台「刚好能装 Win11」的机器（2C/4G/HDD）做一次基线**——这也是 VS Code 的做法（perf bot 固定参考机）。

---

## 8. 与主流方案对照（带来源）

完整对照与 54 条链接见 `outputs/perf-audit-round2/mainstream.md`；这里只列对本项目最有决策价值的部分。

| 维度 | 主流做法 | 本项目现状 | 差距判断 |
|---|---|---|---|
| 启动可观测性 | VS Code：`code --status`、`--prof-startup`（三进程）、`F1 > Startup Performance`、**阻塞贡献 >5 ms 就 WARN** [wiki](https://github.com/microsoft/vscode/wiki/%5BDEV%5D-Perf-Tools-for-VS-Code-Development)、[lifecycle.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/lifecycle/common/lifecycle.ts) | 只有 Host 日志时间戳；无 main/renderer 统一 mark、无用户可见分段、无预算门禁 | **大且最划算**：不追秒数，追「可回归」 |
| 启动期校验 | 主流没有「每次冷启动全量验签」的对等物；Electron 官方 checklist 明确「不要过早加载/执行」 [perf](https://www.electronjs.org/docs/latest/tutorial/performance) | 3–5 次 173.8 MB sha256 + 探针 | **本项目特有**，需靠证据缓存降本 |
| 首屏产物 | 路由级/视图级 chunk [React lazy](https://react.dev/reference/react/lazy) | 2.36 MB JS / 424 KB CSS，mermaid 已拆 | **中**：切分做了，缺字节预算门禁 |
| 输入路径 | `useDeferredValue` 可被下次击键打断 [uDV](https://react.dev/reference/react/useDeferredValue)、`startTransition` [sT](https://react.dev/reference/react/startTransition) | 0 处 transition/deferred，58 state 的 AppShell 每键重渲 | **大**：先状态下沉 + transition，别先补 memo |
| 长内容 | `content-visibility:auto` + `contain-intrinsic-size` [web.dev](https://web.dev/articles/content-visibility) | 工具卡有、正文没有 | **中** |
| PTY / 高频流 | VS Code `throttleBy=5ms` [terminalDataBuffering.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminalDataBuffering.ts)；xterm 流控 [flowcontrol](https://xtermjs.org/docs/guides/flowcontrol/)（16 ms 帧预算 / 50 MB 上限 / HIGH ≤500 K）；Electron MessagePort [message-ports](https://www.electronjs.org/docs/latest/tutorial/message-ports) | 逐 chunk 发、无流控、无 MessagePort | **中**：有官方默认值可抄 |
| GPU / 降级 | 显式探测 + 提示 + 逃生口：Obsidian 有 Hardware Acceleration 开关 [settings](https://obsidian.md/help/settings)；Warp 把 Metal/Vulkan 写进最低要求 [warp](https://docs.warp.dev/getting-started/readme-1/installation-and-setup)；Chromium 已弃用静默 SwiftShader 回退 [swiftshader](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md) | 零探测、零开关、零提示 | **大**：但解法是「显式探测 + 降绘制」，不是静默降级 |
| 空闲功耗 | `backgroundThrottling` 默认开但**一个 webContents 关掉整窗继续出帧** [webPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)；动画只用 transform/opacity [animations-guide](https://web.dev/articles/animations-guide)；Lighthouse `non-composited-animations` [lh](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations) | 可见空闲 2.3–4.7%，3 条无限动画（含 text-shadow/background-position） | **中**：机制清楚，缺硬约束 |
| 低配/电池 | `powerMonitor` on-ac/on-battery/thermal [power-monitor](https://www.electronjs.org/docs/latest/api/power-monitor)；`prefers-reduced-motion` [prm](https://web.dev/articles/prefers-reduced-motion) | 无分级、无电池/热信号、无 reduced-motion | **大** |
| 硬件门槛（参照） | Win11 最低 2C/4G/DX12 [MS Learn](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)；VS Code 要求 1.6 GHz/1 GB [requirements](https://code.visualstudio.com/docs/supporting/requirements) | 空闲 RSS 0.86 GB（接近 VS Code 整机门槛） | **预算偏松**，需按进程归因 |

**口径警告**（`mainstream.md` §4）：首屏体积是 raw/reload 口径（本轮实测 2.36 MB JS），行业多报 gzip；「VS Code 1 秒启动」是传闻（官方无公开 SLA）；空闲 2.3–4.7% 含背景负载；低配收益是机理推演，非真机。

---

## 9. 性能优化方案（P0 / P1 / P2）

> 原则：先做「不改架构、收益可实测」的，再做「需要协议/结构变更」的；每条都给出验收口径，避免「感觉快了」。

### P0（本迭代，收益最大、风险可控）

| # | 动作 | 落点 | 预期收益 | 成本 | 验收 |
|---|---|---|---|---|---|
| P0-1 | **动画整改**：`omp-text-breath` 改 `opacity/transform` 或 2 s 后停；`ce-sheen` 改 `transform` 扫光；空态 371 格只对前 60 格 stagger；`magic-kw-shimmer` 静态化 | `workbench.css:4013/4065/6572/3956`、`activityHeatmap.ts:86-103`、`magicKeywordMarkdown.tsx` | 可见空闲 **2.87% → <0.8%**（实测地板 0.25%）；软合成机器同样受益 | 低（CSS + 少量 TSX） | 60 s 空闲 CPU 均值 <1%，无限动画数目标 0 |
| P0-2 | **验签证据缓存**：`fingerprintExecutable` 按 `(path,size,mtime,fileId)` 缓存；`currentManifest()` 以 `current.json` mtime+version 为键 memo；`locateOmp` 复用 resolve 结果 | `runtime-resolver.ts:231-235,319,359`、`installer.ts:340-366`、`host-composition.ts:971` | 启动 **−0.1~2 s**（HDD 6–9 s）；稳态磁盘 **−5.8 MB/s** | 中高（安全评审） | 二次启动哈希次数 ≤1；`usage.get` 不再读 exe；签名仍逐次校验元数据 |
| P0-3 | **零拷贝快照 seam**：`hasSnapshot()/runtimeEpoch()` 或只读引用 + 显式 `clone()` 边界 | `facade.ts:1447/1507/1840` | 重快照会话 Main **−10 pp**、GC 32 MB/s；open 500 事件 0.8 s → ms 级 | 中 | 流式期 Main CPU 采样；open 到首帧 <100 ms（500 事件） |
| P0-4 | **PTY 合批 + 流控**：Main 侧 8–16 ms 合并；`xterm.write` 回调 + watermark（HIGH 500 K / LOW 100 K） | `terminal-pty.ts:330`、`terminal-ipc.ts:52`、渲染层 `terminalSessions.tsx` | IPC 消息 **−5~20×**，大输出长任务显著减少 | 中小（半天-1 天） | `npm run dev` 刷屏 10 s 的 IPC 计数与长任务 |
| P0-5 | **击键路径**：草稿状态下沉到 composer 局部 + `useDeferredValue`/`startTransition`；去掉每键 forced layout（改为 `ResizeObserver`/节流） | `ChipComposer.tsx`、`App.tsx:3325-3388,6511,6526-6541` | 6× 下 **17.6 → <8 ms/字符**；1× 下无感 | 中（状态语义要重设） | 4× 降速击键 p95 <8 ms；AppShell 重渲次数=0/键 |
| P0-6 | **GPU/动效探测通道**：`data-gpu`/`data-motion`/`data-perf` + 设置开关 + 诊断页字段 + L1/L2 CSS | Main `gpu-info-update` → preload → renderer；`styles/*` | 软合成 / 核显 / 电池场景 idle **−60%+** | 中 | `--disable-gpu` 下 idle <0.5%；设置开关即时生效 |

### P1（本迭代或下一迭代）

| # | 动作 | 预期收益 | 备注 |
|---|---|---|---|
| P1-1 | `show` 提前 + 静态骨架（`security.ts:307` 现在只绑 `ready-to-show`），主题先持久化到 Main 防暗色闪白 | 感知启动 −200~500 ms | 观感收益大于实际关键路径 |
| P1-2 | `startup.start()` 延后到 `did-finish-load`（`host-composition.ts:1520`） | 首帧少抢 I/O/CPU；实测探针 ≥1.2 s | 需保证「打开会话」前 Runtime 就绪的等待语义 |
| P1-3 | macOS `awaitLoginEnvironment` 并行化/超时缩短（`host-factory.ts:700`、`login-env.ts:185`） | macOS 慢 profile 建窗 −1~10 s | 仅 macOS |
| P1-4 | `conversation.open` 单投递 + 分批（`conversation-coalescer.ts:94-113`、`conversation-events.ts:135`） | 开大对话 −150~400 ms | 需协议收敛 |
| P1-5 | 长文 `content-visibility` 分块 + Top-4 列表虚拟化 | 长 transcript/大列表 −150~400 ms | 先 CSS 后结构 |
| P1-6 | i18n 单语言动态 import + preview fixture 动态化 + `icon.png` 压缩（342 KB → ~15 KB，favicon 单独出小图） | 首屏 −140 KB JS（min）/ −82 KB gzip / −327 KB 图片 | 低风险 |
| P1-7 | 8 处定时器加 `document.hidden` 守卫（AgentHub 5 s、usage 30 s 优先） | 隐藏态唤醒 −60%+ | 低风险 |
| P1-8 | Main 用 esbuild 打包（283 模块 / 1.99 MiB → 少数文件） | 主进程启动 −50~150 ms | 中等，需改构建脚本 |
| P1-9 | 隐藏/最小化窗口对 `state.changed`/telemetry/PTY 降采样（`ipc.ts:142-146`） | 后台 CPU/带宽 −30~70% | 配合 §6.3 |
| P1-10 | 把 `App.tsx` 的 58 个 state 拆到域 store（`useSyncExternalStore` + 选择器），去掉「一次击键整壳重渲」的根因 | 全壳重渲成本 −50%+ | 结构改动，回归面大 |

### P2（结构调整，回归面大）

- MessagePort 直连（终端 + 流式帧）：`MessageChannelMain` + `webContents.postMessage('port')`。
- `app://` 协议替代 `file://`：**先验证** code cache 收益（第一轮 S6 未决；本轮未测）。
- GPU 显存/进程内存归因进诊断（Electron 43 无 `sharedBytes`，只能近似）。
- artifact catalog 缓存（`artifact-library.ts:58-79`，上界 32 MiB/50k 记录）。
- 打包态性能基线与 CI 门禁（见 §10）。
- 动画/动效治理规范（新组件必须用 transform/opacity；`prefers-reduced-motion` 全覆盖）。

---

## 10. 性能门禁与可观测性建议

现有门禁（`npm run perf:streaming`、`render-work-bench.mjs`）只覆盖流式帧代价与高亮 Worker。建议补五条**低成本、防回归**的检查，放在**手动触发**的 perf workflow（不进日常 CI）：

1. **产物预算门禁（秒级，只读 dist）**：`dist/index.html` 的 `modulepreload` 集合必须等于白名单（react/vendor/polyfill/commonjsHelpers）；首屏 JS ≤ **2.5 MB raw / 800 KB gzip**，CSS ≤ **450 KB**。按本轮实测（2.36 MB / 738 KB / 424 KB）设初始值，随优化阶梯下调。
2. **启动门禁**：Main 埋 6 个 mark（`main.entry`/`whenReady`/`host.ready`/`window.show`/`did-finish-load`/`first-interactive`），取 5 次中位；判定用「比值不回退 >10%」，不写死绝对毫秒（固定参考机）。
3. **交互门禁**：`scripts/interaction-perf-gate.mjs`，4× 降速下「击键 p95」「页面切换往返」「500 条列表开页」三项，中位不回退 10%。
4. **空闲门禁**：可见静置 60 s 与最小化 60 s 的 Browser/Renderer/GPU 三进程 CPU 均值 **<0.5%**（目标）/ **<1.0%**（门禁），最小化 <0.2%；同时断言无限动画数 = 0（loading 类除外）。
5. **常量路径门禁**：稳态 5 分钟、无用户操作时，Host 对 Runtime 文件的磁盘读 **<5 MB**、`currentManifest`/`fingerprintExecutable` 调用次数 ≤1（用现有诊断计数器）。

**可观测性**：把 `desktop.startup stage=...` 的最近一次分段做成诊断页卡片（数据已在 Host 日志里），低配用户报障不用装 Profiler；同时把本轮 §9 的验收指标写进 `docs/performance.md` 的预算表。

---

## 11. 复现命令（本轮实测）

```bash
# 0) 构建（本轮 HEAD 3c6cbdc，构建日志 outputs/perf-audit-round2/build.log）
npm run build:packages && npm run build -w @omp-studio/renderer && npm run build -w @omp-studio/desktop

# 1) 启动（冷+热各 3 次；dev-unpackaged，隔离 profile）
PERF_AUDIT_REPORT=outputs/perf-audit-round2/raw/r2-startup.json \
  node scripts/perf-audit/startup-probe.mjs --runs 3 --scenario both --tag r2

# 2) 空闲 A/B（出厂态 / 动画关 / 动画+滤镜关，30 s 每相位）
node outputs/perf-audit-round2/probes/idle-variants.mjs --tag r2-idle-baseline --seconds 30
#    软件合成对照（--disable-gpu）
node outputs/perf-audit-round2/probes/idle-variants.mjs --tag r2-idle-gpuoff --seconds 30 --disable-gpu

# 3) 动画清单 + L2 覆盖块真实收益
node outputs/perf-audit-round2/probes/anim-l2-probe.mjs --tag r2-anim-l2 --seconds 30

# 4) 6× CPU 降速（低配代理）
PERF_AUDIT_REPORT=outputs/perf-audit-round2/raw/r2-throttle-6x.json \
  node scripts/perf-audit/throttle-probe.mjs --rate 6 --tag r2-throttle-6x

# 5) 交互增长 / 泄漏检查（20 轮 × 11 动作，强制 GC 后取样）
node outputs/perf-audit-round2/probes/growth-probe.mjs --cycles 20 --tag r2-growth

# 6) 打包安装形态（硬链接树 + 隔离 profile；DNS 阻断更新下载）
node scripts/perf-audit/prepare-packaged-form.mjs
node outputs/perf-audit-round2/probes/packaged-playwright.mjs --tag r2-packaged2 --settle-ms 6000
```

---

## 12. 局限与未验证

**测量口径**

- **宿主负载 10–17%**：CPU 绝对值是上界；所有关键结论都来自同轮 A/B（动画开关、GPU 开关、6× 降速），不依赖跨轮数字。
- **打包形态是近似**：`prepare-packaged-form` 用重命名 exe + 硬链接 Runtime 模拟 `app.isPackaged`，**没有真实安装记录**；`seed`/`resolve` 的 8.4 s / 19.6 s 不能直接当真实用户的稳态值（真实机器可能更快或更慢）。**需要在真实安装机上复测**（建议用 Host 日志 `desktop.startup stage=...` 对齐）。
- **「冷启动」不是真冷**：未清 OS 文件缓存；每形态 n=3，只报中位/最差。
- **6× 只代理 CPU**：不模拟 HDD 顺序读、GPU 带宽、内存压力；没有真实 2C/4G/HDD 机器。
- **增长测试是合成动作**：每轮新建会话会自然增加 DOM 行，不能据此断言「无泄漏」以外的结论。

**结论边界**

- **Runtime 探针的 1.2 s 与 seed 的 8.4 s 未拆分到毫秒级**：需要 Main 侧 mark 或打包态诊断。
- **GPU 真机矩阵缺失**：本轮只有「硬件（RTX 4080 + 虚拟显示适配器）」与「`--disable-gpu`」两档；核显、RDP、VM 的 `featureStatus` 需真机补测。
- **`file://` 下 Blink 磁盘代码缓存是否生效**：第一轮未决；本轮未测，别把「换 app://」当既定收益。
- **未覆盖**：真实供应商长会话（MB 级 transcript）、SSH 远程工作区、macOS 实测、终端大输出实测、`artifact catalog` 真实规模。
- **本轮未修改产品代码**：所有 P0/P1 都是方案，不是已实现。

---

## 13. 证据索引

| 主题 | 文件 / 命令 |
|---|---|
| 桌面启动链路（建窗前成本、5 次哈希、macOS 登录 shell、main ESM 体积） | `outputs/perf-audit-round2/desktop-startup.md` |
| 渲染层运行期（击键、懒加载、i18n/fixture 首屏、定时器、内存卫生） | `outputs/perf-audit-round2/renderer-runtime.md` |
| Host/IPC/Runtime（每事件克隆、30 s 哈希、open 双投递、丢帧闸门、PTY） | `outputs/perf-audit-round2/host-ipc-runtime.md` |
| GPU/合成层/低配（23 条动画清点、380 目标空态、L0–L3、Electron 43 事实表） | `outputs/perf-audit-round2/gpu-lowspec.md` |
| 主流对照（54 条外链、VS Code/Electron/Chromium/xterm/Obsidian/Warp/Windows 阈值） | `outputs/perf-audit-round2/mainstream.md` |
| 启动原始样本 | `outputs/perf-audit-round2/raw/r2-startup.json` |
| 空闲 A/B 原始样本 | `raw/r2-idle-baseline.json`、`raw/r2-idle-gpuoff.json` |
| 动画清单 + L2 | `raw/r2-anim-l2.json` |
| 6× 降速 | `raw/r2-throttle-6x.json` |
| 交互增长 | `raw/r2-growth.json` |
| 打包形态 | `raw/r2-packaged.json`、`raw/r2-packaged2.json` |
| 构建产物 | `apps/renderer/dist/index.html`、`apps/renderer/dist/assets/*`、`outputs/perf-audit-round2/build.log` |
| 既有基线 | [performance.md](performance.md)、[performance-report-2026-09-24.md](performance-report-2026-09-24.md)、[performance-audit-2026-10-29.md](performance-audit-2026-10-29.md) |

---

*本轮为只读审查：未修改任何产品代码、未提交构建产物。所有测量探针都使用隔离 profile（`--user-data-dir` + 隔离 `%APPDATA%`/`%LOCALAPPDATA%`），不读写用户真实配置目录。*
