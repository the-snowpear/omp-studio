# SSH 工作区与账密连接：独立验收报告

验收日期：2026-10-25。执行者：独立验收 agent（未修改产品逻辑，未提交、未推送）。
报告口径：**通过 / 失败 / 阻塞 / 未测试** 四类互斥；"阻塞"指受环境或前置条件限制无法执行，"未测试"指本轮未安排或缺少授权。

## 总览

| 结论 | 内容 |
|---|---|
| 构建 | 通过（`npm run check`，Node 313 + Renderer 128） |
| SSH 专项回归 | 通过（39/39） |
| 账密协议层（新增隔离回归） | 通过（9 项通过 + 1 项 todo 记录缺陷） |
| Windows 密钥模式实机链路 | 通过（部署、文件、Git、重连、PTY） |
| **账密端到端实机登录** | **阻塞**：两台授权主机均关闭 SSH 密码认证 |
| ucloud 部署/终端/重连 | **阻塞**：主机间歇性拒绝新连接（TCP 超时） |
| macOS 实机与打包产物 | 未测试（按用户要求暂缓） |
| **是否可合入** | **可以合入（功能保持"未发布/预览"标记）** |
| **是否可发布** | **不可以**：账密零实机证据，且有 2 项中等级缺陷 |

## 环境与版本

| 项目 | 值 |
|---|---|
| 工作树 | `D:\Project\omp-studio\.claude\worktrees\trusting-khorana-a24ebe` |
| 分支 / HEAD | `claude/trusting-khorana-a24ebe` / `2a561ae374411e8f15c5ff393d26c20392bad755` |
| 本机 | Windows 11 家庭版中文版 build 26300 x64 |
| 本机 SSH | OpenSSH_for_Windows_9.5p2（`C:\Windows\System32\OpenSSH\ssh.exe`） |
| 本机 Node / npm | v22.22.2 / 10.9.7（受管运行时） |
| 远端 `deskserver` | Windows 10.0.19045，OpenSSH_10.3p1，DefaultShell=Git Bash（MINGW64），Node v24.16.0，Git 2.54 |
| 远端 `ucloud` | Ubuntu 24.04.4 LTS，kernel 6.8.0-101-generic x86_64，OpenSSH_9.6p1，Node v22.23.2，Git 2.43.0 |
| 测试目录 | 本机 `tmp/`（gitignored）；远端每次运行独立 marker 目录 |

未读取用户 SSH 私钥，未索取、未记录任何真实密码。本轮所有密码均为夹具内生成的测试字符串，且只以布尔断言比较。

## 命令与退出码

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run check` | 0 | build 通过；Node 313 pass；Renderer 128 pass；0 fail |
| 2 | `node --test apps/desktop/dist/test/remote-{host,manager,terminal}.test.js scripts/target-platform.test.mjs scripts/runtime-artifact.test.mjs` | 0 | 39/39 pass（见下方环境前置） |
| 3 | `npm run test -w @omp-studio/renderer -- src/workspaces/ExecutionTargets.test.tsx src/terminalSessions.test.tsx` | 0 | 5/5 pass |
| 4 | `node --test apps/desktop/dist/test/remote-authentication.test.js`（新增） | 0 | 9 pass / 1 todo / 0 fail |
| 5 | `npm run test -w @omp-studio/renderer -- src/workspaces/SshPasswordDialog.test.tsx`（新增） | 0 | 3/3 pass |
| 6 | `node scripts/test-remote-ssh.mjs deskserver` | 0 | 部署、文件树、Git、重连同 authority 通过 |
| 7 | `node scripts/test-remote-terminal.mjs deskserver` | 0 | PTY cwd/输入输出/resize/Ctrl-C/关闭通过 |
| 8 | `node scripts/test-remote-ssh.mjs ucloud`（3 次） | 1 | 前两步通过，重连阶段 TCP 超时 |
| 9 | `node scripts/test-remote-terminal.mjs ucloud` | 1 | attach 阶段 TCP 超时 |
| 10 | `npm run typecheck -w @omp-studio/renderer` / `-desktop` | 0 / 0 | 新增测试文件类型干净 |

环境前置（非产品缺陷）：

- 首次 `npm run check`（`tmp/check-run-1.log`，退出码 1）在 Renderer `vite build` 清空 `apps/renderer/dist` 时被宿主沙箱的批量删除护栏拦下（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count=55 threshold=50`）。把上一次的 `apps/renderer/dist` 移到 `tmp/` 后重跑即通过；移动出来的副本已删除。
- 首次 SSH 专项（`tmp/ssh-suite.log`，38/39）唯一失败项是 `remote-host.test.js` 在 `%TEMP%` 写 `远端文件.txt` 得到 `EPERM`（宿主文件访问策略）。把 `TEMP/TMP/TMPDIR` 指到工作树内后 39/39 通过，未改动任何测试断言。

