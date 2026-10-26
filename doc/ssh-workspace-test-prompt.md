# SSH 工作区与账密连接：独立验收提示词

## 2026-10-26 增量复验：连接稳定性

当前源码已加入有界恢复与导航取消修复。先保留并阅读 `doc/ssh-workspace-test-report.md` 的原始验收结论，本轮结果另写 `doc/ssh-workspace-recovery-test-report.md`，不要覆盖原报告。

- 本轮实现者已跑通 `npm run check`：314 Node + 129 Renderer；SSH 专项 47/47，Renderer 专项 37/37。计数存在交叉，不相加。应独立复跑，不能直接照抄为本轮结果。
- 重点测试：已连接后瞬断；连续抖动；退避期间取消；挂起 attach 被 120 秒预算终止；认证/host key/配置/协议/Host 停止不重试；一次业务超时只检查健康；未知命令不重发；同 Host 恢复不 probe/deploy/start；同桌面旧 attach 替换、其他桌面不抢占；Host 实例改变有明确提示。
- UI：恢复中和同步中暂停写；恢复后补读当前主/子对话、历史、文件树和 Git；不重挂整个工作台，保留草稿/模型编辑/终端；旧代次事件/读结果/bootstrap 不能覆盖新状态。同步失败提供“重新同步”，不要求重复输入密码或部署。
- Main：整页重载、render-process-gone、销毁取消未完成连接；原生确认框返回迟到的“同意”不能继续连接；页面重载后 IPC 仍可用。已建立连接不能被连接请求 finally 的 abort 误关。
- 安全：只在已有成功登录后的最多两分钟网络恢复中复用内存密码；认证拒绝或最终失败/取消清除。deskserver/ucloud 的 PasswordAuthentication=no 仍是实机账密阻塞，不改 sshd、不试错密码、不索取秘密。
- 本地回归新增：`apps/desktop/test/remote-{recovery,transport,ipc}.test.ts`；Renderer `workspaces/remoteTransport.test.ts` 及 `ExecutionTargets.test.tsx`、`conversation/useConversation.test.ts`。
- 浏览器隔离验收页：`ssh-recovery-harness.html`，源码 `src/test/ssh-recovery-harness.tsx`，不在 Vite 生产入口。只模拟连接状态，不连服务器，不接收真实密码。它不能代替 Electron→OpenSSH→远端的端到端验收。

```bash
node --test apps/desktop/dist/test/remote-*.test.js
```

```bash
npm run test -w @omp-studio/renderer -- src/workspaces/ExecutionTargets.test.tsx src/workspaces/remoteTransport.test.ts src/workspaces/SshPasswordDialog.test.tsx src/conversation/useConversation.test.ts src/conversation/conversation.test.tsx src/terminalSessions.test.tsx src/sidebar/useProjectHistories.test.ts
```

以下为先前的完整验收任务，安全边界继续有效；旧的“尚未构建”描述只代表交接时的历史状态。

将下面的任务正文交给测试 agent 即可。此文件不包含密码、私钥或登录令牌。

---

请独立验收 OMP Studio 当前工作树中的 **SSH 工作区 + 用户名/密码连接**。这轮以测试、复现和报告为主；可以补充隔离的回归测试，不要未经确认重构产品、提交或推送。不要启动子代理。

## 工作目录与现状

- 工作目录：`D:\Project\omp-studio\.claude\worktrees\trusting-khorana-a24ebe`。
- 分支：`claude/trusting-khorana-a24ebe`，开发基线 `2a561ae374411e8f15c5ff393d26c20392bad755`。
- 功能都在未提交改动中，包含未跟踪的新文件；不要只看 `git diff` 就漏掉 `apps/desktop/src/remote/` 等目录。不要切到原仓库根目录或创建一个不含这些改动的工作树来测试。
- 先读 `AGENTS.md`、`doc/feature-index.md`、`docs/ssh-workspaces.md`、`doc/ssh-workspace-progress.md`。
- 用户明确要求实现 agent 停止测试，因此 **账密新增代码尚未构建或实测**。较早的密钥模式曾在 Windows/Ubuntu 跑通，441 项核心回归曾通过，但不代表当前版本通过；不要照抄旧结论。

## 授权与安全边界

- 可使用已有 SSH 别名 `deskserver`（Windows）和 `ucloud`（Ubuntu），只在本次新建的私有临时目录中测试。macOS 实机暂缓，报告中明确列为未验证。
- 已授权使用这些别名不等于已提供它们的密码。真实密码由用户在应用密码框中输入，或通过用户另行授权的安全凭据通道提供；不要在聊天中索取私钥/密码，不读取用户 SSH 私钥，不从已有配置/日志中搜集密码。
- 不要把密码放入命令行参数、环境变量、脚本常量、测试快照、日志、录屏、截图、报告或 Git。需要非真实凭证测试时，在隔离夹具内生成测试密码，比较只输出布尔结果。
- 先做本地 helper/协议夹具；错误密码的实机测试须确认账户锁定策略，仅一次有意失败，不做循环猜测。
- 不关闭 `StrictHostKeyChecking`，不自动信任指纹，不修改用户 `known_hosts`；未知/变化主机密钥用独立临时 known_hosts 夹具验证，真实首次信任留给用户。
- 不改服务器 `sshd`、DefaultShell、注册表、防火墙或密码策略，不新建账户/服务，不重启服务器。没有密码认证条件时标记阻塞，不擅自启用。
- 保留所有现有改动，不 `git reset --hard`，不批量删除、不动共享 stash。不要提交依赖、构建产物、日志或临时截图。
- 不绕过签名、架构检查或 Runtime 自检；不通过修改测试期望掩盖失败。真实模型调用只有得到凭证使用/费用授权后才能进行。

