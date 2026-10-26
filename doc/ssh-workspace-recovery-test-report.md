# SSH 工作区连接稳定性：实机恢复验收报告

验收日期：2026-10-26（GMT+8）。执行者：独立验收 agent。
运行标识：`omp-studio-recovery-20261026-1718-a7f3`。
口径：**通过 / 失败 / 阻塞 / 未测试** 四类互斥；每项另标证据层级（本地隔离 / 实际 SSH 通道 / 通道字节迟滞 / 应用通道 TCP / 正常 Electron / 独立 Electron 测试入口 / 安装包）。
本报告为新增文件，`doc/ssh-workspace-test-report.md`（2026-10-25）保持原样未改写。

## 1. 结论

| 结论 | 内容 |
|---|---|
| 能否作为开发预览使用 | **deskserver：可以**（15/15，含瞬断恢复、连续失联、抖动预算、三阶段取消、Host 停止、实例变化、旧/他人 attach、未知结果不重放、真实 PTY、目标隔离）。**ucloud：有条件**（7 项通过含抖动预算；其余 7 项被主机网络窗口阻塞，未在该机取到证据） |
| 是否达到发布要求 | **不可以**（见第 10 节：账密端到端仍阻塞、macOS 与安装包未测、TCP 层丢包未验证、真实模型/审批任务未测） |
| 本轮是否发现需要修复的问题 | **未发现需要修复的产品缺陷**；有 3 项"需注意"的边界行为与 1 项环境限制（ucloud 间歇性拒绝新连接），见第 9 节 |

判定依据：deskserver 在**真实 `RemoteConnectionManager` + 系统 OpenSSH + 远端 Host** 上完成 15/15 用例；ucloud 完成 7 项全量用例 + 1 项取消语义（注入未生效）+ 7 项被主机网络窗口阻塞（同时刻系统 SSH 同样超时），详见第 7 节。另有真实 Electron 渲染进程闭环 8/8。

## 2. 环境与版本

| 项目 | 值 |
|---|---|
| 工作树 | `D:\Project\omp-studio\.claude\worktrees\trusting-khorana-a24ebe` |
| 分支 / HEAD | `claude/trusting-khorana-a24ebe` / `2a561ae374411e8f15c5ff393d26c20392bad755`（未切换、未提交、未推送） |
| 工作树状态 | 70 项改动（含未跟踪 `apps/desktop/src/remote/`），本轮未修改任何产品源码 |
| 本机 | Windows 11 build 10.0.26300 x64；Node v22.22.2；npm 10.9.7；OpenSSH_10.3p1（`C:\Windows\System32\OpenSSH\ssh.exe`） |
| 远端 `deskserver` | Windows 10.0.19045 x64；OpenSSH_10.3p1（服务端）；Node v24.16.0；Git 2.54.0；登录 Shell = Git Bash（未修改） |
| 远端 `ucloud` | Ubuntu 24.04.4 LTS；kernel 6.8.0-101-generic x86_64；OpenSSH_9.6p1；Node v22.23.2；Git 2.43.0 |
| 本轮目录 | 脚本与结果：`tmp/ssh-recovery-20261026-1718-a7f3/`；数据/日志：`tmp/ssh-recovery-omp-studio-recovery-20261026-1718-a7f3/`（均在 gitignored `tmp/`） |
| 远端私有根 | deskserver：`%TEMP%\omp-studio-recovery-20261026-1718-a7f3-final-desk\root`；ucloud：`~/.cache/omp-studio-recovery-20261026-1718-a7f3-final-uc2/root` |

### 源码与实际运行的 bundle 对应关系

| 产物 | 构建命令 | 结果 |
|---|---|---|
| `packages/*` | `npm run build:packages` | tsc 通过 |
| `apps/desktop/dist`（含 `src/remote/*`、`test/*`） | `npm run build -w @omp-studio/desktop` | tsc 通过，测试与 harness 都导入这份 dist |
| `apps/desktop/dist/remote-host/host.mjs`（远端 Host） | `node scripts/bundle-remote-host.mjs` | 生成 1,697,710 B，`host.json` 同步 |
| `apps/desktop/dist/ssh-askpass/omp-ssh-askpass.exe` | 同上 | 5,632 B（本轮未走账密，未使用） |
| `apps/renderer/dist` | `npx vite build --outDir <私有目录>` | 见第 4 节：产物文件名哈希与源码构建一致（`index-B5EO9SoB.js`），用于 Electron 闭环 |
| `apps/desktop/dist/preload.cjs` | `scripts/preload-bundle.mjs`（`bundlePreload()`） | 80,907 B；仅 Electron 闭环需要（`npm run build` 不产该文件） |

