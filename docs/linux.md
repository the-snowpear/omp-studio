# Linux 客户端（源码预览）

Linux 桌面壳已接入源码预览。当前没有 Linux 桌面安装包，也没有 Linux 桌面的自动更新通道。Release 中的 `omp-studio-remote-*-linux-*.tar.gz` 是 SSH 远程 Host，不能当作桌面客户端安装。

## 开发环境

在有图形会话的 Linux 桌面上准备：

- Node.js 22+ 和 npm（CI 使用 Node 24）、Git。
- Python 3、make、C/C++ 编译器，供 `node-pty` 构建原生终端模块。
- Electron 所需的 GTK、NSS、GBM、ALSA 等系统库；具体包名以发行版为准。
- `xdg-utils`，用于在系统浏览器、文件管理器中打开链接和文件位置。
- GNOME Keyring / libsecret 或 KWallet，供持久化 Hindsight 凭证和服务配置使用；没有系统密钥环时，这些操作会报告安全存储不可用。

Runtime 有 `linux-x64` / `linux-arm64` 构建目标。桌面 CI 首先覆盖 Ubuntu 24.04 x64 的源码检查；ARM64 桌面、其他发行版与 Wayland/X11 图形行为仍需实机验收，不能仅凭 Runtime 已有产物认定桌面可发布。

## 启动界面

```bash
git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git
cd omp-studio
npm ci
npm run omp:overlay:apply
npm run preview
```

启动器使用 npm 安装的 `node_modules/electron/dist/electron`，构建沙箱 preload 并启动 Vite。真实 Runtime 尚未准备好时，界面会显示实际连接状态；可以使用顶栏的预览模式查看演示数据。

使用演示数据启动：

```bash
OMP_PREVIEW_DATA=1 npm run preview
```

源码预览保持 Chromium 沙箱开启。如果 Electron 报 `chrome-sandbox` 的所有者或权限不正确，需要按发行版策略配置它。在允许使用 setuid helper 的开发机上，可在仓库根目录执行：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm run preview
```

重新安装 Electron 后可能需要重新配置 helper。不要用 root 运行整个客户端。启动器不会自动添加 `--no-sandbox`，因为该参数会关闭所有 Chromium 子进程的沙箱，包括内置浏览器打开的网页；见 [Electron 沙箱说明](https://www.electronjs.org/docs/latest/tutorial/sandbox#disabling-chromiums-sandbox-testing-only)。

`OMP_PREVIEW_MODE=production` 在 Linux 上只用于加载已构建的页面，仍使用未打包的 Electron；它不等同于 Linux 安装包验收。

## 连接本机 Runtime

另需 Bun 和 Rust 工具链；版本以 `omp-patch/upstream.json`、vendor 的 `rust-toolchain.toml` 及 [Runtime 开发说明](../omp-patch/README.md) 为准。当前 OMP 18.19.0 使用 Bun 1.4.4。请在与目标架构一致的 Linux 机器上构建。

```bash
npm run omp:install-deps
npm run omp:keys
npm run omp:build:host
npm run preview
```

`omp:keys` 只需在开发机首次运行，会复用已有密钥。`omp:build:host` 生成带签名的本机构建产物，桌面按既有 Runtime 发现、验签和握手链路连接，不以 CLI 文本或终端按键控制 Runtime。

## 路径与桌面行为

| 项目 | Linux 行为 |
|---|---|
| Host 状态根 | `$XDG_CONFIG_HOME/omp-studio`；变量未设、为空或为相对路径时使用 `~/.config/omp-studio` |
| Host 日志 | `<状态根>/logs/host-YYYY-MM-DD.log` |
| 本地签名密钥 | `<状态根>/keys`；构建与启动应使用同一份 XDG 环境 |
| Host 存活证明 / socket | 固定 `/tmp` 下的私有短目录；authority 按 uid 区分，目录权限仍由 socket 服务检查 |
| Runtime、更新暂存 | `<状态根>/runtimes`、`updates-v2`；目录约定不代表已开放 Linux 在线更新 |
| 文件与链接 | 使用 `xdg-open`；界面使用「文件管理器」名称 |
| 终端 | `$SHELL` → 账户 Shell → `/bin/bash`；没有项目时从家目录打开，PTY 失败后的管道模式仍为交互 Shell |
| 关窗 | 主窗口单独存在时走保存／退出确认；有浮窗时可隐藏主窗口，最后一个浮窗关闭后重新显示工作台 |
| 托盘 | 提供菜单，但不把 Tray 对象创建成功当作图标可见；Linux 不自动关闭到托盘 |
| 开发者工具 | 源码预览支持 F12 / Ctrl+Shift+I |
| 凭证与服务配置 | 使用系统密钥环；不接受 Electron 的 `basic_text` 固定密码回退，也不清空已有加密文件 |
| 更新提示 | 可以查看 Release 说明，不会把 Windows Setup 或远程 Host 包作为 Linux 桌面安装器 |

## 正式分发前

需要先确定安装包格式、首发架构与发行版最低版本，再接入打包、Runtime 随包资源、原生 PTY、安装与卸载、发布资产和更新策略。当前 `pack:win` / `pack:mac` 仍只生成对应平台安装包。

实机验收至少覆盖 Wayland / X11、GNOME / KDE、有无托盘扩展、中文输入、文件对话框、剪贴板、内置网页、终端退出与子进程回收，以及一次真实 Runtime 握手和对话。桌面捕获与麦克风还需验证对应发行版的 portal / PipeWire / 权限交互。

开发检查沿用 [唯一检查入口](development.md#everyday-commands)：`npm run check -- --production`。PR #22 的审查与分发缺口见 [审查记录](reviews/pr22-linux-client-2026-11-14.md)。
