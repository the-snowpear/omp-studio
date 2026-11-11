# 项目安全与内存修复验证

本轮修复 Git 文件误操作、Bridge 中断和恢复阻塞、SSH 网络出口边界，以及历史读取、终端和文件资源的生命周期问题。实现位于独立分支 `codex/security-memory-fixes`，基线为 `fc8e677`：它基于 `8b5c29b`，并单独保存原目录中的后台任务未提交改动。原目录 HEAD 与 12 个未提交文件的 Git blob 均已核对未变，完整编辑前备份在新工作树的 `.codex-backups/security-memory-baseline/`。

## 修复范围

| 问题 | 最终行为 | 回归证据 |
| --- | --- | --- |
| Git 文件名作为 wildcard/pathspec | stage、unstage、discard、路径限定 commit、diff 使用 literal pathspec | 同时修改 `report[1].txt` 和 `report1.txt`，单文件 discard 保留未选中内容 |
| 子目录工作区的 Git 路径错位 | 仓库根相对路径在仓库根执行；真实路径统一后保存 `workspacePrefix`，将 Explorer 和文件 Diff 映射到工作区 | 工作区选 `repo/src` 时，操作 `src/a.txt` 不再覆盖 `src/src/a.txt`；系统目录 alias 不改变仓库识别或文件名大小写 |
| Git watcher 持续增长 | 与现有 16 条工作区身份 LRU 一起释放，重新访问可重建 | 40 个工作区活跃 watcher 从 120 降到 48；重访后仍为 48，dispose 后为 0 |
| Bridge 丢事件恢复阻塞 | 继续处理收据和控制帧，保留 decoder 中的半帧，快照尾部结算在途请求 | split receipt、snapshot receipt tail、连续两次 gap 后恢复 |
| Runtime 中途取消被外层队列阻塞 | 外层复用 arbiter 的并行语义，保留独占操作串行 | 真实 named pipe 下 `job.cancel`、`agent.kill`、`btw.ask` 在 prompt 未结束时完成 |
| 子 Agent 历史缓存不失效 | 定位和名册读取更新子文件版本 | 追加消息后读取新正文、revision 和统计，无需清缓存 |
| Time Travel 列表读取全部完整快照 | 时间线只保留摘要，捕获和恢复只加载最新或选中的完整 manifest；旧数据按需建立摘要 | 200 个检查点列表内存、捕获、storage 和 cleanup 前后采样，旧快照恢复测试 |
| 分页重同步后 loadingOlder 不清 | 新 hydrate 接管分页状态，旧代次错误不覆盖新状态 | 主、子对话重同步成功后可再次加载更早消息 |
| `@` 文件索引长期陈旧 | Git 变更通知失效缓存，普通文件夹使用 5 秒缓存，失败允许重试 | 新文件可检索、删除文件消失、失败重试及遍历预算 |
| 历史图片先全量读入 | 只读当前用户消息，读取期间按 8MiB 保留；分页补读，旧读取不覆盖新范围 | 原生 IndexedDB 1,000 张图中请求 100 张，只返回 100 张；删除走 key cursor |
| favicon 下载后才限量 | 分块读取，超限取消 reader；data URL 解码前限量 | 8MiB 输入在 327,680B 后取消，比原全量读取减少 96.1% |
| 退出后仍创建 PTY | document token 使迟到 CWD 失效，退出事件清理旧监听器 | destroyed、did-navigate、render-process-gone 三种事件后均不 spawn |
| 重载和崩溃遗留文件 lease | 释放旧 lease、dirty 和关闭请求，迟到 inspection 释放并拒绝 | 旧 URL 从 200 变 404，AbortController 已中止，新文档 lease 仍为 200 |
| SSH loopback 代理缺身份 | HTTP/CONNECT 要求私有随机代理认证，认证头不转发到目标 | 未授权 407 且零 dial；Bun 1.4.4 标准 fetch 通过，目标 Bearer 保留 |
| 本机 DNS 绕过私网策略 | 在执行服务解析公共地址，直连和上游代理均使用已检查的地址；连接建立前可尝试后续已检查地址 | 私网域名、IPv4-mapped 私网阻断；HTTP/SOCKS/直连不会再次解析目标或重放应用请求 |
| 可选 Web bootstrap 无 Origin 被拒绝 | 正常同源 GET 可依会话、Host 和 Fetch Metadata 读取；写请求和 WebSocket 保持 Origin/CSRF 规则 | paired browser bootstrap 成功，cross-site GET 和无 Origin WebSocket 仍拒绝 |
| Runtime ZIP 解压及依赖公告 | fflate 0.8.3、Electron 43.8.8、Vite 6.4.6、Vitest 4.1.12 和修补后的传递依赖 | npm audit 从 21 个受影响包降为 0；保留 Mermaid 11.16.1，KaTeX 为 0.18.10 |
| 首屏和官网帧资源 | 首页、历史、统计、教程按需加载；官网保留 13 个邻近位图，最多 3 个在途加载 | 静态闭包体积、真实 Electron 导航和 Chromium 位图/RSS 前后采样 |
| 性能 CI 和补丁稳定性 | CI 拉取 submodule 并应用 overlay；补丁固定 10 位 Git index 缩写 | 不同 core.abbrev 的 regen 字节一致，独立干净 vendor 完整验证通过 |

