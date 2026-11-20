# OMP Studio 运行性能审查

2026-11-19，以 `6e89725` 为基线。在 Windows x64、i9-13900HX、32 个逻辑处理器、约 32 GB 内存和 RTX 4080 Laptop GPU 上测量。Electron 为 43.8.8，浏览器流式基准使用 Chromium 151.0.7922.34。Electron 的 GPU 信息确认通过 ANGLE / Direct3D 11 做硬件合成。夹具使用独立配置和合成数据，模型调用次数为零。

## 同机对照

| 操作和测量口径 | 基线 | 改动后 |
| --- | ---: | ---: |
| Host 投递 10,000 次文本增量并维护回放，5 次中位数 | 160.6 ms | 15.6 ms |
| Host 解码 770,111 字节的 Bridge 帧，每片 1 KiB，7 次中位数 | 89.5 ms | 3.3 ms |
| 同一帧，每片 16 KiB | 7.1 ms | 3.6 ms |
| 同一帧，一次交付 | 2.9 ms | 3.0 ms |
| Bun 1.4.4 中的 Runtime 解码器，同一帧、每片 1 KiB，7 次中位数 | 27.2 ms | 1.1 ms |
| 浏览器连续接收 6,000 次工具输出，ASCII，5 次中位数 | 396.8 ms | 4.4 ms |
| 同一负载，中文混合 emoji | 796.9 ms | 5.3 ms |
| 24,000 行、约 42.4 MiB 的已保存评测报告，从第 601 行读 30 行，5 次中位数 | 101.1 ms | 65.5 ms |
| 同次翻页，相对开始前的 V8 堆占用采样峰值增量 | 62.4 MiB | 6.6 MiB |
| 32 个网格共用一张 512 × 512 贴图，两种采样设置，实测 WebGL 纹理存储分配数 | 32 | 2 |
| 同一场景加载后，Windows 记录的 GPU 进程专用显存增量，两轮范围 | 83.2–88.4 MiB | 41.8–47.1 MiB |
| 从挂载相同 3D 场景到首张 WebP 预览图可用，5 次中位数 | 162.6 ms | 36.0 ms |
| 正式入口静态导入的 JavaScript，原始字节 / gzip 字节 | 3,634,803 / 1,171,903 | 3,320,988 / 1,072,837 |

工具输出基准通过真实 `ConversationStore.applyEvent` 投递，末尾发布一次快照。它测量积压数据进入 Store 的成本。3D 基准挂载真实 `GraphicScene`，用 WebGL 调用计数，并在模型仍挂载时采集 Windows 专用显存。相同运行环境内，两版预览图的 SHA-256 完全一致。评测报告以独立 Node 进程运行，每 2 ms 采样一次堆，包含行内容解析和垃圾回收波动。首屏体积按生产 HTML 的静态导入递归统计，桌面从磁盘读取原始字节。

## 改动与覆盖面

| 部分 | 实现和验证 |
| --- | --- |
| Runtime、Host、IPC | 两端的 Bridge 解码器直接解析完整帧，分片帧按接收量成倍扩容，累积复制量随输入线性增长。长度检查先于分配。回归覆盖输入缓冲区复用、拆开的长度头、粘连帧和错误后关闭。Runtime 补丁集升至 `18.20.2-studio.16`。 |
| 对话、工具、终端 | Host 只在接近分块上限时重新编码文本。Renderer 以 UTF-8 字节数维护工具输出尾窗，旧快照中的字符串保持稳定。流式验收检查跟底、切换、长历史、卡片展开和工具交接。终端另外通过 PTY 合批、流控和渲染组件回归。 |
| 图形、文件预览 | Worker 对同一纹理地址合并解码，场景内按图片共享 Three.js 的纹理数据源，各材质保留自己的 UV 变换和采样设置。33 种材质引用同一图片的 OBJ 现在能打开并只解码一次。 |
| 评测历史 | 遍历 JSONL 时记录键的首次位置，只保留当前页正文。后续同键更新仍覆盖该位置，计数、导出和重启读取沿用原语义。翻页仍需扫描日志，磁盘读取量会随报告增长。 |
| 首次教程、工作台 | 教程图例通过不透明度切换高亮，背景模糊独立于对话框，舞台高亮层缩至实际矩形。实测同一页面中英文来回切换时，五行图例的位置和页面实例保持稳定。工作台启动包由 Rollup 按使用位置放置其余第三方依赖，按需图表的依赖可随图表加载。 |
| 文件浏览器与磁盘 | Windows 旧路径的容量查询超时后仍可能占着 Host 的文件系统请求。本机一次检查的 10 项断言均已通过，进程却持续驻留。新实现先读取系统实际分配的盘符，再由独立进程并行读取容量。实测两个本地卷返回容量，一个卷显示未就绪，专项检查约 7 秒正常退出。辅助进程的冷启动会计入首次卷列表耗时，本机一次约 0.8 秒。 |
| 其他组件 | 单独运行 Agent Hub、模型配置、设置、诊断、后台任务、文件窗口、文件浏览器、终端、评测及选择性提交等组件用例。Dock、历史、审批、浏览器标签、工作区文件、用量轮询等也在项目核心回归中覆盖。 |

