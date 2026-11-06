# 流式性能维护

0.2.0 新功能的持续运行审查见 [2026-11-06 报告](reviews/0.2.0-performance-review-2026-11-06.md)：评测读取合并与隐藏暂停、浏览器存档写入收敛，以及首屏体积、后台网页与大型报告的后续优化空间。

启动/整壳订阅、按需加载和资源体积的后续优化见 [2026-10-29 报告](performance-2026-10-29.md)；第二轮综合审查（打包形态、GPU 软合成、6× 低配、动画 A/B）见 [performance-review-2026-10-29-round2.md](performance-review-2026-10-29-round2.md)。`scripts/startup-perf.mjs` 单独测完整 App 合成夹具，不代替真实 Runtime 启动数据；性能脚本支持用 `PERF_URL` 连接已启动的生产验证页面。

OMP Studio 的流式管线继续使用 Runtime Bridge、Host conversation 事件、Renderer 有界 Store 和现有 Markdown 扫描器。优化不改变持久 transcript，也不删除执行服务的安全检查或 Renderer transport 的克隆隔离；固定可信 Main 输出不重复做逐字段解析。

## 数据路径与所有权

Runtime 维持原有 16ms 合流。Host 在校验 Runtime 原始事件序列之后、分配 conversation `streamSeq` 之前，对后台目标做 250ms 缓冲。Facade 在其后分配全局 cursor，因此不在 IPC 出口删除已编号事件。

Host 仅拼接相邻、目标及块身份一致的 ASCII 文本或工具 append。replace、结构变化和截断标记变化保留边界。非 ASCII 增量保留原事件边界：UTF-8 头截断和不完整代理对在某些上限位置不满足合并结合律。缓冲会延后这类中间更新，但不承诺减少它们的 IPC 事件数。Runtime→Host 原始管道流量不在本次降低范围内。

审批、错误、收据发布和断连先排空 pending，再交付控制状态。`conversation.open` 在返回 replay/watermark 前同步排空目标。epoch 改变丢弃旧 pending，旧异步结果不会写入新目标。

可见性来自两个信号：Renderer 真正显示的 pane 租约，以及 Main 的窗口显示/最小化状态。多个窗口取可见目标并集；失焦不降级。child pane 使用 `conversation.open` 返回的 child ID 和 epoch。演示 fixture 不登记；旧 preload 缺方法时保留旧前台行为。Renderer 在 document hidden 时用定时器替代 RAF；状态立即入 Store，中间快照最多每 250ms 发布，结构事件立即发布。Chromium 仍可能进一步限制隐藏页计时器，恢复可见时同步补齐。

| 资源 | 所有者与预算 | 释放时机 |
|---|---|---|
| Host 工具 replay | 每工具最多 256KiB 头部文本；最多 1,024 片，超过后压为约 8Ki UTF-16 单元的页 | tool complete、turn 更换、LRU 淘汰、dispose；turn 终态物化后释放片段 |
| Host 后台缓冲 | 每 controller 最多 500 个原事件、1MiB（含原始 envelope JSON 的保守计数） | 250ms、控制屏障、打开/切前台、满额立即排空；旧 epoch/dispose 清空 |
| Renderer Store | 原有 2,000 items / 24MiB 窗口、live 限制与 120 挂载行上限 | 目标切换或 pane 关闭；Engine/Store getters 在 dispose 后只返回空快照 |
| Mermaid | 自动渲染最多 20,000 UTF-16 单元、600 行、启发式分数 1,500；串行，等待最多 8；缓存 32 项 / 4MiB | 卸载取消等待；不可中断的实际渲染完成前不释放串行槽；结果禁止回写已取消订阅 |
| 高亮 Worker | 懒启动，`max(1,min(2,floor(cores/2)))`，未知核心数用 1；队列 32 项 / 2MiB 源码；缓存 128 项 / 8MiB | 队列无人订阅则删除；实际运行超过 5 秒终止 Worker；空闲 30 秒终止；页面关闭/HMR/teardown 清场 |
| 高亮 token | 输入沿用 96Ki UTF-16 单元资格；输出最多 40,000 节点、深度 64、序列化 2MiB | 只接受白名单 class 的 span/text；异常保留原文，不自动退回主线程重计算 |
| 诊断 provider / timer | 进程内计数读口，不持有正文副本 | 对应 Engine/Store/controller/Runtime 生命周期结束时注销 |

