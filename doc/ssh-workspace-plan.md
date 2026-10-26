# SSH 工作区：调研与实施讨论稿

日期：2026-10-24；实施更新：2026-10-26。状态：**SSH 基础功能与账密连接已接入；已完成连接稳定性优化及本地回归，真实密码登录仍受服务器认证配置阻塞，macOS 实测暂缓**。实施与验证记录见 [ssh-workspace-progress.md](ssh-workspace-progress.md)，测试交接见 [ssh-workspace-test-prompt.md](ssh-workspace-test-prompt.md)。

用户已批准按三平台计划执行，继续由当前助手亲自完成、不使用子代理。本文保留调研时的取舍与阶段目标；“建议”不代表已实现能力，实际交付以实施记录为准。

## 1. 目标与建议结论

在工作台输入框上方现有的“项目 / 分支”右侧增加执行位置选择器：**此计算机 / SSH 主机**。

推荐把 SSH 工作区定义为：**界面在本机，项目文件、Git、终端、OMP Runtime 和会话数据在远端执行或保存**。通过 SSH 连接，不复制整个项目到本机，不把远端包装成一个假的本地目录，也不要求模型改用另一套 `remote_*` 工具。

**已确认的平台要求：远端必须同时考虑 Linux、Windows 和 macOS，三者均是本计划的正式支持目标，不再把 Windows / macOS 远端推迟为可选扩展。** 共用协议与交互，分别实现平台适配并验收；“仅 Linux 跑通”不代表本功能完成。

客户端沿用应用当前的 Windows / macOS 桌面范围，支持多个已保存连接、一个前台执行位置。这里区分“连接 Linux 工作区”和“新增 Linux 桌面安装包”：后者不是本轮 SSH 功能自动包含的改动。CPU 架构和最低系统版本是单独的兼容矩阵，不能因为同属某个操作系统就宣称全部支持。

### 1.1 平台与架构规划

| 远端系统 | 建议首批验收基线，尚未实测 | 必须覆盖的差异 |
|---|---|---|
| Linux | x64、glibc，选择一个当前受支持的发行版作为基线 | 用户级后台进程、libc / 原生依赖、POSIX 权限和路径 |
| Windows | x64、Windows 11 / 受支持的 Windows Server，启用 OpenSSH Server | cmd / PowerShell、盘符路径、ACL、Windows PTY 和后台进程 |
| macOS | Apple Silicon arm64、受支持的 macOS，开启远程登录 | 登录环境、隐私权限、钥匙串、Mach-O 签名和进程生命周期 |

Linux arm64、Windows arm64、Intel macOS x64 都列入架构兼容评估；根据 patched Runtime、原生依赖、制品和测试机情况逐项定级，不暗中依赖模拟运行。Windows arm64 已有 Runtime 平台条目，但不等于远端 Host 已验收；Intel macOS 目前没有对应 Runtime 制品，不能标为已支持。

首批架构基线与最低 OS / libc / OpenSSH 版本在 P0 给出实测结论；不支持的组合在连接准备阶段显示具体缺项，不到发出第一条提示词时才报错。

## 2. 当前应用的接入事实

源码基线：`2a561ae374411e8f15c5ff393d26c20392bad755`。

| 已核对的事实 | 位置 | 对方案的影响 |
|---|---|---|
| 项目和分支已有同一条 `ctx-strip` | [App.tsx:5356](../apps/renderer/src/App.tsx:5356) | 新选择器直接接在分支后，不另造工作区页面 |
| 上下文条只在新对话且未发送时显示 | [App.tsx:3847](../apps/renderer/src/App.tsx:3847) | 消息发送后也必须有持续可见的执行位置提示 |
| 现有上下文条已有颜色、字号、间距、弹出菜单样式 | [workbench.css:4271](../apps/renderer/src/styles/workbench.css:4271) | 复用现有设计 token、Icon 和菜单，不改整套视觉风格 |
| 工作区是 Host 内部真实目录，注册和激活会本地 `lstat` | [workspace-registry.ts:19](../packages/studio-host/src/workspace-registry.ts:19)、[workspace-registry.ts:105](../packages/studio-host/src/workspace-registry.ts:105) | 不可把 `ssh://...` 填进当前 `canonicalPath` |
| 对外工作区记录只有不透明 ID 和展示信息 | [read-models.ts:264](../packages/client-contract/src/read-models.ts:264) | 保留列表不携带绝对路径和凭证的边界 |
| 文件树、Git、工作区目录选择由 Desktop 组装 | [host-factory.ts:569](../apps/desktop/src/host-factory.ts:569)、[workspace-files.ts:57](../apps/desktop/src/workspace-files.ts:57) | 仅转发 Runtime Bridge 不够，这些服务也要在远端运行 |
| 每个常驻 Runtime 固定绑定启动时的 workspace / cwd | [runtime-session.ts:184](../apps/desktop/src/runtime-session.ts:184) | 切换机器是选择另一执行上下文，不是迁移正在运行的会话 |
| `ClientTransport` 已有统一的 bootstrap/query/command/subscribe/close | [client-contract/index.ts:116](../packages/client-contract/src/index.ts:116) | 可复用语义契约，增加 SSH 传输适配，不解析 TUI |
| Client reducer 的 epoch/cursor 属于一个 authority | [reducer.ts:670](../packages/client/src/reducer.ts:670) | 不把多台主机的事件混入同一个 reducer 再比数字大小 |
| PTY 是独立桌面 IPC，不走上述 Host transport | [terminal-ipc.ts:1](../apps/desktop/src/terminal-ipc.ts:1)、[terminal-shared.ts:28](../apps/desktop/src/terminal-shared.ts:28) | 必须单独接远端终端，不能误把本机终端标为 SSH |
| `transport-web` 有 HTTP / 浏览器适配，WebSocket 服务端升级仍留给调用方 | [transport-web/server.ts:68](../packages/transport-web/src/server.ts:68) | 不是现成可上线的 SSH 后端；借鉴接口，不强行搬入浏览器 pairing/cookie 流程 |
| 当前生产 Host 限定 Windows / macOS，Runtime 制品也没有 Linux | [host-factory.ts:665](../apps/desktop/src/host-factory.ts:665)、[runtime-platform.ts:7](../packages/runtime-installer/src/runtime-platform.ts:7)、[target-platform.mjs:8](../scripts/target-platform.mjs:8) | Linux headless Host 与 Runtime 构建验证必须先做 |