## 空闲、帧和资源寿命

原生 Electron 分别测首次教程、关闭教程后的工作台和最小化窗口。两份生产 Renderer 使用同一 Desktop / Host，独立配置，按旧、新、新、旧交替。每个状态采 8 次进程 CPU 与工作集，并对 Windows GPU 进程的 3D 引擎原始计数取时间差。视口为 1282 × 802 CSS 像素，缩放为 125%。

| 状态 | 旧版进程 CPU 合计 | 新版进程 CPU 合计 | 旧版 3D 引擎 | 新版 3D 引擎 |
| --- | ---: | ---: | ---: | ---: |
| 首次教程播放中 | 2.34–3.06% | 1.02–1.58% | 9.41–24.86% | 6.98–25.04% |
| 工作台可见空闲 | 0.10–0.22% | 0.05–0.08% | 0.04–0.30% | 0.02–0.04% |
| 窗口最小化 | 约 0.07% | 0.06–0.07% | 0% | 0% |

教程采样窗口内，Chromium 样式重算累计从 676–958 ms 降至 14–20 ms。教程播放时两版的 GPU 引擎占用范围重叠，这组样本不足以判断 GPU 利用率的变化趋势。新工作台可见空闲时，Electron 各进程工作集之和约 1.23–1.24 GiB，包含共享内存页。显存收益采用上表同一模型的专用显存增量。

生产流式基准每个场景运行 3 次，每次测 90 帧。短历史、长历史及长历史叠加工具卡展开的最终 p95 帧间隔均为 4.0 ms，各场景中位样本均有 0 帧超过 48 ms。Chromium 的回调节奏约为 256 Hz。工具输出从 1,200 行增至 2,400 行时，DOM 节点数均为 684。18 项流式检查全部通过。

卡片展开探针现在等待种子数据中正在运行的卡片完成自动展开，再开始测用户点击。原探针把两段高度动画叠在一起，旧版一轮因此报出 3.8 px 位移。最终实测 0.6 px，阈值仍为 1.5 px。探针起点的修正单独计入测量方法变更。

另用真实 Electron、IPC 和 Host 读取 16 个合成归档，在同一 Desktop / Host 上交替装载两份生产 Renderer。每版两轮，首次打开不同会话共 6 次，点击到正文就绪的中位数为 316.3 → 281.2 ms。再次切换共 8 次，中位数为 280.0 → 234.7 ms。这段计时包含读档与界面过渡。另一次快速切换和阅读位置检查通过，结束时后台读取数与脱离的宿主节点数均为零。

生产文件模式还覆盖 100 个代码块的高亮、Mermaid 队列、主／子会话反复挂载和原生窗口隐藏／恢复。回收后 Engine 和 Store 数量回到零，空闲 31 秒后高亮 Worker、等待任务和槽位订阅数均为零。实际使用数小时后的内存曲线、macOS、Linux、集显、软件渲染和 SSH 实机延迟仍待单独测量。

## 复测入口

