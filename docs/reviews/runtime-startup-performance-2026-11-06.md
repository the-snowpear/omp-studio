# Runtime 启动与重连专项

日期：2026-11-06。Desktop/Host 修改基线 `ba93a9f`；Runtime 源码基线 `18.13.2-studio.43`，空会话修复经 regen 生成 `studio.44`。修改前恢复点为 `refs/backup/runtime-startup-20261106`，原 vendor diff 另存于 `.git/runtime-startup-20261106/`。

本轮确认并处理两个问题：大型文件校验存在较多小块读取开销；尚未发消息的空会话没有对应磁盘记录，强制重连会失败。性能结论采用交替对照的约 8% 启动改善，不采用顺序测量得到的约 45%。

**后续完整应用实测：** `studio.44` 在完整 Electron 应用中，安装后重新打开到 Runtime 就绪的中位数为 **10.18 秒**，首次包含安装为 **18.12 秒**。下文约 3.3 秒的数字是单独 Runtime 调用链的隔离基准，不能用作应用启动速度；完整应用数据见文末。

## 真实使用日志

用户 Host 日志中 2026-11-06 的一次启动：

| 阶段 | 耗时 |
|---|---:|
| 基础 Host | 61ms |
| 安装状态／播种检查 | 7,485ms |
| 兼容性解析与探测 | 6,058ms |
| 正式启动 | 3,506ms |
| 正式启动内部：launch.begin 到 handshake.ok | 1,329ms |

三个 Runtime 阶段合计约 17 秒。`launch.begin` 原来在安装清单校验之后才记录，因此仅看它到 ready 的时间会漏掉正式启动前的约 2 秒等待。前一天的多次记录也有相似分布；日志没有提供每次磁盘缓存、杀毒扫描或整机负载状态，不能把这些因素中的某一个直接判定为原因。

## 修改内容

### 1. 降低完整校验的读取开销

[`sha256File`](../../packages/runtime-installer/src/signed-artifact.ts) 与 [`readExecutableDigests`](../../packages/studio-host/src/runtime-resolver.ts) 使用 1 MiB 分块，替代 Node 文件流默认的 64 KiB。被测 Runtime 二进制为 439,037,440 bytes，一次扫描的块数由 6,700 降为 419；仍逐字节计算原算法的摘要，保留流式内存使用。

签名、受签名保护的摘要比较、探测前后两次完整内容指纹、兼容性握手、快照 smoke、干净退出检查及缓存失效规则均保持不变。扩充现有回归覆盖多 MiB 文件、末尾不足一块的数据和最后一个字节篡改。

[`runtime-session.ts`](../../apps/desktop/src/runtime-session.ts) 增加 `runtime.launch.stage`：`verify` 包括工作区和安装清单校验，`bootstrap` 是 Bridge 凭据准备，`handshake` 包括进程准备／启动／握手，其后是 `snapshot` 与 `manifest`。每项记录 generation、阶段耗时及累计耗时，不记录路径、PID、令牌或会话正文。

### 2. 修复空会话重连失败

真实 `18.13.2-studio.38` 二进制在创建空会话后第一次 `ensure({force:true})` 即退出，报 `Session "…" not found`。当前源码 `studio.43` 的回归测试同样确认：Bridge 已公布会话 ID，磁盘上却没有会话文件。上游 SessionManager 延迟创建文件，而 Host 已把该 ID 作为重连目标。

在 [`runStudioHostMode`](../../omp-patch/overlay/packages/coding-agent/src/studio/studio-host-mode.ts) 的 Bridge 启动前调用原生 `sessionManager.ensureOnDisk()`。这会让 Studio 的空会话提前拥有可恢复记录，保留原 ID 与已有状态，不伪造消息、不更换会话作为回退。Runtime 内部 Worker 回收原本已使用同一个原生方法。

新增测试使用真实 SessionManager，验证 Bridge 就绪时文件已存在，以及关闭后重新打开仍是同一 ID、消息列表仍为空。overlay 通过 `omp:overlay:apply` → vendor 编辑 → `omp:patches:regen` 回收；没有手改接缝补丁。