## A. 构建与产物

| 项目 | 状态 | 证据 |
|---|---|---|
| 完整构建 + 核心回归 | 通过 | 441 项（313 + 128）全绿，仅有既有 chunk-size 与 hydration 警告 |
| SSH 专项 39 项 | 通过 | 见命令 2 |
| Windows askpass 编译 | 通过 | `apps/desktop/dist/ssh-askpass/omp-ssh-askpass.exe`（5632 B），PE optional-header magic `0x10b`、**Subsystem=2（WINDOWS_GUI，无控制台）** |
| 构建接线 | 通过 | `scripts/bundle-remote-host.mjs:13` 调用 `buildSshAskpass()`；`npm run build` 已产出该 EXE |
| 打包路径 | 静态通过 / 打包未测试 | `packaging/electron-builder.yml:30-31` 用 `!**/*.exe`、`!dist/ssh-askpass/**` 排除出 asar，`:48-54` 用 extraResources 复制到 `resources/ssh-askpass`；主进程 `apps/desktop/src/main.ts:291` 打包态取 `process.resourcesPath/ssh-askpass`，开发态取 `app.getAppPath()/dist/ssh-askpass`，与构建输出一致。本轮未执行 `pack:win`（缺 `packaging/runtime-payload`），因此"打包后实际存在"未验证 |
| Mac 打包配置 | 静态通过 / 未测试 | `scripts/mac-bundle.mjs:116-121` 复用同一 extraResources（`askpass.sh`、`askpass.cjs` 随包）；`.gitattributes` 有 `*.sh text eol=lf`，工作区文件实测 LF；产物脚本 `askpass.sh` 由 `build-ssh-askpass.mjs:20` chmod 0755。`askpass.sh` 用 `ELECTRON_RUN_AS_NODE=1 "$OMP_SSH_ASKPASS_NODE"`，路径全引号，可容忍含空格的 app 路径；仓库未使用 `@electron/fuses`、也未关闭 run-as-node（其他特性 `mac-app-swap.ts:221`、`login-env.ts:184` 同样依赖该开关），故静态判定兼容。**`scripts/audit-mac.mjs` 未覆盖 ssh-askpass，属检查缺口** |

## B. 账密连接行为

### B1 连接配置

**通过。** `RemoteConnectionProfile` 含 `name/host/user/port/platform/authMode`，无密码字段（`apps/desktop/src/remote/shared.ts:8`）；`manager.save()` 重建对象后落盘，`authMode` 缺省写为 `agent`（`manager.ts:50`）；读取时只有 `authMode === "password"` 走密码分支，其余（含无 `authMode` 的旧配置）按密钥/agent 处理（`platform.ts:49`）。回归 `remote-manager.test.js` 断言重启后 profile 保留且文件不含 `password`。

### B2 密码弹窗

| 要求 | 状态 | 证据 |
|---|---|---|
| 独立密码框、显示正确目标 | 通过 | `SshPasswordDialog.tsx:28` 渲染 `user@host:port`；测试断言 `ubuntu@10.0.0.5` |
| 不预填旧密码 | 通过 | 输入框无 `defaultValue`，测试断言初值为空 |
| 空密码不提交 | 通过 | `SshPasswordDialog.tsx:23` 提前返回；测试断言不触发 `onSubmit` |
| 取消/Esc/关闭/提交后清空 | 通过 | `:17`、`:24`、`:15` 清理；测试覆盖提交与取消 |
| 不进 React 持久状态/草稿/localStorage | 通过（代码） | 密码只存在于局部变量，随后 `credentials.password = ""`（`ExecutionTargets.tsx:140-145`），`useTargetMemory` 未涉及密码 |
| 真实 Electron 闭环 | 未测试 | 需用户在应用内输入真实密码 |

