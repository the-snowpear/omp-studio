# OMP Studio 安装与打包

Windows 安装器使用 WebView2 显示 720 × 480 的四步向导，NSIS 负责复制文件、注册安装信息和创建快捷方式。缺少 WebView2 或图形宿主启动失败时，使用完整的 Windows 原生向导。

## Windows 安装行为

- 默认仅为当前账户安装，位置是 `%LOCALAPPDATA%ProgramsOMP Studio`；应用使用 `asInvoker`。
- 全新安装可选目录；更新、修复与降级沿用现有的 `InstallLocation`。同版修复与降级都需要确认，包括原生回退流程。
- 发现目标目录的应用仍运行时，提示先从托盘菜单「退出」，再直接重试。安装器不会强制终止任务，也不会阻止其他目录的 Studio 或 OMP。
- 文件写入期间不能取消；没有承诺或模拟回滚。失败时显示未完成状态，关闭向导后可重新运行安装包。
- 进度百分比来自 NSIS 的原生进度控件；准备阶段没有百分比时显示活动指示。完成页以 NSIS 的完成握手为准。
- 开始菜单快捷方式始终创建；桌面快捷方式全新默认勾选，更新与修复读取现有图标状态，保留用户的选择。
- 完成页可选择运行应用。点击「完成」或标题栏关闭按钮都会应用这一选择，并退出 NSIS 与 WebView2 宿主。
- 旧全机安装迁移仍会单独请求管理员授权，完成 Runtime 与头像迁移后才移除旧安装。

### 目录规则

浏览与输入选择一个文件夹，实际安装根按以下规则解析：

| 选择 | 安装位置 |
|---|---|
| 已是 `OMP Studio` 目录，或已有应用/卸载器 | 原目录；重复的产品后缀收成一层 |
| 盘符根、系统目录、非空普通文件夹 | 添加 `OMP Studio` 子目录 |
| 空目录或尚不存在的路径 | 所选目录本身 |
| 更新、修复、降级 | 上次安装位置 |

对应实现：`scripts/installer-dir.mjs`、`packaging/ui/wizard.js` 与 `packaging/nsis/custom.nsh`。安装执行前检查目标位置能否写入和可用空间，失败时保留可编辑的目录页。

### 数据与卸载

程序目录包含桌面程序、公钥与随包提供的签名 Runtime。活跃 Runtime 位于 `%LOCALAPPDATA%omp-studiountimes`，会话、日志和设置位于 `%APPDATA%omp-studio`；详见 [更新系统](../docs/updates.md)。

真实卸载使用 electron-builder 的原生 MUI2 卸载器：删除程序目录、快捷方式、头像目录和旧版安装目录内的 `userdata`；保留会话、日志及外置 Runtime。升级调用旧卸载器时保留头像与 `userdata`，供迁移使用。

## 文件与预览

| 文件 | 职责 |
|---|---|
| `electron-builder.yml` | 打包布局、当前用户模式、NSIS 配置 |
| `ui/index.html`、`styles.css`、`wizard.js` | 图形向导与明确标记的演示模式 |
| `installer-host/InstallerHost.cs` | WebView2、目录/磁盘读取、安装握手与原生进度读取 |
| `nsis/custom.nsh` | 安装与卸载钩子、原生回退页、完成退出 |
| `installer-shell/` | 本地 Electron 预览，读取本机目录，安装过程为演示 |

直接打开 `ui/index.html`，或运行 `npm --prefix packaging/installer-shell run dev`。浏览器与 Electron 预览显示「演示」；真实 Setup 从宿主读取版本、架构、磁盘和快捷方式状态，不回退到演示数据。

每次图形安装使用当前账户下独立的临时 UI 与 WebView2 缓存，退出时清理；不再向所有 Users 授予共享缓存的写权限。握手文件只属于该次 NSIS 实例，进程等待使用该宿主的句柄。

## Windows 构建与验证

```bash
npm run pack:win
npm run pack:win -- --skip-host --skip-build
npm run pack:win:ui
npm run pack:win:audit
npm run test:tooling
```

构建产物在 `outputs/installer/`：`win-unpacked/` 与 `OMP-Studio-Setup-<version>-windows-<arch>.exe`。一次构建一个架构：`OMP_TARGET_ARCH=x64` 或 `arm64`。ARM64 的小型 WebView2 宿主使用 x86，引导程序通过 Windows API 检查原生 ARM64 进程，界面显示真实目标架构。