现有 `EnvironmentId` 出现在 bootstrap / 历史记录中，但不能只凭名称就把它认作 SSH 主机 ID。实施时核对它的现行语义；下文用 `executionTargetId` 表示新的执行位置概念，最终命名统一后再落契约。

## 3. 网络调研结论

网页抓取工具未能访问目标域名，搜索工具没有返回有效条目；随后通过 GitHub API 成功读取参考仓库源码、VS Code 官方文档源文件及 OpenSSH 官方手册源文件。未执行下载的代码，也未把参考仓库的功能声明当作实机验证。

### 3.1 dsh-remote-ssh：可参考交互和兼容经验，不照搬核心模型

核对版本：`2.4.38`，提交 `55001e20572e19ec38988daa16f9a44f6bbb5dd3`，MIT 许可。

源码和 README 表明它是 DSH 的适配插件，主要机制是：

- 用系统 OpenSSH，提供连接配置、密钥 / 密码、ProxyJump、SSH config 发现。
- 用本地镜像目录和 `.remote-ssh.json` 标识远端工作区，拦截文件路由、包装模型侧文件服务。
- 文件读写等操作复用常驻 `ssh <host> bash`，通过输出哨兵切分执行结果；不是部署完整的远端 DSH Host。
- 集成终端使用 shell wrapper 和 `ssh -tt`，并进入远端项目目录。
- 处理 @ 文件补全、批量目录读取、缓存失效、连接超时和错误诊断。

值得借鉴：连接入口、导入已有别名、远端目录选择、终端 cwd、@ 远端文件、操作合并以减少 SSH 往返。

不建议照搬：

- **本地镜像作为文件真值。** 其 README 明确说明本地有旧文件时仍可能读取旧镜像；写回失败与本地写入成功也可能分离。OMP Studio 应避免出现“模型说改好了，但远端没改”的双重状态。
- **只拦截部分路由。** OMP 有 Runtime 文件工具、Git、归档、Skills/MCP、独立 PTY、媒体与系统打开等多条路径，遗漏一条就可能误用本机数据。
- **关闭主机密钥验证或密码进入参数。** 核对版本的终端 wrapper 使用 `StrictHostKeyChecking=no`，密码分支使用 `sshpass -p`。这些不进入本计划。
- **用 shell 输出哨兵实现 Studio 控制协议。** 本项目已有类型化 Bridge，应使用结构化协议帧；终端输出只用于终端显示。

如果未来复用 MIT 源码片段，应保留相应版权和许可；本计划不以复用该项目源码为前提。

### 3.2 VS Code Remote SSH：更适合本应用的架构方向

官方文档描述的是：本地 UI 通过 SSH 通道访问远端 Server，代码和命令在远端，无需在本机保留源码；远端 Server 可由本地下载后传过去，端口转发用来访问远端开发服务。

借鉴这个分层，而不是依赖或分发 VS Code Server。OMP Studio 部署自己的轻量 Headless Host 和匹配的 OMP Runtime。

### 3.3 SSH 库选择

**首选系统 OpenSSH，`ssh2` 为需要重新评估时的备选，不首版同时实现两套。**

