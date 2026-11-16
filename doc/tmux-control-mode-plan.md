# tmux 控制模式（`tmux -C`）接入计划

立项：2026-11-14。状态：**已实现，M0–M5 完成**。实施工作树：`.claude/worktrees/tmux-control-mode`，分支 `codex/tmux-control-mode`，基于任务开始时的 `0.2.0` 提交 `6c2be11`；恢复点为 `codex/tmux-control-mode-base`。下面的实测修订与实施记录优先于原方案示例。

### 实施记录（as-built）

- M0 吞屏修复、M1 协议核心、M2 SSH 管理与 IPC、M3 窗口分屏界面、M4 恢复与生命周期、M5 用户文档分别提交。普通 Shell 和 tmux 窗格复用终端数据、backlog 与 ACK，未改 Host / Studio Bridge / Runtime 契约。
- 界面拆为 `tmux/TmuxPanel.tsx`、选择器、关闭弹窗、窗口视图和 `tmux.css`，复用已有 `WorkspaceDialog`、`AppSelect` 与浏览器链接菜单。全局终端类型直接引用 Desktop 契约，不再重复定义。
- 输入只在 Desktop IPC 的 `parseTmux*` 校验一次；不增加结果校验器或拒绝多余字段的白名单。连接层保留真实目标所属关系、并发关闭与资源上限检查。
- 拓扑额外保留 `fullLayout`。缩放时按 `layout` 呈现可见窗格，隐藏的 xterm 仍使用完整布局的尺寸并消费输出，避免未显示窗格堵住整条连接。
- `capture-pane -a` 返回全屏程序背后保存的普通屏幕，恢复时先写该屏，再进入备用屏写当前可见屏。鼠标分别恢复 1000 / 1002 / 1003 和 SGR 模式，不能把 `mouse_any_flag` 一律当作 1003。
- 分离、断线后保留只读屏幕；移除和重新附加会释放旧 Main 连接及 Renderer 图形资源，重新附加沿用分组位置。
- 预览只保留本地拓扑与布局占位；关闭方式记忆在预览中也只保存在本地演示状态。无假 Shell 输出，无 Host 调用。
- 使用说明：[docs/tmux.md](../docs/tmux.md)。功能索引、设置搜索入口与 Unreleased 已更新。

### 合并前审查修订（2026-11-15）

- 整合最新 `0.2.0`（`3148169`），保留 Linux 桌面支持及终端国际化改动。
- 命令块按完整的 time / number / flags 配对；屏幕中的其他 `%end` / `%error` 行保持原文。启动之后只用 `flags & 1` 的块兑现 stdin 命令，用户 hook 的输出不消耗命令 FIFO。
- 隐藏操作改为 `setWindowVisible { windowId, visible }`，由连接持有窗口隐藏状态；远端新增窗格继承该状态，恢复时在 64 个显示窗格的上限内重新抓屏。
- Renderer 记录连接所属的终端面板；再次附加同一个连接时转移分组和已有 xterm，避免多个对话重复挂载同一屏幕。移除过程中忽略该连接的最后一份退出拓扑。
- 补齐 tmux 执行层错误的中英文文案，保留第三方原始错误与终端正文。具体问题及验证见[审查记录](../docs/reviews/tmux-control-mode-2026-11-15.md)。

### 验证结果与范围（2026-11-14）

- 真实 SSH 抓包：tmux 3.2a、3.4、3.7c；原始 `.bin` 禁止 Git 换行转换。协议核心对整块与随机切块回放、UTF-8 跨输出通知、嵌套 / 缩放布局及命令 FIFO 均通过。
- `npm run check -- --only desktop --suite tmux --suite terminal-ipc` 通过，覆盖流控、恢复、连接丢失、最低版本、窗口关闭竞态和 IPC 路由。通过 `TMUX_TEST_SSH` / `TMUX_TEST_CONTAINER` 实测 3.2a 与 3.7c 的附加、输入、拆分、隐藏 / 恢复、detach 保留会话、重新附加。
- `npm run check -- --only renderer --suite terminalSessions --suite TerminalPane --suite TmuxWindowView` 通过，覆盖窗格登记与 ACK、关闭选择与记忆、隐藏 / 恢复、分隔线换算、只读 / 资源释放、重新附加位置、预览和 `marks=off`。
- `npm run check -- --production` 通过（206 秒）：架构、选择器、动效、全部类型、全量核心测试、Renderer / preload / 远端 Host 生产产物。此命令已包含普通 `npm run check` 的门禁，没有重复跑一遍全量核心。
- 真实 Chromium + SSH 管道复核使用临时验证页面和独立 tmux socket，通过三窗格拆分、分隔线拖动、18px 字号、主题、缩放、关闭弹窗、隐藏 / 恢复、预览和 `marks=off`。vim 使用 `C.UTF-8`，含中文和 emoji 的未保存内容在 detach / 重新附加后仍可见；截图保留于工作树的 `output/playwright/`，不提交。最终鼠标模式代码也再次通过 tmux 3.2a 的真实 SSH 集成测试。
- 仍需外部环境复核：macOS 桌面壳、密码 SSH 目标、物理断网、htop 鼠标操作，以及所有 §8 人工项目的双版本完整走查。未将这些标记为已完成。`%pause` 的重同步和 stdout 背压已由连接测试驱动；`too far behind` 文本以 tmux 3.2a `control.c` 确认，未等待原生默认五分钟超时去复现断连。

### M0 实测修订（2026-11-14）

- 经真实 `ssh -T` 抓取主机 tmux 3.4，以及临时 Ubuntu 22.04 / Debian testing 容器的 tmux 3.2a / 3.7c。原始字节见 `apps/desktop/test/fixtures/tmux/`，可用 `scripts/tmux-transcript.mjs --ssh <alias> [--container <name>]` 重现；使用独立随机 socket。
- 三个版本均支持无 tty 控制连接、启动应答块、四参数 `%layout-change`、可见缩放布局、`pause-after`、订阅和空行 detach。
- **3.2a 不支持按窗口的 `refresh-client -C @id:WxH`**（返回 `bad size argument`）。产品统一使用 `refresh-client -C WxH`，同一连接的标签共用 Studio 终端视口，不新增版本降级分支。
- 远端非登录环境可能是 C locale。统一用 **`tmux -u -C`** 强制 UTF-8；否则 tmux 的命令输出会将分隔用的 tab 改为 `_`。列会话也使用 `tmux -u list-sessions`。
- 单引号只阻止命令解析阶段的展开。`rename-window` 自身仍会展开格式，所以重命名时另将 `#` 转成 `##`，避免执行 `#(…)` 或展开 `#{…}`。
- `-CC` 提示由 Renderer 的 `controlMode` 状态翻译呈现，不把翻译后的文字写入存储的通用丢失通知。普通 DCS 原样交给 xterm，Sixel 继续解码。

---

## 0. 摘要与已确认的产品决定

目标：在 **SSH 工作区** 的底栏终端里提供「附加 tmux 会话」。Studio 自己经 `ssh -T` 用**管道**运行远端 `tmux -C`，把 tmux 的窗口映射成终端标签，把窗格按 tmux 布局画成多个 xterm 分屏（iTerm2 的 tmux integration 是同一个模型）。

| 决定 | 结论 |
|---|---|
| 入口 | **只做 SSH 工作区的「附加 tmux」**，由 Studio 发起，走管道。不接管用户在终端里手敲的 `tmux -CC`，不做 macOS 本机，也不做 WSL（见 §3 非目标）。 |
| 界面映射 | **tmux 窗口 = 终端标签，窗格按 `%layout-change` 布局分屏**。可以拆分、关闭、拖分隔线。 |
| 最低版本 | **tmux 3.2**。低于 3.2 时附加失败，提示升级，不做降级分支。 |
| 关闭窗口标签 | **每次询问「隐藏 / 结束窗口」**，可以勾选「记住选择」，之后在设置里改回来。退出 Studio、关闭 Studio 窗口、SSH 断线一律只 detach，tmux 会话留在服务器上。 |
| 关闭整个 tmux 连接（分组头的 ×） | detach，不询问。结束整个会话放在分组菜单里，二次确认后执行。 |

