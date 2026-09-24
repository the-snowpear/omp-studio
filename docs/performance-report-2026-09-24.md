# 流式性能实施报告（2026-09-24）

本报告对应 `doc/streaming_rebuild.md`，在 `perf/streaming-rebuild` 分支继续原有 W01/W03/W05/W11 与部分 W00 提交，补齐回放、后台投递、数值诊断、Mermaid、高亮 Worker、浏览器验收和维护文档。本次接续由单一主代理执行，没有使用子代理。

## 默认状态

Host 增量工具 replay、解析器自有对象复用、Mermaid 预算/队列以及后台投递/发布默认启用。按项目负责人 2026-09-24 的明确选择，Worker 高亮仅生产构建默认启用；开发模式保留原路径。每项有独立内部回滚开关，详见 [维护文档](performance.md)。原有协议、前台刷新档位、Runtime 16ms 合流、Store/虚拟行预算和真实/预览数据边界保留。

## 环境与方法

- 本机 Windows、Intel Core i9-13900HX、32 个逻辑核心。
- Node 基准使用 Node v24.13.0。真实 Chromium 流式门禁使用 Chromium 151.0.7922.34，观测刷新率约 60Hz。
- 生产 `file://` harness 使用 Electron 43.4.0 / Chromium 150.0.7871.224 / Electron 内置 Node 24.18.1。不同构建模式和浏览器的数字不交叉比较。
- 每项性能结果预热后正式运行五次，记录中位数及最差值。流式开关对照另外使用五组交替 A/B 顺序，降低连续运行的顺序偏差。所有 fixture 都是测试合成数据。
- 原始 JSON、日志和构建 harness 在本机 `outputs/perf/`，不提交生成物。身份字段记录 commit、dirty 文件摘要、Node/浏览器、构建模式、CPU、刷新率（流式门禁）和开关；报告中的耗时不外推为所有机器上的固定收益。

## 分项性能

### W04 工具 replay

来源：最终源码的 `outputs/perf/host-final-before.json` 与 `host-final-after.json`，同一机器、同一 W04 基准，比较显式关闭/开启增量存储。接续初期的 `w04-takeover-before/after.json` 也保留，单独作为该阶段的记录。

| 场景 | 旧路径中位数 | 增量路径中位数 | 结果 |
|---|---:|---:|---|
| 5,000 × 41B append | 2,602.20ms | 15.04ms | 降低 99.4%，超过 20% 目标 |
| 每 50 次 append 读快照 | 2,351.84ms | 21.01ms | 无回归 |
| 累计后单次 snapshot | 0.386ms | 0.167ms | 物化未造成快照回归 |
| 500 × 64KiB replace | 127.52ms | 65.55ms | 单列结果，不承诺固定同等收益 |
| 中文/emoji 小增量 | 992.35ms | 51.53ms | 最终输出与旧语义对照一致 |

追加场景最差值分别为 2,883.90ms / 17.94ms。测试覆盖 JSON 转义、分开的 UTF-16 代理对、头截断、replace、complete/abort、watermark、克隆隔离、分片压实和释放。

### Worker 高亮

来源：`render-work-file-before.json` 与 `render-work-file-final.json`。每轮挂载/重挂 100 个不同 TypeScript 块，逐块检查即时 CodeFrame、完整文本、颜色、外框身份和高度。生产同构建方式对照：

| 指标 | 原路径 | Worker + 缓存 |
|---|---:|---:|
| 主线程 ScriptDuration 中位数 | 573.69ms | 209.57ms |
| 主线程 ScriptDuration 最差轮 | 588.17ms | 293.40ms |
| 输入事件至下一次绘制延迟 p95（全部探针样本） | 20.1ms | 5.9ms |

主线程耗时降低约 63.5%，通过 20% 目标。每轮 100/100 代码块着色成功，文本不匹配、外框重挂均为 0，着色前后高度差为 0。

开发态对照 `render-work-before.json` / `render-work-after.json` 为 1,079.52ms → 1,250.06ms（增加约 15.8%），未达到目标，所以不在 dev 默认启用 Worker。失败数据保留，未修改预算或把 dev 结果算作收益。

### 既有流式门禁

五组交替对照在 `outputs/perf/paired-streaming/`：十轮原有门禁均通过，聚合比较 `comparison.json` 通过。以下为每种配置五次的中位数，单位毫秒：

| 场景 | Script 任务 p95：前 → 后 | Layout 任务 p95：前 → 后 |
|---|---:|---:|
| 短历史 | 1.50 → 1.38 | 1.71 → 1.69 |
| 长历史 | 14.24 → 14.87 | 2.33 → 2.34 |
| 长历史 + 展开工具卡 | 1.58 → 1.65 | 1.97 → 2.02 |