理由：OpenSSH 原生处理用户的 `Host` / `Include` / `Match` / IdentityFile / ssh-agent / ProxyJump 等配置，减少自己重写 SSH 配置规则和认证行为。Windows 优先明确解析系统 OpenSSH，避免无意使用 Git Bash 的另一套 ssh。

- 连接配置保存别名或结构化字段，不接受任意 shell 命令字符串。
- 主机发现只用于列出候选；实际连接交给 OpenSSH。显示生效参数时可使用 `ssh -G`，不把简单 INI 解析器当成完整 OpenSSH 配置实现。
- 读取用户已有配置不等于信任项目文件中的 SSH 配置。`ProxyCommand` / `Match exec` 可执行本地命令，不从工作区自动导入或自动运行。
- `ssh2` 能做 exec、PTY、SFTP、forwardOut 和交互认证，但仍需自行实现配置兼容、主机信任和凭据策略；文档说明未设置 `hostVerifier` 时会自动接受主机密钥，不能使用这个默认行为。

## 4. 界面与交互

### 4.1 入口位置

保留现有布局，只增加第三项：

```text
[ 项目名 ▾ ]  [ main ▾ ]  [ 此计算机 ▾ ]
┌──────────────────────────────────────────┐
│ 输入消息……                                │
└──────────────────────────────────────────┘
```

连接远端后：

```text
[ backend ▾ ]  [ feature/api ▾ ]  [ SSH · dev-server ▾ ]
```

下拉菜单建议包含：当前“此计算机”、已保存 SSH 主机、添加 SSH 连接、从 SSH 配置选择、管理连接。主机行显示名称和文本状态，不只靠绿点表达是否连上。

- 与项目 / 分支菜单互斥打开；支持键盘、Escape 关闭、焦点返回触发按钮。
- 窄窗口优先截断项目名 / 分支名，仍保留“SSH”和主机简称；不靠 hover 才能识别执行位置。
- 沿用现有图标、字号、密度和主题 token，不引入新的字体或图标库。
- 当前上下文条发送后会隐藏：建议原位置保留紧凑的执行位置标识。已建立会话不允许通过一个开关直接改变其执行机器；可以从入口切换到另一机器的工作区 / 新对话。

### 4.2 新增连接

普通字段：连接名称、主机或已有 SSH 别名、用户名、端口；高级选项再展开密钥文件、跳板机、远端平台（自动 / Linux / Windows / macOS）和必要的 Shell 覆盖。已有 SSH 别名不要求重复填写其配置。连接成功后显示实际 OS / 架构；“此计算机”永远指运行当前桌面客户端的机器，远端系统不会改变这个文案的含义。

建议流程：

1. 选择或填写连接。
2. 连接并完成主机指纹信任 / 必要认证。
3. 检查远端系统、架构、目录权限及运行要求。
4. 首次使用时明确说明并确认安装 OMP Studio 远端组件。
5. 输入远端路径或用远端目录选择器浏览，注册并打开工作区。

连接测试不偷偷部署程序。未知主机密钥须确认；主机密钥变更则阻断并给出核验指引，不自动清空 known_hosts。

连接状态区分“SSH 已连接”“组件准备中”“工作区就绪”。能登录服务器不等于模型已配置或 Runtime 已就绪。

### 4.3 切换语义

- **机器选择决定项目列表的数据源。** 切到 dev-server 后只能从 dev-server 的项目 / 远端目录中选择，不沿用本机目录字符串。
- 第一次进入远端，没有最近项目时显示目录选择；取消或连接失败仍留在原执行上下文，不半切换。
- 老对话、审批、队列和终端绑定创建时的目标，不能跟随一个全局当前机器变量改投其他主机。
- 草稿按执行位置、工作区和会话分别保存；跨机器不自动搬运本机文件胶囊。纯文本复制可以显式提供，附件需要显式上传。
- 切换视图不等于停止后台会话；“断开连接”“停止任务”“卸载远端组件”是不同动作。
- 首版侧栏、历史、用量与配置页以当前机器为范围并标明作用域；不先做跨所有服务器的混合会话目录。后台状态至少保留目标级摘要，不能伪装所有主机共享一个 Runtime。

## 5. 推荐架构

```text
本机 Renderer
  │ 现有类型化 Desktop IPC
本机 Desktop：执行位置管理、SSH 认证、连接与目标路由
  ├─ 此计算机 → 现有 Host → 现有 Runtime / Git / 文件 / PTY
  └─ SSH 主机 → OpenSSH 加密通道 → 远端 attach 网关
                                   │ 当前用户私有 IPC（socket / named pipe）
                              远端 Headless Host
                                ├─ workspace / Git / 文件 / 配置
                                ├─ 会话目录、归档、命令收据
                                └─ OMP Runtime 常驻会话

远端交互终端：独立 SSH PTY 通道，绑定明确目标和远端工作区
```

### 5.1 传输与远端生命周期

