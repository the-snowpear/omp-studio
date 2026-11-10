# 会话切换与内存重构

## 分支与恢复点

工作树：`D:\Project\.worktrees\omp-studio-session-switch`。分支：`codex/session-switch-refactor-recovered`，基于最新的 `7ae8772`。

开始实施时，`582aeb3` 保存了原工作区的 285 项未提交改动。原工作区期间由其他工作提交为 `7ae8772`。随后两个实验工作树目录从文件系统消失，Git 提交仍完整；因此本次在新的锁定工作树上重放功能提交，保留最新主分支的修正，未覆盖原目录或重置用户内容。

| 提交 | 内容 |
| --- | --- |
| `fe94164` | 跨阶段计时、操作编号、逐进程采样 |
| `b02cb1e` | 共享项目读取、正文优先、有界首屏缓存、取消与 Git 优化 |
| `451a370` | 归档 Worker、共享索引、远端打包与部署 |
| `0df3a69` | 新上下文初始化前显示纯首屏缓存、完善诊断工具 |

早期工作树删除前的实验只用于定位热点，最终验收以重新生成、存放在原项目 `outputs/perf/session-switch-refactor-20261110/` 的原始数据为准。

## 问题与实现

原诊断中 10 次上下文打开启动了 143 次查询。正文计时包含上下文初始化等待，模型、Git 和历史统计在切换时反复读取；历史统计和旧请求还会在切走后继续执行。两段切换约 23% 的时间落在长任务中。892 → 1363 → 954 MiB 的进程私有工作集，以及基本恢复的 JS 堆，说明峰值和重复分配必须治理，但不足以证明持续泄漏。两个 Renderer 未保留 PID 映射，也不能把二者全部内存归因于主页面。

### 数据归属与预算

`ProjectReadServices` 归 Host authority 所有，会话 facade 继续独立持有 Runtime 投影、订阅和命令入口。模型、技能等服务按固定 cwd 创建，异步读取不会跟随之后的工作区切换。同键模型和技能读取合并，相关配置命令完成时失效。

| 层次 | 数据 | 限额与有效期 |
| --- | --- | --- |
| Renderer | 项目展示数据 | 估算 16 MiB、128 个键；模型/技能 30 秒，目录/历史/Git 3–5 秒 |
| Renderer | 会话首屏 | 4 个会话、合计 8 MiB、单页 2 MiB；最近使用后 60 秒 |
| Renderer | 无引用项目 | 最多 4 个，5 分钟；项目只读上下文在最后一个消费者离开 30 秒后关闭 |
| Host | 项目元数据 | 估算 16 MiB，30 秒；配置写入完成时失效 |
| Host Worker | 归档快照和投影 | 全局最多 8 个、原始字节 32 MiB、解析/投影估算 64 MiB |
| Host | 历史统计成功结果 | 按工作区、会话、revision 缓存 60 秒，最多 16 项 |

解析对象按原始字节 4 倍估算，带投影按 6 倍估算。上述是保留预算，不是操作系统工作集保证。活动视图、进行中的读取、临时缓冲和 GPU 另外统计。Worker 内的 Reader 共享一份归档身份索引，避免每个项目重复保存同一目录索引。

首屏缓存只包含不可变页数据，不保存引擎、Store、DOM、订阅、审批、权限或 Runtime 状态。缓存按连接、authority epoch、项目、会话及 revision 隔离；显示缓存后仍重新读取真值。完整页协调复用相同条目的对象身份，实时 token 增量不做深比较。保留现有可见文档挂载、虚拟列表、草稿与阅读锚点恢复。

### 正文优先与预热

正文、bootstrap 和权限信息不等待模型目录、Git、文件树、历史统计和 evaluation。正文提交并给浏览器一次帧机会后，才释放辅助读取；切走时未开始的会话请求结束。热首屏可以在新的 IPC 上下文初始化前显示，并保持同步状态。

项目激活、首屏显示后延迟 2 秒开始预热，要求最近 500 ms 无点击、输入或滚动，且没有前台项目/正文读取。每个连接只运行一个后台队列：先读取模型、技能、最近历史、Git 摘要，再从最近 6 个会话选最多 2 个其他小会话首屏。Host 跳过驻留会话、压缩归档及超过 4 MiB 的原始文件；返回页超过 2 MiB 也跳过。离开项目停止后续预热。预热不启动 Runtime、不发模型请求、不读取所有历史、不预热统计探测。

### 取消与 Worker

归档读取按消费者管理生命周期。关闭一个 facade 不会中断另一消费者；最后一个消费者离开后，在异步解析、哈希和投影的让出边界取消。追加解析复制索引和 Hash 状态后再发布，取消不会留下半更新缓存。游标签名密钥在 Host 生命周期内稳定，淘汰缓存不会使分页游标失效。