缓存预算是源码与序列化结果的 UTF-8 逻辑字节数，不是实际 V8 retained heap。Mermaid 复杂度分数为行数加边特征数加节点特征数，是启发式预算。大 SVG 可供当前组件显示，超过单项缓存预算则不缓存。

## 高亮与回滚

未闭合围栏继续立即使用 CodeFrame 显示等宽正文。已闭合代码先显示同一个外框，再仅替换 `<code>` 内着色节点。复制内容、外框身份和滚动位置保持一致。正常路径用 lowlight 3.3.0 / common 语言集；不猜无语言块、不替换配色、不改 Markdown 切点。Worker 输出通过 React 安全构建，不注入 HTML。

生产构建默认使用 Worker；开发模式默认保留原 rehype-highlight 路径。这个差异来自同机实测及项目负责人的选择：生产高亮压力场景收益明显，React 开发模式的额外更新反而增加总开销。下面都是内部环境变量，不进入设置页或 Studio Bridge。

| 开关 | 默认 | 设为 `0` 的效果 |
|---|---|---|
| `OMP_INCREMENTAL_REPLAY` | Desktop 开 | 恢复累计字符串 replay |
| `OMP_CONVERSATION_PARSER_REUSE` | 开 | 每次完整解析；边界校验始终保留 |
| `OMP_BACKGROUND_COALESCING` | Desktop 开 | Host 恢复立即交付 |
| `VITE_OMP_BOUNDED_MERMAID` | 开 | 使用原 Mermaid 组件 |
| `VITE_OMP_HIGHLIGHT_WORKER` | production 开，dev 关；`1` 可显式启用 | 使用原主线程高亮路径 |
| `VITE_OMP_BACKGROUND_PUBLISHING` | 开 | Store 恢复原 RAF 调度 |
| `VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE` | 未设 | `1` 禁用开发态每 10 秒 marks/measures 清理；生产始终不启动清理器 |

`OMP_*` 在启动 Main 前设置；`VITE_*` 需要在 dev 启动或 build 前设置。Engine 正确释放、校验和诊断字段限制属于正确性要求，不提供使泄漏复现的产品开关。某优化正确性失败必须修复；性能不达标时关闭对应开关，不放宽预算。

## 本地诊断

评测的 `evaluationPolling.ts` 在每个读取作用域内只保留一个在途读取，期间的多次变更合成一次补读。窗口隐藏时取消计时，重新可见时刷新；状态入口隐藏时不订阅，后台任务仍由 Host 运行。详情维持 1.5 秒兜底、状态入口维持 5 秒兜底，历史列表按事件刷新。

`ManagedBrowserStore` 的页面更新只在持久化字段变化时排队写盘，加载状态、文档 ID、前进后退和 DevTools 状态仍即时通知界面。纯读取不创建空会话；未打开网页的会话释放也不创建记录。现有标签、控制权、权限与设置的保存格式不变。

Main/Host 处于同一 Electron Main 进程，只采样一次。Renderer 使用可用的 Chromium heap API；不可用时字段缺省。Runtime 从进程内部读取内存与已有标量计数，镜像纯数值 helper 由测试与 studio-protocol 钉齐，不读取 transcript、不调用 Bridge query、不触发 `ensureWorkerLive`。

常规采样 60 秒一次、不重叠；首次、显著变化、资源计数改变或 5 分钟心跳才写日志。heap 变化门槛 5%，RSS/external/ArrayBuffer 10%，绝对变化不足 1MiB 时忽略比值噪声。固定的 chrome IPC 对 Renderer 样本校验可信 sender、白名单字段、有限非负数、大小和 60 秒限频。Runtime 使用专门的 `[studio.performance]` 数值 stderr 行进入既有 Host 日志链，不从日志推导业务状态。

日志位于 `%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`，事件 `performance.sample` / `runtime.stderr`。`role` 为 `main-host`、`renderer` 或 `runtime`；`instance` 为进程内诊断序号，不是 PID。字段 `rssBytes`、`heapUsedBytes`、`heapTotalBytes`、`externalBytes`、`arrayBuffersBytes` 分开解释，不能相加；ArrayBuffer 可能已包含于 external。未知字段省略，不用 0 冒充未知。Runtime 的 `workerResidency` 编码依次为 active=0、sleeping=1、recycling=2、reviving=3、dormant=4、failed=5。