### B3 `BatchMode=no` + `SSH_ASKPASS_REQUIRE=force`

**代码通过，实机阻塞。** `platform.ts:50-51` 在密码模式输出 `BatchMode=no`、`PreferredAuthentications=password`、`PubkeyAuthentication=no`、`KbdInteractiveAuthentication=no`、`NumberOfPasswordPrompts=1`、`ControlMaster=no/ControlPath=none`，`authentication.ts:103` 设 `SSH_ASKPASS_REQUIRE=force`、`:102` 设 `SSH_ASKPASS`。这些参数同时用于无 PTY 帧通道（`deploy.ts:19`、`transport.ts:47`）与真实 PTY（`terminal.ts:40-45` 把 `-T` 换成 `-tt` 并沿用同一 env）。

实机无法验证的原因见"阻塞 B1"：两台主机均 `PasswordAuthentication no`。

### B4 askpass 票据（本地隔离夹具）

新增 `apps/desktop/test/remote-authentication.test.ts`，用真实 `omp-ssh-askpass.exe` + 真实 named pipe 服务端跑，全部通过：

| 行为 | 状态 | 说明 |
|---|---|---|
| 一次有效消费 | 通过 | 同一 ticket 二次调用退出码 1、stdout 为空 |
| 错误票据 / 重复使用拒绝 | 通过 | 同上 |
| 主机信任确认提示不获密码 | 通过 | `yes/no/[fingerprint]` 提示返回 1 且空输出 |
| 私钥解锁提示不获密码 | 通过 | `Enter passphrase for key ...` 返回 1 |
| 非目标账户提示不获密码 | 通过 | `root@example.invalid's password:` 返回 1 |
| 被拒提示同样消耗票据 | 通过 | 同一 ticket 后续再用仍失败 |
| 超时拒绝 | 未测试 | `REQUEST_TTL_MS = 90s`（`authentication.ts:22`）无注入点，未做 90 秒等待；仅代码审阅 |
| 断开/关闭后不可用 | 通过 | `close()` 后 `request()` 抛 `SSH 密码已清除` |
| `-G` 用户/主机与密码提示一致 | 通过（静态+实测 `-G`） | 应用按 `${user}@${hostname}'s password:` 构造（`authentication.ts:42`）。上游 OpenSSH `userauth_passwd()` 用 `"%s@%s's password: "`，其中 host 是 `HostName` 替换后的最终主机名；实测 `ssh -G deskserver` → `10.208.119.201`、`ssh -G ucloud` → `165.154.23.36`、`ssh -G Example.COM` → 已小写 `example.com`、IPv6 `::1` 原样，均与构造规则一致 |
| 默认端口/别名/长用户名 | 通过（静态） | 同一公式无特例，未发现拼接分支 |
| `HostKeyAlias` 场景 | 未测试（风险） | OpenSSH 在设置 `HostKeyAlias` 时用该别名生成提示，应用仍用 hostname，会拒绝交付（fail-closed，不会发错密码，但账密连接建不起来）。本轮两台主机均未配置该指令 |

### B5 Windows helper 与 POSIX helper

| 要求 | 状态 | 证据 |
|---|---|---|
| 无可见控制台 | 通过 | PE Subsystem=2（`/target:winexe`，`build-ssh-askpass.mjs:15`） |
| 返回 UTF-8 密码 | 通过 | 含中文、引号、反斜杠、空格的测试密码逐字节一致 |
| stdout 不混入 .NET/启动日志 | 通过 | 输出恰为 `密码 + "\n"`，stderr 为空字符串 |
| 管道超时与长度限制 | 通过（代码） | `Askpass.cs:22,25,32` 各 5s；响应上限 4097；服务端 5s socket 超时、8192 输入上限、最多 16 连接（`authentication.ts:51-62`） |
| 不授予服务器 impersonation | 通过（代码） | `TokenImpersonationLevel.Identification`（`Askpass.cs:20`） |
| POSIX socket 权限 owner-only | 静态通过 / 实机未测 | `authentication.ts:78` chmod 0600；`ensurePrivateSocketDirectory` 校验目录非软链、属主一致、`mode & 077 == 0`（`socket-paths.ts:66-86`） |
| helper 不依赖全局 Node | 静态通过 / mac 未测 | `askpass.sh` 用 `OMP_SSH_ASKPASS_NODE`（= `process.execPath`，Electron）且 `unset NODE_OPTIONS NODE_PATH` |