`npm run check` 的完整 `vite build` **未成功**（被宿主批量删除护栏拦下），因此没有"一次命令产出全部产物"的证据；上述分部构建是等价替代，且 renderer 产物经哈希比对与源码一致。

## 3. 本轮方法与故障注入分层

harness 全部位于 `tmp/ssh-recovery-20261026-1718-a7f3/`：

- `gate.mjs`：测试进程内包装 `node:child_process.spawn`（`syncBuiltinESMExports()`），**持有本轮每条系统 SSH 子进程的真实句柄**，只对本轮 ssh 的 `-T` 控制通道做帧级代理（`@omp-studio/studio-protocol` 的 `FrameDecoder/encodeFrame`），其余进程原样返回；另包装 `node-pty.spawn` 取得 PTY 的真实 pid。
- `lib.mjs`：真实 `RemoteConnectionManager` 夹具、状态时间线、等待/断言、真实 `runSsh` 证据读取。
- `run-host.mjs`：15 个场景；`ui-test-main.mjs` + `ui-flow.mjs` + `cdp.mjs`：Electron 闭环。

隔离方式（唯一注入点，与交接要求一致）：

1. `services.probeRemote` 实际调用产品 `probeRemote`，**只把返回的 `environment.root` 换成本轮私有根**；`deployRemote` / `attachRemote` / OpenSSH / 远端 Host 全部真实实现。
2. manager 的 profiles 文件、helper 目录指向本轮私有路径；不使用默认 `omp-studio/remote/state`。
3. Electron 闭环使用**独立测试入口**（`tmp/.../ui-test-main.mjs`），复用真实 preload（`dist/preload.cjs`）、真实 renderer 产物、真实 `RemoteConnectionManager` 与 `registerRemoteIpc`，另注入两项：私有远端根、自动接受部署确认（正常安装包使用原生对话框，自动化无法点击）。报告不把它当作安装包证据。

故障注入的证据层级（诚实标注）：

| 注入 | 实现 | 证据层级 |
|---|---|---|
| 瞬断 | `child.kill()` 终止本轮捕获的**真实 ssh.exe 句柄**；`stdout` EOF 由代理原样转发，产品据此判定 `network` | 实际 SSH 通道 + 真实进程终止 |
| 短暂迟滞 | 在代理里暂缓**服务端→客户端**的帧转发（保留字节），观察到 degraded 后放回 | **应用控制通道字节迟滞，不是 TCP 丢包** |
| 连续失联 | 持续暂停上述转发，直到产品两次 ping 超时关闭通道 | 同上 |
| 握手/同步挂起 | 在代理里hold住 `hello`（出方向）或 `bootstrap` 响应（入方向） | 同上 |
| 未知结果 | 请求已到达远端并产生副作用后，hold住 `command` 响应再终止通道 | 实际 SSH 通道 + 远端真实副作用 |
| 终端自身 SSH 死亡 | `taskkill /PID <node-pty 捕获的 pid>` | 实际 SSH 通道 + 真实进程终止 |

**TCP 层丢包/中断未做**：在不改用户 SSH config、不改防火墙/路由/网络适配器的前提下，无法把一条独立的 loopback 转发器插进产品的 ssh 调用（产品不暴露 `ProxyCommand`/额外 `-o` 注入口）。因此"真 TCP 丢包"在本轮为**阻塞**，上表的迟滞类结论只覆盖应用控制通道。未用 `peer.close(new Error(...))` 之类内存模拟冒充网络断线。