## 重点入口

- UI：`apps/renderer/src/workspaces/ExecutionTargetPicker.tsx`、`ExecutionTargets.tsx`、`SshPasswordDialog.tsx`、`RemoteScopeNotice.tsx`、`ssh.css`。
- 目标状态/终端：`apps/renderer/src/App.tsx`、`terminalSessions.tsx`、`TerminalPane.tsx`；客户端 `packages/client/src/{studio-client,reducer}.ts`。
- 认证：`apps/desktop/src/remote/authentication.ts`、`platform.ts`、`manager.ts`、`ipc.ts`、`apps/desktop/src/preload.ts`。
- askpass：`apps/desktop/ssh-askpass/Askpass.cs`、`askpass.cjs`、`askpass.sh`；构建 `scripts/build-ssh-askpass.mjs`、`scripts/bundle-remote-host.mjs`；打包 `packaging/electron-builder.yml` 和 `scripts/mac-bundle.mjs`。
- SSH 执行：`apps/desktop/src/remote/{deploy,transport,wire,terminal}.ts`。
- 远端生命周期与安装：`apps/desktop/src/remote/{main,host,server,authority,install}.ts`。

## A. 构建与现有回归

在当前工作目录先检查改动，随后运行一次完整构建和核心回归：

```bash
npm run check
```

补跑 SSH 专项（依赖前一步生成的 dist，不要拿旧 dist 当最新源码）：

```bash
node --test apps/desktop/dist/test/remote-host.test.js apps/desktop/dist/test/remote-manager.test.js apps/desktop/dist/test/remote-terminal.test.js scripts/target-platform.test.mjs scripts/runtime-artifact.test.mjs
```

```bash
npm run test -w @omp-studio/renderer -- src/workspaces/ExecutionTargets.test.tsx src/terminalSessions.test.tsx
```

检查 Windows `csc.exe` helper 编译；确认生成的 `omp-ssh-askpass.exe` 位于 `apps/desktop/dist/ssh-askpass`，打包后位于 `resources/ssh-askpass`，没有被全局 EXE 排除规则或 asar 路径挡住。也检查 Mac 打包配置保留脚本可执行位、路径带空格、CRLF、`ELECTRON_RUN_AS_NODE` 以及 Electron run-as-node fuse 的兼容性，但不要把静态检查算作 Mac 实测。

## B. 账密连接必须验收的行为

1. 添加/编辑连接有主机、独立用户名、认证方式、端口、远端系统。原有无 `authMode` 的配置仍按密钥/agent 模式读取；保存、重启、编辑后只保留非秘密字段。
2. 选择账密模式连接时出现独立密码框，显示正确目标，不预填旧密码。空密码不提交；空格/引号/反斜杠/Unicode 密码原样交给 SSH，绝不经过 shell 拼接。取消、Esc、关闭、发送后输入框清空，不进入 React 持久状态、草稿或 localStorage。
3. `BatchMode=no` + `SSH_ASKPASS_REQUIRE=force` 在无 PTY 控制通道和真实 PTY 终端均实际生效。验证是 **password 认证成功**，不是用了机器上已有的公钥或 ControlMaster。密码错误不可静默回退公钥。
4. 本机 askpass 票据：一次有效消费、重复使用拒绝、超时拒绝、错误票据拒绝、断开/退出后不可用。拒绝主机信任确认、私钥解锁提示、非目标账户提示；不要把目标密码发给跳板机。核对系统 SSH `-G` 的用户/主机与真实密码提示一致，包括别名、域用户、IPv6、长用户名/主机名。
5. Windows helper 无可见控制台，返回 UTF-8 密码给 SSH；标准输出不能混入 .NET/启动日志。管道请求有超时、长度限制，客户端不授予服务器 impersonation 权限。POSIX socket 权限 owner-only，helper 不依赖全局安装的另一个 Node。
6. 检查密码不在 SSH/PowerShell/Node 的 argv 或环境中，不落本机/远端文件、报错或 host log。进程环境可以有短时票据，但不得有明文密码。验证清理效果时禁止导出真实密码堆转储。
7. 在密码弹窗、部署确认、配置读取、probe、上传、attach 各阶段取消；确认没有“取消完成后又连上”的迟到动作。重载 Renderer/关闭窗口/应用退出也须收回未完成连接。连接失败后重试必须重新询问密码。
8. 连接成功后，新建终端、部署阶段多次 SSH、Runtime 上传/安装重连均能获得各自票据；切换到另一连接不能获得原连接密码。断开清除密码，已建立的普通终端不重新绑定目标。
9. 不支持项须明确失败：keyboard-interactive、OTP/MFA、密码过期要求改密、账密 ProxyJump/ProxyCommand。不能发送密码响应到这些提示。缺 askpass 组件、Node<22、远端系统误选应报告错误而不是假成功。