`pack:win` 构建工作区和沙箱 preload、准备当前签名 Runtime 与公钥、编译 WebView2 宿主、打包并审计。`--skip-host --skip-build` 仅复用已准备好的构建与签名 Runtime。审计覆盖架构、Runtime 签名、必要资源及私钥泄露；不重复运行源码测试。

普通检查使用 [项目检查入口](../AGENTS.md#验证)。安装回归包含真实 NSIS 函数、目录保留、宿主完成退出、旧版迁移、实际进程范围，以及图形向导的运行中重试、快捷方式选择和失败反馈。

## 发布 Runtime 复用

桌面与六个平台远程环境共用 `.github/scripts/find-runtime.sh`，按已提交的 Runtime 输入和目标平台查找签名工件。桌面界面或安装器变化不重建未变化的 Runtime；缓存命中仍核对来源、平台、通道与签名。工件过期或 Runtime 源码变化时才重建，`rebuild_runtime` 可强制冷构建。

发布流程和完整产物表见 [releasing.md](../docs/releasing.md)。

## macOS（darwin-arm64，ad hoc 签名）

在 Apple Silicon Mac 上，从仓库根目录：

```bash
npm run pack:mac                  # 已有签名 Runtime 工件时：npm run pack:mac -- --skip-host
npm run pack:mac:audit            # 单独重跑审计
```

前置同 `omp:build:host`（Xcode Command Line Tools、Rust、Bun ≥ 1.4.2、原生 arm64 Node），另用到系统自带的 `sips`、`iconutil`、`ditto`、`hdiutil`、`codesign`。产物在 `outputs/installer-mac/`（gitignore）：

- `mac-arm64/OMP Studio.app`：ad hoc 签名的 bundle，审计对象。
- `OMP-Studio-<ver>-macos-arm64.dmg`：首装用，拖进「应用程序」。
- `OMP-Studio-<ver>-macos-arm64.zip`：整包更新载荷。用 `ditto` 打包，符号链接和签名 xattr 都能保留。

要点：

- **配置在代码里派生**：`scripts/mac-bundle.mjs` 读 `electron-builder.yml`、生成 mac 配置，yml 本身不改，Windows 打包输入逐字节不变。根级 `extraFiles`（Runtime 与公钥）改走 `extraResources`，落在 `Contents/Resources/`。`Contents/` 下任何非标准条目都不在签名封印内，bundle 会被判为“已损坏”。
- **签名由 pack-mac 自己做**：用 `@electron/osx-sign` 执行 `codesign --sign -`，不走 electron-builder 的证书查找——它按子串匹配 `-`，在开发机上可能挑中真证书。ad hoc 期间不开 hardened runtime（库验证会拒绝 ad hoc 框架），也不打时间戳。`packaging/mac/entitlements.mac*.plist` 已经嵌入，等换成 Developer ID 签名才生效。
- **Runtime 不重签**：签名时整棵跳过 `Contents/Resources/runtime/**`。`omp` 保留上游构建时的签名与 entitlements，字节由 `checksums.json` 和 Ed25519 签名覆盖，审计会用包内公钥复验。
- **隐私用途字符串**：`Info.plist` 写明麦克风、本地网络、Apple 事件、文稿 / 桌面 / 下载、可移除宗卷与网络宗卷的用途，中文放在 `zh_CN.lproj/InfoPlist.strings`。缺了麦克风说明，首次录音时 TCC 会直接结束进程。
- **首次打开**：ad hoc 包没有公证。macOS 15 起要到“系统设置 › 隐私与安全性”点“仍要打开”，或执行 `xattr -dr com.apple.quarantine "/Applications/OMP Studio.app"`。首启会把 Runtime 从包内复制到 `~/Library/Application Support/omp-studio/runtimes/`，并清除副本继承的 quarantine 标记（`apps/desktop/src/platform/quarantine.ts`）；包本身不动。
- **ad hoc 的代价**：每次更新后签名身份都会变，麦克风、文件夹、本地网络授权会重新询问，钥匙串也会再次请求授权。换成 Developer ID 签名并公证后，这些都会解决。

`scripts/audit-mac.mjs` 任一项不满足即失败：

- Info.plist 键齐全；
- `Contents/` 只含标准条目；
- renderer 与 CSP、入口、preload、托盘模板图都在；
- 恰好一个 Runtime：arm64、`0755`，签名与 checksums 复验通过；
- 只有公钥；
- node-pty 的 `spawn-helper` 可执行，且不带 Windows 预编译；
- `codesign --verify --deep --strict` 和 `hdiutil verify` 通过；
- update zip 用 `ditto -x` 解出后，签名再验一次也通过。
