# Linux 客户端

Linux x64 的 AppImage 与 deb 已接入打包和发布流程，将随包含本次变更的下一版正式 Release 提供。已发布的 0.2.0 / 0.2.1 没有 Linux 桌面安装包。请以 [Releases](https://github.com/the-snowpear/omp-studio/releases) 中实际列出的附件为准；`omp-studio-remote-*-linux-*.tar.gz` 是 SSH 远程 Host，不能当作桌面客户端安装。

## 首发范围

- x64（Intel / AMD 64 位）。原生构建与安装验收使用 Ubuntu 24.04；最低 glibc 2.39、libstdc++ 13.2。Debian 13 等更新的系统还需具备包内列明的桌面依赖。Ubuntu 22.04、Alpine / musl 不在此构建目标内。
- 两种安装格式：Ubuntu / Debian 推荐 deb；AppImage 用作便携包，需要系统提供 FUSE 2 和可用的非特权用户命名空间。
- 内置签名 OMP Runtime、Electron 和原生 PTY。使用安装包不需要安装 Node、npm、Bun 或 Rust；开发项目本身用到的 Git、编译器和语言工具仍由用户安装。
- Linux 桌面先采用手动升级，Runtime 保留应用内签名更新、兼容性检查和回滚。ARM64 桌面、RPM、Flatpak 与软件源不包含在此次首发中。

## 安装与启动

下载 `OMP-Studio-<版本>-linux-x64.deb` 后，在该文件所在目录执行：

```bash
sudo apt install ./OMP-Studio-*-linux-x64.deb
omp-studio
```

也可以从应用菜单打开 **OMP Studio**。deb 安装到 `/opt/OMP Studio`，注册 `omp-studio.desktop`、图标与 `/usr/bin/omp-studio` 命令。应用以普通用户运行。包的安装脚本沿用 electron-builder 的 Chromium sandbox 和 Ubuntu AppArmor 集成。

使用 AppImage：

```bash
chmod +x ./OMP-Studio-*-linux-x64.AppImage
./OMP-Studio-*-linux-x64.AppImage
```

以上命令假定目录中只有本次下载的一份同格式安装包。AppImage 可移到个人应用目录，再从文件管理器启动。

### AppImage 与沙箱

Ubuntu 24.04 安装 FUSE 2 使用 `sudo apt install libfuse2t64`，Debian 13 使用 `sudo apt install libfuse2t64`。其他发行版按其包管理器安装 libfuse2。缺少 FUSE 时也可用 `--appimage-extract` 解包，然后运行解出的 `squashfs-root/omp-studio`，但仍须满足系统的 Chromium 沙箱要求。

Ubuntu 的 AppArmor 可能限制从任意下载位置启动的 AppImage 创建用户命名空间；这是与安装到固定位置的 deb 不同的系统策略。遇到 `No usable sandbox` 或 `Operation not permitted`，Ubuntu / Debian 用户请使用 deb。管理员自定义 AppImage 策略时应只授权可信应用的固定路径。安装器和启动脚本不会添加 `--no-sandbox`，也不会修改全局 userns / AppArmor 开关。不要以 root 运行客户端。

## 更新与卸载

「设置 → 更新与维护」从 `updates-linux-x64.json` 验签获取可用版本。AppImage 用户看到 AppImage 下载按钮，deb 用户看到 deb 下载按钮；下载完成后先退出 Studio，再替换 AppImage 或用上述 apt 命令安装新版 deb。桌面自动下载开关在 Linux 上只影响可在线安装的 Runtime，不会在后台下载或替换系统安装包。

Runtime 更新仍按平台、通道、最低桌面版本和 Bridge 协议匹配。如果 Runtime 需要新版桌面，会先提示升级桌面，不下载不兼容组合。全新安装和桌面升级都可从包内验签、复制并激活 Runtime，安装过程不需要联网下载运行时。

卸载 deb：

```bash
sudo apt remove omp-studio
```

AppImage 退出后删除该文件即可。两种方式都保留用户配置、会话、日志和活跃 Runtime；不删除用户项目。需要恢复旧桌面时，从历史 Release 下载对应的完整安装包。

## 开发环境

在有图形会话的 Linux 桌面上准备：

- Node.js 22+ 和 npm（CI 使用 Node 24）、Git。
- Python 3、make、C/C++ 编译器，供 `node-pty` 构建原生终端模块。
- Electron 所需的 GTK、NSS、GBM、ALSA 等系统库；具体包名以发行版为准。
- `xdg-utils`，用于在系统浏览器、文件管理器中打开链接和文件位置。
- GNOME Keyring / libsecret 或 KWallet，供持久化 Hindsight 凭证和服务配置使用；没有系统密钥环时，这些操作会报告安全存储不可用。

Runtime 有 `linux-x64` / `linux-arm64` 构建目标；桌面打包目前只接受原生 Linux x64 构建机。不要用跨平台编译或 Windows 的 node_modules 打包 Linux 原生模块。

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
| Runtime、更新暂存 | `<状态根>/runtimes`、`updates-v2`；安装包之外的用户可写目录 |
| 文件与链接 | 使用 `xdg-open`；界面使用「文件管理器」名称 |
| 终端 | `$SHELL` → 账户 Shell → `/bin/bash`；没有项目时从家目录打开，PTY 失败后的管道模式仍为交互 Shell |
| 关窗 | 主窗口单独存在时走保存／退出确认；有浮窗时可隐藏主窗口，最后一个浮窗关闭后重新显示工作台 |
| 托盘 | 提供菜单，但不把 Tray 对象创建成功当作图标可见；Linux 不自动关闭到托盘 |
| 开发者工具 | 源码预览支持 F12 / Ctrl+Shift+I |
| 凭证与服务配置 | 使用系统密钥环；不接受 Electron 的 `basic_text` 固定密码回退，也不清空已有加密文件 |
| 更新提示 | 签名 Linux 清单；AppImage / deb 手动升级，Runtime 可在线更新；不选 Windows Setup 或 SSH Host 包 |

## 构建安装包

先按上文准备原生 Runtime 构建工具，并安装 `desktop-file-utils` 与 FUSE 2。开发打包使用本机临时签名身份：

```bash
npm ci
npm run omp:overlay:apply
npm run omp:keys
keys="${XDG_CONFIG_HOME:-$HOME/.config}/omp-studio/keys"
export OMP_RUNTIME_TRUSTED_PUBLIC_KEY="$keys/trusted-public.pem"
export OMP_RUNTIME_SIGNING_KEY_ID="$(tr -d '[:space:]' < "$keys/key-id.txt")"
npm run pack:linux
```

产物在 `outputs/installer-linux/`：`linux-unpacked/`、`OMP-Studio-<版本>-linux-x64.AppImage` 与 `OMP-Studio-<版本>-linux-x64.deb`。`--skip-host --skip-build` 可复用已准备的 Runtime 和工作区产物；`npm run pack:linux:audit` 单独审计。正式 Release 使用仓库已有的发布密钥，不使用上述开发密钥。

审计分别解开 AppImage 和 deb，检查 ELF 架构、glibc 要求、桌面入口、沙箱、Renderer / preload、原生 PTY，以及包内 Runtime 的执行权限、签名与摘要。Runtime 和公钥放在 `resources/runtime/versions` 与 `resources/runtime-keys`，不放进 ASAR。

## 验证与发布

普通 CI 执行 Windows / Linux 源码检查。手动 CI 的 `linux-package` 额外构建、审计两种安装包，并运行 X11 AppImage / deb、Wayland deb、真实 Runtime 握手、原生终端、会话重启与安装 / 卸载数据保留验收。对话使用本机 OpenAI 兼容测试端点驱动真实 Runtime 和文件读取工具，不使用外部模型账户或假 Host。产物使用测试密钥，不能作为正式 Release 附件。

自动化中的中文输入检查覆盖 Chromium composition 事件；实体 IBus / Fcitx、GNOME / KDE 的窗口策略、屏幕共享 portal / PipeWire、麦克风与系统密钥环仍按目标桌面实机验证。能力是否可用由真实 Runtime 探测报告，不因安装包生成成功而伪造能力。

Release 默认包含 Linux x64，任一选中平台的构建 / 包审计失败会阻止整次发布。版本号须晚于已发布版本，不能重用 0.2.0 / 0.2.1 的 tag。详细流程见 [发布指南](releasing.md)。

开发检查沿用 [唯一检查入口](development.md#everyday-commands)：`npm run check -- --production`。PR #22 的审查与分发缺口见 [审查记录](reviews/pr22-linux-client-2026-11-14.md)。