## 重复验证

先构建依赖，然后按范围运行测试。基准只使用合成 fixture，不读真实对话、历史 backup 或用户凭证。

```bash
npm run check
PERF_INCREMENTAL_REPLAY=0 PERF_BENCH_REPORT=outputs/perf/host-before.json node scripts/host-replay-bench.mjs
PERF_INCREMENTAL_REPLAY=1 PERF_BENCH_REPORT=outputs/perf/host-after.json node scripts/host-replay-bench.mjs

# Chromium 流式门禁：预热后每场景五次，保存中位数、最差值及原样本
PERF_TRACE=1 PERF_REPORT=outputs/perf/streaming-after.json npm run perf:streaming
# 在相同构建模式、机器、浏览器和开关对照下比较
node scripts/compare-streaming-perf.mjs outputs/perf/streaming-before.json outputs/perf/streaming-after.json outputs/perf/comparison.json
# 若连续批次存在明显顺序偏差，预先固定五组交替顺序；全部原始运行仍保存
node scripts/paired-streaming-perf.mjs

# 生产 harness 写入 outputs/，不修改产品入口
PERF_BUILD_MODE=production PERF_TRACE=1 npm run perf:streaming
PERF_BUILD_MODE=file PERF_REPORT=outputs/perf/file-smoke.json node scripts/render-work-bench.mjs
```

上面是 Git Bash 环境变量写法。Playwright/Chromium 必须已经安装；脚本不会改 package.json/lockfile 安装浏览器。`PERF_RUNS=1` 仅用于功能 smoke，不作为五次中位数性能验收。`PERF_TRACE=1` 在测试 harness 启用 Chromium timeline，报告 script/layout 任务 p95，另保留每帧 CDP 总耗时、RAF p95、输入事件至绘制延迟。产品不逐 token 计时或写日志。

`render-work-bench.mjs` 验证 100 个代码块、即时围栏、Mermaid、50 次主/子视图生命周期、缓存计数及空闲 Worker 归零。`file` 模式通过 Electron 加载生产文件，并另外启动未接 Playwright 的原生窗口验证最小化/恢复，避免自动化的焦点模拟掩盖 document visibility。

性能 workflow 只手动触发，日常 CI 与发布不运行基准。需要比较性能时使用上述命令，阈值和采样方式保持一致。

Runtime 修改仍按 `npm run omp:overlay:apply` → vendor 编辑 → `npm run omp:patches:regen`。`npm run omp:verify:patches` 要求 vendor 干净，会应用并在 finally 清理补丁/overlay；它是 Runtime 专项验证，独立于日常 `npm run check`。不要在未回收的 vendor 改动上运行清理。

验收数据及未覆盖范围见 [本次性能报告](performance-report-2026-09-24.md)。RSS 未马上下降不单独判失败；以 provider/listener/pending/Worker 计数及三批操作后的 retained heap 为准。若计数稳定而 RSS 持续上涨，另做诊断，不自动增加强制 GC 或杀进程策略。

## 0.2.0 优化轮（2026-10-30）

本轮把第二轮审查（[round2](performance-review-2026-10-29-round2.md)）里的 P0/P1 落成代码。执行记录、逐项证据与未验证部分见 [0.2.0-optimization-execution-report.md](0.2.0-optimization-execution-report.md)。这里只保留**维护者需要知道的常量与不变量**，改这些值时必须连同对应测试一起改。

### 空闲绘制