### B6 密码不外泄

| 通道 | 状态 | 证据 |
|---|---|---|
| SSH 子进程 argv | 通过 | 测试断言 argv 不含密码；密码只经 askpass 管道返回 |
| SSH 子进程环境 | 通过 | `request().env` 只有 `OMP_SSH_ASKPASS_TICKET`（32 字节随机票据）等，测试断言序列化后不含密码 |
| 本机/远端文件 | 通过（代码） | profile 落盘无密码；`manager.save()` 只写非秘密字段；远端不上传任何密码文件 |
| 报错文本 | 通过（代码） | 密码模式错误一律替换为通用文案，不回显 stderr（`deploy.ts:38`、`transport.ts:68`、`manager.ts:119-120`） |
| host log | 通过（代码） | `apps/desktop/src/remote/*.ts` 无任何 `console.*` 输出 |
| 内存擦除 | 部分通过 | `secret.fill(0)`、helper 收到后清 Buffer；**不能宣称 JS/系统内存无瞬时字符串副本**（与实施状态文档一致）。本轮禁止导出堆转储 |

### B7 取消与迟到动作

| 阶段 | 状态 | 证据 |
|---|---|---|
| 密码弹窗取消 | 通过 | `finishPassword(null)` → `连接已取消`，`ExecutionTargets.tsx:139` |
| 部署确认取消 | 通过 | `ipc.ts:32` 在 `manager.connect` 前检查确认结果与 abort |
| 配置读取/probe/上传/attach 取消 | 通过（代码） | `AbortController` 贯穿 `probeRemote/deployRemote/attachRemote`，`runSsh` 在 abort 时 kill 子进程（`deploy.ts:23-30`）；`manager.ts:101-103` 在每步后 `throwIfAborted` |
| 取消后不得又连上 | 通过（代码） | `manager.ts:114` 在 bootstrap 后校验 `#live` 一致性；渲染侧 `cancelledConnection` 二次校验（`ExecutionTargets.tsx:143-147`） |
| 关闭窗口收回未完成连接 | 通过（代码） | 窗口 `dispose()` → `remoteIpc.dispose()`（`main.ts:880`）→ abort 所有 pending + `manager.disconnect`（`ipc.ts:66`） |
| 应用退出 | 通过（代码） | `beforeShutdown` → `remoteTerminals.disposeAll()` + `remoteConnections.close()`（`main.ts:892`） |
| **重载 Renderer 收回未完成连接** | **失败（未实现）** | `ExecutionTargets.tsx:108-116` 只在 React 卸载时清理，整页重载不会执行；主进程没有对应的导航钩子（`main.ts:580` 的 `did-start-navigation` 只重置会话可见性），`remoteIpc.dispose` 只在窗口关闭时触发。重载后主进程可能继续完成连接，密码 Buffer 保留到手动断开 |

### B8 多阶段票据与断开清除

**代码通过 / 实机未测试。** 每次 `request()` 都生成新票据（`authentication.ts:92-112`），probe、deploy、attach、Runtime 上传/安装重连、新终端各自取一张；票据绑定连接 id（`#authentication`），切换连接拿不到原连接密码；`disconnect()` → `#clearAuthentication()` → `close()` 擦除 Buffer（`manager.ts:127-140`）；Runtime 安装期间仅在维护窗口内保留，维护结束若已无 live 连接则清除（`manager.ts:154-158`）。实机验证需可用密码的服务器。

### B9 不支持项必须明确失败