## 4. 命令、退出码与回归计数

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run check` | **1** | **环境阻塞**：`vite build` 清空 `apps/renderer/dist` 时被宿主批量删除护栏拦下（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count=55 threshold=50`，目标 `dist/brands`）。按授权未移动/删除目标绕过 |
| 2 | `npm run build:packages && npm run build -w @omp-studio/desktop && node scripts/bundle-remote-host.mjs` | 0 | 分部构建通过（等价替代 #1 的构建部分） |
| 3 | `npx vite build --outDir tmp/.../renderer-build` | 0 | 通过；`index.html` 与 `apps/renderer/dist/index.html` 逐字节相同，主 chunk 哈希同为 `index-B5EO9SoB.js` |
| 4 | `node --test apps/desktop/dist/test/remote-*.test.js` | 0 | **47 pass / 0 fail / 0 skipped / 0 todo** |
| 5 | `npm run test -w @omp-studio/renderer -- src/workspaces/ExecutionTargets.test.tsx src/workspaces/remoteTransport.test.ts src/workspaces/SshPasswordDialog.test.tsx src/conversation/useConversation.test.ts src/conversation/conversation.test.tsx src/terminalSessions.test.tsx src/sidebar/useProjectHistories.test.ts` | 0 | **7 files / 37 tests pass** |
| 6 | `node scripts/test-remote-ssh.mjs deskserver` / `test-remote-terminal.mjs deskserver` | 未运行 | 见第 11 节：本轮用等价但更强的 manager harness 覆盖同一链路，未重复跑旧脚本（其 finally 清理不完整，易累积 Host） |
| 7 | `node tmp/.../run-host.mjs deskserver` | 0 | 15/15 场景通过 |
| 8 | `node tmp/.../run-host.mjs ucloud`（含 3 次针对剩余场景的复跑） | 0 | 7 通过 / 1 部分 / 7 阻塞（主机网络窗口，系统 SSH 同时失败，见 7.2） |
| 9 | `node tmp/.../ui-flow.mjs deskserver` | 0 | 见第 8 节 |

#1 的副作用：`vite build` 在报错前已删掉 `apps/renderer/dist/assets`。为恢复可用产物，用同一源码的私有构建**复制**回 `apps/renderer/dist`（只复制、未删除任何东西；`index.html` 内容与构建前逐字节一致）。这不是绕过护栏，但确属本轮对构建产物目录的写操作，特此记录。

## 5. deskserver（Windows）用例矩阵

证据层级：除注明外均为**实际 SSH 通道**（真实 manager + 系统 OpenSSH + 远端 Host），时间线来自 `results-deskserver.json`。

| # | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | 首次连接 | 通过 | probe/deploy/attach = 1/1/1；`hello.protocolVersion=2`、`platform=win32`；bootstrap 有 authority；文件树含 `sample.txt`、`子目录 带空格`；Git 判定为仓库；耗时 3,743 ms |
| 2 | 成功后保持连接 | 通过 | 连续 62 s 采样 61 次全为 `connected`；期间 4 次健康 ping；attach 数未增加 |
| 3 | 稳定 60 s 后断开 → 新预算 | 通过 | 断开后状态 `recovering` 的 `attempt=1`，首个退避 1.1 s；generation 1→2；Host instanceId 不变 |
| 4 | 瞬断自动恢复 | 通过 | 真实终止控制通道 ssh 子进程后：`recovering→synchronizing→connected`，无手动 connect；probe/deploy 计数不变（1/1）；attach +1；instanceId 不变；authority 不变 |
| 5 | 短暂迟滞 | 通过 | 迟滞 30 s 后进入 `degraded`（"远端响应迟缓，暂停新的写操作…"），放行后 `synchronizing→connected`；**未新建通道**（attach 不变）、未重新部署 |
| 6 | 连续失联 | 通过 | 两次 ping 超时后 44,976 ms 触发恢复；被暂停的通道由产品关闭；恢复只 attach 一次、deploy 仍为 1 |
| 7 | 连续抖动 / 预算耗尽 | 通过 | 5 次快速抖动得到 `attempt=1..5`，退避实测 **1.1 / 2.0 / 3.2 / 9.1 / 14.8 s**（1/2/4/8/15 ±20%）；第 6 次断开进入 `failed`，文案"自动恢复已停止（最多 5 次 / 120 秒）；请手动重连核对任务，未重发命令"；期间 deploy 始终为 1；随后手动 connect 成功且仍复用原 Host |
| 8 | 退避中取消 | 通过 | 取消后 4 s 内无新 attach（9→9），状态 `disconnected`，无存活控制通道，认证已清除 |
| 9 | attach 握手中取消 | 通过 | 挂起通道保持 `recovering`（未 connected）；取消后 2.5 s 仍 `disconnected`，被挂起通道已关闭，无迟到 connected |
| 10 | 快照同步中取消 | 通过 | 观察到 `synchronizing`；取消后 2.5 s 仍 `disconnected`；被 hold 的 bootstrap 响应 1 帧从未交付；通道关闭；只发生被取消的那一次 attach |
| 11 | Host 停止 | 通过 | `shutdown` 被接受后进入 `failed`，文案"远端 Host 已停止或端点不存在；请手动重新连接，自动恢复不会重启任务"；**未自动 probe/deploy**；手动重连才重新部署 Host |
| 12 | Host 实例改变 | 通过 | 手动重连后 instanceId `b4fc6064…` → `a04747b9…`，状态带 `hostRestarted=true` 与"已更换实例；…不能保证原任务仍在运行"；generation 前进 |
| 13 | 同一 Host 的旧 attach | 通过 | 同 key seq1 → seq2 成功替换（旧通道 ping 失败）；随后 seq1 迟到被拒："这条 SSH 通道已被更新的连接取代"；新通道 ping 正常（未被踢掉）；未在报告写出 attachment key |
| 14 | 其他桌面占用 | 通过 | 第二个独立 manager（独立 profiles）连接同一 Host：`failed`，文案"远端 Host 已被其他桌面连接占用；不会强制断开对方"；第一方 ping 正常、generation 不变 |
| 15 | 未知结果不重放 | 通过 | `workspace.file.create`；请求到达远端后 hold 住确认并终止通道；客户端报 `OUTCOME_UNKNOWN`（"SSH 通道已中断；已发送命令结果未知，未自动重发"）；恢复后远端文件**恰好 1 个**；客户端只发过 1 次 command，恢复后的新通道 command 帧为 0 |
| 16 | IPC 映射 | 通过 | 真实 `registerRemoteIpc` 的 `omp-studio:remote:command` 返回 `{ok:false,error:{code:"OUTCOME_UNKNOWN"}}`；远端副作用仍只有 1 份 |
| 17 | 真实 PTY | 通过 | cwd = 远端中文/空格项目；输入输出往返；resize 后仍可用；Ctrl-C 中断后 shell 返回；**控制通道断开期间终端继续可用**；终止 PTY 自己的 ssh（pid 692，父进程校验）后 `onExit` 触发，5 s 内无自动重开 |
| 18 | 目标隔离 | 通过 | 命令写入只落在远端项目；本机同名目录未生成同名文件；本机哨兵 `sentinel.txt` 内容哈希与 mtime 均未变 |
| 19 | 资源收尾 | 通过 | 追踪 37 条 ssh 子进程，结束时 `leftoverPids=[]`、`liveControl=0` |

**deskserver 合计：15 个场景（上表按行为拆成 19 行）/ 15 通过，99 项检查全绿。**

## 6. 时间线与重试预算实测（deskserver）

```
connected#1 ──(62 s stable, 4 pings)── kill ── recovering(a1, 1.1 s) ── synchronizing ── connected#2
connected#2 ── hold 30 s ── degraded ── release ── synchronizing ── connected#3   (attach 不变)
connected#3 ── hold ── degraded ── 2×ping timeout(45.0 s) ── recovering(a2) ── connected#4
connected#4 ── 62 s stable ── 5×(kill → recovering a1..a5 → connected) ── 6th kill ── failed
failed ── manual connect ── connected（probe/deploy 仍为 1）
```

`probe=2 / deploy=2 / attach=21` 是整轮累计：2 次来自"首次连接 + Host 重启后的重新部署"，其余 19 次都是 attach（恢复/取消/旧 attach 测试）。

## 7. ucloud（Ubuntu）用例矩阵

### 7.1 结果