普通文件 lease 只保存 metadata 和取消状态，不持有完整文件或永久 FD。Office 转换在文档退出时取消；没有将它表述为已证实的永久 Office 进程泄漏。

## 性能与内存数据

同机 Windows x64、i9-13900HX 32 逻辑处理器、Node 24.13.0；流式和 IDB 使用固定 Playwright 1.62.1 / Chromium 151.0.7922.34。Electron 由 43.4.0 更新到 43.8.8。所有浏览器和桌面配置、Host 数据、Git fixture 均与用户真实数据隔离。

### 有明确收益的路径

| 场景 | 修复前 | 修复后 | 变化 |
| --- | ---: | ---: | ---: |
| Time Travel 200 检查点 × 1,000 文件，warm list | 60.42ms | 21.83ms | -63.9% |
| 同场景 list heap 增量峰值 | 62.20MiB | 4.29MiB | -93.1% |
| 同场景 GC 后返回数据保留量 | 33.65MiB | 0.069MiB | -99.8% |
| 新检查点捕获 | 64.77ms | 6.16ms | -90.5% |
| Storage 统计 | 161.78ms | 29.30ms | -81.9% |
| 过期清理 | 191.50ms | 139.57ms | -27.1% |
| IDB 1,000 张 64KiB 图片，请求 100 张，中位加载 | 84.3ms | 12.3ms | -85.4% |
| 同场景返回 base64 字节 | 65,536,000B | 6,553,600B | -90.0% |
| 同场景 GC 后 heap 增量 | 65,756,932B | 6,588,576B | -90.0% |
| 删除会话观察到的 heap 增量峰值 | 71,459,616B | 76,084B | -99.9% |
| 官网 Renderer RSS 采样峰值 | 810.36MiB | 377.20MiB | -53.5% |
| 官网离开序列后的活动位图 | 全序列 HTML 图片仍被引用 | 0 | 旧位图全部关闭 |
| 首屏静态 JS 闭包 | 3,216,828B | 3,066,334B | -4.68% |
| 首屏 CSS | 652,511B | 613,666B | -5.95% |

Time Travel 保留旧完整 manifest 格式；旧数据首次生成摘要约 58.15→164.52ms，是一次性额外等待，后续 warm 数据见表。IDB 删除峰值通过 CDP 约每 10ms 观察，不能当作严格的所有瞬时分配上限。官网 RSS 是原生 Renderer 进程的实际采样，位图像素字节另记为逻辑资源大小；截图在对应 scrub 位置已核对一致。

### 流式、启动与空闲

流式每场景预热后运行 5 次，前后 18 项门禁均通过。后测长/短历史布局成本比为 1.56，繁忙场景 p95 为 16.7ms，超过 48ms 的帧为 0/90。后两批 GC 后 JS 堆为 9.47→7.96MiB，listener 为 253→248；批次间惰性资源收尾会影响数值，结论是未观察到持续保留增长。工具输出翻倍后的 DOM 为 681→651，切会话、展开和工具交接检查通过。

真实 Electron 冷、热各运行 3 次，profile cold 不等于操作系统磁盘缓存冷。启动数字含 Playwright 调用和完整首启界面，本轮未证明启动加速：

| 指标中位数 | 修复前 | 修复后 |
| --- | ---: | ---: |
| Cold spawn 到连续 3 个 DOM 安静帧 | 11,838ms | 11,858.5ms |
| Hot spawn 到连续 3 个 DOM 安静帧 | 11,698.3ms | 12,000.9ms |
| Cold Renderer FCP | 7,640ms | 7,848ms |
| Hot Renderer FCP | 7,496ms | 7,772ms |

整壳空闲每状态采 15 秒。前后 Electron 版本与进程内原生库不同，下面保留事实，不把局部缓存优化推广成整壳 RSS 下降：

| 状态 | CPU 总和均值前→后 | 进程 RSS 总和均值前→后 |
| --- | ---: | ---: |
| 正常可见 | 1.34%→1.18% | 1,226.74→1,270.95MiB |
| 最小化 | 0.10%→0.07% | 1,143.53→1,190.05MiB |

