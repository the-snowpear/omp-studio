# 会话切换性能采样

这是诊断工具，不改变会话释放、Runtime 重连或恢复逻辑。默认关闭，不加入发布门禁。

## 最短人工操作入口

优先按 [一轮人工会话切换采样](session-switch-manual-test.md) 操作：双击 `采集会话切换.cmd` 自动定位主进程，再将 `scripts/manual-session-switch-capture.js` 贴到应用 Console。脚本分段录制 60 秒并自动导出；数据汇总在 `outputs/perf/manual-session-switch/`。不用手动分析，也不必手填单一实例的 PID。

## 在真实应用采样

开发预览使用 Vite 和开发版 React。生产预览使用打包后的 React，但仍有 Electron 的主进程、Renderer、GPU、网络进程以及可能存在的 Runtime。不要把开发服务器内存、JavaScript 堆和所有进程的工作集混成一个数字。

1. 打开应用开发者工具 Console，执行：

   ```js
   window.ompSessionPerf.start()
   ```

   开启状态保存到本地，下次加载仍继续开启。每次加载会开始一份新记录，不会把历史记录一直累积。

2. 分别操作：停留不动、反复切换相同会话、依次打开不同会话、关闭对话窗口。测试期间不要编辑源码，HMR 会重载页面并清空当前记录。
3. 每种场景结束立即导出：

   ```js
   window.ompSessionPerf.download()
   ```

4. 测完关闭：

   ```js
   window.ompSessionPerf.stop()
   ```

导出包含最多 600 条记录，满后淘汰最旧条目；`dropped` 表示已淘汰条数。每秒采样一次，记录切换派发、React 提交、客户端打开、bootstrap、只读 query、正文加载状态和浏览器长任务。query 只记协议名称，不记录参数、结果或异常文本。不会输出会话 ID、标题、路径、正文、密钥、调用堆栈或截图。

常见字段：

| 字段 | 含义 |
|---|---|
| `real.documents` / `real.views` | 保留的轻量对话身份记录数 / 仍存在的对话视图数 |
| `real.mountedDocuments` | 仍被对话或工具窗口引用、需要挂载界面的文档数 |
| `real.unreferencedDocuments` | 暂无窗口引用的轻量身份缓存；用于重开时恢复草稿，不等于界面仍驻留 |
| `real.detachedHosts` | 已脱离页面、仍保留的对话 DOM 容器数 |
| `real.detachedNodes` | 显式深度快照或导出时，脱离页面的容器内部 DOM 数；定时采样不遍历子树 |
| `engines.active` / `stores.active` | Renderer 仍持有的对话引擎和 Store 数 |
| `heapUsedBytes` / `heapTotalBytes` | Chromium 提供的 JavaScript 堆估算，不是进程占用或 GPU 内存 |
| `timerLagMs` | 定时任务超过预期间隔的延迟；后台节流也会使其升高 |
| `longtask.durationMs` | Chromium 主线程长任务耗时，不代表全部绘制或 GPU 时间 |
| `sequence` | 本次录制内的切换序号，不是会话标识；后台查询保留其开始时的序号 |

`switch.dispatch` 只测点击后同步的 Store 更新。`switch.commit` 是 React 提交，不承诺画面已经绘制。正文状态事件也可能来自隐藏对话，因此应结合资源计数和 query 的开始/结束判断，不把不同事件直接当成同一会话的完整耗时。

## 分进程采样

在任务管理器详细信息中找到 **OMP 主进程**的 PID，替换下方占位值。在项目根目录运行：

```bash
powershell.exe -NoProfile -File scripts/sample-session-processes.ps1 -RootProcessId <OMP主进程PID> -DurationSeconds 60
```

脚本只采样目标进程树的性能数值，不启动、停止或重启应用。默认按约 1 秒间隔输出主进程、Renderer、GPU、网络和 Runtime 分类数值，实际间隔以 `atMs` 为准；结果默认写入 `outputs/perf/session-processes-*.jsonl`。PID 只用于在本机找到进程，不写入结果。目标退出时停止，已存在的输出文件不会覆盖。

`workingSetBytes` 是包含共享页面的工作集；`privateWorkingSetBytes` 是 Windows 性能计数器提供的私有工作集（计数器不可用时省略，不填假零）；`privateCommitBytes` 是进程私有提交量，不是私有工作集。共享页面可能重复计入多个工作集，不能将其相加作为精确物理内存总量。`cpuCorePercent` 以一个逻辑核为 100%，`cpuMachinePercent` 再除以逻辑核数。

旧版本 Host 文本日志曾把长数字误当作 PID 脱敏。当前版本只对经过明确字段选择的性能数值保留原值，其他敏感文本继续脱敏。已有日志中的 `heapUsedBytes=[redacted]` 无法恢复，需要用新版本重新采样。

## 可重复的离线对照

