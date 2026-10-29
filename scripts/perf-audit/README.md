# OMP Studio 桌面性能审计探针

这些脚本**只做测量**：不修改产品源码、不改现有构建脚本、不写入用户真实配置目录。

## 隔离边界

每次启动都会：

- 传 `--user-data-dir=outputs/perf-audit/bench/tmp/<tag>/userdata`；
- 把 `%APPDATA%` / `%LOCALAPPDATA%` 指向 `.../tmp/<tag>/appdata`、`.../localappdata`（`apps/desktop/src/platform/desktop-paths.ts` 的 `stateRoot` / `runtimesRoot` / endpoint registry 都从这里来）；
- 不连接、不安装、不更新任何已安装的 Runtime；探针结束后 `taskkill /T /F` 兜底。

原始数据写到 `outputs/perf-audit/bench/raw/*.json`（`outputs/` 已 gitignore）。

## 前置条件

```bash
# 构建产物必须与 HEAD 匹配（renderer/dist 会被 Vite 重建）
npm run build:packages
npm run build -w @omp-studio/renderer
npm run build -w @omp-studio/desktop
```

`outputs/perf-audit/bench/raw/build.log` 保存了本次审计实际使用的构建日志。

## 1. 启动阶段

```bash
# 冷 + 热各 3 次，写 raw/startup.json
node scripts/perf-audit/startup-probe.mjs --runs 3 --scenario both
```

两个通道（互相对照，口径不同）：

| 通道 | 做法 | 能测到 | 不能测到 |
| --- | --- | --- | --- |
| `native` | 直接 `spawn(electron.exe, [apps/desktop, --user-data-dir=…])`，主进程通过 `NODE_OPTIONS=--require scripts/perf-audit/lib/main-hook.cjs` 在 `main.js` 之前挂监听，把 `app-ready` / `browser-window-created` / `ready-to-show` / `did-finish-load` 的时间戳写进 JSONL | spawn→进程创建→Node 引导→app ready→建窗→`ready-to-show`→`did-finish-load` | renderer 内部指标（无法 attach） |
| `playwright` | `playwright._electron.launch` + `firstWindow()` + `page.evaluate` | renderer Navigation Timing、FCP/LCP、DOM 静默帧（首屏可交互代理）、CDP `Performance.getMetrics`、reload 复测 | `app-ready` 等主进程阶段（Playwright 会过滤 `NODE_OPTIONS`，hook 挂不上） |

**注意**：Playwright 通道里 `spawn -> processCreated` 含驱动自身的调用开销（实测 ~30–40 ms），`native` 通道的同一行（~100 ms）是 Node/Python 侧 `spawn` 到 OS 进程创建的真实延迟；两者不要混用。

「首屏可交互」代理：reload 前注入 rAF 采样，取**连续 3 帧 DOM 零 mutation 且 `#root` 已有子节点**的第三帧时刻，减去进程创建时刻。

### 打包形态（可选，更接近真实用户）

```bash
node scripts/perf-audit/prepare-packaged-form.mjs
node scripts/perf-audit/startup-probe.mjs --runs 3 --scenario cold \
  --exe "outputs/perf-audit/bench/packaged-form/OMP Studio.exe" --native-only --tag packaged
```

`prepare-packaged-form.mjs` 用**硬链接**镜像 `node_modules/electron/dist`（并把 `electron.exe` 链成 `OMP Studio.exe`，使 `app.isPackaged === true`），再把 `packaging/runtime-payload` 与 `packaging/runtime-keys` 按 electron-builder `extraFiles` 布局放好。逻辑体积 ~570 MB，但硬链接几乎不占额外磁盘；清理直接删目录。

## 2. 空闲资源

```bash
node scripts/perf-audit/idle-probe.mjs --seconds 60 --states normal,blurred,minimized
```

启动完成后静置 5 s，再在三种窗口状态下各采 60 次 `app.getAppMetrics()`（主进程内 `setInterval` 1 s，探针不在采样路径上），同时按秒采宿主 CPU。输出按进程类型（`Browser`/`Tab`/`GPU`/`Utility`）的 CPU% 均值/p95、RSS 均值/峰值，以及宿主基线 CPU%（空载、无 app）。

## 3. GPU 状态

`idle-probe.mjs` 会一并写入 `app.getGPUFeatureStatus()` 与 `app.getGPUInfo("basic"|"complete")` 原始对象（`gpu.featureStatus` / `gpu.info_basic` / `gpu.info_complete`）。

## 4. 4x CPU 降速交互

```bash
node scripts/perf-audit/throttle-probe.mjs --rate 4
```

CDP `Emulation.setCPUThrottlingRate{rate:4}` 之后依次做：切 5 个主页面、composer 输入 200 字符、滚动会话列表、开关大面板，每一步采 `Performance.getMetrics` 差值（Task/Script/Layout/RecalcStyle）、`longtask`、rAF 帧间隔（>50 ms 记为掉帧）。

## 5. 首屏 JS 成本

`startup-probe.mjs` 的 `reloadCost` 字段：在已加载页面上 `Network.enable` + `Performance.enable` 后 reload 同一文档，统计真实传输字节（`Network.loadingFinished.encodedDataLength`）、script 字节、`ScriptDuration`、`longtask`、帧间隔。放在 reload 上是因为 `file://` 文档不暴露 Resource Timing 条目，而 Performance 计数器必须在导航前 enable。

## 约定

- 每次运行前 `tasklist /FI "IMAGENAME eq electron.exe"`，有残留就 `taskkill /T /F`；脚本内部已做。
- `idle-probe.mjs` 的 `blurred` 状态在 Windows 上可能不生效（`win.blur()` 后 `isFocused()` 仍为 true），报告里会写明；真失焦需在交互式桌面手动抢占前台后采样。
- 打包态（`app.isPackaged=true`）会忽略 `NODE_OPTIONS`，主进程 hook 挂不上；`--native-only` 的打包样本只能拿 Host 日志或外部观测。
- 打包态首启会跑 Runtime 播种/自检并检查更新（可能下载较大 zip 到隔离目录）；确认不需要后直接 `rm -rf outputs/perf-audit/bench/packaged-form outputs/perf-audit/bench/tmp`。
- `--runs`、`--scenario`、`--rate`、`--seconds`、`--states`、`--tag` 可复现参数；`PERF_AUDIT_REPORT=<path>` 指定输出 JSON。
- 报告：`outputs/perf-audit/bench/REPORT.md`。