blurred 前测实际失焦，后测 `blur()` 后仍 focused，两个样本不作失焦收益比较。4× CPU 降速下输入 200 字符和面板展开没有观察到掉帧或长任务；旧探针的页面切换只触达部分标签、滚动场景为空，因此未将这些结果当作完整交互验收。另用真实 Electron GUI 独立验证真实/预览模式的首页、历史、设置、工作台，8 次导航全部成功。

## 验证入口与数据

原始 JSON、日志和截图在工作树 `output/playwright/review-data/`，按项目约定 gitignore，不提交测量产物。

- `time-travel-{before,after,comparison}.json`：实际 Store 合成 fixture。
- `desktop-{before,after}.json`：真实 Git、watcher、favicon、终端与 lease 计数。
- `thumbs-{before,after}.json`、`website-{before,after}.json`：原生 Chromium 内存和资源采样。
- `assets-{before,after}.json`、`streaming-{before,after}.json`：生产资产和流式门禁。
- `startup-{before,after}.json`、`idle-{before,after}.json`、`throttle-after.json`：真实 Electron 测量。
- `npm-audit-{before,after}.json`、`comparison-summary.json`：安全依赖和数据摘要。
- `gui-after/report.json`、`terminal-native.json`：8 次真实/预览导航和 Electron 43.8.8 的 ConPTY 运行。
- `runtime-full.log`：独立干净 vendor，129 个单文件套件共 995 个测试、类型和 smoke 全部成功，验证结束恢复干净。
- `tooling-full.log`：112 个打包、签名、更新和工程脚本测试全部成功。
- `check-desktop-production-final.log`、`desktop-production-final-tests.log`：最终 Desktop 全量检查与生产构建；816 个测试中 809 个通过，7 个 POSIX socket / login shell 测试按平台跳过，0 失败。Renderer、远端 Host、Windows/macOS sandboxed preload 构建与 2 个 preload 测试均通过。
- `validation-summary.json`、`artifact-index.json`：最终验证状态和原始数据清单。
- `source-workspace-preservation.json`：原目录 HEAD 与 12 个未提交文件的内容未变。

复现命令使用同一工作树和匹配其 lock 的依赖；Playwright 可安装到临时工具目录，通过 `PLAYWRIGHT_MODULE` 指定，不改产品依赖。

```bash
npm run check -- --all --production
npm run check -- --only renderer --all
npm run check -- --only desktop --all --production
node --test --test-concurrency=4 scripts/*.test.mjs
npm run omp:verify:patches -- --source <干净的独立 vendor 工作区>
PERF_BUILD_MODE=production PERF_REPORT=output/playwright/review-data/streaming-after.json npm run perf:streaming
node scripts/renderer-assets.mjs apps/renderer/dist output/playwright/review-data/assets-after.json
node scripts/review-thumb-memory.mjs after
npm --prefix website ci
npm --prefix website run build
node --test website/a/frameWindow.test.ts
node scripts/review-website-memory.mjs after
node scripts/review-native-terminal.cjs
node scripts/review-workbench-gui.mjs
```

Vitest 4 的升级修正了 3 个 callback mock 类型，以及 5 个文件中旧 mock/spy 复用和 global stub 的行为。产品断言、矩形数值与源代码行为保留。Renderer 全量终验由同一 `scripts/check.mjs --only renderer --all` 切片完成，274 个文件、1,931 个测试、0 uncaught errors。通过状态和耗时记录在 `check-renderer-final.log`；文件与测试数量由前轮完整 Vitest JSON 和未变的无过滤发现范围核对，详见 `vitest4-suite-compatibility.json`。全工作区入口中的架构、选择器、动效、全部包编译与 Node 包测试均通过；Renderer 的旧夹具失败由上述最终切片验证解决。

最终 `scripts/check.mjs --only desktop --all --production` 在 139.1 秒内通过，覆盖最后的系统路径 alias 和网络地址重试修正，并重建生产 Renderer、远端 Host 与 preload。桌面测试夹具在临时 profile 删除前等待 composition shutdown，避免后台初始化写入已删除目录。本机 C 盘只剩约 166MiB 时，两个更新测试正确触发 256MiB 磁盘门槛；最终测试把 TEMP/TMP 指向 D 盘隔离目录后通过，产品门槛和原断言均未降低。

本机网络出口现在要求桌面 DNS 能解析目标，以便核验真实地址；只在代理侧能解析的域名无法使用本机出口，可改用远端网络。没有加入外部 DNS 服务或放弃私网检查。

本轮未发布、部署或合并到原分支。未重建和签发可分发 Runtime 二进制；真实 Bridge 使用 Bun 1.4.4 源码及经相同 Rust/Cargo/绑定输入核对的本机 native。macOS 真机、真实多用户 SSH、付费模型调用和完整已安装形态仍需对应环境验收。两份 npm 隔离试验目录的清理被自动审批拒绝，保留在 ignored 输出目录中，不影响构建或验证。
