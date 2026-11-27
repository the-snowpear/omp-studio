# Web 工作台 / Web workbench

## 中文

Web 工作台在 Windows、macOS 和 Linux 上运行，可以在本机浏览器或局域网里的电脑、平板、手机中使用。桌面程序和浏览器连接同一个 Host，共用该系统账户的项目、会话、模型配置与终端。关闭桌面窗口或退出桌面程序后，Host 继续运行。

### 启动

从 GitHub Release 下载与你的系统和架构匹配的 `omp-studio-remote-<版本>-<平台>` 运行环境包并解压。其中包含私有 Node、签名 Runtime、Web 页面和终端模块。

Windows 执行 `omp-studio-web.cmd start`。macOS / Linux 执行 `./omp-studio-web start`。服务默认监听 `http://127.0.0.1:8560`。运行 `status` 可以查询正在运行的服务地址。

从源码运行时，先执行 `npm ci`、`npm run omp:overlay:apply`、`npm run build`，再执行以下命令。

```bash
npm run web -- start --renderer apps/renderer/dist
npm run web -- pair
```

配对码有效期为 60 秒。打开命令输出的链接，在页面确认授权范围后点击配对。设备授权保存在浏览器的 HttpOnly Cookie 中，可跨刷新和 Host 重启恢复，有效期上限为 400 天。清除浏览器站点数据后需重新配对。

### 局域网和设备管理

在 **设置 → 常规与通知 → Web 访问** 中点击 **管理 Web 访问**，选择主机的局域网地址，导出 CA 证书。通过可信方式将证书传到自己的设备，核对界面中的 SHA-256 指纹，在系统或浏览器中安装并信任。之后使用界面生成的 HTTPS 配对链接。

**显示 Web 控制条** 默认关闭；开启后，控制条默认停靠在工作台下方并保留独立空间，不遮挡审批或输入区。拖动左侧手柄或状态文字可在窗口内自由移动，位置保存在当前设备上；缩小窗口时会保持在可见范围内。点击控制条的停靠按钮，或在设置中选择「回到底部」，可恢复底部停靠。手柄也支持方向键移动（Shift 加速）和 Home 键回到底部。可直接点击关闭按钮隐藏，设备管理和接管入口仍可从设置中打开。

无桌面环境可以通过命令行完成同一流程。

```bash
./omp-studio-web listen --ip 192.168.1.20
./omp-studio-web certificate OMP-Studio-CA.cer
./omp-studio-web pair
./omp-studio-web devices
./omp-studio-web revoke <device-id>
```

`listen` 不带 `--ip` 会关闭局域网监听。本机入口继续可用。局域网地址变化后重新选择地址、导出并信任更新后的证书。设备列表支持重命名与单独撤销，撤销会断开该设备的事件流并释放其视图。

### 使用项目和控制权

点击“打开本地文件夹”时，Web 页面要求输入 **Host 机器上的绝对目录路径**。也可以运行 `omp-studio-web project <绝对路径>` 登记项目。模型配置页面操作 Host 的模型设置，API Key 和模型请求保留在 Host 侧。OAuth 登录生成链接后，工作台提供“完成登录”入口，供应商支持情况仍由现有 Runtime 决定。

所有已配对设备可以查看已登记项目。点击 **接管** 后，该设备可以发送消息、处理审批、修改文件、执行 Git 操作及输入终端命令。另一端接管时，当前页面保留草稿并切换为查看状态。已有任务继续执行。断线恢复会重新订阅并读取状态，结果未知的写操作需要先核对结果。

控制权按已配对的浏览器设备分配，同一浏览器配置中的标签页共用设备授权和控制权。不同设备可以分别选择项目和对话。

终端在 Host 的系统账户下运行，具有该账户的文件和进程权限。关闭页面保留 Shell，终端中的关闭操作结束 Shell。换设备后可附加到原终端，回放保存最近约 3 MiB 的文本，超出时显示提示。Host 退出或机器重启后需重新创建 Shell。

桌面上的原生窗口、文件管理器和图形接管使用桌面服务。Web 首版操作 Host 本机项目。已有“手机访问”仍使用其单项目、8 小时授权，完整工作台需要单独配对。

服务面板支持直接启动和管理服务，已保存的加密服务配置仍由桌面程序管理。Hindsight 的桌面加密令牌会同步到正在运行的 Host 内存，独立重启 Host 后需要重新打开桌面同步。无桌面环境可在启动 Host 前配置原生 `HINDSIGHT_API_URL` 和 `HINDSIGHT_API_TOKEN` 环境变量。模型账户、Provider 和原生 Runtime 配置继续使用 Host 的原有存储。

“手机访问”配对成功时取得独立控制权。桌面或完整 Web 工作台接管后，旧手机页面的写操作会被拒绝，重新配对可以再次取得控制权。

### 停止和升级

`omp-studio-web stop` 在任务、审批或终端仍活动时提示处理。明确需要终止这些活动时使用 `stop --force`。升级时先结束活动并停止 Host，再解压新运行环境包并启动。用户数据位于原有 Studio 配置目录，运行环境包可单独替换。桌面发现运行中的 Host 版本不匹配时会提示停止旧服务后重开。

Host 日志沿用 Studio 的 `logs/host-YYYY-MM-DD.log`，服务启动日志为同目录下的 `shared-host.log`。只托管 `apps/renderer/dist` 的静态服务器无法启动 Host 或提供工作区数据，需要通过上述入口运行。

### 验证范围（2026-11-24）