建议 Studio 语义通道使用无 PTY 的 `ssh -T`，运行受控 attach 入口；stdin/stdout 只传有版本、有长度边界的结构化帧，诊断走 stderr。登录脚本污染 stdout 时给出明确握手错误，不把任意终端输出当 JSON 尝试吞掉。**远端 exec 会经过服务器配置的 Shell，不能认为本机 `spawn` 的参数数组已经解决远端命令转义。**

引导阶段采用平台适配：Linux / macOS 使用经过验证的 POSIX 入口，Windows 分别覆盖 OpenSSH 默认 cmd 和配置为 PowerShell 的场景。不能统一发送 `bash -lc`、`uname`、`chmod` 或 `nohup`。只做有界的系统 / Shell 探测，不确定时让用户选择目标平台，随后用握手验证；平台选择不是跳过校验。安装位置通过受控引导取得，上传目录 / 制品路径按目标 Shell 编码，协议内容不走 PowerShell 文本管道，避免二进制、换行或编码被改写。

attach 入口连接**目标系统的当前用户私有 IPC 端点**：Linux / macOS 使用私有 Unix socket，Windows 使用带用户 ACL 的 named pipe。**常驻 Headless Host 的生命周期不绑在一条 SSH stdin 上**，否则网络闪断会杀掉任务。无需开放公网 HTTP 端口，不默认修改 sshd 配置、Windows DefaultShell 注册表或系统防火墙。

组件部署以普通用户权限为目标，但要区分两个前提：启用 Windows OpenSSH Server / 防火墙或 macOS 远程登录可能需要管理员操作；Windows 的无交互常驻与会话退出策略也尚需实测，不能提前保证所有机器都能无提权部署后台宿主。

三平台在 P0 都验证 SSH 断开、显式结束登录会话、Host 崩溃、机器休眠 / 重启等不同场景。POSIX 的独立进程组不等于一定能逃过会话清理，Windows 的 `Start-Process` / detached 标志也不等于已经解决 SSH 会话回收或 Job Object 继承。优先验证受支持的用户级宿主方式；若某环境需要注册后台任务 / 服务才能达到承诺，须明确说明权限和清理方式并取得授权，不能悄悄安装系统服务。重启后恢复历史不等于运行中任务自动继续。

服务端数据帧与 PTY 大流量分通道；目录查询、文件读取按需分页/合并。保留现有流式节流和背压，不逐 token 建 SSH 连接。

`transport-web` 不承担首版远程连接认证；无需为了 SSH 引入公网服务、浏览器 pairing 或新的通用 `invoke`。

### 5.2 目标、工作区与 Client 隔离

建议引入本地执行位置目录，保存连接配置引用和远端最近工作区引用。每台 Host 仍维护自己的 WorkspaceRegistry，路径规范化在目标机器上执行。

客户端身份按 `{executionTargetId, workspaceId, sessionId}` 分区：

- 不能按项目名称、相同绝对路径或裸 sessionId 合并不同机器的数据。
- 不让 Windows 路径函数处理 Linux 的 `/home/...`。
- 每个 authority 使用独立 Client 状态和事件流。切换前台会话时切换相应上下文；旧连接迟到事件只能更新旧目标。
- 当前机器、待连接机器分开保存；完成握手和工作区选择后才提交前台切换。
- 本地连接管理始终可用，即便远端不可达；不要把连接管理功能放到“必须先成功连远端才能调用”的远端 facade 中。
- 现有模型配置仍保持每台机器 / 用户单份全局 `models.yml`，不因为 SSH 改成每项目复制一份。

### 5.3 必须覆盖的远端表面

- 对话、工具、审批、计划：远端 Runtime 和 Host，沿用现有语义协议。
- 文件树、@ 提及、Git 状态 / 分支 / diff / 提交：远端服务，读取同一工作区。
- 终端：真实 SSH PTY，进入已验证的项目目录；切换机器不会把已有终端重新绑定。远端目录不存在时明确报错，不悄悄落到本机 Shell。
- 模型配置、Skills、MCP、用量和诊断：当前执行机器的数据。MCP 的 stdio 进程在远端启动，不能假定能访问本机工具。
- 历史 / 归档 / Runtime 收据：远端 Host 持有，本地仅保存必要展示缓存和引用。
- 产物查看与下载、本地附件上传：明确的数据传输动作，不能把远端路径交给本机 fs，也不能把本机附件路径直接交给远端模型。
- “在资源管理器 / 访达显示”、外部编辑器、Plan 另存为等桌面旁路：逐项适配。没有远端能力的项目显示原因并禁用，不能回落本机同名路径。
- 本机相机 / 麦克风 / 实时媒体等不作为首版远端等价能力承诺；若无显式转发，禁用并说明。

### 5.4 三平台服务适配要求