- `npm run check -- --production` 已通过，包含类型检查、核心回归、Renderer、preload 与远端 Host 生产包。另测 14 个组件套件共 183 项，全部通过。`npm run test:tooling` 通过 152 项，跳过 1 项。Runtime 源码校验、`omp:verify:patches`、Bun 类型检查与 smoke 均通过，专项检出恢复干净。
- Host 热路径用 `PERF_INCREMENTAL_REPLAY=1 node scripts/host-replay-bench.mjs`。帧与生命周期用 `scripts/streaming-perf-gate.mjs` 和 `scripts/render-work-bench.mjs`。前者选择 `PERF_BUILD_MODE=production`，后者选择 `PERF_BUILD_MODE=file`。
- 会话切换用 `node scripts/native-session-perf.mjs --smoke`，阅读位置可追加 `--verify-reading`。生产入口体积用 `node scripts/renderer-assets.mjs apps/renderer/dist`。本机本轮的原始采样、专项负载脚本与日志位于忽略目录 `outputs/perf/hardware-review-20261119-1304/`。
- CPU 与内存采用 Electron 的分进程采样方法，浏览器用 CDP 记录脚本、样式和布局，显存另外读取 Windows 的 GPU 进程计数器。实现依据见 [Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)、[Chromium 渲染阶段](https://web.dev/articles/rendering-performance)、[Three.js 纹理数据源](https://threejs.org/docs/pages/TextureSource.html)和 [Windows GPU 引擎与显存计量](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)。

## 2026-11-20 复验

以 `821bc22` 的生产构建为开发基线。使用同一台 Windows x64、i9-13900HX、RTX 4080 Laptop GPU、260 Hz 显示器的机器。由真实组件消费独立配置中的合成数据，模型调用数为零。

| 场景 | 第一版 | 完善版 |
| --- | ---: | ---: |
| 40.3 万三角形 PLY 冷挂载的同步任务，五组中位数 | 62.3 ms | 23.4 ms |
| 同一模型冷挂载期间的 WebGL 绘制与 WebP 海报次数 | 各 2 次 | 各 1 次 |
| 接近 8 MiB 的 WRL 贴图从 Worker 投递到 Renderer，五组中位数 | 6.6 ms | 0.3 ms |
| 24,000 行已完成评测报告暖翻页，读取 30 行 | 66.2 ms | 2.2 ms |
| 24 个代码块滚动时的滚轮响应 p95，五轮 p95 的中位数 | 32.3 ms | 20.8 ms |
| 同一滚动场景中的实际 Composer 输入响应 p95 | 16.9 ms | 13.6 ms |
| 16 个原生归档，点击后事件循环恢复时间的冷切中位数 | 74.1 ms | 65.9 ms |
| 同一组归档的暖切中位数 | 96.1 ms | 86.2 ms |

PLY 的生成法线由解析 Worker 计算并和几何一起进入现有缓存。比较样本的法线和海报哈希，海报编码沿用原时序。挂载期测试按实际调用统计 WebGL 绘制次数，静态等尺寸回调跳过绘制。WRL/X3D 只在 Worker 到 Renderer 的边界转移每块底层缓冲区一次，iframe 继续读取 Renderer 持有的缓存数据。

评测分页索引保留首见的键顺序和同键最后一条记录。旧文件和新写入共用 JSONL 格式。索引只保留最近一个终态报告，偏移表最多 2 MiB。活动报告、导出、重跑失败项继续使用原有数据读取路径。专项覆盖 UTF-8 跨块、CRLF、追加、替换和重启。

真实会话测试使用正文、工具卡和实际 Composer，分别渲染 1、4、24 个代码块，输入由 Chromium 驱动注入按键和中文组合事件。24 块的场景快速滚动经过 19 块正文，同屏最多两个已着色块。比较紧凑 token、直接 DOM 提交、分帧提交及 CSS 隔离后，采用局部 CSS 隔离。轻量场景的帧间隔 p95 均约 7.7 ms，暗色和浅色的嵌套斜体、字重、文本选区与横向滚动通过等价校验。

带 JS 栈的切换跟踪定位到阅读列在写入布局标记后读取 Composer 队列高度。候选版在三次冷切中移除了该处三次 647 节点样式重算。表中的切换时长来自其他未开启跟踪的轮次，原生读取和草稿恢复另有验收。输入延迟为浏览器事件到下一帧后的任务，帧间隔来自浏览器调度。Windows 进程采样分别记录私有内存与 GPU 专用显存。

在合并前的主分支和集成分支各自构建生产资源。两边使用相同样本、独立配置、交替顺序。比较静态入口依赖时只沿桌面入口的静态导入计算原始字节，另检查桌面、图形和移动端三个 HTML 的资源。给需要复验的代码路径保留以下入口。

```bash
npm run check -- --production
npm run runtime:verify-source
npm run omp:verify:patches
PERF_INCREMENTAL_REPLAY=1 node scripts/host-replay-bench.mjs
PERF_BUILD_MODE=production npm run perf:streaming
PERF_BUILD_MODE=file node scripts/render-work-bench.mjs
node scripts/native-session-perf.mjs --smoke --trace --verify-reading
node scripts/renderer-assets.mjs apps/renderer/dist
```

本机专项脚本、集成版对照原始数据和运行日志保存在忽略目录 `outputs/perf/refine-20261120/`。