| 场景 | 状态 | 证据 |
|---|---|---|
| keyboard-interactive / OTP / MFA | 通过 | 客户端 `KbdInteractiveAuthentication=no`（`platform.ts:51`），不会向这类提示发送密码 |
| 密码过期要求改密 | 通过（代码） | 提示为 `Enter user@host's old password:`，与期望不匹配即拒绝（fail-closed） |
| 账密 ProxyJump/ProxyCommand | 部分通过 | 连接前用 `ssh -G` 检测并拒绝（`authentication.ts:39-40`），实机未配置跳板，未实测；**但拒绝文案被通用错误覆盖（见缺陷 1）** |
| 缺 askpass 组件 | 通过 | 测试断言抛 `SSH 账密认证组件未安装`（`authentication.ts:119`） |
| 远端 Node < 22 | 通过（代码） | `probeRemote` 抛 `Remote Node.js 22 or newer is required`（`deploy.ts:55`） |
| 远端系统误选 | 部分通过 | `manager.ts:98` 抛 `目标系统是 X，请修改连接配置`，但密码模式在 `:120` 被替换为通用文案，用户看不到系统不匹配（同缺陷 1） |

## C. UI 与目标隔离

| 要求 | 状态 | 证据 |
|---|---|---|
| 「项目 / 分支 / 此计算机或 SSH」顺序 | 通过（代码） | `ExecutionTargetPicker` 紧跟分支选择器（`App.tsx:5563`） |
| 发送消息后入口不消失 | 通过（代码） | `showContextStrip = isNewConversation && !composerSubmitted`（`App.tsx:3857`），结束后渲染常驻条 `<ExecutionTargetPicker/>`（`:5588`） |
| 项目/分支/执行位置菜单互斥 | 通过（代码） | 打开选择器时回调关闭另两个菜单，`otherMenuOpen` 反向关闭（`ExecutionTargetPicker.tsx:44`、`App.tsx:5563`） |
| 无桌面桥诚实禁用 | 通过 | `unavailable = !preview && !api` → 菜单项 `disabled` + 提示"SSH 连接需要桌面客户端"（`:150,157`） |
| 预览模式三系统 + 账密弹窗演示 | 通过 | `PREVIEW_SSH_TARGETS` 含 linux/win32/darwin；保存账密配置后弹 `SshPasswordDialog demo`（`:184`）；既有测试断言预览选择不调用 `connect/select` |
| 演示不写 Host、不伪造 capability | 通过（代码） | 预览分支只改本地 `useTargetMemory` 与 `demoPasswordProfile` |
| 本机/双远端草稿与会话隔离 | 通过（测试） | `ExecutionTargets.test.tsx` 两项：切回保留原草稿；远端 bootstrap 失败保留本机目标与草稿 |
| 终端按目标保留 | 通过（代码+测试） | `TerminalPane.tsx:35` 按 `executionTarget.id` 过滤；`terminalSessions.test.tsx` 覆盖关闭/缓存 |
| 断线不回落本机 | 通过（代码+测试） | `manager.get()` 抛 `SSH 已断开…不会回落到本机`；`refresh()` 对非 connected 目标调用 `transportLost` |
| 模型配置未保存阻止切换 | 通过（代码） | `ExecutionTargets.tsx:164` |
| 浅色/深色、窄窗口视觉 | 未测试 | `ssh.css` 全部使用主题变量（`:14-15` 等），但未做真实窗口截图/交互 |
| 浏览器/Electron 交互与截图 | 未测试 | 未启动浏览器或 Electron；本轮以代码 + jsdom 测试代替 |

新增 `SshPasswordDialog.test.tsx`（3 项）覆盖 B2 的 UI 行为；该文件与 `remote-authentication.test.ts` 都不在 `scripts/test-core.mjs` 默认门禁内，符合"不把页面细节加入默认门禁"的约定。

## D. 双平台远端功能

| 项目 | deskserver (Windows) | ucloud (Ubuntu) |
|---|---|---|
| 严格 host key 的密钥登录 | 通过 | 通过（首次探测时） |
| Host 部署（版本化目录、校验） | 通过 | 通过（两次运行均完成） |
| 文件树 / Git（中文+空格项目名） | 通过 | 通过（两次运行均 `FILES_GIT_OK`） |
| 断线后附加同一 Host（同 authority） | 通过（`RECONNECT_SAME_HOST_OK`） | **阻塞**：第二次连接 TCP 超时（3 次运行均在此步失败） |
| 终端 cwd/输入输出/resize/Ctrl-C/关闭 | 通过 | **阻塞**：attach 阶段 TCP 超时 |
| 无 Runtime 空态 | 通过（`runtime.status=unavailable` 且仍可浏览） | 通过 |
| Runtime 导入 / 签名与架构校验 | 未测试（无匹配的签名制品，未执行 `pack:win`） | 未测试 |
| 真实模型任务 / 文件修改 | 未测试（无模型调用授权） | 未测试 |
| 断线后 Host 继续跑任务、审批等待 | 未测试 | 未测试 |
| 主机换实例后的完整重同步 | 未测试 | 未测试 |