开发服务器下打开 `/session-switch-perf.html?sessionPerf=1&preview=0`。页面加载真实 App，但 transport 只提供固定只读 fixture，Runtime 状态固定不可用，任何 command 都拒绝执行，不读取用户会话。

等待侧栏显示 Performance fixture，再在 Console 执行：

```js
await window.ompSessionSwitchHarness.run(12)
```

每次运行前重新加载页面，以相同初始状态对比。结果包含已打开/已关闭 context 数、订阅数、保留身份与挂载文档数、堆估算、query 数和长任务。`nextTaskMs` 测点击到下一个事件循环任务的阻塞时间，**不是首帧绘制耗时**。

另外可执行真实浏览器中的草稿与阅读锚点恢复回归。它会切换固定会话，检查旧 DOM 已释放、草稿保留、同一条消息及其像素偏移恢复；失败直接抛出错误：

```js
await window.ompSessionSwitchHarness.verifyReading()
```

这项几何测试要求页面持续产生动画帧。预览标签或桌面应用处于后台时，内嵌浏览器可能暂停帧，即使 `document.visibilityState` 仍是 `visible`；应先将预览置于前台，不能把这种超时计为产品耗时。助手的隐藏预览也可用逐步点击和截帧确认同一锚点，不采用后台等待时间作为性能指标。

- `&stalled=1`：正文 query 故意不返回，用于只剩加载态时的对照；它不是正常 fixture 的默认行为。
- `&delayMs=1000`：每次 query 延后，用于区分等待与渲染阻塞。

构建同一页面的独立生产包：

```bash
node scripts/build-session-switch-perf.mjs
```

产物位于 `outputs/perf/session-switch-production/`，不覆盖产品 `dist`。通过 `.claude/launch.json` 中的 `session switch production` 启动预览，再打开 `/session-switch-perf.html?sessionPerf=1&preview=0`。这个对照比较开发版和生产版 Renderer，不等同于已安装 Electron 应用的全进程内存验收。

## 隔离的原生 Electron 采样

`scripts/native-session-perf.mjs` 默认使用生产 Renderer、真实 Electron 主进程、IPC 和 Host 归档读取；可通过 `OMP_NATIVE_PERF_DEV_URL` 显式指定已启动的本地 Vite URL，按相同数据量对照开发 Renderer。Vite 服务器不计入 Electron 进程树。它创建全新的配置、工作区和原生 JSONL 合成会话，不打开用户已有会话，也不发送模型请求。它不是已安装 exe 的包体或全功能验收。

先完成 Desktop 编译和 Renderer 生产构建，再把自动化依赖装到忽略的输出目录（不改项目依赖和锁文件）：

```bash
npm install --prefix outputs/perf/native-tools --no-save --package-lock=false --ignore-scripts playwright-core
```

先执行小规模启动检查：

```bash
PLAYWRIGHT_MODULE=../outputs/perf/native-tools/node_modules/playwright-core node scripts/native-session-perf.mjs --smoke
```

可选的自动化实验默认生成 24 个合成会话，每个 160 条消息，依次测试切换前空闲、12 次首次打开、24 次 A/B 往返、36 次快速切换及切换后空闲。优先按上方人工入口采集真实使用数据；大规模合成数据的生成时间不是产品切换耗时：

```bash
PLAYWRIGHT_MODULE=../outputs/perf/native-tools/node_modules/playwright-core node scripts/native-session-perf.mjs
```

可用 `OMP_NATIVE_PERF_SESSIONS` / `OMP_NATIVE_PERF_TURNS` 调整合成规模。若要对照开发版，先独立启动 Vite，再给同一命令加 `OMP_NATIVE_PERF_DEV_URL=http://localhost:28200`（端口与实际服务器一致）；不要在计时中修改源码或重启服务器。自动化会打开自己的窗口并聚焦；采样期间不要运行构建或其它性能测试。输出位于 `outputs/perf/native-session-switch/run-*`，包含 `report.json`、Windows 分进程曲线 `processes.jsonl` 和合成内容截图。应用启动后的失败会写报告；造数据或构建阶段失败可能只输出终端错误。不要把这些失败或等待超时当成产品切换耗时。

`nextTaskMs` 是同步点击到下一任务的时间，`readyMs` 包含归档读取与界面切换过渡，都不是 GPU 首帧耗时。进程采样的 `startedAtUnixMs + atMs` 与报告的阶段时间对齐；Windows 下采样根是 Electron 主进程，而不是自动化启动器。脚本会拒绝把意外连接 Runtime 的运行当作离线对照；只关闭自己启动的应用，不影响用户应用实例。

针对诊断和现有生命周期的检查：

```bash
npm run check -- --only renderer --suite sessionSwitchPerformance --suite rendererPerformance --suite conversationWorkspace/client --suite conversationWorkspace/Workspace.integration --suite conversationWorkspace/workspace
```