为什么用管道、不在 PTY 里识别 `-CC`：Windows 本机终端跑在 ConPTY 上，ConPTY 会解释并重绘 VT 输出。`tmux -CC` 的 DCS 包头 `ESC P1000p` 不一定能原样透传，超过列宽的 `%output` 行也可能被折行，协议会被破坏。Windows Terminal 至今还在为 tmux 控制模式推进 DCS 透传（[#3656](https://github.com/microsoft/terminal/issues/3656)、[PR #18928](https://github.com/microsoft/terminal/pull/18928)、[PR #19640](https://github.com/microsoft/terminal/pull/19640)）。直接用 `ssh -T`（不分配 tty），远端 `tmux -C` 的字节流原样进 Node 的 stdout 管道，Windows 和 macOS 走同一条路。

顺带修一个现存 bug（M0）：在 Studio 终端里手敲 `tmux -CC`，现在屏幕会冻住。原因见 §2.3。

---

## 1. tmux 控制模式速查（实现依据）

来源：tmux wiki「Control Mode」和 `tmux.1` 的 CONTROL MODE、`refresh-client` 两节（链接见 §11）。原方案待确认项已按 M0 的 3.2a / 3.4 / 3.7c 抓包修订；没有实际诱发的慢客户端超时明确标注来源。

### 1.1 进入与退出

- `tmux -C new-session …` / `tmux -C attach-session …`：控制模式。客户端从 stdin 按行读命令（以 `\n` 结尾），在 stdout 输出结构化文本。
- `-CC` 会把 tty 设成 raw 模式，并用 DCS `\033P1000p` … `\033\\` 包住整个会话，需要 tty。**产品使用 `-u -C`，经管道运行，没有 tty、回显和 DCS。** 已通过真实 SSH 验证无 tty 的启动与分离。
- **stdin 收到空行就 detach。** 退出时 tmux 输出 `%exit [reason]`。`refresh-client -f wait-exit` 会让 tmux 在 `%exit` 之后再等一个空行才退出。
- 客户端落后太多时 tmux 会主动断开，`%exit` 带原因。tmux 3.2a 的 `control.c` 明确写出 `too far behind`，默认上限是 300000 ms；本轮未实际等待五分钟诱发该退出。

### 1.2 命令应答帧

- 每条命令产生**一个**输出块：`%begin <time> <number> <flags>`，若干行输出，然后 `%end <time> <number> <flags>`（成功）或 `%error …`（失败）。三段参数首尾一致。
- **通知不会出现在输出块内部。** 块里以 `%` 开头的行仍然是命令输出。
- 关联方式：Studio 每发一行命令，就按 FIFO 等一个块。**一行只发一条命令，不用 `;` 串命令。**
- 实测启动参数中的 `new-session -A …` 会先产生一个块。「启动门」收到首个成功块后才发送排队命令；启动错误立即失败，15 秒没有块也算附加失败。

### 1.3 通知（3.2+，`tmux.1` 当前版本）

| 通知 | 参数 | Studio 的用途 |
|---|---|---|
| `%output` | `%pane value` | 窗格输出；`value` 里小于 0x20 的字节和 `\` 转成 `\ooo` 三位八进制，**其余字节原样，可能不是合法 UTF-8** |
| `%extended-output` | `%pane age … : value` | 开启 `pause-after` 后代替 `%output`；按 ` : ` 切出数据，忽略中间的参数 |
| `%pause` / `%continue` | `%pane` | 流控暂停 / 恢复 |
| `%layout-change` | `@win layout visible-layout flags` | 窗格布局（渲染用 `visible-layout`，缩放时它和 `layout` 不同） |
| `%window-add` / `%window-close` | `@win` | 窗口增减 |
| `%window-renamed` | `@win name` | 标签名 |
| `%window-pane-changed` | `@win %pane` | 活动窗格 |
| `%session-window-changed` | `$sess @win` | 活动窗口 |
| `%session-changed` / `%session-renamed` | `$sess name` / `name` | 会话名 |
| `%sessions-changed` | — | 会话列表变了（选择器刷新） |
| `%pane-mode-changed` | `%pane` | 窗格进入或退出 copy mode（控制模式不发送 tmux 自绘 UI，只用来刷新状态） |
| `%subscription-changed` | `name $sess @win idx %pane … : value` | 格式订阅（M4：窗格标题、cwd） |
| `%unlinked-window-*` | `@win …` | 其他会话的窗口；忽略 |
| `%client-detached`、`%client-session-changed` | — | 其他客户端；忽略 |
| `%paste-buffer-changed` / `-deleted`、`%message`、`%config-error` | — | `%config-error` 写日志并在分组头显示一次，其余忽略 |
| `%exit` | `[reason]` | 连接结束 |

3.2a、3.4 和 3.7c 抓包均为四参数 `%layout-change`；缩放时 `visible-layout` 只有可见窗格。

### 1.4 Studio 用到的客户端命令

| 目的 | 命令 |
|---|---|
| 版本 | `display-message -p '#{version}'`（返回如 `3.2a`、`3.5a`、`next-3.6`） |
| 客户端选项 | `refresh-client -f pause-after=15` |
| 默认尺寸 | `refresh-client -C 120x32` |
| 窗口视口尺寸 | 产品统一使用 `refresh-client -C 120x32`。3.2a 对 `-C @3:120x32` 返回 `bad size argument`，所以不使用新版的逐窗口语法。 |
| 窗格开关、流控恢复 | `refresh-client -A '%5:on'` / `'%5:off'` / `'%5:continue'` |
| 订阅（M4） | `refresh-client -B 'studio-pane:%*:#{pane_title}'` |
| 窗口清单 | `list-windows -F '#{window_id}\t#{window_index}\t#{window_active}\t#{window_flags}\t#{window_visible_layout}\t#{window_name}'` |
| 窗格清单 | `list-panes -s -F '#{pane_id}\t#{window_id}\t#{pane_active}\t#{pane_dead}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}\t#{pane_title}'` |
| 首屏与历史 | `capture-pane -p -e -J -t %5 -S -1000`；备用屏另取 `capture-pane -p -e -a -t %5` |
| 输入 | `send-keys -t %5 -H 6c 73 0d`（十六进制字节，精确，不受 tmux 按键名解析影响） |
| 结构操作 | `split-window -h -t %5`、`split-window -v -t %5`、`new-window -t @3 -a`、`kill-pane -t %5`、`kill-window -t @3`、`select-pane -t %5`、`select-window -t @3`、`rename-window -t @3 'name'`、`resize-pane -t %5 -x 40`、`resize-pane -t %5 -Z`、`kill-session` |

自由文本字段（窗口名、窗格标题）一律放在格式的**最后一列**，解析时只按前 N−1 个 `\t` 切开。

### 1.5 布局字符串

```
c8f1,204x51,0,0{102x51,0,0,0,101x51,103,0[101x25,103,0,1,101x25,103,26,2]}
```

- 开头 4 位十六进制是校验和，然后是一个 cell。
- cell = `W x H , X , Y`，后面接 `,N`（叶子，N 是窗格 id 的数字部分，即 `%N`），或 `{…}`（左右排列），或 `[…]`（上下排列）。子 cell 之间用逗号分隔。
- 坐标以字符格为单位；相邻窗格之间留 1 格边框（例子里 `102 + 1 = 103`）。
- 校验和算法（tmux `layout_checksum`）：`csum = 0; for c: csum = (csum >> 1) + ((csum & 1) << 15); csum += c;`，取 16 位。只用来校验，失败时记 `protocol_error` 并全量刷新。

### 1.6 流控（3.2+）

- `refresh-client -f pause-after=N`：某个窗格的输出在 tmux 里积压超过 N 秒，就暂停它并发 `%pause %N`。暂停期间的输出**丢弃**。
- 用 `refresh-client -A '%N:continue'` 恢复，之后需要客户端自己 `capture-pane` 重画屏幕。
- `refresh-client -A '%N:off'` 告诉 tmux 不需要这个窗格的输出（用于隐藏的窗口）。

### 1.7 发行版里的 tmux 版本（执行时以实测为准）

| 版本 | 系统 |
|---|---|
| ≥ 3.2 ✅ | Ubuntu 22.04（3.2a）、24.04（3.4）；Debian 12（3.3a）；RHEL / Rocky 9（3.2a）；Homebrew（3.5+） |
| < 3.2 ❌ | Ubuntu 20.04（3.0a）、Debian 11（3.1c）、RHEL / CentOS 8（2.7） |

---

## 2. 现状（代码事实）

### 2.1 终端链路

- 终端是 **Desktop chrome IPC，不是 Host 传输**（`doc/feature-index.md` 的「终端、窗口铬、设置、诊断」）。tmux 也留在这一层，**不进 `client-contract`、Studio Bridge 或 Runtime**。
- 通道与校验：[terminal-shared.ts](../apps/desktop/src/terminal-shared.ts)（`TERMINAL_IPC_CHANNELS`、`parse*Input`、`OmpStudioTerminalApi`）。preload 可以 import 这个文件，它不能用 Electron Main 或 Node 的 API。
- 路由：[terminal-ipc.ts:118-165](../apps/desktop/src/terminal-ipc.ts)。`write` / `resize` / `ack` / `dispose` 先问 `remote.owns(windowId, id)`，再落到本机 manager。tmux 窗格照这个做法再加一层 `tmux.owns`。
- SSH 终端：[remote/terminal.ts:60-108](../apps/desktop/src/remote/terminal.ts) 用 node-pty 跑 `ssh -tt`，`workspace.path` 取远端目录，`sshAuthenticationRequest` 发一次性 askpass 票据。
- [remote/platform.ts:43-58](../apps/desktop/src/remote/platform.ts) 的 `sshArguments` **默认就是 `-T`**（SSH 终端把 `args[0]` 改成了 `-tt`）。tmux 控制连接直接用默认参数。
- 合批与流控：[terminal-batch.ts](../apps/desktop/src/terminal-batch.ts)。`push(id, Uint8Array)` 接受字节，每个会话有一个有状态的 `StringDecoder`，**跨 chunk 拆开的 UTF-8 码点会被拼回去**。所以窗格输出解码成字节后可以直接交给 batcher，不用自己处理 `%output` 行之间被拆开的多字节字符。高水位 500 KiB 时调 `pauseSource(id, true)`，降到低水位 100 KiB 时恢复。
- 组装：[main.ts:402](../apps/desktop/src/main.ts) 创建 `RemoteTerminalManager`，[main.ts:884-897](../apps/desktop/src/main.ts) 调 `registerTerminalIpc`，[main.ts:1101](../apps/desktop/src/main.ts) 在 `beforeShutdown` 里 `remoteTerminals.disposeAll()`，[main.ts:693](../apps/desktop/src/main.ts) 在 SSH 目标还有终端时拒绝安装 Runtime（`hasTarget`）。
- preload：[preload.ts:113-144](../apps/desktop/src/preload.ts) 是冻结的 `ompStudioTerminal`。
- Renderer 存储：[terminalSessions.tsx](../apps/renderer/src/terminalSessions.tsx)。每个 id 一份 backlog 和图形解码器，按 xterm 实际写入的字节 ACK。**未知 id 的输出直接丢弃**（第 226 行），`#sessionIds` 由 `#publish` 按 `state.sessions` 重建（第 378-385 行）。
- 面板：[TerminalPane.tsx](../apps/renderer/src/TerminalPane.tsx)。预览模式下 `targetId = preview ? null : executionTarget.id`（第 40 行），也就是预览时终端只连本机。xterm 选项 `convertEol: true`，scrollback 1000（第 189-200 行）。CSS 在 `styles/workbench.css` 的 `.term-*`。
- 上限：`TERMINAL_MAX_SESSIONS = 8`，统计每个窗口里的 PTY 进程数。

### 2.2 测试与门禁

- Desktop 测试用 `node:test`，跑在 dist 上，靠假 spawner 隔离（参考 `apps/desktop/test/remote-terminal.test.ts`、`terminal-flow-control.test.ts`）。
- 核心名单：`scripts/core-suites.mjs` 第 40-41 行（desktop 的 terminal-batch / flow-control）、第 80 行（renderer 的 terminalSessions）。
- 切片：`npm run check -- --only desktop`、`npm run check -- --only renderer --suite <名>`、`npm run check -- --fast`。

### 2.3 现存 bug：手敲 `tmux -CC` 会冻住终端

[terminalGraphics.ts:81-82](../apps/renderer/src/terminalGraphics.ts) 把**所有** `ESC P`（DCS）都当成可能的 Sixel，一直缓冲到 `ESC \` 为止。`tmux -CC` 发出 `ESC P1000p` 之后，ST 要等 tmux 退出才出现，于是之后的输出全被扣住：屏幕没有任何变化，攒到 2 MiB 时报「Terminal graphics input exceeds limit」，然后把协议原文吐到屏幕上。M0 修这个问题。

---

## 3. 范围

### 本轮做

1. 修 §2.3 的 bug：识别 `ESC P1000p`，不再吞屏，提示用户改用「附加 tmux」，并给一个「退出控制模式」按钮（M0）。
2. SSH 工作区（远端是 POSIX 系统）的 tmux 会话选择器：列出会话，新建或附加（M2、M3）。
3. 一个附加连接对应 Studio 终端列表里的一个分组。分组下每个 tmux 窗口是一个标签，标签内按布局画多个 xterm 窗格（M3）。
4. 输入、尺寸同步、拆分、新窗口、关闭窗格、关闭窗口（询问隐藏或结束）、重命名、切换活动窗格、缩放（M3、M4）。
5. 流控：背压、`%pause` 之后重同步（M2、M4）。
6. 附加时恢复屏幕：历史、可见屏、光标、备用屏（M2 基础版，M4 补全终端模式）。
7. 断线或退出时 detach；断线后可以「重新附加」（M2、M4）。

### 本轮不做（写进 `docs/tmux.md` 的限制一节）

- 在 PTY 终端里接管 `tmux -CC`（只做 M0 的提示与退出）。
- macOS 本机附加、Windows 经 WSL 附加。架构上留口子：`TmuxControlManager` 的连接来源是可注入的 `spawnControl`，以后加本机或 WSL 只需要换一个来源。
- 远端是 Windows 的 SSH 目标（没有 tmux）。
- tmux 自绘的 UI：copy mode、choose-tree、display-panes、状态栏。控制模式本来就不发送这些。
- tmux 前缀键：控制模式下前缀键不生效，由 Studio 的按钮和菜单代替。快捷键放到后续再做。
- 录制 tmux 窗格（SSH 终端本来就不支持录制）。
- 多个 Studio 窗口共用同一条控制连接：每个窗口各连各的，和现有终端按 `windowId` 隔离的做法一致。
- tmux 低于 3.2。

---

## 4. 总体架构

```
Renderer (TerminalPane / TmuxWindowView / terminalSessions store)
   │  ompStudioTerminal.tmuxSessions / tmuxAttach / tmuxCommand / tmuxDetach   (invoke)
   │  ompStudioTerminal.onTmux                                                   (event: 拓扑快照)
   │  ompStudioTerminal.write / ack  ← 窗格 terminalId 复用现有通道
   │  ompStudioTerminal.onData       ← 窗格输出复用现有通道
   ▼
Main: terminal-ipc.ts ──owns?──► tmux/manager.ts (TmuxControlManager，按 windowId 分)
                                   │  每个连接 = TmuxConnection
                                   │    ├─ control-client.ts  命令 FIFO、启动门、版本检查
                                   │    ├─ control-parser.ts  字节流 → 行 → 块 / 通知 / 窗格字节
                                   │    ├─ layout.ts          布局字符串 → 树 + 叶子矩形
                                   │    ├─ commands.ts        类型化动作 → 安全的命令行
                                   │    └─ TerminalOutputBatcher（每个窗格一个 terminalId）
                                   ▼
                     child_process.spawn(ssh, [...sshArguments(profile)(含 -T), remoteCmd], 管道)
                                   ▼
                     远端：/bin/sh -c 'PATH=…; exec tmux -C new-session -A -s NAME -c DIR'
```

关键取舍：

1. **窗格就是普通终端 id。** Main 给每个 `%N` 分配一个 `TERMINAL_ID_PATTERN` 格式的随机 `terminalId`，窗格输出走现有的 `terminal-data` 事件、batcher、ACK 和 Renderer backlog。xterm 侧几乎不用新写数据通路。
2. **拓扑是整份快照。** 任何结构通知都先合并 16 ms，再推一份完整的 `TmuxTopology`。窗口和窗格数量都很小，用不着增量补丁，Renderer 也不需要维护 diff 状态机。
3. **Renderer 只发类型化动作，不发 tmux 命令文本。** 所有命令行只在 Main 的 `commands.ts` 里生成（呼应 `AGENTS.md`「不以 slash 文本 / 按键宏模拟控制」）。
4. **输入校验只放一处**：沿用终端 IPC 现有做法，在 `tmux-shared.ts` 的 `parse*` 里做，由 Main 的 handler 调用。Renderer 不预检，Main 不再复查 tmux 返回的内容（`AGENTS.md`「不写结果校验器」）。tmux 的输出只做协议解析，解析失败就记日志并全量刷新。
5. **背压对整条连接生效。** 任一窗格的 batcher 要求暂停，就暂停 ssh 的 stdout（不丢数据）。tmux 那边设 `pause-after=15` 兜底：积压超过 15 秒的窗格才会被 tmux 暂停，之后由 Studio 重同步。代价是一个疯狂输出的窗格会短时间拖慢其他窗格，这在可以接受的范围内。按窗格暂停（`%N:pause`）留作以后的优化，见 §10。

---

## 5. 详细设计

### 5.1 Main：`apps/desktop/src/tmux/`（新目录，不依赖 Electron）

#### `tmux-shared.ts`（preload 和 Renderer 都会 import：只放类型、常量和纯函数，不用 Node API）

```ts
export const TMUX_IPC_CHANNELS = {
  sessions: "omp-studio:desktop:terminal-tmux-sessions",
  attach:   "omp-studio:desktop:terminal-tmux-attach",
  command:  "omp-studio:desktop:terminal-tmux-command",
  detach:   "omp-studio:desktop:terminal-tmux-detach",
  topology: "omp-studio:desktop:terminal-tmux-topology", // Main → Renderer
} as const;

export const TMUX_MIN_VERSION = [3, 2] as const;
export const TMUX_MAX_CONNECTIONS_PER_WINDOW = 4;
export const TMUX_MAX_PANES_PER_CONNECTION = 64;
export const TMUX_SESSION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const TMUX_WINDOW_ID_PATTERN = /^@\d{1,9}$/;
export const TMUX_PANE_ID_PATTERN = /^%\d{1,9}$/;

export interface TmuxSessionsInput { targetId: string; workspaceId: string }
export interface TmuxSessionSummary { id: string; name: string; windows: number; attached: number; createdAt: number }
export type TmuxSessionsResult =
  | { available: true; version: string; sessions: TmuxSessionSummary[] }
  | { available: false; reason: "remote-windows" | "not-installed" | "too-old" | "ssh-failed"; version?: string; message: string };

export interface TmuxAttachInput { targetId: string; workspaceId: string; session?: string /* 省略 = 新建默认名 */; cols: number; rows: number; flowControl?: boolean }
export interface TmuxAttachResult { connectionId: string }

export type TmuxAction =
  | { kind: "newWindow"; afterWindowId?: string }
  | { kind: "splitPane"; paneId: string; direction: "right" | "down" }
  | { kind: "killPane"; paneId: string }
  | { kind: "killWindow"; windowId: string }
  | { kind: "killSession" }
  | { kind: "selectPane"; paneId: string }
  | { kind: "selectWindow"; windowId: string }
  | { kind: "renameWindow"; windowId: string; name: string }        // ≤128 字符，不含控制字符
  | { kind: "resizeWindow"; windowId: string; cols: number; rows: number } // 复用 TERMINAL_MIN/MAX_*
  | { kind: "resizePane"; paneId: string; axis: "x" | "y"; cells: number }
  | { kind: "zoomPane"; paneId: string }
  | { kind: "setPaneVisible"; paneIds: string[]; visible: boolean }; // 隐藏窗口 → off；显示 → on + 重同步
export interface TmuxCommandInput { connectionId: string; action: TmuxAction }

export type TmuxLayoutNode =
  | { type: "pane"; paneId: string; x: number; y: number; cols: number; rows: number }
  | { type: "row" | "column"; x: number; y: number; cols: number; rows: number; children: TmuxLayoutNode[] };

export interface TmuxTopology {
  connectionId: string;
  targetId: string;
  workspaceId: string;
  state: "attaching" | "attached" | "exited" | "lost";
  reason?: string;                     // %exit 原因 / ssh 失败原因
  version?: string;
  session?: { id: string; name: string };
  activeWindowId?: string;
  windows: Array<{ id: string; index: number; name: string; zoomed: boolean; layout: TmuxLayoutNode; cols: number; rows: number }>;
  panes: Record<string, { terminalId: string; windowId: string; active: boolean; title: string; paused: boolean; dead: boolean; off: boolean }>;
  configErrors?: string[];
}
```

再加上 `parseTmuxSessionsInput / parseTmuxAttachInput / parseTmuxCommandInput / parseTmuxDetachInput`，写法照抄 `terminal-shared.ts` 的 `parse*`：字段白名单、正则、整数范围、抛 `TerminalIpcError`。这是 tmux 动作**唯一**的输入校验点。

#### `control-parser.ts`

- `class TmuxControlParser`，`push(chunk: Buffer)`，回调 `onBlock({ number, ok, lines: Buffer[] })`、`onNotification(name, args: Buffer)`、`onPaneOutput(paneId, bytes: Uint8Array)`、`onNoise(line)`。
- **全程按字节处理**，以 `\n` 切行，去掉行尾 `\r`。不能先把整条流解码成 UTF-8：`%output` 里大于等于 0x80 的字节是原样输出的，可能只是半个码点。
- 进入首个 `%begin ` 之前的行都算 noise（远端 shell 打印的 motd、rc 文件输出），交给 `onNoise`，最多记 20 行进诊断日志，不显示。
- 块的状态机：`%begin t n f` 进入块，块内每一行都是输出，遇到 `%end t n f` 或 `%error t n f`（且 `n` 一致）结束。不一致时记 `protocol_error`，按 `%end` 处理。
- `%output %N <value>`：反转义。逐字节扫描，遇到 `\` 读 3 位八进制得到一个字节，其余字节原样，结果直接交给 `onPaneOutput`。
- `%extended-output %N <age> … : <value>`：找到第一个 ` : `，后半段按 `%output` 反转义。
- 单行上限 4 MiB（tmux 一行 `%output` 不会这么长）。超过就丢弃这一行、记日志，并对该连接全量重同步。

#### `layout.ts`

- `parseTmuxLayout(s: string): { root: TmuxLayoutNode; panes: Array<{ paneId; x; y; cols; rows }> }`，按 §1.5 的语法递归下降。叶子的数字 N 映射成 `%N`。
- `tmuxLayoutChecksum(body: string): string`，用来校验。
- 纯函数，不抛业务错误；解析失败返回 `undefined`，由调用方触发全量刷新。

#### `commands.ts`

- `quoteTmux(value: string)`：用单引号包起来，内部的 `'` 写成 `'\''`。单引号里的内容 tmux 不做 `$VAR`、`~`、`#{}` 展开，`;` 也不会被当作命令分隔符。窗口名先经 `parseTmuxCommandInput` 拒掉控制字符。
- `sendKeysLines(paneId, data: string): string[]`：UTF-8 编码后转十六进制，每 512 字节一行 `send-keys -t %N -H xx xx …`。`TERMINAL_MAX_WRITE` 是 64K 字符，一次粘贴最多约 400 行命令，可以接受。
- `actionLines(action): string[]`：按 §1.4 的表生成。`setPaneVisible` 生成 `refresh-client -A '%N:on|off'`，多个 `-A` 合并成一行。
- `remoteTmuxCommand(session, dir)`：远端执行的 sh 脚本。写法参考 `remoteTerminalCommand` 的 POSIX 单引号转义：

  ```sh
  exec /bin/sh -c 'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:$HOME/bin"; export PATH; command -v tmux >/dev/null 2>&1 || { echo "studio-tmux: not-installed" >&2; exit 127; }; exec tmux -C new-session -A -s '\''NAME'\'' -c '\''DIR'\'''
  ```

  补 PATH 是因为 `ssh host cmd` 用的是非登录 shell，Homebrew / linuxbrew / `~/.local/bin` 下的 tmux 常常不在 PATH 里。不用 `-l` 登录 shell，避免 profile 往 stdout 打印东西；就算打印了，parser 也会把首个 `%begin` 之前的内容当 noise 跳过。和现有 SSH 终端一样，假设远端登录 shell 能执行 POSIX `exec /bin/sh -c …`（fish 也支持 `exec` 和单引号）。
- `remoteListCommand()`：`tmux -V; tmux list-sessions -F '#{session_id}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_name}' 2>&1 || true`，外层包同样的 PATH 前缀。输出里出现 `no server running` 或 `error connecting to` 时视为空列表。

#### `control-client.ts`

`class TmuxControlClient`，入参是 `{ stdin: Writable, onEvent }`，内部持有 parser：

- `#queue: Array<{ resolve, reject, lines }>`，`run(line): Promise<Buffer[]>` 写入 `line + "\n"`，排进 FIFO。`fire(line)` 也排进 FIFO，结果丢弃，`%error` 只记日志，同一类错误只记一次。
- 启动门：在收到第一个块之前，`run` 都排队不写；第一个块到达后清空排队并开始写。15 秒没有收到块就报 `attach-timeout`。
- `detach()`：写一个 `\n` 再 `stdin.end()`。

#### `connection.ts`（`TmuxConnection`，一条附加连接）

**附加流程**（全部在 Main，Renderer 只等拓扑事件）：

1. spawn `ssh`：`child_process.spawn(systemSshExecutable(), [...sshArguments(profile), remoteTmuxCommand(name, path)], { stdio: "pipe", windowsHide: true, env: { ...process.env, ...authRequest?.env } })`，不调 `setEncoding`，保持 Buffer。
2. 等启动门打开后，`display-message -p '#{version}'`，解析成 `[major, minor]`。`next-3.6` 和 `master` 当作最新版。低于 3.2 就 detach，拓扑 `state: "exited", reason: "too-old"`。
3. `refresh-client -f pause-after=15`，然后 `refresh-client -C <cols>x<rows>`（Renderer 附加时传的初始尺寸）。
4. `list-windows …` 和 `list-panes -s …`，建立窗口表和窗格表。给每个新窗格分配 `terminalId`，并调 `batcher.open(terminalId, { flowControl })`。
5. 每个窗格先进入 `restoring` 状态：这段时间到达的 `%output` 先存进该窗格的「恢复缓冲」（上限 1 MiB，超过就丢最旧的并记数）。然后执行 `capture-pane -p -e -J -t %N -S -1000`。如果 `alternate_on=1`，再执行 `capture-pane -p -e -a -t %N`。
6. 拼接恢复内容：历史和可见屏按行用 `\r\n` 连接。有备用屏时追加 `\x1b[?1049h\x1b[H\x1b[2J` 和备用屏内容。最后加 `\x1b[{cursor_y+1};{cursor_x+1}H`。依次 `batcher.push(terminalId, 恢复内容)`、`batcher.push(恢复缓冲)`，然后切到 `live` 状态。iTerm2 的做法也是这样，恢复期间可能有少量重复输出，可以接受。
7. **先推一份 `state: "attached"` 的拓扑快照，再放行任何窗格输出**（见 §5.3 的顺序约束）。

**运行期**：

- `%output` → `batcher.push(terminalId, bytes)`。未知窗格先触发一次全量刷新（窗格可能刚刚创建），刷新完之前的输出存进它的恢复缓冲。
- `%layout-change` → 立即更新该窗口的布局并推拓扑，这样拖分隔线时延迟低。窗格集合有变化时再排一次全量刷新。
- `%window-add/close/renamed`、`%window-pane-changed`、`%session-window-changed`、`%session-renamed`、`%pane-mode-changed` → 合并 16 ms 后全量刷新（重新 `list-windows` 和 `list-panes`，按 diff 分配或释放 terminalId）。
- 窗格消失 → `batcher.finish(terminalId)` 之后 close。拓扑里删掉它，Renderer 随之销毁对应的 xterm。
- 窗格数超过 64 时，多出来的窗格发 `%N:off`，拓扑里标 `off: true`，Renderer 画一个「未显示」占位。
- `%pause %N` → 拓扑 `paused: true`。等该窗格 batcher 的 unacked 降到低水位以下（可以借用 `pauseSource(id, false)` 这个时机），发 `refresh-client -A '%N:continue'`，再 `capture-pane -p -e -t %N`（只取可见屏），推送 `\x1b[H\x1b[2J` 加内容加光标位置，然后 `paused: false`。
- `%exit [reason]` → `state: "exited"`，所有窗格 `batcher.finish`。
- ssh 进程退出但没有收到 `%exit` → `state: "lost"`，reason 取 stderr 末尾 2 KB（脱敏：不带密码，askpass 本来也不会出现在 stderr）。
- 背压：batcher 的 `pauseSource(terminalId, paused)` 回调把 terminalId 记进 `#paused` 集合。集合非空时 `child.stdout.pause()`，变空时 `resume()`。
- 写入：`write(terminalId, data)` → `sendKeysLines(paneId, data).forEach(fire)`。窗格处于 `paused` 或 `dead` 时丢弃写入。
- 尺寸：`resizeWindow` → `refresh-client -C @id:WxH`，同一窗口在同一帧内只发最后一次（合并 16 ms）。

**结束**：

- `detach()`：`client.detach()`，等进程退出，最多 3 秒，超时就 `terminateProcessTree`。然后对所有窗格 `batcher.close`，并释放 askpass 票据。
- `killSession` 动作：执行 `kill-session`，tmux 随后会发 `%exit`。

#### `manager.ts`（`TmuxControlManager`，结构对照 `RemoteTerminalManager`）

- 构造参数：`connections: RemoteConnectionManager`、`spawnControl`（测试注入）、`log(level, event, detail)`（接 `hostLog.write`）、`batchOptions?`。
- `sessions(windowId, input)` → 一次性 spawn `ssh … remoteListCommand()`：超时 15 秒，输出上限 64 KB。远端 `environment.platform === "win32"` 时直接返回 `available: false, reason: "remote-windows"`。
- `attach(windowId, input, listeners)`：先 `assertWritable(targetId)`，同一窗口最多 4 条连接；同一窗口对同一个 `(targetId, session)` 已有活连接时直接返回它的 `connectionId`，不重复附加。和 `RemoteTerminalManager.create` 一样，用 `#windowEpochs` 防止窗口关闭后才 resolve 的附加泄漏出去。
- `owns(windowId, terminalId)`、`write`、`acknowledge` → 转给对应的连接。
- `command(windowId, input)`、`detach(windowId, connectionId)`。
- `hasTarget(targetId)`：有活连接就返回 true。`main.ts:693` 的判断改成 `remoteTerminals.hasTarget(id) || tmux.hasTarget(id)`。
- `disposeWindow(windowId)` → 该窗口的所有连接 detach。`disposeAll()` → 全部 detach，在 `beforeShutdown` 里 `await`，最多等 1 秒。
- 日志事件（不记会话名和输出内容）：`desktop.tmux.attach`（版本、耗时、结果）、`desktop.tmux.exit`（原因）、`desktop.tmux.protocol_error`（类别）、`desktop.tmux.noise`（行数）。

### 5.2 IPC、preload 与路由

- `terminal-shared.ts`：
  - `OmpStudioTerminalApi` 增加**可选**方法：`tmuxSessions?(input)`、`tmuxAttach?(input)`、`tmuxCommand?(input)`、`tmuxDetach?(connectionId)`、`onTmux?(listener)`。可选是为了兼容旧 preload，和 `ack?` 同样处理。
  - `recordingStart` 收到窗格 id 时报「tmux 窗格暂不支持录制」。
- `terminal-ipc.ts`：
  - `TerminalIpcOptions` 加 `tmux?: TmuxControlManager`。
  - 注册 4 个 `handle`（sessions / attach / command / detach），都要 `assertTrusted` 和 `track(sender)`。拓扑事件和现有 `listenersFor` 一样经 `sender.send(TMUX_IPC_CHANNELS.topology, …)` 发出，同样受 `active()` 守卫。
  - `write` / `ack`：先判断 `options.tmux?.owns(...)`，再判断 remote，最后落到本机。`resize` 收到窗格 id 时什么都不做（窗格尺寸由布局决定）。`dispose` 收到窗格 id 时也什么都不做（结构操作走 `tmuxCommand`）。
  - `track` 的 teardown 增加 `options.tmux?.disposeWindow(sender.id)`。
  - `dispose()` 和启动时的 `removeHandler` 列表都要加上新通道。
- `preload.ts`：在 `terminalApi` 里加上述方法，`onTmux` 用 `subscribeChannel`。
- `main.ts`：在 `remoteTerminals` 旁边 `new TmuxControlManager({ connections: remoteConnections, log: … })`，传给 `registerTerminalIpc`，加进 `beforeShutdown` 和 `hasTarget` 判断。
- `apps/renderer/src/vite-env.d.ts`：`ompStudioTerminal` 的类型会随 `OmpStudioTerminalApi` 一起更新。确认它引用的是这个接口，没有另写一份类型。

### 5.3 Renderer

#### 存储：`terminalSessions.tsx`

- `TerminalSession` 增加 `kind?: "shell" | "tmux-pane"` 和 `tmux?: { connectionId: string; paneId: string; windowId: string }`。窗格会话也放进 `sessions` 数组，这样 `#sessionIds`、backlog 和 ACK 全部沿用现有逻辑。UI 列表按 `kind` 过滤，窗格不在列表里单独显示。
- `TerminalState` 增加 `tmux: Readonly<Record<string, TmuxTopology>>`（按 connectionId）。
- `#listen()` 里订阅 `api.onTmux`：收到快照后**同步**更新 `tmux` 状态，并按 `topology.panes` 增删 `tmux-pane` 会话。窗格消失时走和 `remove` 相同的释放逻辑（`#releaseScreen`），但不调 `api.dispose`。
- **顺序约束**：Main 保证某个窗格第一次出现在拓扑快照里之后，才发送它的输出。Electron 从 Main 向同一个 webContents 发的消息（不论哪个 channel）都走同一条有序管道，所以 `onTmux` 一定先于该窗格的第一条 `onData` 到达。保险起见，再给存储加一层：连接处于 `attaching` 时，未知 id 的输出先暂存（和 `#creating` 的做法一样），拓扑到达后再归位。补一条测试覆盖这个场景。
- 新方法：`listTmuxSessions(targetId, workspaceId)`、`attachTmux(targetId, workspaceId, session?)`（初始 cols/rows 取当前终端视图的尺寸，没有就用 120×32）、`tmuxCommand(connectionId, action)`、`detachTmux(connectionId)`、`forgetTmux(connectionId)`（从列表里移除已经 exited 或 lost 的分组）。
- 隐藏窗口是纯本地状态：`hiddenWindows: Record<connectionId, Set<windowId>>`。隐藏时发 `setPaneVisible(paneIds, false)`，恢复时发 `true`，Main 负责重同步（`on` 之后执行 `capture-pane`）。
- `close()`（Provider 卸载）时对所有连接 `detachTmux`。

#### 面板：`TerminalPane.tsx`

- 列表（`.term-list`）里，普通终端照旧。每个 tmux 连接显示为一个分组：
  - 分组头：`tmux · <session>`，加状态 chip（附加中 / 已附加 / 已断开 / 已结束）。右侧一个 ⋯ 菜单（重命名会话放到以后；「结束整个会话」需要二次确认），一个 × 按钮（detach，不询问）。
  - 分组下每个 tmux 窗口一行：`<index>: <name>`，活动窗口加标记，行上的 × 走关闭询问流程。
  - 有隐藏窗口时显示「已隐藏 n 个窗口」，点击展开后可以逐个恢复。
- 「新建终端」按钮旁边加「附加 tmux…」：
  - 预览关、当前执行目标是 SSH、并且已连接：可用。
  - 本机目标：禁用，tooltip 写「仅 SSH 工作区可附加 tmux」（诚实空壳）。
  - 远端是 Windows：在选择器里显示 `remote-windows` 的原因。
- 选中一个 tmux 窗口时，右侧 `.term-view` 显示：
  - `.term-cwd` 行：`tmux · <session> · <window>`，M4 起再加活动窗格的 cwd。右侧是工具按钮：向右拆分、向下拆分、新窗口、缩放、关闭窗格。用现有 `Icon`，缺图标就在 `icons` 里补。
  - 连接是 `exited` 或 `lost` 时：横幅写明原因，并给出「重新附加」（附加同名会话，成功后替换掉旧分组）和「移除」两个按钮。窗格内容保留为只读（`disableStdin`）。
  - 有 `configErrors` 时：显示一次折叠提示。
  - 主体是 `<TmuxWindowView>`。
- 录制控件：tmux 窗口不显示（SSH 本来就不显示）。

#### 选择器：`tmux/TmuxSessionPicker.tsx`（新文件）

- 打开时调 `listTmuxSessions`。加载中显示进度，失败时显示 `message`。
- 列出会话：名称、窗口数、已附加的客户端数、创建时间。点击即附加。
- 「新建会话」：名称输入框，默认 `studio-<工作区目录名>`，非法字符替换成 `-`，截到 64 个字符，并按 `TMUX_SESSION_NAME_PATTERN` 实时提示。如果名称已存在，`new-session -A` 会直接附加到它，界面要说明这一点。
- 弹窗和列表复用项目已有组件，不新造。下拉框遵守「选择器规则」（`--fast` 会检查）。

#### 窗口视图：`tmux/TmuxWindowView.tsx`（新文件）

- **测量**：容器里放一个隐藏的测量用 xterm，字体和行高与窗格完全一致（`readTerminalTypography()`、`lineHeight: 1.3`）。在它上面用 `FitAddon.proposeDimensions()` 得到整个容器能容纳的 `cols × rows`，这就是期望的 tmux 窗口尺寸。单元格像素取 `.xterm-screen` 的 `clientWidth / cols`、`clientHeight / rows`，不读 xterm 私有字段。容器的 ResizeObserver 和字体设置变化都会触发重新测量，结果合并 16 ms 后发 `resizeWindow`（数值没变就不发）。
- **布局**：以拓扑里该窗口的 `layout` 为准，**不用自己测出的尺寸**，因为其他客户端也可能影响窗口大小。每个叶子窗格画一个绝对定位的 xterm 容器：`left = x * cellW`、`top = y * cellH`、`width = cols * cellW`、`height = rows * cellH`，然后 `term.resize(cols, rows)`。窗格不用 FitAddon。
  - 叶子之间的 1 格空隙画成分隔线元素，占满空隙。
  - tmux 窗口比容器大时，容器出现滚动条；比容器小时，留白并显示 chip「尺寸受其他 tmux 客户端限制」。
- **窗格 xterm**：
  - 选项和普通终端一致，但 **`convertEol: false`**。窗格输出是原始 PTY 字节，vim、htop 等全屏程序依赖裸 LF 只下移一行；恢复内容已经自带 `\r\n`。
  - `onData` → `api.write(terminalId, data)`，Main 转成 `send-keys`。
  - 宿主注册复用 `store.attachHost(terminalId, host)`，backlog 和 ACK 不用改。
  - 链接识别复用 `registerTerminalBrowserLinks`，主题跟随复用 `applyTheme`。
- **交互**：
  - 点击或聚焦一个窗格 → `selectPane`。活动窗格画焦点描边（颜色用 token）。
  - 键盘焦点跟随拓扑里的 `active` 窗格。
  - M4：拖动分隔线 → 按单元格换算，16 ms 合并后发 `resizePane`。悬停态的过渡用 `motion.css` 的现成模式，不写字面时长（`check-renderer-motion.mjs` 会拦）。
  - 缩放（`zoomed`）时，`visible-layout` 里只剩一个窗格，按它渲染即可。
  - `paused` 窗格叠一层半透明提示「输出过快，正在重新同步」。`off` 窗格画占位。
- **关闭询问**：`tmux/TmuxCloseDialog.tsx`，三个按钮「隐藏 / 结束窗口 / 取消」，加一个复选框「记住选择」。勾选后写入本地设置 `terminalTmuxCloseAction: "ask" | "hide" | "kill"`（加在 `settings/appSettings` 里，和 `terminalFontFamily` 放在同一处）。设置页的终端分组加一行下拉框，可以改回「每次询问」。关闭一个窗格（工具栏按钮）也走 `killPane`，但不询问，因为它是明确的破坏性按钮，按钮文案写「结束窗格」。

#### 预览模式（按 `AGENTS.md`「接入步骤」）

- 预览开：「附加 tmux…」可用，选择器显示 `preview/tmuxPreview.ts` 里的 `PREVIEW_TMUX_SESSIONS`（2-3 个演示会话），带「演示」标记。点击附加后，在本地生成一个演示分组，拓扑取自 `PREVIEW_TMUX_TOPOLOGY`（2 个窗口，其中一个左右分屏、右侧再上下分屏）。
- 演示窗格**不写假的 shell 输出**（`AGENTS.md` 禁止「把底部真实终端换成假 PTY 行」）。窗格只画布局壳、标题条和居中的「演示窗格」占位。`marks === false` 时占位文字也去掉，只留空白窗格和分隔线。
- 演示按钮（拆分、关闭等）只改本地演示拓扑，不调 IPC。
- 预览关：只用真实数据。本机目标下入口是禁用壳加原因，见上文。
- 不往 Host、client-contract、transport、reducer 里写任何 mock。

#### i18n

在 `i18n/locales/zh.ts` 和 `en.ts` 的 `terminal` 对象下新增 `tmux` 子对象：入口、选择器、状态 chip、关闭询问、横幅、错误原因（`remote-windows` / `not-installed` / `too-old` / `ssh-failed` / `attach-timeout` / `lost`）、工具按钮的 aria-label。不要在组件里硬编码中文（现有 `TerminalPane` 里有几处硬编码，不在本次范围内，不要顺手改）。

### 5.4 M0：图形解码器不再吞掉 DCS

修改 `terminalGraphics.ts` 的 `decode`：

- 看到 `ESC P` 时，如果后面的内容匹配 `^\x1bP[0-9;]*q`（Sixel），或者还太短、仍可能变成 Sixel，就按现有逻辑缓冲。
- 如果是 `\x1bP1000p`：从流里去掉这一段，返回 `{ controlMode: "enter" }`，并进入 swallow 状态。这个状态下**边读边丢**，不累积缓冲，同时寻找 `\x1b\\`。找到后返回 `{ controlMode: "exit" }`，之后的内容恢复正常显示。
- 其他 DCS（XTVERSION、DECRQSS 应答等）立即原样交给 xterm，xterm 自己会解析。

`terminalSessions.tsx` 收到 `enter` 时，在 `notices[id]` 写入提示：「这个终端进入了 tmux -CC 控制模式。OMP Studio 不在普通终端里接管控制模式；SSH 工作区请使用「附加 tmux…」。」并在 state 里记 `controlMode[id] = true`。TerminalPane 在提示旁放「退出控制模式」按钮，点击执行 `api.write(id, "\n")`（空行会让 tmux detach，之后 tmux 发出 `%exit` 和 ST，解码器退出 swallow 状态）。收到 `exit` 时清掉提示。

已知局限：Windows 本机的 ConPTY 可能会吞掉 DCS，这时解码器看不到 `ESC P1000p`，屏幕上会出现协议原文。这一点写进 `docs/tmux.md`，不再额外处理。

---

## 6. 里程碑

每个里程碑一个或几个提交，提交信息沿用仓库风格（`feat(terminal): …`、`fix(renderer): …`）。分支由负责人决定；当前 checkout 在 `0.2.0` 发布线上，建议从 `main` 新切 `feat/tmux-control-mode`。

### M0 — 抓包与现存 bug（可以单独发布）

1. **抓包脚本** `scripts/tmux-transcript.mjs`（开发工具，不进产品）：在装了 tmux 的 Linux 或 macOS 上运行 `tmux -L studio-capture -f /dev/null -C new-session -A -s cap`（管道 stdio），依次发一组固定命令（§1.4 全表，外加 split、resize、kill、`printf` 输出中文和 emoji、`cat` 一个 200 KB 的文件、`vim` 打开再退出），把 stdout 原始字节写到 `apps/desktop/test/fixtures/tmux/<version>-<scenario>.bin`。至少覆盖 tmux **3.2a** 和当前最新版两个版本（可以用 Docker：`ubuntu:22.04` 自带 3.2a，`debian:testing` 或 Homebrew 提供新版）。
2. 拿抓包结果逐条核对 §1 里标了 ⚠ 的地方，结论写回本文 §1（直接改，删掉 ⚠）。另外在一台真实的 SSH 主机上手工跑一次 `ssh -T host tmux -C new -A -s x`，确认无 tty 时可以工作。
3. 按 §5.4 修 `terminalGraphics.ts` 和 `terminalSessions.tsx`、`TerminalPane.tsx` 的提示与按钮，加 i18n。
4. 测试：`terminalSessions.test.tsx` 增加一个用例：输出 `ESC P1000p` 加几行 `%begin…`，再加 `ESC \` 和 `$ `，断言协议行不显示、出现提示、ST 之后的 `$ ` 正常显示。另加一个 Sixel 回归用例，确认图片仍能解码。
5. 检查：`npm run check -- --only renderer --suite terminalSessions --suite TerminalPane`。
6. 验收：在 macOS 本机或 SSH 终端里手敲 `tmux -CC`，终端不冻住，出现提示；点「退出控制模式」后回到 shell 提示符。

### M1 — 协议核心（只有 Desktop，没有 UI）

- 新增 `apps/desktop/src/tmux/{tmux-shared,control-parser,layout,commands,control-client}.ts`。
- 测试 `apps/desktop/test/tmux-control.test.ts`，用 M0 的抓包文件驱动：
  - parser：把抓包随机切成 1 到 4096 字节的 chunk 喂进去，结果必须和整块喂入完全一致；输出块里出现以 `%` 开头的行；八进制转义（`\134`、`\015`、`\012`）；把一个中文字符的 UTF-8 字节拆到两行 `%output` 里，batcher 解码后不出现 `�`（连同 `TerminalOutputBatcher` 一起测）；首个 `%begin` 之前的 noise；`%exit` 带原因和不带原因两种情况。
  - layout：抓包里真实出现的嵌套布局和缩放布局，以及校验和。
  - commands：`quoteTmux` 处理 `'`、`;`、`$HOME`、`#{…}`；`sendKeysLines` 的分块边界；每种 `TmuxAction` 生成的命令行（快照式断言）。
  - client：启动门、FIFO 关联、`%error` 时 reject。
- 把 `tmux-control.test.js` 加进 `scripts/core-suites.mjs` 的 desktop 名单（协议解析出错就是真实 bug，符合核心名单的标准）。
- 检查：`npm run check -- --only desktop`。

### M2 — Main 连接管理、IPC 与 preload

- 新增 `tmux/connection.ts`、`tmux/manager.ts`。修改 `terminal-shared.ts`（可选 API 和录制拒绝）、`terminal-ipc.ts`、`preload.ts`、`main.ts`。
- 测试 `apps/desktop/test/tmux-manager.test.ts`，假 spawner 写法参考 `remote-terminal.test.ts`，用抓包回放 stdout：
  - 附加时，按顺序写出 version → `refresh-client -f` → `-C` → list-windows → list-panes → capture-pane；拓扑快照先于窗格输出发出。
  - `write(paneTerminalId)` 生成 `send-keys -H`；`ack` 记到对应窗格的 batcher 上。
  - 某个窗格 batcher 超过高水位时，`stdout.pause()` 被调用；ACK 之后 resume。
  - `%pause` 时发 `continue` 并重新 capture；`%exit` → exited；进程退出但没有 `%exit` → lost。
  - `disposeWindow` 写空行之后 end stdin；3 秒超时则杀进程。
  - 版本 3.1c 时 → `too-old`，并且已经 detach。
  - 窗口关闭之后才 resolve 的附加，会被丢弃并 detach（epoch）。
  - `terminal-ipc.test.ts`：tmux 窗格 id 的 write / ack 路由到 tmux manager；resize / dispose 对窗格 id 不做任何事。
- 可选的真实 tmux 集成测试 `tmux-real.test.ts`：`PATH` 里找不到 tmux 时 `skip`。用本机 `tmux -L studio-test -f /dev/null -C new-session` 代替 ssh 跑完整流程，测完 `kill-server`。**不进核心名单**。
- 检查：`npm run check -- --only desktop`，然后 `npm run check -- --fast`（架构规则：tmux 目录不能 import electron）。

### M3 — Renderer 基本可用

- 修改 `terminalSessions.tsx`、`TerminalPane.tsx`、`styles/workbench.css`、两个 locales 文件、`settings/appSettings` 和设置页的终端分组。新增 `tmux/TmuxSessionPicker.tsx`、`tmux/TmuxWindowView.tsx`、`tmux/TmuxCloseDialog.tsx`、`preview/tmuxPreview.ts`。
- 本阶段要做到：选择器、附加、分组列表、窗口标签、按布局渲染、输入、尺寸同步、工具按钮（拆分、新窗口、关闭窗格）、关闭询问与记住选择、隐藏和恢复窗口、exited / lost 横幅与重新附加、预览演示。
- 测试（只测用户能感知的行为，不进核心名单）：
  - `terminalSessions.test.tsx`：拓扑快照会增删窗格会话；窗格输出写进对应 host，ACK 正确；`attaching` 期间未知 id 的输出会暂存并归位。
  - `TmuxWindowView.test.tsx`：给定布局，各窗格容器的 left / top / width / height 与单元格换算一致；点击窗格发出 `selectPane`。
  - `TerminalPane.test.tsx`：关闭窗口时询问；选「隐藏」发 `setPaneVisible false`，选「结束」发 `killWindow`；记住选择后不再询问；本机目标下入口禁用并显示原因；预览模式显示演示标记，`marks=off` 时不显示。
- 检查：`npm run check -- --only renderer --suite terminalSessions --suite TerminalPane --suite TmuxWindowView`，再跑 `npm run check -- --fast`（选择器规则和动效规则）。
- 手工检查：`启动预览.cmd` 连一台 SSH 主机，完成 §8 的 1-9 项。

### M4 — 保真度与打磨

- 附加恢复补全终端模式：`list-panes` 额外取 `#{keypad_cursor_flag}`、`#{keypad_flag}`、`#{mouse_any_flag}`、`#{mouse_sgr_flag}`、`#{wrap_flag}`、`#{origin_flag}`、`#{scroll_region_upper}`、`#{scroll_region_lower}`、`#{cursor_flag}`，转成对应的 DECSET / DECSTBM 写进恢复内容。tmux 有哪些可用的格式变量，以 `tmux.1` 的 FORMATS 一节为准，没有的就不做。
- 订阅：`refresh-client -B 'studio-title:%*:#{pane_title}'` 和 `'studio-cwd:%*:#{pane_current_path}'`。`%subscription-changed` 更新拓扑里窗格的 `title` 和 `cwd`，`.term-cwd` 行显示活动窗格的 cwd。
- 拖动分隔线调整大小，缩放按钮，`paused` 遮罩与重同步。
- 「重新附加」时沿用旧分组在列表里的位置。
- 诊断：Host 日志里有 §5.1 列出的事件；诊断页不新增面板。
- 测试：在 M2 / M3 的测试文件里补对应用例（订阅解析、`resizePane` 的单元格换算、`%pause` 遮罩）。

### M5 — 文档与收尾

- `docs/tmux.md`（面向用户）：前提条件（SSH 工作区、远端 POSIX、tmux ≥ 3.2、tmux 在 §5.1 补过的 PATH 里）、怎么附加、窗口与窗格的对应关系、关闭和隐藏的区别、断线后的行为、限制（§3 非目标、Unicode 宽度差异、与其他客户端的尺寸互相影响、Windows 本机手敲 `-CC` 的局限）。在 `docs/README.md` 加链接。
- `doc/feature-index.md`：「终端、窗口铬、设置、诊断」表里加一行「tmux 控制模式」，Renderer 列写 `TerminalPane.tsx`、`tmux/*.tsx`、`terminalSessions.tsx`、`preview/tmuxPreview.ts`，Desktop 列写 `tmux/*.ts`、`terminal-ipc.ts`、`preload.ts`，加一句用途说明。「命令落点速查」如果按通道列，也补上。
- `CHANGELOG.md`：在 Unreleased 下加一条。
- 本文顶部的状态改成「已实现」，并补 as-built 差异（参照 `doc/browser-sidebar-integration-plan.md` 的 §0 写法）。
- 检查：`npm run check`（全量核心），然后 `npm run check -- --production`。

---

## 7. 测试策略汇总

| 层 | 文件 | 是否核心 | 驱动方式 |
|---|---|---|---|
| 协议解析、布局、命令 | `apps/desktop/test/tmux-control.test.ts` | ✅ | M0 抓包文件，随机切 chunk |
| 连接与 manager | `apps/desktop/test/tmux-manager.test.ts` | ❌ | 假 spawner 回放抓包 |
| IPC 路由 | `apps/desktop/test/terminal-ipc.test.ts`（补用例） | 沿用 | 假 ipcMain |
| 真实 tmux | `apps/desktop/test/tmux-real.test.ts` | ❌ | 本机 tmux，找不到就 skip |
| 存储 | `apps/renderer/src/terminalSessions.test.tsx`（补用例） | 沿用 | 假 api |
| 视图 | `apps/renderer/src/tmux/TmuxWindowView.test.tsx`、`TerminalPane.test.tsx`（补用例） | ❌ | jsdom |

不要写的测试：拒绝畸形输入的成套用例、内部结构快照、给演示 fixture 写的测试（`AGENTS.md`）。`parse*` 校验函数只在 IPC 测试里顺带覆盖 1-2 条。

---

## 8. 手动验收清单（真实 SSH 主机，tmux 3.2a 和最新版各跑一遍）

1. 选择器能列出已有会话；没有 tmux server 时列表为空并提示可以新建；远端没装 tmux → 「未安装」；tmux 3.1 → 「版本过低」。
2. 新建会话：分组出现，窗口 0 显示 shell 提示符，cwd 是工作区目录。
3. 输入：中文、emoji、粘贴 5000 行文本、`vim` 的方向键和 Esc、`htop` 的鼠标点击。
4. 拆分右、拆分下、新窗口、关闭窗格；在远端另开一个普通 `tmux attach` 做同样的操作，Studio 能实时反映。
5. 改变 Studio 底栏大小和字号：tmux 窗口跟着变，各窗格按布局重排，没有错位，也不残留旧内容。
6. 关闭窗口标签时出现询问：选「隐藏」→ 窗口仍在 tmux 里（另一端 `tmux ls` 能看到），在「已隐藏」里恢复后内容正确；选「结束」→ 窗口消失；勾选「记住」后不再询问，到设置里改回「每次询问」后又会询问。
7. detach（分组 ×）之后 `tmux ls` 显示会话还在；重新附加后历史和光标恢复，vim 或 htop 的全屏状态能恢复。
8. 拔网线或 kill 掉 ssh：分组显示「已断开」并给出原因；恢复网络后「重新附加」能用。
9. 退出 Studio：远端会话保留；再次启动后可以重新附加。
10. `cat` 一个 50 MB 的文件：界面不卡死，没有出现「已丢弃」提示（背压生效）；同时另一个窗格仍能输入（可能有短暂迟滞）。
11. 在 tmux 里 `kill-session`，或者关闭最后一个窗口：分组显示「会话已结束」。
12. 密码认证的 SSH 目标：列会话和附加都不会再次弹出密码框（一次性 askpass 票据）。
13. 预览模式：演示分组和布局正常；`启动预览版.cmd`（`marks=off`）下不显示任何演示标记。
14. 远端 SSH 目标有 tmux 连接时安装 Runtime → 被拒绝，提示先关闭。

---

## 9. 风险与待验证

| 风险 | 应对 |
|---|---|
| 启动块、`%layout-change` 参数个数、`-C @win:WxH` 这些细节在 3.2a 和新版之间有差别 | M0 抓包确认，以实测为准修订 §1；parser 对多出来的参数保持宽容 |
| 非交互 ssh 的 PATH 里找不到 tmux | §5.1 补常见目录；仍然找不到就返回 `not-installed`，文档说明可以在 `~/.ssh/environment` 或 `~/.bashrc` 里设置 PATH |
| 远端 shell 往 stdout 打印东西，污染协议 | 首个 `%begin` 之前的内容一律当 noise，日志只记行数 |
| 和其他 tmux 客户端互相影响窗口尺寸（`window-size latest`） | 以 tmux 回报的布局为准渲染，留白或滚动，并给出 chip 提示；不改用户的 tmux 选项 |
| Unicode 宽度不一致（tmux 和 xterm 对 emoji、模糊宽度字符的判断不同）导致错位 | 文档写为已知限制；不做补偿 |
| 大量输出时一个窗格拖慢其他窗格 | 整条连接背压是有意的取舍（§4 第 5 条）；如果验收第 10 项不能接受，就改成按窗格暂停（§10） |
| 命令注入 | 只接受类型化动作；ID 用正则校验；自由文本用单引号转义并拒绝控制字符；会话名限定字符集；远端 sh 脚本复用已有的单引号转义写法 |
| 窗格太多，xterm 内存上涨 | 每个连接最多 64 个窗格；每个窗格 scrollback 1000 行，和普通终端相同 |

## 10. 以后可以做（本轮不做）

- 在 PTY 里接管 `tmux -CC`（macOS 本机和 SSH 终端）：把 M0 的 swallow 状态改成接入 `TmuxControlClient`，复用 M1-M4 的全部实现。
- macOS 本机、Windows 经 WSL 附加：给 `TmuxControlManager` 换一个 `spawnControl` 来源（`tmux -C …` 或 `wsl.exe -e tmux -C …`，都走管道）。
- 按窗格流控（`refresh-client -A '%N:pause'`），代替整条连接的背压。
- 快捷键：拆分、切换窗格、新窗口（先查 `keyboard/shortcuts.ts` 有没有冲突，macOS 由原生菜单独占的组合键要绕开）。
- 记住每个工作区上次附加的会话，启动时提示一键恢复。

## 11. 参考

- tmux wiki「Control Mode」：<https://github.com/tmux/tmux/wiki/Control-Mode>
- `tmux.1`（CONTROL MODE、`refresh-client`、FORMATS）：<https://github.com/tmux/tmux/blob/master/tmux.1>
- Windows Terminal 的 tmux 控制模式需求：<https://github.com/microsoft/terminal/issues/3656>；相关 PR：<https://github.com/microsoft/terminal/pull/18928>、<https://github.com/microsoft/terminal/pull/19640>；ConPTY 透传：<https://github.com/microsoft/terminal/issues/1985>
- WezTerm 的 tmux 控制模式 issue：<https://github.com/wezterm/wezterm/issues/336>