- 默认界面不再有无限动画。加载态的 `omp-spin` 与骨架 `omp-shimmer` 是仅存的两条无限动画，它们是状态指示器，不是装饰。
- 动画只允许用合成属性（`opacity` / `transform`）。`text-shadow`、`box-shadow`、`background-position`、`filter` 的无限动画会逐帧重绘，禁止新增。
- `prefers-reduced-motion: reduce` 与「减少动效」偏好走同一套 L1 规则（`apps/renderer/src/perf/tiers.css`）；L1 只把时长压到 0.01ms、迭代 1 次，不写 `animation: none`，否则 loading 指示器会消失。
- 分级 L0–L3 **只由 Main 判定**（`apps/desktop/src/perf-profile.ts`，判据 `app.getGPUFeatureStatus()`；`getGPUInfo("basic")` 无法区分软/硬合成，禁止用作判据）。渲染层不重新推导等级，只保存最新机器快照、叠加用户的减少动效偏好（用户只能更严），并在首帧前写**一个**属性：
  `<html data-perf-tier="L2 L1">` —— 值是"包含的层"集合（`L3` → `L3 L2 L1`，`L0` → `L0`），CSS 用 `[data-perf-tier~="L2"]` 选择。改等级只改 Main 的 `gradePerfProfile()`；改视觉只改 `tiers.css`。
  **降级是少画，不是退回软件渲染，也不是关校验。**

### Runtime 验签证据

- `RuntimeInstaller#currentManifest()` 每次仍完整验签（三份签名元数据 + ed25519），只有 entrypoint 的**字节**校验走证据缓存 `StatKeyedVerificationCache`。
- 缓存键 = 绝对路径 + `lstat` 身份（size/mtimeMs/inode/dev）+ assertion（校验类型、版本、期望摘要）；TTL 10 分钟；install/activate/rollback/uninstall/prune 一律 `invalidate()`；进程重启即空；执行边界（spawn 前）的指纹永远当场读。
- 三层失效（stat 身份、TTL、进程内 + 显式 invalidate）都是承重的，简化时必须保留。`mtime + size` 不能单独作为永久信任依据。
- 诊断：`installer.verificationStats()`（`contentHashes` / `cacheHits` / `singleFlightJoins` / `skippedBytes`）。执行边界指纹每次当场读取，不再描述已移除的 Host 指纹缓存。

### Facade 快照与 conversation.open

- `OperatorStateSnapshot` 在 facade 内部以只读引用传递（`#currentSnapshotRef()` / `#hasSnapshot()` / `#currentRuntimeEpoch()`），只在四个真正的出口拷贝一次：bootstrap、`home.get`、`session.state`、live telemetry 叶子。流式热路径与 `kind:"snapshot"` 事件零拷贝。
- `conversation.open` 的事件排空是**分片**的：默认 64 envelope 或 4ms 一片，`setImmediate` 让出；审批/回执/publication/runtimeLost 仍是同步屏障（`flush()` 语义未变）。事件顺序、watermark 与 epoch 隔离不变；outbox > 2,000 时退化为一次全量排空，避免把长 task 换成无界积压。

### PTY 与终端 IPC

- 合批窗口 8ms（半帧）；每会话一个 `StringDecoder`，跨 chunk 的半个码点会重组，不产出替换字符。
- 有界：每会话缓冲硬上限 2MiB，到上限**先暂停源再交付**，不丢字节；退出时先刷净缓冲再发 exit，并留一个合批窗口给 ConPTY 的尾行。
- 流控：渲染侧 `xterm.write` 回调 ACK，水位 HIGH 500KiB / LOW 100KiB（xterm 官方建议）。没有 ACK 的旧 preload 自动降级为"只合批、不暂停"。
- 输入通道不合批、不计水位。
- 单个 Buffer 批次直接解码，不再 `Buffer.concat` 复制；多个 Buffer 仍按顺序合并，`StringDecoder` 的跨窗口状态不变。
- 本地会话只有一份按 ID 索引的 owner/process/listeners/size/生命周期记录；自然退出进入 draining，不占运行限额。`TerminalOutputBatcher.finish()` 先排空、保留一个合批窗口，`close()` 取消尾部计时并最终解码，release 在输出之后只调用一次。本地/SSH 共用这套时序；录制在 final flush 后结束，窗口清理同时处理 running/draining。
- Renderer 仅在会话列表变化时重建 ID 索引。ACK 回调只捕获 id/bytes，不额外滞留整份 event/batch 正文；live/ended 逐批有序排空，ended 不拼接整个最多 3MiB 的 backlog，也不 ACK。图片转义剥离后仍按 wire bytes 计数；无 xterm 时不提前信用，超限丢弃保留显式通知。

### Composer 草稿与测量