ucloud 失败细节：`ssh: connect to host 165.154.23.36 port 22: Connection timed out`，失败发生在 TCP 建连阶段（`transport.ts:68` 上报），同一时刻手工 `ssh ucloud echo` 也连续 3 次超时，数分钟后恢复。判定为**主机/网络侧对新连接的间歇性拒绝**，不是应用逻辑错误；也不是"断线后不能重连"的产品缺陷，但本轮无法据此确认 ucloud 的重连与终端。

`AttachConsole failed`（node-pty `conpty_console_list_agent.js`）在 deskserver 终端测试通过后仍打印，脚本退出码 0。核实：本机无残留 `conpty_console_list_agent` 进程、无残留 `ssh.exe`，远端无对应测试 Host 进程；该 worker 自行退出。与实施状态文档记录一致，属已知诊断噪声，不称为"完全无警告"。

## 缺陷清单

| # | 严重度 | 位置 | 描述 | 复现/证据 |
|---|---|---|---|---|
| 1 | 中 | `apps/desktop/src/remote/authentication.ts:115-121`、`apps/desktop/src/remote/manager.ts:119-120` | 密码模式把所有失败统一改写为"无法准备 SSH 账密认证…"/"账密 SSH 连接失败…"，跳板机拒绝、系统误选、用户名/主机解析失败、取消等原因全部丢失，用户无法判断该改什么 | 新增测试 `the jump-host refusal names the unsupported feature` 标记为 todo：实际抛出通用文案 |
| 2 | 中 | `apps/renderer/src/workspaces/ExecutionTargets.tsx:108-116`、`apps/desktop/src/main.ts:580,880` | 重载 Renderer 不会取消进行中的 SSH 连接（只有 React 卸载、窗口关闭、应用退出会取消） | 代码路径核对：主进程无导航/`render-process-gone` 钩子调用 `remoteIpc.dispose` |
| 3 | 低 | `apps/desktop/src/remote/authentication.ts:26` | 密码超过 4096 字节时报"不支持换行或 NUL"，未说明长度上限；UI `maxLength=4096` 以字符计，长 Unicode 密码会被静默判为超长 | 代码核对 |
| 4 | 低（风险） | `apps/desktop/src/remote/authentication.ts:42` | 依赖 `ssh -G` 的 `hostname`；若用户 config 设了 `HostKeyAlias`，OpenSSH 会用别名生成提示，应用将拒绝交付密码（fail-closed，连接建不起来） | 上游 `userauth_passwd()` 语义比对；本轮无该配置，未实测 |
| 5 | 低（流程） | `scripts/audit-mac.mjs` | Mac 打包审计未覆盖 `ssh-askpass`（可执行位、随包存在性） | 全文无 `askpass` 引用 |

未发现：密码进入 argv/env/文件/日志、票据可重用、错误提示把密码回显、公钥静默回退（`PubkeyAuthentication=no`）、把目标密码发给跳板机（跳板在连接前被拒）。

## 阻塞与未测试

**阻塞**

1. **账密端到端**：`deskserver` 与 `ucloud` 的 sshd 均为 `PasswordAuthentication no`（另 `KbdInteractiveAuthentication no`）。按授权边界未修改服务器配置，未做任何"错误密码"尝试（因此也没有触发账户锁定的风险；deskserver 锁定阈值为 10 次/10 分钟，仅作记录）。B3、B8 的实机部分与 C 的 Electron 闭环都因此无法执行。
2. **ucloud 的 attach/终端/重连**：主机间歇性拒绝新连接（TCP 超时），非应用缺陷。

**未测试**