## 性能对照

环境：Windows / Intel i9-13900HX；Node 24.13.0。使用真实已安装的 `18.13.2-studio.38` 二进制，临时空工作区和隔离的 Runtime 配置，不恢复用户真实会话，不发送提示词。每次执行安装状态检查、完整解析探测、正式启动及连接确认。系统文件缓存未清空。

先按版本顺序各测 3 次得到 7.285s → 3.993s，但这个结果包含运行顺序与整机状态的影响。之后固定 A/B、B/A 交替顺序，两种分块各测 5 次，作为最终性能证据。交替脚本仅对 `omp.exe` 文件流切换读取大小，其余调用链、验证和 Runtime 二进制相同。

| 中位数 | 64 KiB | 1 MiB |
|---|---:|---:|
| 总启动 | 4,401ms | 4,046ms |
| 安装状态检查 | 342ms | 213ms |
| 兼容性解析／探测 | 2,355ms | 2,259ms |
| 正式启动 | 1,688ms | 1,612ms |
| 已连接时普通 ensure | 0.067ms | 0.063ms |

总启动中位数减少约 **355ms / 8.1%**。各阶段中位数不必相加等于总耗时中位数。所有 10 次均成功连接；旧读取的总耗时范围为 4.35–4.50 秒，新读取为 3.99–4.77 秒，后者有一次握手偏慢，原样保留。

新构建的 `studio.44` 另行安装到测试目录、完整验签与 smoke 后，对同一个空会话执行 10 次 `ensure({force:true})`。每次均成功，始终保留初始会话 ID。该新二进制下，64 KiB／1 MiB 各 5 次交替的强制重连中位数为 **1,231ms／845ms**，约减少 **31.4%**；计时包含停止旧进程、校验、启动和恢复握手。这是同一新二进制的读取方式对照，不能把旧 `studio.38` 与新 `studio.44` 的所有性能差异都归因于本轮改动。

`studio.44` 的另 5 次独立空配置完整启动全部成功，中位数 **3,307ms**，范围 3,015–3,340ms。这个数字是新版产物的单独基准，不是与旧版本按相同运行顺序做出的因果对照。

另外尝试了单缓冲复用的文件读取：同机 5 次交替中，单摘要中位数由约 210ms 变为 276ms、双摘要由 395ms 变为 462ms，故未采用。源码中没有留下这一方案。

**这不是“用户实际冷启动从 17 秒变成 4 秒”的证明。** 前者来自真实应用历史日志，后者是预热文件缓存、空配置、隔离工作区的基准。MCP、扩展、历史恢复、并行 Renderer 初始化及低配机器的实际体验需要后续同条件测量。

## 后续方向

- 充分预热后，独立兼容性探测本身仍约 1.4 秒，正式 Worker 握手约 1.3 秒。进一步显著缩短时间，需要评估探测结果复用或启动流程合并；这会调整现有验证策略，不能只把校验删掉或永久缓存“曾经成功”。
- 被测已安装 `studio.38` 二进制约 439 MB；本轮按当前源码与固定 Bun 1.4.4 构建的 `studio.44` 为 260,532,224 bytes。该差异包含此前尚未进入旧二进制的源码／构建变化，不能归为本轮两处读取参数的收益。继续优化打包内容应先对比模块与内嵌资源。
- 新增分阶段日志可判断剩余等待是在校验、Bridge 准备、实际进程初始化，还是首次快照／命令清单读取，避免把所有延迟都归因于连接。

原始证据位于 `outputs/perf/runtime-startup-20261106/`（忽略，不提交）：`historical-stages.json`、`before.json`、`after.json`、`paired.json`、`summary.json`、`hash-bench.json`、`reuse-bench.json`、空会话失败日志与各验证日志。性能对照使用旧二进制，空会话修复使用新源码与新二进制单独验收，不混算成一次速度比较。