- `composer/useComposerDraft.ts` 持有精确 live 草稿和稳定的发布回调；渲染视图保持 140ms trailing debounce。空/非空、图片、胶囊边界立即发布，状态签名用标量保存，不重复扫描旧快照；发送与排队读取 editor/live 而非延迟视图。
- 恢复/清空只写 editor 一次，立即发布该次 emit 的归一化快照；图片编号、目标级 draft book、页面导航和焦点规则保持不变。首次非空草稿显示侧栏临时会话行的壳渲染是状态边界，不当成连续击键回归。
- 胶囊结构变化保留同步编号/测量；宽度 ResizeObserver 与胶囊变化共用一个可取消 RAF，连续插入/删除每帧至多补测一次。普通字符不触发布局测量，卸载取消未执行的帧。

### 性能快照边界

- 完整字段解析只在 `perf-profile-cache.ts` 的磁盘缓存入口执行，固定可信 Main cached/probe/changed 通道不重复解析或复制字段；preload 仍冻结 API，保留 null/缺 handler/调用失败处理和原 listener 身份注销。sender 信任检查与 Main 的分级规则不变。
- `perf/tiers.ts` 预计算层数组与属性字符串，同值不 `setAttribute`；仍保留最新时间戳防回退、订阅后的主动 reconcile 和 dispose 后迟到 probe 不写 DOM。

### 局部性能对照（2026-10-30）

本轮合成测量输出在 `outputs/perf/local-refactor/`（忽略、不提交）：`before.json`、`after.json`，以及预先固定 A/B、B/A 交替顺序的 `paired.json`。每版本预热两次、采样五次，同机器/Node/负载比较中位数；复制字节和调用次数另外计数，不污染计时样本。

- 每 1,000 个 64KiB 单块批次消除 1,000 次 concat、62.5MiB 额外复制；多块 concat、输出字节与消息数一致。
- 每次连续插入 12 个胶囊，帧后扫描从 12 次减为 1 次；即时编号与测量不减少。同档位刷新 10,000 次，从 10,000 次属性 mutation 减为首次 1 次。
- Renderer/Composer 计时是 jsdom 的同步合成 workload，不是浏览器布局、FPS 或真实 IPC 吞吐；低频 profile push 的微基准不代表可感知的整壳收益。多块及中文计时有明显波动，保留原样本，不把未减少的复制宣称成算法加速。
- 行为回归覆盖 UTF-8、消费后 ACK、早到 create 数据、自然退出尾部、失败关闭恢复、草稿立即发送与目标切换；真实平台 ConPTY/SSH/macOS 的吞吐、RSS/retained heap 和整机 FPS 尚未量化。

### Dock 工作台

- 布局持久化按 200ms 合并写；scope 切换、draft 交接、`pagehide`、`beforeunload`、`visibilitychange→hidden` 同步刷盘。配额失败先精简载荷重试一次，再失败则本次会话不再写，且永不抛错。
- 支持 `moveBefore` 时，展开的对话工具卡将稳定的面板宿主置于卡片占位框内，正文随列表同步滚动和裁剪；嵌套滚动区到达边界时使用 `scrollChain.planScroll()` 接力，避免 Chromium 间歇性丢失滚轮步进。同文档移动保留活动内容；不支持 `moveBefore` 的浏览器与其他区域仍由固定宿主层承载，需要跨 DOM 交接时使用同一套滚动规划。
- 区域可见性在 reducer 末尾统一收敛（`settle()`）：右栏/底栏失去最后一个模块自动收起；左栏保留空态、对话工具区不动。只在最终提交状态判断，撤销/重做天然恢复。
- `MutationObserver` 只关心 dock 几何节点，面板正文内的流式 DOM 变化不触发测量；测量按 host 几何签名早退。

### 门禁

- 新增核心套件（`scripts/core-suites.mjs`）：Dock 模型/持久化/宿主/滚动交接、窄窗抽屉、GPU 分级与等级接线（`tiers.test.ts` / `tierControl.test.ts`）、用量轮询、IPC 订阅生命周期、Runtime 验签证据、快照克隆计数、open 分片、终端合批与流控。Composer 击键预算 `App.composerPerf.test.tsx` 单独运行，不放入默认门禁。
- 验收口径：默认界面可见空闲 CPU（自绘动画成本）目标 < 0.8%，无限装饰动画数 = 0；首屏 JS ≤ 2.5MB raw / 800KB gzip。真实数字与测量条件见执行报告，不把旧报告数值当成本轮结果。