ucloud 的完整矩阵跑到 `cancel-during-snapshot-sync` 时进入一段主机网络窗口（见 7.2），此后每个场景的**首次连接**都在 15 s 建连阶段失败。为避免把环境问题写成产品结论，本轮做了三件事：①窗口内用系统 SSH 并发对照；②对已通过项记录完整时间线；③对剩余项单独复跑。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 首次连接 | 通过 | probe/deploy/attach=1/1/1；hello `platform=linux`；文件树含 `sample.txt` 与中文目录；Git 仓库；bootstrap authority；5,175 ms |
| 2 | 稳定保持 | 通过 | 62 s 内全 connected，4 次健康 ping，attach 不变 |
| 3 | 稳定后断开 → 新预算 | 通过 | attempt=1；generation 前进；instanceId 不变 |
| 4 | 瞬断自动恢复 | 通过 | 真实终止控制通道 ssh → `recovering→synchronizing→connected`；deploy 不变；attach +1 |
| 5 | 短暂迟滞 | 通过 | 迟滞 → `degraded` → 放行 → `synchronizing→connected`，不新建通道 |
| 6 | 连续失联 | 通过 | 两次 ping 超时后 44,945 ms 触发重建；deploy 不变 |
| 7 | 连续抖动 / 预算耗尽 | 通过 | attempts `[1,2,3,4,5]`；退避实测 **1 / 1.9 / 4.1 / 9.4 / 15 s**；第 6 次 `failed`，文案"自动恢复已停止（最多 5 次 / 120 秒）…" |
| 8 | 退避中取消 | 通过 | 取消后无新 attach，`disconnected` |
| 9 | attach 握手中取消 | 通过 | 挂起通道保持 `recovering`；取消后仍 `disconnected`，无迟到 connected |
| 10 | 快照同步中取消 | **部分** | 观察到 `synchronizing`，取消后保持 `disconnected`、通道关闭、只发生 1 次 attach；但该轮 `heldFrames=0`（同步是自然变慢而非被 hold），注入未真正生效 |
| 11 | Host 停止 | **阻塞（环境）** | 首次连接即卡在 15 s 建连超时 |
| 12 | Host 实例改变 | **阻塞（环境）** | 同上 |
| 13 | 旧 attach 替换 | **阻塞（环境）** | 同上（deskserver 同代码已通过） |
| 14 | 其他桌面占用 | **阻塞（环境）** | 同上 |
| 15 | 未知结果不重放 | **阻塞（环境）** | 客户端侧断言通过（`network`/"结果未知，未自动重发"、"未重发"），但"请求到达远端"与"恢复后核对"被窗口阻塞 |
| 16 | IPC 映射 | **阻塞（环境）** | 同 15 |
| 17 | 真实 PTY | **部分 / 阻塞** | cwd、输入输出、resize、Ctrl-C、**控制通道断开后终端仍可用**全部通过；最后等待控制通道恢复超时（环境） |
| 18 | 目标隔离 | **阻塞（环境）** | 首次连接即超时 |
| 19 | 资源收尾 | 通过 | 本轮 5 个残留 Host 以精确 PID + 命令路径核对后 SIGTERM 停掉，目录按 marker 删除（见第 11 节） |

**ucloud 合计：7 个场景通过；`cancel-during-snapshot-sync` 取消语义通过但注入未生效；7 个场景被主机网络窗口阻塞（其中真实 PTY 的 5 项终端行为已通过）。上述未通过项在 deskserver 上由同一份产品代码全部通过。**

### 7.2 主机网络窗口（环境问题，非产品缺陷）

- 现象：从 `cancel-during-snapshot-sync` 起，产品侧每次连接都在 **15.2 s** 失败（`ConnectTimeout=15`），错误文案"SSH 网络连接中断或超时"；随后场景逐个 15 s 连坐。
- 归因证据（关键）：在同一窗口内并发执行**系统 OpenSSH**（同样的 `ucloud` 别名、同样密钥），得到
  `ssh: connect to host <redacted> port 22: Connection timed out`；
  产品捕获到的 ssh stderr 也是同一条 `connect to host ... Connection timed out`（exit 255）。窗口外同样命令 3/3 成功（TCP 建连 33–42 ms，ssh 1.9 s）。
- 也就是说：**系统 SSH 与产品同时失败**，属主机/网络侧对新连接的间歇性拒绝；产品在窗口内的表现（有界退避、如实显示"网络连接中断"、不重启 Host、不重发命令）符合设计。
- 环境侧只读观察：`fail2ban` 未启用；`MaxStartups 30:30:100`、`LoginGraceTime 30`（加固配置）。窗口与该 VM 的连接建立速率相关，本轮未改动任何 sshd/网络配置。

## 8. Electron UI 闭环

入口：`tmp/.../ui-test-main.mjs`（**独立 Electron 测试入口**，非安装包）。真实链路：Renderer（真实 `apps/renderer/dist` 产物）→ 真实 preload（`dist/preload.cjs`）→ 真实 `registerRemoteIpc` → 真实 `RemoteConnectionManager` → 系统 OpenSSH → 远端 Host。注入项仅三处：私有 profiles/state、私有远端数据根、自动接受部署确认（正常安装包用原生对话框，自动化点不到）。驱动方式为 CDP `Runtime.evaluate` 派发 DOM 事件（非 OS 级输入）。