| 能力 | Linux | Windows | macOS |
|---|---|---|---|
| SSH 服务 | 已配置的 sshd；检查账户和 exec 权限 | 已启用的 OpenSSH Server；识别实际版本和账户策略 | 已开启“远程登录”，允许当前账户访问 |
| 引导与 Shell | POSIX 引导；交互 Shell 单独选择 | 兼容 cmd 默认入口及 PowerShell；不修改全局 DefaultShell | POSIX 引导；交互使用账户 Shell，常见为 zsh |
| 工作区路径 | `/home/...`，按目标文件系统规则处理 | 盘符、反斜杠、空格和中文；从远端列可访问磁盘，不使用本机盘符 | `/Users/...`，延续规范化和 Unicode 处理，验证大小写敏感卷 |
| 权限与 IPC | 用户所有权、0700 / 0600、Unix socket | 用户 SID / ACL、named pipe；不以 chmod 替代 ACL | 用户所有权、Unix socket；额外处理隐私权限限制 |
| 终端 | 真实 SSH PTY、窗口大小和信号 | 验证 OpenSSH / ConPTY 行为、PowerShell 与 cmd、Ctrl-C 和 resize | 真实 SSH PTY、账户 Shell、Ctrl-C 和 resize |
| 环境与凭证 | 登录环境与非交互环境可能不同 | 服务登录环境不等于桌面 PATH；域账户 / 网络资源凭据可能受限 | SSH 环境不等于 Finder 启动环境；钥匙串可能锁定 |
| 制品与更新 | ELF / 架构 / libc / 原生依赖 | PE / 架构；运行中 EXE 不能覆盖，版本化切换 | Mach-O / 架构 / 签名与 quarantine；不依赖 Rosetta 掩盖缺包 |

路径、文件编码与换行不做跨平台“统一修正”，例如不能把远端文件全部写成客户端平台的换行。权限和目录包含性判断仍放在真正执行文件操作的服务中，只做一处，不给每层 IPC 加一套重复校验器。

Windows 的普通用户与管理员账户在默认公钥文件位置和 ACL 上不同，诊断应能解释，不能统一套用 Linux 的 `~/.ssh/authorized_keys` 指引。SSH 登录不保证能访问映射盘 / UNC 共享；首批 Windows 验收以该登录账户可访问的本地磁盘为准，网络共享需单列凭据与权限条件。

macOS 的完整磁盘访问是用户的授权选择，不是自动开启项；不可因某个目录无权读取就默认索取整盘权限。远端钥匙串不可用时提示配置方式，不尝试绕过。休眠、合盖和关机后不承诺任务继续运行。

适配代码按职责集中：客户端 SSH / 引导差异放在 Desktop 平台边界；远端 IPC、进程、路径和部署放在 Headless Host 平台边界。业务 query/command、对话状态和 UI 不散布三套 `if Windows/Linux/macOS` 分支。

### 5.5 远端与本地 Host 共存

目标 Windows / macOS 可能已经打开 OMP Studio 桌面应用。远端 Headless Host 不复用桌面进程的锁、端点、账本或会话租约文件，防止一次远程连接接管或终止已有桌面会话。

模型 / Skills / MCP 等用户级配置可按现有 OMP 规则读取，但必须核对共享配置写入和会话文件并发语义。不能仅因为两份 Host 的状态目录不同，就认为对同一 OMP 会话文件的写入已经隔离。首版不自动接管目标机桌面正在运行的会话；需要使用共同的会话所有权约束或明确分区，P2 验证后定案。也不通过复制本机凭证或创建项目级 `models.yml` 来规避。

## 6. 认证、部署与配置

### SSH 登录

首版建议优先密钥文件、ssh-agent 和现有 SSH config / ProxyJump。私钥不上传服务器，模型拿不到密钥，日志不记密码。

加密密钥口令、密码和 keyboard-interactive 可以通过 OpenSSH askpass 类认证桥接到应用弹窗，但 Windows 系统 OpenSSH 和 macOS 的实际行为需在 P0 验证。**不要为了提前承诺密码登录而用 `sshpass -p` 或解析 PTY 提示自动输密码。** 纯密码 / 多因素是否必须进入首版是待讨论项；认证取消应立即停止相关连接尝试。

认证凭证首版可仅驻内存，不做“记住密码”。如果后续持久化，使用已有安全存储能力，并明确保存范围。

### 远端组件部署

