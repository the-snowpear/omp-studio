# 流式性能维护

OMP Studio 的流式管线继续使用 Runtime Bridge、Host conversation 事件、Renderer 有界 Store 和现有 Markdown 扫描器。优化不改变持久 transcript，也不删除 IPC 校验或 Renderer transport 的克隆隔离。

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

Runtime 修改仍按 `npm run omp:overlay:apply` → vendor 编辑 → `npm run omp:patches:regen`。`npm run omp:verify:patches -- --skip-workspace-check` 要求 vendor 干净，会应用并在 finally 清理补丁/overlay；全仓 `npm run check` 必须另外通过。不要在未回收的 vendor 改动上运行清理。

验收数据及未覆盖范围见 [本次性能报告](performance-report-2026-09-24.md)。RSS 未马上下降不单独判失败；以 provider/listener/pending/Worker 计数及三批操作后的 retained heap 为准。若计数稳定而 RSS 持续上涨，另做诊断，不自动增加强制 GC 或杀进程策略。