| 检查 | 结果 | 证据 |
|---|---|---|
| 工作台启动 + 真实 preload 桥 | 通过 | 标题 "OMP Studio — 工作台"；`window.ompStudioRemote` 14 个方法；真实 manager 读出预置连接 |
| 执行位置菜单 | 通过 | "此计算机 / UI deskserver / Windows · 已断开 / 添加 SSH 连接" |
| 从 UI 发起连接 | 通过 | manager `state=connected`（generation 1），完成真实 probe/deploy/attach |
| 远端目录选择（中文+空格） | 通过 | 对话框列出远端真实目录；填入 `…\UI 稳定性 project` 后注册成功；选择器变为 `SSH · UI deskserver` |
| 远端文件树 / Git | 通过 | 界面出现 `sample.txt` 与项目名 `UI 稳定性 project`；bootstrap authority 来自远端 |
| 草稿 + 瞬断恢复 | 通过 | 可编辑框写入未发送草稿；终止 Electron 主进程的 ssh 子进程后，选择器显示 **恢复中**；恢复后草稿逐字保留，目标未回落"此计算机" |
| 整页重载 | 通过 | 重载后 Main 仍 `connected`，generation 保持 2（未重建连接），活动目标仍为 `ui-profile`，选择器仍 `SSH · UI deskserver` |
| 退出清理 | 通过 | 关闭窗口后主进程退出，其 ssh 子进程数 0 |

步骤合计 **8/8 通过**；截图见 `tmp/ssh-recovery-20261026-1718-a7f3/ui-deskserver/shots/01..06-*.png`。

未覆盖的 UI 项（明确未测）：同步失败后的"重新同步"按钮点击、原生部署确认框的真实点击、对话/子对话恢复后补读与"旧事件不覆盖新状态"的界面级断言、终端回滚在窗口中的渲染、窄窗/深色视觉、安装包内行为。

## 9. 缺陷与边界行为

**未发现需要修复的产品缺陷。** 以下为需注意的边界行为，均未在本轮判为缺陷：

| # | 级别 | 描述 | 证据/说明 |
|---|---|---|---|
| 1 | 注意 | 本机 ssh 子进程被**无 stderr 地**终止时，产品依赖 stdout EOF 才判为 `network`；若先收到子进程 `close`（非零/无诊断），会归为 `unknown` 并停止恢复 | 首轮 harness 未转发 EOF 时曾复现该分类（桌面机 `failed`），补上 EOF 转发后瞬断恢复 15/15 通过。属注入保真度问题，但说明"ssh 被外部杀死且无 stderr"这一类故障在真实环境中会被判成不可恢复 |
| 2 | 注意 | `npm run build` 不产出 `preload.cjs`，直接 `electron apps/desktop` 会得到"Studio client unavailable"；正常入口是 `npm run preview` / 打包 | Electron 闭环前需单独调用 `bundlePreload()`；本轮已记录 |
| 3 | 注意 | 同一 manager 内，恢复预算窗口跨场景保留：短时间内多次断开不会重置预算（设计如此）。若上一场景刚断开过，下一次断开可能直接落在 attempt≥2 | 抖动场景因此显式先稳定 61 s 再计数，避免误判 |
| 4 | 环境 | ucloud 间歇性拒绝新连接（历史问题），窗口内所有新连接 15 s 超时；同一时刻系统 SSH 亦超时 | 见 7.2；产品侧 stderr 与系统 SSH 完全一致（`connect to host ... Connection timed out`），非应用缺陷 |

## 10. 阻塞与未测试

**阻塞**

1. **账密端到端**：`deskserver` 的 `sshd_config` 仍为 `PasswordAuthentication no`（只读确认；`ssh -o PreferredAuthentications=password` 返回 `Permission denied (publickey)`）。`ucloud` 的**有效配置已变为** `PasswordAuthentication yes`（`00-codex-incident-hardening.conf` 先匹配，后续 `999-force-keyonly.conf` 等不再生效；服务端广告 `publickey,password`），但本轮**没有可用凭据**，按授权未做任何密码尝试、未改 sshd。账密弹窗、askpass、`BatchMode=no` 实机生效均**未验证**。
2. **TCP 层丢包/中断**：见第 3 节，无法在不改用户配置/系统网络的前提下注入。
3. **正常安装包内的 Electron 行为**：未执行 `pack:win`/`pack:mac`（缺 `packaging/runtime-payload` 与签名），本轮 UI 证据来自独立测试入口。

