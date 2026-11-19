# WSL 工作区实机验证

## 2026-11-20 · 第 0 阶段

Windows 11 x64（10.0.26300.9974），WSL 2.7.10.0，内核 6.18.33.2-2。初始只有 Docker Desktop 的内部发行版 `docker-desktop`。经用户确认安装了 `Ubuntu-24.04`，`wsl.exe -l -v` 确认版本为 2。原默认发行版仍为 `docker-desktop`。Spike 未指定 Linux 用户，Ubuntu 新装后尚未完成交互式账户初始化，此时发行版默认 UID 为 0。

### 发行版发现

一次性 Node 脚本直接调用系统的 `wsl.exe`，按原始字节读取 stdout 和 stderr。下列四次调用的退出码均为 0，stderr 均为空。

| 命令 | 未设置 `WSL_UTF8` | 设置 `WSL_UTF8=1` |
|---|---|---|
| `wsl.exe -l -v` | 168 字节，UTF-16LE，无 BOM | 84 字节，与左侧解码后的 ASCII 文本一致 |
| `wsl.exe -l --running -q` | stdout 为 0 字节 | stdout 为 0 字节 |

两次详细列表的表头均为英文 `NAME / STATE / VERSION`，默认发行版前有 `*`。安装 Ubuntu 后详细列表分别为 246 和 123 字节。Ubuntu 运行时，运行列表分别为 28 和 14 字节，解码后均只有 `Ubuntu-24.04` 和换行。

请求不存在的发行版时，Node 取得退出码 4294967295。WSL 把中文诊断和 `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` 写入 stdout，stderr 为空。不开 UTF-8 时为 116 字节的 UTF-16LE，开启后为 94 字节的 UTF-8。未安装 WSL 和完全没有注册项两种状态经用户同意，留给干净的 Windows 环境补验。

### 命令、数据和 Host

| 实测项 | 观测结果 |
|---|---|
| 命令参数 | 直接使用计划指定的 Node `spawn`、argv 和 base64 启动脚本，stdout 与预期 UTF-8 字节完全相同，引号、字面量 `$HOME`、中文、空格和尾随分隔符均保留。 |
| 二进制 stdin | 52,428,800 字节随机数据写入发行版临时文件。Windows 和 Ubuntu 的 SHA-256 均为 `7f9e6a343e0e16abb50005e28d82a395ad4aad6268a58f957c0c49f4ec49f486`。 |
| Host 生命周期 | 使用仓库构建的真实 Headless Host、校验过的 Linux Node 24.17.0 和独立状态目录。`start` 的 wsl.exe 退出后，attach 连续 30.1 秒收到同一 Host 的 6 次 ping 响应。所有 attach 退出后仅在 Windows 枚举运行状态，180.6 秒后再次连接仍复用了原实例。本次取得的是存活时长下限。 |
| 关停与重新连接 | 确认 Ubuntu 是唯一运行的发行版后执行 `wsl --shutdown`，attach 在 1.75 秒内以退出码 1 结束。stderr 仅有启动时已出现的 localhost 代理提示。再次握手得到协议错误码 `host-unavailable`。显式执行 `start` 并再次握手，已确认实例 ID 改变。 |
| ConPTY | 通过仓库的 node-pty 打开交互式 Bash。`stty size` 从 26 行 90 列变为 37 行 115 列，Ctrl-C 中断 `sleep 60`，Shell 报告状态码 130，然后正常退出。 |
| UNC | Electron Main 的 `fs.realpath` 和 `fs.stat` 成功读取 `\\wsl.localhost\Ubuntu-24.04` 下的测试文件，`shell.openPath` 成功。调用 `shell.showItemInFolder` 后从资源管理器读回了已选中文件的完整 UNC 路径。 |
| VS Code | 在独立的 VS Code 1.146.0 配置中安装官方 WSL 扩展 1.104.7，直接用 `Code.exe --remote wsl+Ubuntu-24.04 <Linux 项目路径>` 打开。窗口标题带有 `project [WSL: Ubuntu-24.04]`，工作区 URI 对应正确的 Linux 目录。首次下载 Server 后，远程解析器在 160 秒后返回 WebSocket，客户端收到服务端的重连宽限配置。 |

## Studio 集成验收

使用工作区编译的桌面端、Renderer 和正式签名的 Linux x64 运行包 v0.2.4。发行包来自项目 Release，安装器校验签名与摘要；本机临时目录和 WSL 临时工作区保存测试数据。

| 场景 | 结果 |
|---|---|
| 桌面入口 | 真实 Electron 菜单列出 Ubuntu-24.04，未列出 Docker。保持菜单挂载执行中文 → 英文 → 中文，状态随语言切换。首次点击后出现「准备 WSL 工作区」，目标为 Ubuntu-24.04 · Linux · x64。 |
| 预览与目录 | Playwright 验证选中 Debian 后按钮显示 `WSL · Debian`，`marks=on/off` 分别显示和隐藏演示标记。组件测试覆盖不调用真实发现或连接、切换语言时保留 `/mnt/c/test` 输入和显示 Windows 磁盘提示。 |
| 安装、Git 与终端 | 桌面连接管理器完成体检、确认、上传、校验、Runtime 激活、握手与目录登记。Host 的 `git.repository.get` 识别出 Ubuntu 中创建的测试仓库。通过 RemoteTerminalManager 启动的终端标签为 `WSL · Ubuntu-24.04`，Shell 报告 Linux、35 行 101 列，Ctrl-C 返回 130。 |
| 会话、工具和凭据 | 本机使用模拟凭据代理，测试模型在 Ubuntu 回环地址提供流式回复。通过真实联网通道轮换测试 API Key 后，新建会话成功，模型端收到带新 Key 的请求。Agent 调用 Bash 执行 `uname -s` 和 `command -v python3`，模拟模型收到 Linux 工具结果，会话记录包含最终回复。未使用真实模型账号。 |
| 自动恢复 | 已连接状态执行 `wsl --shutdown`，管理器进入 recovering，验证已安装环境并重启 Host。连接代次从 1 变为 2，`hostRestarted` 为真。草稿保留由 Renderer 恢复回归覆盖。 |
| SSH | 运行既有连接、传输、认证、终端、部署、tmux、编辑器与模型同步测试，使用隔离夹具。没有登录用户配置的 SSH 服务器。 |

验证命令 `npm run check -- --fast`、`npm run check -- --only desktop` 和 `npm run check -- --only renderer` 均通过。WSL、恢复、模型同步和文件 IPC 专项 43 项通过；工作位置与语言专项 19 项通过。SSH 等远程相关专项 97 项通过，1 项既有 Bun 代理用例跳过。以上名单有重叠。

两个待补的环境场景为干净 Windows 上未安装 WSL，以及已安装 WSL 但完全没有注册任何发行版。