- Windows x64 完成独立 Host 启动、桌面冷启动与退出、退出后同一 Shell 保活、Web 配对与控制权转移、撤销设备及 Host 重启后的设备恢复。
- Chrome 完成真实 Runtime `19.0.1-studio.1` 流式回复、Host PTY 输入与回放、文件保存、Git 暂存与提交、统计页、中英文往返切换、断网恢复保留草稿，以及 390 × 844 窄屏检查。模型请求使用本机测试 Provider。
- 局域网 HTTPS 测试验证导出 CA、TLS 校验及 Secure Cookie。Windows 独立运行环境完成资源组装与 PTY 启动检查。
- `npm run check -- --production` 和 `npm run test:tooling` 通过，最终界面与控制权修正另行通过对应切片回归。
- macOS、Linux、Windows ARM64 和真实移动设备的安装与运行验收仍需对应平台完成。六目标打包路径已接入，当前记录覆盖本机 Windows x64。

## English

The Web workbench runs on Windows, macOS and Linux. Desktop and browser clients connect to one Host and share the system account's projects, conversations, model configuration and terminals. The Host continues running after the desktop app exits.

Download and extract the matching `omp-studio-remote-<version>-<platform>` release environment. It includes private Node, a signed Runtime, the workbench and the terminal module. Run `omp-studio-web.cmd start` on Windows or `./omp-studio-web start` on macOS / Linux. The default local address is `http://127.0.0.1:8560`. Run `status` to inspect the active address and `pair` to generate a link valid for 60 seconds.

For source development, run `npm ci`, `npm run omp:overlay:apply`, and `npm run build`, followed by `npm run web -- start --renderer apps/renderer/dist` and `npm run web -- pair`.

For LAN access, open **Settings → General and notifications → Web access → Manage Web access**, select a local network address, and export the CA certificate. Transfer it through a trusted channel, verify its SHA-256 fingerprint, and trust it on the other device. Open the HTTPS pairing link to authorize that browser. The CLI equivalents are `listen --ip <address>`, `certificate <output.cer>` and `pair`. Run `listen` without an IP to disable LAN access. An address change requires exporting and trusting the updated certificate.

**Show Web control bar** is off by default. When enabled, the bar docks below the workbench with its own space, keeping approvals and message input accessible. Drag the left handle or the status text to move it freely within the window; its position is saved on this device and kept in view when the window shrinks. Use the bar’s dock button or **Dock at bottom** in Settings to restore the docked layout. The handle also supports arrow keys to move (Shift for larger steps) and Home to dock. Its close button hides the bar; device management and takeover remain available in Settings.

Browser authorization uses an HttpOnly Cookie, survives refresh and Host restart, and lasts up to 400 days. Clearing browser site data requires pairing again. List devices with `devices`, rename them in the workbench, or run `revoke <device-id>` to disconnect a device. Each device can view registered projects. **Take control** transfers message sending, approvals, file and Git changes, and terminal input to that device. Existing tasks continue and drafts stay on the previous device.

Control belongs to the paired browser device. Tabs in the same browser profile share authorization and control. Different devices can select their own projects and conversations.

Opening a project in the browser asks for its absolute path **on the Host machine**. The CLI also supports `project <absolute-path>`. Configure models through the existing model settings. Credentials and model requests are handled by the Host. For supported OAuth providers, use the **Complete sign-in** link produced by the existing login flow.

Terminals run as the Host's system account with that account's filesystem and process permissions. Closing a page retains the Shell. Closing the terminal ends it. Another device can attach to the same terminal with a replay of approximately 3 MiB of recent text. Truncated replay is indicated. Host or machine restart requires creating a new Shell. Browser workspaces use this Host's local projects. Desktop native views and graphical control use desktop services. The existing mobile-only access retains its separate project scope and eight-hour authorization.

The Services panel can start and manage services directly. Saved encrypted service definitions are managed by the desktop app. Desktop-encrypted Hindsight credentials are synchronized into the running Host's memory. After restarting a standalone Host, open the desktop app to synchronize them again, or configure the native `HINDSIGHT_API_URL` and `HINDSIGHT_API_TOKEN` environment variables before starting the Host. Model accounts, providers and native Runtime configuration use the Host's existing storage.

A successful mobile-only pairing takes its own control identity. A later desktop or Web takeover rejects that phone's writes. Pairing the phone again takes control back.

`stop` asks you to finish active tasks, approvals and terminals. Use `stop --force` when you intend to terminate them. For an upgrade, stop the Host, replace the extracted environment, and start it again. Project and conversation data remains in Studio's existing configuration directory. A desktop/Host version mismatch asks you to stop the old Host before reopening Studio.

Diagnostics use `logs/host-YYYY-MM-DD.log` and `logs/shared-host.log` in the Studio state directory. Serving `apps/renderer/dist` alone does not start the Host or supply workspace data.

### Verification coverage, 2026-11-24

Windows x64 verification covered standalone startup, cold desktop startup and exit with a surviving Shell, pairing, takeover, revocation and remembered devices after a Host restart. Chrome verification covered Runtime `19.0.1-studio.1` streaming through a local test provider, PTY input and replay, file saves, Git staging and commits, the statistics dashboard, mounted Chinese/English switching, reconnecting with an unsent draft, and a 390 × 844 viewport. LAN tests verified the exported CA, TLS validation and Secure cookies. Windows environment staging started its PTY successfully.

`npm run check -- --production` and `npm run test:tooling` passed. Subsequent UI and control changes passed their scoped regressions. Installation and live execution on macOS, Linux, Windows ARM64 and physical mobile devices require those platforms. Packaging is wired for all six Host targets, with local execution evidence covering Windows x64.