- 部署 Studio 自己的版本化 Headless Host 与 patched OMP Runtime，不安装 Electron，优先采用当前用户权限；启用系统 SSH 服务的权限前提单独说明。
- 安装根目录由远端平台服务解析，例如 Linux `~/.local/share/omp-studio/remote/`、Windows `%LOCALAPPDATA%\omp-studio\remote\`、macOS `~/Library/Application Support/omp-studio/remote/`。这是待定路径建议，不由客户端展开 `~` 或环境变量；各自按版本分目录，避开项目代码目录与已有本地 Host 状态。
- 本机按**远端 OS + CPU 架构 + 必要 ABI**选择并验证签名制品，通过 SSH 传输，远端校验摘要后暂存、原子激活。正在运行的会话继续使用原版本，不能升级到一半替换进程文件；Windows 不覆盖正在运行的 EXE，macOS 校验代码签名，Linux 校验 ELF 与依赖要求。
- 这消除了远端下载制品必须能访问 GitHub 的要求，但**不消除远端调用模型 API 的网络要求**。
- 支持手动导入匹配制品作为离线准备路径；不以临时 `curl | sh` 或服务器上随意 `npm install latest` 作为正式交付方式。
- 将“远端 Runtime / Host 制品平台”与“桌面应用升级平台”区分，不能简单往共享 `UPDATE_PLATFORMS` 填 Linux，导致桌面升级逻辑去找 Linux Electron 包。
- 缺失签名、错误架构、缺文件等才是发布阻断；按项目约定不把全部源码测试或 GUI 验收塞进发布流水线。

### 模型凭证与网络

推荐默认使用**远端已有模型配置和凭证**；没有配置时明确引导设置，不自动复制本机 `models.yml`、auth 数据库或环境变量到远端。

这是一项实际使用约束：如果目标机不通模型 API，完整远端 Runtime 方案需要另行设计模型代理 / 网络出口。如果用户的主要目标就是不能联网、不能安装组件的集群，需要重新比较“本机模型 + 远程工具”的路线，而不是在本方案里悄悄镜像文件。

首版不默认做 SSH agent forwarding、端口代理式凭据转发或本机配置同步。Git push / GitHub 操作使用远端的认证环境，缺少 git / gh / 凭证时显示真实缺项。

## 7. 断线与恢复

- SSH 断开不等于远端任务失败，也不等于 Runtime 已退出。界面显示“连接已断开，任务状态待确认”，不自动回落本机。
- 断线时禁止提交新写命令；未发送草稿保留。已经发出但没收到结果的命令保持待核对 / 结果未知，不自动补发 prompt、commit、文件写入等操作。
- 重连先核对目标、Host 实例和会话，再同步 snapshot、收据和对话。相同 Host 优先恢复游标；游标已过期则完整重同步，不要求无限保存流式增量。
- Host / Runtime 确实重启时使用新的实例代次，旧命令不能因“SSH 连回来了”被标为成功。
- 远端等待 GUI 审批时保持等待，不因断线自动允许。
- 首版普通终端不承诺恢复断线前的交互 Shell；恢复连接后提供新终端，明确显示旧终端已断开。Linux / macOS 用户可以自行使用 tmux 保留终端长任务；不把 tmux 当作 Windows 前提，也不依赖它控制任何平台的 Studio Runtime。
- 切走机器保留其运行任务和必要状态监听；显式断开不自动停止任务。远端 Host 在没有任务、PTY 或连接的情况下按明确空闲策略退出，不永久遗留无人管理进程。

## 8. 首版范围建议

### 首版应当形成的闭环

- Windows / macOS 桌面都能连接 Linux、Windows 和 macOS 远端；按 §1.1 的首批架构基线逐项验收，三平台均是本功能交付范围。
- 执行位置选择器、保存 / 编辑 / 测试连接、已有 SSH config 别名、密钥 / agent、ProxyJump。
- 首次信任、组件准备、远端目录选择、就绪 / 失败状态。
- 远端项目内真实对话、文件工具、文件树、@、Git 与终端。
- 远端模型 / Skills / MCP 配置作用域清楚；未配置时如实提示。
- 基本附件上传、产物读取 / 下载或明确禁用，绝不误用本地路径。
- 连接中断、重新连接、会话恢复与命令不重复执行。
- 真值和演示两套 UI，预览只影响显示与演示交互。

### 不作为首版验收前提

整项目同步 / SSHFS、跨机器迁移正在运行的会话、容器 / WSL 环境编排、集群作业调度、多人协作编辑、全主机统一历史搜索、未验证的旧 OS / 非基线 ABI 组合、持久终端恢复、完整远端浏览器观察 / 本机媒体转发。Linux / Windows / macOS 本身不在排除范围内；首批架构之外的组合以兼容矩阵明确记录。

开发服务端口转发属于紧邻的扩展能力：可设计显式“远端端口 → 本机 loopback 端口”，但不把它与现有尚未落地的 Preview / 浏览器侧栏一起强行承诺。没有真实隧道时不生成可点击的假 localhost 预览 URL。

## 9. 实施阶段与验收点

### P0：三平台可运行性与 SSH 认证原型

在 Linux x64 glibc、Windows x64、macOS arm64 上分别验证 patched Runtime、Headless Host 所需 Node / Bun、原生依赖、权限、IPC、终端和后台进程生命周期。Windows / macOS 客户端分别验证结构化通道、跳板机、指纹确认及 askpass 可行性；明确 Windows 默认 cmd 与 PowerShell 的引导兼容，补三平台架构评估和最低版本清单。

验收：三类测试主机各自能完成 `bootstrap → 创建会话 → 真实读写一个文件`，断开 attach 通道不会意外杀掉 Host；Windows 不能仅凭 Start-Process 启动成功就算通过，macOS 不能只在已登录桌面会话内验证。依赖与支持矩阵有实测结果；未达标平台列阻碍，不能作为可选项悄悄剔除。此阶段不修改用户服务器安全策略。

### P1：执行位置身份与本地兼容层

增加连接目录、工作区引用及目标级 Client 上下文；保留现有本地 WorkspaceRegistry 和历史。明确 IPC 路由、事件来源、草稿与队列归属。先用测试替身验证，不把演示 fixture 放进 Host / reducer。

验收：两台机器同名项目、相同路径和重复样例 sessionId 均不串；本机打开 / 恢复历史 / 多常驻会话行为不退化。

### P2：抽出可在远端运行的 Host 组装

复用 `host-client-api`、`studio-host`；将真正需要的 Git / 文件 / session 组装逻辑移入 Electron-free 边界，注入系统服务。新增 Linux 平台实现，并将现有 Windows / macOS 能力适配到无桌面依赖的远端宿主；按 §5.4 覆盖 Shell、路径、IPC、权限、终端与进程生命周期。只移动相关模块，不全面重构桌面应用。

建议新增独立远端入口与共享组装包，名称可为 `apps/remote-host` / `packages/host-core`，以实际依赖关系为准。

验收：远端不依赖 Electron，文件、Git、配置和 Runtime 都以远端 cwd / home 为准；未接入的桌面能力返回不支持。

### P3：SSH 连接、部署和传输恢复

实现系统 ssh 解析、认证桥、信任流程、签名制品传输、attach 协议及重连。扩展远端制品平台并与桌面更新平台拆开。

验收：首次安装、再次复用、取消认证、主机密钥改变、协议不匹配、网络断线和 Host 重启均有正确状态；写命令不会因重连重复。

### P4：工作台 UI 与远端操作表面

在分支右侧接选择器，补连接管理与远端目录选择；完成 @ / Git / PTY / 附件 / 产物和旁路能力处理。发送后保持远端身份可见。模型等页面标明当前机器作用域。

预览接入遵守项目既有规则：`usePreviewMode()`；演示数据仅放 `apps/renderer/src/preview/`；演示 SSH 按钮只改本地 UI、不建连接、不调 Host；真实态不回退假数据。底部终端仍是真实本机或真实 SSH PTY，不使用假终端输出。

验收：界面显示 SSH 时，模型修改、文件树、Git diff 和终端看到同一远端文件；断线没有任何本机回落。

### P5：回归、真实连接验收与交付文档

按实际变动范围运行 `npm run check`，必要时增加 Runtime / 制品专项验证；测试覆盖用户行为，不为协议字段逐项堆校验器测试。UI 用预览验证布局和交互；SSH 行为必须用真实测试主机证明，不能只靠 Mock。

核心场景：密钥直连、跳板机、空格 / 中文路径、工作目录丢失、慢网络、断线时正在生成或等待审批、重连没有重复写入、本地与远端来回切换、同名项目、旧终端归属、远端缺模型凭证、制品架构错误。

跨系统连接验收按下表执行，而不是只在每种系统本机跑单测：

| 桌面客户端 | Linux x64 glibc 远端 | Windows x64 远端 | macOS arm64 远端 |
|---|---|---|---|
| Windows | 必验 | 必验 | 必验 |
| macOS Apple Silicon | 必验 | 必验 | 必验 |

六条链路都覆盖部署 / 复用、创建会话、真实文件修改、Git diff、@、终端、断线 / 重连和停止任务。额外覆盖 Windows cmd / PowerShell、盘符和 ACL、EXE 占用时升级，macOS 受限目录 / 钥匙串锁定 / 无桌面登录环境，Linux libc 缺项 / 会话清理策略。所有系统检查文件字节和换行不被传输修改、SSH 关闭后没有误杀其他进程；Windows / macOS 验证远端 Host 与目标机桌面 Host 同时运行不抢会话。目标平台缺测试机时明确标注未验证，不把 Mock 通过视作实机覆盖。

文档覆盖远端要求、安装位置、配置作用域、日志、断线行为、显式停止与卸载。发布流程只校验能否产生正确制品，不重跑全套源码与 GUI 门禁。

## 10. 主要落点

- UI：`apps/renderer/src/App.tsx`、`main.tsx`、`styles/workbench.css`；建议新增 `workspaces/ExecutionTargetPicker.tsx`、连接管理 / 目录选择组件和目标上下文层。
- 客户端 / 契约：`packages/client-contract/src/{index,operations,read-models}.ts`、`packages/client/src/`、Desktop IPC / preload 的明确目标路由。
- 本机 SSH 控制：建议新增 `apps/desktop/src/ssh/`，负责系统 OpenSSH、连接管理、认证、部署与 transport，不让 Renderer 直接拿 token / 私钥 / 进程句柄。
- 可复用后端：`apps/desktop/src/{host-factory,host-composition,runtime-session,session-commands,git-service,workspace-files}.ts`、`packages/studio-host/`、`packages/host-client-api/`。
- 终端与系统旁路：`terminal-{shared,ipc,pty}.ts`、`workspace-shell-*`、`runtime-media-files.ts`、附件及 Plan 保存相关入口。
- 平台 / 制品：`packages/runtime-installer/src/runtime-platform.ts`、`scripts/target-platform.mjs` 和相关构建脚本；三平台远端 Host 适配与 OS / CPU / ABI 制品矩阵，与桌面安装包矩阵分离。Linux 远端支持不暗示新增 Linux 桌面安装包。
- 若确需改 Runtime：按 overlay / vendor / regen 既有流程，禁止手写 `.patch`。

## 11. 已确认范围与待讨论取舍

**已确认：远端 Linux、Windows、macOS 都要纳入设计与验收；入口仍位于项目 / 分支右侧；用户已批准实施。**

1. **远端环境约束：** 三个平台是否均允许部署用户级组件、保留后台进程并访问模型 API？系统名称已经确定，这里只讨论权限、网络和生命周期限制，不再要求用户从三个系统中选一个。
2. **凭证与模型位置：** 是否接受远端 Runtime 使用远端模型配置？本文默认不自动复制本机凭证。若必须模型留在本机，需要重新设计远程工具边界。
3. **认证范围：** 首版以密钥 / agent / SSH config 为主，还是纯密码、多因素交互登录也必须第一版完整覆盖？后者将增加首阶段认证验证与 UI 范围。Windows OpenSSH 与 POSIX 服务端支持的认证方式不能画等号，应按实测服务端能力显示；不把泛称“多因素”作为三平台统一承诺。

三平台目标不代表任意 CPU / OS 版本已经支持；§1.1 的架构扩展和最低版本仍需 P0 验证。先确定“谁运行 Runtime、文件以哪端为准、目标机能做什么”，再收敛内部接口名。

## 12. 调研来源

- [dsh-remote-ssh README（固定提交）](https://github.com/ZhangFengshun/dsh-remote-ssh/blob/55001e20572e19ec38988daa16f9a44f6bbb5dd3/README.md)
- [dsh 常驻命令会话](https://github.com/ZhangFengshun/dsh-remote-ssh/blob/55001e20572e19ec38988daa16f9a44f6bbb5dd3/lib/index.js#L546-L589)
- [dsh SSH 参数与认证](https://github.com/ZhangFengshun/dsh-remote-ssh/blob/55001e20572e19ec38988daa16f9a44f6bbb5dd3/lib/index.js#L729-L768)
- [dsh 终端 wrapper](https://github.com/ZhangFengshun/dsh-remote-ssh/blob/55001e20572e19ec38988daa16f9a44f6bbb5dd3/lib/index.js#L5074-L5128)
- [VS Code Remote SSH 官方文档](https://code.visualstudio.com/docs/remote/ssh)；本轮读取的是[官方文档仓库](https://github.com/microsoft/vscode-docs/blob/main/docs/remote/ssh.md)。
- [OpenSSH ssh_config 官方手册源码](https://github.com/openssh/openssh-portable/blob/master/ssh_config.5)
- [OpenSSH ssh 官方手册源码](https://github.com/openssh/openssh-portable/blob/master/ssh.1)
- [ssh2 官方 README / Client API](https://github.com/mscdex/ssh2#client)
- [Microsoft：Windows OpenSSH Server 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)；本轮读取[官方文档源码](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/administration/OpenSSH/openssh-server-configuration.md)，确认默认 cmd、DefaultShell、公钥文件和账户差异。
- [Microsoft：Windows OpenSSH 安装](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)及[密钥管理](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)；本轮通过官方仓库读取安装权限、端口与 ACL 要求。
- [PowerShell：Start-Process 官方文档源码](https://github.com/PowerShell/PowerShell-Docs/blob/main/reference/7.5/Microsoft.PowerShell.Management/Start-Process.md)；其远程会话生命周期说明提醒不能把本机 detached 行为当作远端保证，不能据此推断某一 OpenSSH 版本已实测。
- [Apple：允许远程电脑访问 Mac](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)；本轮已读取页面，确认远程登录、允许用户和远程用户完整磁盘访问是独立授权设置。

研究限制：未启动 OMP Studio 做视觉实测，未部署任何平台的远端组件，未测试 OpenSSH 登录或断线恢复。本文是依据当前代码与公开资料形成的架构和产品讨论稿；三平台是设计与交付目标，不是兼容性认证结果。