约 50.75 MiB 归档的三次生产版 CPU profile 确认了 Worker 条件：解析连续占用主线程分别约 47.7 / 84.6 / 58.0 ms，投影约 97.6 / 111.2 / 105.1 ms，均超过预先约定的 20 ms。解析、哈希、投影和全量快照缓存现位于一个按需启动、长期复用的 Node Worker 中。队列优先前台正文，主进程只接收已有协议限制下的分页、摘要或临时副本位置。模型目录没有同等证据，因此没有增加第二个 Worker。

历史统计的临时复制、CLI 子进程和临时目录清理由同一个共享任务拥有；Host 同时只执行一个探测。最后一个消费者离开时终止子进程，等待进程关闭再清理临时目录。完成读取时再次检查实时统计，实时数据优先。

### Git、折叠面板与兼容

新增 `git.repository.summary`，返回仓库身份、分支/HEAD、ahead/behind、改动文件数和采样时间，顶栏使用这个摘要。摘要和完整读取共享进行中的 Git status；仓库身份短期复用，减少 Windows 进程创建。写操作及其 revision 前置检查始终重新读取，不复用写入前的展示结果。

折叠的 Context 图标显示已有实时用量，历史探测在正文面板打开后运行。预览模式仍使用 Renderer fixture；命令始终走真实 client。

新增 `session.transcript.prefetch`（`ready + page` 或 `skipped`）；`session.telemetry.read` 增加可选 `refresh`。AbortSignal 只用于 Host 内部，不进入 IPC。Runtime Bridge、会话文件格式保持现有契约；旧 Host 不支持预热时只关闭该连接的预热。

远端 bundle 生成 `archive-worker-<sha256>.mjs`；主 bundle 引用内容寻址文件名，使 Worker 更新同时改变 Host 身份。开发 SSH 部署与签名运行环境都携带并验证 Worker。产物测试直接从打包目录启动 Worker 读取归档，不依赖源码目录。

## 验收与复现

标准规模是 24 个会话、每个 160 条消息，使用独立配置、合成 JSONL 和独立 Git 仓库。没有模型请求，不读取真实会话。开发版和生产版必须分开记录。`nextTaskMs` 是点击到下一事件循环任务，`readyMs` 包含布局过渡完成时间，均不等于屏幕首帧。`conversation.bodyCommit` 是正文提交；Paint 需要结合 Chromium trace 判读。

录制整轮只启动一次，阶段用标记表示；并发操作通过 `operationId` 配对，允许跨阶段完成。Windows 采样保留角色汇总、PID、父 PID 和启动时间，区分 telemetry probe；Electron 报告保存 webContents 类型与 PID 映射。

```bash
node scripts/check.mjs --production
node scripts/check.mjs --only studio-host --suite session-archive --suite session-telemetry-probe
node scripts/check.mjs --only desktop --suite remote-deploy --suite git-service
node --test scripts/archive-worker-bundle.test.mjs
PLAYWRIGHT_MODULE=../outputs/perf/native-tools/node_modules/playwright-core node scripts/native-session-perf.mjs --cpu-profile --trace --acceptance
```

`--acceptance` 增加 5 轮，每轮 20 次切换、回到同一会话、静置 120 秒，不强制 GC。开发版通过 `OMP_NATIVE_PERF_DEV_URL` 指向 Vite；基线通过 `OMP_NATIVE_PERF_APP_ROOT` 指向对照工作树。大档使用 `OMP_NATIVE_PERF_TURNS=160 OMP_NATIVE_PERF_LARGE_BYTES=52428800`，单独报告，不混入小会话 p95。

性能实验不加入默认门禁。macOS 的窗口、内存与发布产物需要在 macOS 设备上独立验证。

## 参考

- [ZCode sessionDataLayer](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/ui/src/v4/sessionDataLayer.ts)：共享数据和短期保温；本次补充字节/数量预算。
- [ZCode conversationRowSharing](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/ui/src/v4/conversationRowSharing.ts)：完整快照条目的结构共享。
- [oh-my-pi-gui session-hydration](https://github.com/nornzach/oh-my-pi-gui/blob/a0476e95b9af05d6983c30d1fcf0b569919c160e/src/renderer/hooks/session-hydration.ts)：分阶段应用数据；本次进一步延后辅助请求启动。
- [Electron performance](https://github.com/electron/electron/blob/v43.4.0/docs/tutorial/performance.md)、[Node Worker threads](https://nodejs.org/api/worker_threads.html)：根据同步热点的重复测量决定迁移。