建议为以上真实生命周期补少量可复现测试，优先用户可感知行为，不写成套内部结构/字符串匹配测试。Electron contextBridge 会复制参数，单元替身不要依赖对传入对象后续修改来假装真实 IPC。

## C. UI 与目标隔离

- 新对话的顺序必须是“项目 / 分支 / 此计算机或 SSH”，发送消息后目标入口不消失；项目、分支、执行位置菜单互斥。
- 真实模式没桌面桥时诚实禁用；预览模式提供三系统与账密弹窗演示，演示保存/连接不调用 Host/SSH，不伪造 capability。
- 本机与两远端来回切换：草稿、选中会话、历史、相同 sessionId、事件流、命令收据、审批、队列不串；模型配置未保存时阻止切换。
- 旧终端标签和回滚内容留在创建目标；后台输出继续收集；新终端进入对应远端项目。断线不把新的提示词/文件操作发到本机。
- 浅色/深色、正常桌面宽度和窄窗口下检查菜单、密码框、目录框、取消、键盘焦点与错误提示。可用浏览器工具时执行交互与截图；**设置自定义宽高不要同时传会覆盖它们的 preset**，并读回 `innerWidth/innerHeight`。工具不能设置目标宽度时明确记录，不反复重试同一个调用。
- 真正的 UI→preload→Main→SSH→Host 闭环需 Electron 验收，浏览器 fixture 和脚本各自通过不能替代它。

## D. 双平台远端功能

先完成安全前提，再按需使用三个参数化手动入口。它们采用已有系统密钥，**不能证明账密认证成功**；账密要从新 UI 路径单独验收。

```bash
node scripts/test-remote-ssh.mjs deskserver
```

```bash
node scripts/test-remote-ssh.mjs ucloud
```

```bash
node scripts/test-remote-terminal.mjs deskserver
```

```bash
node scripts/test-remote-terminal.mjs ucloud
```

`test-remote-session.mjs` 需要显式 `<alias> <host-entry> <state>`，只传验收 agent 自己新建的隔离 state；它会创建会话并在末尾停止该测试 Host。Windows Git Bash 传 POSIX 路径时注意 `MSYS_NO_PATHCONV=1`。

验证空格/中文项目路径、文件真实字节、Git diff、目录已删除、无 Runtime 空态、缺模型配置。Runtime 导入需覆盖错误架构/坏签名拒绝，存在任务/审批/终端时拒绝安装，同版本重装，失败后旧 Runtime/keys 保留，成功后恢复连接；核对真正的 OS、CPU 和 Bridge identity。

终端必须有 xterm 协议应答（不是仅抓 stdout），覆盖 cwd、输入/输出、resize、Ctrl-C 和退出后无残留。Windows DefaultShell=Git Bash 是已知实测环境，需注意 PTY 整命令引用；另检查 cmd/PowerShell 分支但不要更改用户系统 DefaultShell。若 node-pty 仍出现 `AttachConsole failed`，记录真实影响和残留进程证据，不仅凭脚本 exit 0 忽略。

断开控制连接后 Host/运行任务应继续；重新附加确认同一 authority/epoch/session，不自动重发未确认修改。等待审批时不能被闲置回收。若主机已经换实例或重启，必须完整重同步而非声称原任务自动续跑。

有明确模型调用授权时，在临时 Git 项目发送一个最小文件修改任务，核对模型工具、文件树、`@`、Git diff、终端看到同一个远端文件；没有授权则将该项标记为未测试。

## E. 清理与报告

- 所有远端测试写入事先确认的本次私有临时目录。记录本次创建的目录与进程，只清理自己创建且确认无任务的资源；不要按模糊进程名杀 Node/SSH 或按通配符删除用户目录。
- 旧实验脚本在 gitignored `tmp/ssh-debug/experiments/`，只是本次实现调试记录，不是发布工具；先阅读，勿直接运行。构建产物/临时测试密钥不得带入正式包。
- 输出报告 `doc/ssh-workspace-test-report.md`。内容：版本/系统/SSH/Node/Bun/路径环境；每项通过/失败/阻塞/未测试；确切命令与退出码；脱敏截图或日志；可复现步骤；严重度、文件和行号；本次资源清理情况。
- 明确区分代码缺陷、环境限制、旧版本证据与新验证。macOS、密码实测或模型调用未进行就写未进行。
- 最后给出“是否可合入”和“是否可发布”的独立结论；若阻塞，列最小修复项，不改生产逻辑后不复验就报通过。