全部满足不回退超过 10% 的门槛。小于 1ms 的基数保留计划允许的最多 1ms 绝对余量，未放宽既有布局比值、帧停顿、DOM 或 retained-heap 门槛。每帧 CDP 总耗时、RAF p95 与 trace 任务 p95 分开记录，不能混为同一个指标。

最初按两个连续批次运行的 `streaming-verified-before/after.json` 曾有部分对照超线；该记录保留。随后固定合成数据、门槛及构建配置，采用预先固定的五组交替顺序重新比较，结果如上。没有筛掉失败样本或选择其中最快的运行。

## 正确性与释放

- Host：10,000 次 ASCII delta 验证完整文本与连续 streamSeq；前台/后台目标不串流；249/250ms 假时钟边界、item/byte 满额排空、打开前 watermark 排空、审批/发布/断连屏障、epoch/dispose 清理均有覆盖。
- 非 ASCII 保留原事件边界，避免在 UTF-8 截断处改变结果。例如仅余 1B 时，先追加“中”再追加“a”与一次追加“中a”不等价。该保守规则不承诺减少中文/emoji 流的 IPC 事件数，但 Renderer 仍合并隐藏状态下的发布。
- `file://`：Worker 以自有构建文件加载，未使用 blob、远程 Worker、unsafe-eval；无页面错误。旧 preload 缺接口仍正常运行。
- 真实浏览器连续 50 次主/子视图生命周期，Engine/Store 登记数均从 0 回到 0；保留已 dispose Engine 引用时 getters 仍为空。
- 100 个代码块后高亮缓存 100 项、4,895,600 个逻辑字节；空闲 31 秒后 Worker/running/queued/slotListeners 都为 0。单测另覆盖缓存淘汰、输出节点/深度/大小限制、超时、乱序、崩溃重试及持续失败停止重启。
- Mermaid 压力场景观察到 1 项运行、7 项等待；卸载后 running/queued/slotListeners 全部归零。超预算源码保留且不生成 SVG；共享任务、LRU、不可中断渲染以及可见性竞态有独立测试。
- 未连接 Playwright 的原生 Electron 窗口实测最小化/恢复：隐藏时输入 10,000 个字符，恢复后一次发布完整文本。Windows Chromium 可把隐藏 timer 延后超过 250ms；恢复不依赖隐藏 RAF。
- Runtime 采样只读取进程内存和已有计数。Bun 测试覆盖 dormant 数值采样、异常隔离、无重复 timer、unref、dispose，以及原有 Worker 回收/恢复行为。

集成验证还发现并修复了一个原有切换问题：运行工具卡的入场展开会越过两帧隐藏稳定阶段，导致正文淡入后移动。现在仅在 `settling` 隐藏阶段停止内部高度过渡；可见交互与工具交接动画门禁继续通过。位置探针也改为在 ResizeObserver 贴底补偿之后读取真实绘制帧，仍保存原始逐帧位置。

## 验证记录与限制

`npm run check` 已通过：构建、类型检查及 1,703 项测试全部成功；Runtime helper 经上游格式器整理后，镜像语法结构测试和协议测试再次通过。Runtime 单独的 `bun run check:ts`（格式/静态检查/所有包类型检查）通过。

`npm run omp:verify:patches -- --skip-workspace-check` 已通过：85 个 overlay 文件、4 组接缝补丁完成应用、静态检查、Bun 回归和 smoke，vendor 恢复干净。`npm run omp:test:metadata` 的 47 项测试通过。源码 patchset 经规定的 regen 流程成为 `18.2.5-studio.9`。

生产构建 `PERF_BUILD_MODE=production PERF_RUNS=1 PERF_TRACE=1 npm run perf:streaming` 通过全部原有门禁；这一轮按功能 smoke 记录，不替代上面的五次性能对照。原始日志为 `final-check.log`、`final-runtime-source.log`、`final-runtime-patches.log`、`final-runtime-metadata.log`，生产 smoke 为 `production-streaming-smoke.json`。汇总及阈值判定在 `outputs/perf/streaming-rebuild-2026-09-24/baseline.json`。

本次未构建或安装新的签名 Runtime/安装包，没有改动用户当前安装的应用或 Runtime。验证覆盖源码、Bun 与测试用 Electron 生产文件，不代表已经发布新版。没有做长达数小时的真实供应商会话 RSS 测试；三批合成操作的 retained heap、DOM/listener 与确定性资源计数按现有门禁验证，生产不强制 GC 或定期杀 Runtime。