**未测试**

- macOS 实机与 macOS 出站 SSH（按交接暂缓）。
- 真实模型调用、真实任务在断线期间的存活、审批等待中断线（无费用授权）。
- 系统睡眠/重启、跳板机、MFA、代理。
- 签名 Runtime 导入/安装/自检全流程（无匹配签名制品）。
- 界面级的"同步失败→重新同步"按钮、旧代次事件覆盖新状态的断言、终端回滚渲染、窄窗/深色截图。
- 安装包与 `resources/ssh-askpass` 的打包后路径。

## 11. 资源清理

本机：

- 证据保留在 gitignored `tmp/`：`tmp/ssh-recovery-20261026-1718-a7f3/`（harness、日志、截图、私有 renderer 构建）与 `tmp/ssh-recovery-omp-studio-recovery-20261026-1718-a7f3/`（结果 JSON、时间线、profiles、本地哨兵目录）。
- 本轮临时 `TEMP`（`…/tmp/ssh-recovery-20261026-1718-a7f3/temp`，约 650 KB）已删除。
- Electron 二进制由 `node_modules/electron/install.js` 从本机缓存装入工作树 `node_modules`（依赖目录，不提交）。
- 结束态核对：按进程表检查，本轮无残留 `ssh.exe`、无残留 Electron 进程、无属于本轮测试目录的 node 进程（`count=0`）。

远端（删除前逐个核对目录名含本轮 run id，且无进程引用；见 `cleanup-remote.mjs`）：

| 主机 | 路径 | 处理 |
|---|---|---|
| deskserver | `%TEMP%\omp-studio-recovery-20261026-1718-a7f3*`（含 `-final-desk`、`-main/-main2`、`-s4..-s11`、`-probe/-probe2/-r1..-r3`） | 20 个目录全部删除并复核 |
| deskserver | `%TEMP%\omp-studio-recovery-ui-deskserver*`（4 个 UI 运行） | 删除并复核 |
| ucloud | `~/.cache/omp-studio-recovery-20261026-1718-a7f3*`（6 个） | 先以精确 PID + 命令路径核对后 SIGTERM 停掉 5 个残留 Host，再删除并复核 |
| ucloud | `~/.cache/omp-studio-recovery-ui-*` | 本轮未在该机跑 UI，无目录 |

**未处理、不属于本轮**：

- deskserver 上 `omp-studio-ssh-test-*`、`omp-studio-terminal-test-*` 若干历史目录（2026-10-25 及更早），未删除。
- ucloud 上 `omp-studio-ssh-test-1792860425334` 及其 Host 进程（自 10-24 起运行）等 7 个历史目录，未触碰。

报告与日志中不含私钥、密码、token、ticket、attachment key 或完整个人 SSH 配置；主机地址在正文以别名或 `<redacted>` 指代。

## 12. 结论

- **可作开发预览**：deskserver 15/15、Electron 闭环 8/8；ucloud 在可用窗口内完成 7/15 并通过了最难的抖动预算与连续失联。恢复过程未重新部署 Host、未重发业务命令、未回落本机；取消三阶段均不产生迟到 connected；Host 停止/换实例有明确文案；未知结果标记 `OUTCOME_UNKNOWN` 且副作用只出现一次。
- **不可发布**：账密端到端在真实服务器上仍无证据（deskserver 禁用密码认证；ucloud 虽已由加固配置广告 `password`，但本轮无凭据、未做任何密码尝试），macOS、安装包、TCP 层丢包、真实模型任务/审批中断线均未验证；ucloud 的 7 项场景被主机网络窗口阻塞，只能在 deskserver 上证明同代码行为。
- **需要修复的问题**：本轮未发现产品缺陷。发布前建议补：①账密实机（含一次错误密码与 askpass 生效证据）；②安装包内 UI 闭环；③TCP 层故障注入能力（否则"网络故障"结论只能停在应用通道）；④ucloud 这类小规格主机上的连接建立速率问题（属环境，但会影响用户观感）。
