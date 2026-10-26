# SSH 工作区实施状态

更新：2026-10-26。**已完成连接稳定性优化及本地验证：有界自动恢复、健康检查、恢复同步、安全错误提示、Renderer 导航取消。未提交、未发布。**

## 2026-10-26 稳定性优化

- 自动恢复仅针对已连接会话的网络故障：优先 attach 原 Host，最多 5 次 / 120 秒，1/2/4/8/15 秒退避并加入 ±20% 抖动。连续稳定 60 秒才重置预算，避免反复瞬断导致无限重试。
- 每 15 秒执行一次应用层健康检查，单次等待 15 秒；一次丢响应暂停写入，两次连续丢响应才重建通道。不把业务请求超时等同于任务失败，不重启 Host/Runtime，不重发任何业务命令。
- 附加身份仅在 Main 内存，序号递增；新通道只能替换本桌面同目标的旧通道，其他桌面仍拒绝。私有线协议升为 v2，旧 Host 需显式连接准备更新，不在断线恢复中升级。
- 恢复后同步 Client 快照，并刷新主/子对话、文件树、Git、历史与基础库存。当前页面、草稿、未保存表单、终端不因自动恢复整体重挂。事件与异步读取按连接代次隔离，迟到旧 bootstrap 不能覆盖新状态。
- 认证/主机密钥/配置/协议错误或 Host 已停止立即停止恢复。已验证密码仅在当前连接和有界恢复窗口中保留，失败/取消/主动断开/退出清除。首次失败不自动重复尝试密码。
- 已修复独立验收的两项缺陷：内部安全错误保留具体原因（跳板、目标 OS、取消等）；Main 对整页导航、Renderer 崩溃和销毁取消未完成连接，保持 IPC 可复用。已建立连接不因连接请求结束而误触发 abort。
- 核心检查通过：`npm run check`，314 项 Node + 129 项 Renderer。最新 SSH 专项 47/47，Renderer 专项 37/37（部分与核心重叠，不合并宣称独立总数）。Windows askpass 真 helper 隔离测试通过，跳板提示用例已无 todo。
- 浏览器隔离验收页验证了恢复、同步失败后重试、取消以及未保存编辑保留；768×1024 与 375×812 均读回尺寸，窄窗无横向溢出，深浅色提示均可读。验收页不调用真实 SSH。热更新重复 createRoot 警告已通过卸载清理修正。
- 本轮未运行真实服务器网络故障注入、模型调用、密码登录、完整 Runtime 安装或安装包验收；macOS 实测仍暂缓。本地注入回归不能替代真实 SSH 端到端。
- 构建首次失败于新增测试的两处 TypeScript 声明，修正后完整检查通过。保留既有 Vite chunk-size 和 React hydration 警告，不称零警告。

2026-10-25 的独立验收报告保留在 [ssh-workspace-test-report.md](ssh-workspace-test-report.md)，未改写原报告。以下保留先前实施历史；涉及“未验证”的历史条目应结合本节的新结果阅读。

用法见 [SSH 工作区](../docs/ssh-workspaces.md)，测试任务见 [交接提示词](ssh-workspace-test-prompt.md)，架构取舍见 [原始计划](ssh-workspace-plan.md)。

## 已实现

- 工作台“项目 / 分支”右侧的“此计算机 / SSH”选择器；连接保存/编辑/移除、取消连接、远端目录选择、断开与重连。发送消息后仍有执行位置入口。真实与演示模式分开；演示按钮不建立 SSH 连接。
- 目标级 Client、事件、草稿、路由与队列状态隔离；传输中断将未确认命令标记为结果未知，不自动重发，不转投本机。独立 Runtime 的已提交队列不随 UI 切换迁移。
- 不依赖 Electron 的远端 Host，复用原有会话、文件树、Git/GitHub、模型配置与 Runtime 管理。系统 OpenSSH 的无 PTY 帧通道承载语义请求，交互终端走独立真实 SSH PTY。
- 版本化 Host 部署、启动和重新附加；版本不一致时只允许在无其他附加客户端、无任务和无待处理审批时更换。Windows 用 CIM 启动脱离 SSH 登录进程的当前用户进程，没有安装系统服务。
- 签名 Runtime ZIP 导入、目标平台检查、上传摘要检查、停止空闲 Host、获取同一 authority 锁、安装/自检/激活后重连；复用既有可信公钥，不接收制品自带信任根。
- Linux、Windows、macOS 路径和 Shell 分支，Linux Runtime 平台表/ELF 检查。桌面更新平台表保持 Windows/macOS，没有新增 Linux 桌面包。
- 终端按目标保留，不因切换工作位置销毁；关闭时终止 PTY，不向未知前台程序输入 `exit`。Windows PTY 整命令引号修复了 Git Bash 作为 DefaultShell 时丢失参数、落错目录的问题。
- 本机文件打开、媒体/屏幕/浏览器、产物等尚未适配远端的旁路被阻断，避免操作本机同名目录。Composer 图片传内容，普通本机文件提示使用远端 `@`；远端 Plan 保存使用项目内相对路径表单。

## 新增账密实现（未验证）

连接配置新增 `authMode`（缺省为原有 agent/密钥方式）和独立用户名。密码不进入 profile、localStorage、Host read model、远端部署文件或命令行；连接时由单独的密码弹窗提供，通过固定 Electron IPC 交给 Main。