## 验证与交付

- `npm run check -- --only studio-host --suite runtime`：通过，保留执行前后内容变化、身份与签名一致性回归。
- `npm run check -- --only desktop --suite runtime-session --suite runtime-startup --suite runtime-install`：通过。
- `npm run check -- --only runtime-installer --all`：通过，包含大文件末尾篡改与缓存失效回归。
- 架构检查、生产构建通过；Renderer/preload/remote-host 产物重新生成。
- Bun 1.4.4 构建 `studio.44`，二进制 smoke、身份探测、签名与隔离安装自检通过。
- 独立检出目录的完整 Runtime 检查、116 个测试文件 / 937 项测试、CLI smoke 及四组接缝补丁回放通过，验证后检出恢复干净。首次并行构建期间有一项 Bridge 测试端点未及时监听，原配置复测通过；没有调整等待阈值，首次日志保留。
- 新版二进制的 10 次强制重连、5 次完整隔离启动通过，分别保存在 `reconnect.json`、`reconnect-summary.json`、`latest.json`。

已验签的本地开发产物放在 `packages/runtime-installer/dist/artifacts/win32-x64/18.13.2-studio.44/`，供下次开发预览启动发现和安装。没有替换当前用户安装目录、重启正在运行的应用或发布远端 Release；首次采用新包仍包含一次正常安装／激活检查。macOS、低配机器、真实项目 MCP／扩展和冷文件缓存启动尚未验收。

## 完整应用复测（同日，代码 a615821）

启动真正的 Electron Main、Host、生产 Renderer 和 `studio.44`，打开当前 `D:\Project\omp-studio` 项目。桌面和 OMP 用户配置使用独立目录；首个有效运行没有已安装 Runtime，后续五次复用同一测试配置。没有恢复用户真实聊天或发送提示词，也没有清空系统文件缓存。

| 项目 | 本次结果 |
|---|---:|
| 首次包含 Runtime 安装：发起应用启动到 Runtime 就绪 | 18.122s（1 次） |
| 安装后重新打开：Runtime 就绪 | 9.692 / 9.746 / 10.381 / 10.182 / 10.240s，中位数 **10.182s** |
| 安装后重新打开：首屏 DOM 出现 | 中位数 **2.964s** |
| 应用内 `runtime.ensure({force:true})` | 2.117 / 1.793 / 1.947 / 1.888 / 1.814s，中位数 **1.888s**；5 次均连接成功并保持会话 ID |

正常重开的阶段中位数：安装状态检查 **2.047s**，兼容性解析／探测 **4.183s**，正式启动 **2.274s**；其余包含 Electron 与基础 Host 初始化。各阶段中位数不等于逐次总耗时中位数之和。首次的安装阶段为 **9.454s**，这是它比后续启动更慢的主要区别。

计时从 Playwright 发起 Electron 启动开始，包含自动化启动开销；Runtime 就绪取 Host `desktop.startup stage=launch` 的时间戳，再通过真正的 preload `bootstrap` 验证 connected、版本和快照。应用内重连通过类型化 command/subscription 验证，未使用按键宏、slash 或日志推导业务状态。

测试目录最初缺少 Windows 标准目录，出现两次环境初始化失败；补齐目录并在测试钩子中设置 Electron 的 appData/userData/home/downloads 后得到以上有效样本。失败记录保留，未算入性能采样；产品代码没有为测试修改。独立配置不包含用户级 MCP／扩展，因此以上结果仍不能保证任意真实配置或机器重启后的冷启动速度。

原始记录：`outputs/perf/runtime-speed-retake-20261106/summary.json`、`full-app.json`、`full-app-reconnect.json`、测试脚本和隔离 Host 日志。与先前单独 Runtime 的约 3.3 秒／0.84 秒相比，应使用本节的 **约 10 秒启动／约 1.9 秒应用内重连** 来判断完整应用体验；首屏较早出现后，用户仍在等待检查和探测完成。