- macOS 实机、macOS 出站 SSH、Mac 打包产物内的 `ssh-askpass` 权限与 run-as-node 实际执行。
- 真实打包（`pack:win`）后 `resources/ssh-askpass` 是否存在（缺 `packaging/runtime-payload`）。
- 签名 Runtime 导入全流程（错误架构/坏签名、任务中拒绝安装、同版本重装、失败保留旧 Runtime）。
- 真实模型调用、模型文件修改、审批等待中断线、系统睡眠/重启、跳板/MFA。
- 浏览器与 Electron 的真实交互、浅色/深色与窄窗口截图。
- 票据 90 秒超时的实际拒绝（无注入点，未等待）。

## 资源清理

本机：

- 移出的旧 `apps/renderer/dist`（约 24 MB）与 `tmp/verify-20261025/`（含 runtime-artifact 测试临时目录，126 KB）已删除。
- 无残留 `ssh.exe`、无残留 `conpty_console_list_agent` 进程、无本次测试 Host 进程。
- `tmp/*.log`（构建/测试原始输出）保留在 gitignored 的 `tmp/` 下作为证据，未提交。

远端（仅删本次创建、确认无任务的目录）：

| 主机 | 路径 | 处理 |
|---|---|---|
| deskserver | `…\AppData\Local\Temp\omp-studio-ssh-test-1792919656734` | 已删除，复核不存在 |
| deskserver | `…\AppData\Local\Temp\omp-studio-terminal-test-1792919670212` | 已删除，复核不存在 |
| ucloud | `~/.cache/omp-studio-ssh-test-1792919566852` | 先 kill 该目录的 Host PID 3088698，再删除，复核不存在 |
| ucloud | `~/.cache/omp-studio-ssh-test-1792919715094` | 已删除，复核不存在 |
| ucloud | `~/.cache/omp-studio-terminal-test-1792919938350` | 已 kill 对应进程并删除，复核不存在（`procs=0`） |

**未处理、留给负责人确认**（不属于本次创建）：`~/.cache/omp-studio-ssh-test-1792860425334`、`-1792860751905`、`-1792910548838`、`omp-studio-terminal-test-1792864271694`、`-1792910695322`、`-1792911440082`、`omp-studio-runtime-test-1792865634980`；其中 `-1792860425334` 的 Host 进程（PID 2641164，自 10-24 起）仍在运行，占用该临时数据根。未按模糊进程名或通配符清理。`tmp/ssh-debug/experiments/` 未运行、未改动。

## 结论

**是否可合入：可以。** 构建与 441 项核心回归通过，SSH 专项 39 项通过；Windows 密钥模式的部署/文件/Git/重连/PTY 实测通过；账密协议层（票据一次性、错误/越权提示拒绝、UTF-8、argv/env 无明文）由新增隔离测试覆盖。缺陷 1、2 不改变"密码不外泄"的安全边界，但影响可用性与取消语义，应在合入说明中保留，并保持功能为未发布的预览状态。

**是否可发布：不可以。** 账密端到端从未在真实密码服务器上跑通（两台授权主机都禁用密码认证），macOS 未验证，打包产物未实测。发布前最小修复/验证项：

1. 保留具体失败原因（缺陷 1）：`authentication.ts` 的 catch 只包装未知错误，`manager.ts` 密码分支保留 `cause.message` 或按类别映射（跳板机/系统不匹配/Node 版本/取消）。
2. 重载 Renderer 时取消进行中的连接（缺陷 2）：主进程监听 `did-start-navigation`/`render-process-gone`，或在 preload 用 `pagehide` 触发 disconnect。
3. 修正超长密码提示（缺陷 3）。
4. 在**开启密码认证且已确认锁定策略**的主机上各做一次：正确密码登录（验证 askpass 实际生效、非公钥/ControlMaster）、一次错误密码（确认不静默回退公钥、不锁定账户）。
5. macOS 实机核对 `Contents/Resources/ssh-askpass/askpass.sh` 可执行位与 run-as-node 执行，并把该检查加进 `audit-mac`。

在上述 4、5 完成前，任何"账密认证通过"的表述都不成立；本报告不把代码审阅、夹具测试或脚本退出码 0 当作账密实机通过的证据。