Main 用内存 Buffer 保留本次连接密码，按 SSH 子进程创建短时、单次 askpass 票据。Windows askpass 为无窗口 .NET Framework helper；macOS/POSIX 为脚本 helper，走私有 Unix socket。票据绑定目标账户密码提示，拒绝主机确认、非目标提示与重复消费。密码模式只启用 SSH password 认证，不偷偷退回公钥或 keyboard-interactive。

认证注入覆盖 probe、Host 部署、attach、Runtime 上传/安装/重连及新 SSH 终端。失败、取消、断开和退出清理内存密码与票据；Runtime 安装的受控断连期间临时保留，重连完成后继续属于同一连接。安全擦除只针对可控 Buffer，不能宣称 JavaScript/系统内存中不存在瞬时字符串副本。

打包构建新增 `scripts/build-ssh-askpass.mjs`，生成 `apps/desktop/dist/ssh-askpass`，electron-builder 作为 `resources/ssh-askpass` 携带；没有把依赖、生成 EXE 或秘密文件纳入源码。取消信号覆盖部署确认、异步配置加载和实际连接，Renderer 重载也取消尚未完成的连接。

保留三个参数化手动验收入口：`scripts/test-remote-ssh.mjs`、`scripts/test-remote-terminal.mjs`、`scripts/test-remote-session.mjs`。六个临时交叉构建、上传和签名实验脚本已移入 gitignored `tmp/ssh-debug/experiments/`，不作为产品工具交付，文件内容仍保留在当前工作树。

**用户提出“先不测试了”后，未运行新一轮构建、单元测试、浏览器测试或真实密码登录。** 因此账密 helper 编译、OpenSSH askpass 行为、打包路径、密码清理和新 UI 都必须由接手 agent 验证；不能沿用早先的通过数作为最终账密版本的通过证据。

## 此前实际验证（账密变更之前）

| 项目 | Windows `deskserver` | Ubuntu `ucloud` |
|---|---|---|
| 严格 host key 的系统 SSH 密钥登录 | 通过 | 通过，短连接间歇网络超时 |
| Host 部署、文件树、Git | 通过 | 通过 |
| 断线后附加同一 Host | 通过 | 通过 |
| 可信 Runtime 安装与 session.create | 18.12.6-studio.1 通过 | 18.12.6-studio.1 通过 |
| Runtime 会话重连 | 已创建会话可连接 | 已确认同一 authority/epoch/session |
| 终端 cwd、输入输出、resize、Ctrl-C、关闭 | 通过 | 通过 |

实测环境：Windows 10 build 19045 / Node 24.16.0；Ubuntu Linux x64 / Node 22.23.2 / glibc 2.39。本机 Windows OpenSSH Client 9.5；Windows 服务端 OpenSSH 10.0，DefaultShell 是 Git Bash。没有修改服务端注册表、sshd、防火墙或系统服务。

Linux 测试 Runtime 的两次实际构建问题已区分：跨平台 Bun 字节码曾 JSC abort；不含字节码的实验构建曾因漏做 `gen:stats` 而让完整 smoke test 返回 HTTP 500。按上游流程补齐嵌入资源后，完整 `--smoke-test`、Bridge probe、签名安装、session.create 与重连全部通过。**该 Windows 交叉构建只用于本次验收，正式 Linux Runtime 仍需 native runner 构建；没有发布测试签名或测试二进制。**

PTY 自动化加入 xterm 协议应答后双平台通过。随包 ConPTY DLL 曾留下 node-pty worker，已撤销该改动，恢复系统 ConPTY；最终系统 ConPTY 测试正常退出，但其内部 `conpty_console_list_agent.js` 打印过 `AttachConsole failed`，这是保留的已知诊断，不称为完全无警告。

早先 `npm run check` 完整通过：313 项 Node 核心 + 128 项 Renderer 核心。另有 SSH Host、配置、终端、UI 草稿/终端缓存和 Runtime 制品专项回归通过。完整 build 仍有既有 chunk-size 警告，核心 UI 测试有既有 hydration 警告。

浏览器仅完成演示菜单、三平台选项、连接表单、演示保存、无 console error 的局部检查；没有完成可靠的全宽/深色/窄屏和真实 Electron SSH 闭环。多次 resize 误传了覆盖自定义宽高的 preset，不能据此声称 1440px 验收通过。

## 未验证与限制

- 账密新增代码全部待验证；macOS 实机按用户要求暂缓。没有读取用户 SSH 私钥或索取/记录密码。
- 真实模型调用、模型文件修改、审批等待中断线、系统睡眠/重启、跳板机、Mac 客户端尚未验收。
- 首次 host key 信任仍由系统 SSH 完成；密码模式不支持 MFA、改密和跳板机，密钥模式继续沿用 config。
- 远端 Node 自动安装、Runtime 自动下载、普通本机文件上传、产物跨端传输、远端本机媒体转发、SSH 终端录制未实现。
- Windows 私有端点使用随机 pipe 名和认证令牌，令牌/状态目录有 ACL；pipe DACL 的独立多用户验收仍待完成。专用 agent 目录隔离会话/模型配置，但不等于隔离 OMP 所有共享插件/统计目录。
- 同一远端账户/data root 只允许一个附加桌面，多个 alias 不自动合并。
- 测试仅在本任务创建的私有临时目录中进行。部分测试 Runtime/签名阶段目录仍保留，待验收 agent 核对后按精确路径清理；不批量删除用户目录。
