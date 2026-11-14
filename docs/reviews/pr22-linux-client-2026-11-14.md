# PR #22：Linux 客户端接入审查

日期：2026-11-14。

结论：[#22](https://github.com/the-snowpear/omp-studio/pull/22) 可以作为 Linux 源码客户端的起点，但原补丁不能直接视为 Linux 正式发行支持。本次在当前 `0.2.0` 的独立工作树中移植原提交并补齐启动、退出、路径和验证方面的问题；桌面安装包与在线更新仍需另定首发范围。

## 基线与恢复

- 审查原提交：`cfdf45ba1ae1f95b9ecc19afd3a14f637925de7c`，作者 oliclice；保留作者信息 cherry-pick 为 `ea7b3cc`。
- 独立工作分支：`codex/linux-client`，以当前 `0.2.0` 的已提交代码为起点。
- 起点／恢复引用：`codex/linux-client-base` → `6c2be11`。原工作树的未提交文件与 vendor 不参与本次实现。
- 处理了 `CHANGELOG.md` 和 `scripts/preview.mjs` 的移植冲突，保留当前 OMP 18.19.0、演示数据启动参数及生产预览的 CDP 重载逻辑。
- PR 描述中的 Fedora 44 / Wayland 实测针对 OMP 18.13.2；这是作者的已有证据，不是本次 OMP 18.19.0 的 Linux 实机验收。

## 已修复的问题

| 级别 | 原补丁的问题与影响 | 本次处理 |
|---|---|---|
| P1 | Linux 的 Tray 构造成功不代表图标可见。Electron 可以在 D-Bus、GTK 初始化失败后静默降级；原补丁仍设置关闭到托盘，导致没有托盘宿主的桌面关窗后失去入口。 | Linux 主窗口关闭走保存／退出确认；保留多窗口工作流，最后一个浮窗关闭时恢复隐藏的主窗口。托盘构造异常只在 Linux 降级。 |
| P1 | Linux 预览无条件追加 `--no-sandbox`，会取消所有 Chromium 子进程的操作系统沙箱，包含内置网页，而非只解决开发机 helper 权限。 | 去掉自动关闭沙箱，提供针对 Electron sandbox helper 的启动说明。 |
| P1 | Linux 默认 `/tmp` 是全系统共享目录，而原 authority scope 固定为 `authority`。第一位用户创建目录后，其他 uid 会被既有权限检查拒绝。自定义 `TMPDIR` 还可能使两个进程检查不同的存活证明。 | Linux authority scope 带当前 uid；桌面 socket 根固定 `/tmp`。沿用已有服务的 0700、所有者和陈旧 socket 检查。 |
| P2 | `XDG_CONFIG_HOME ?? ...` 把空字符串或相对路径当成配置根，导致 profile 不是绝对路径，或把本地签名私钥写入工作目录。 | Desktop 与签名脚本都遵循 XDG 的绝对路径规则；空／相对值回退家目录，增加跨平台路径一致性回归。 |
| P2 | 旧更新检查把所有非 macOS 平台交给 Windows `.exe` 选择器。Linux 会得到错误的 Setup 下载链接。 | 按平台显式选安装器。Linux 仍可查看版本说明，但不提供其他平台安装包或 SSH Host 包。 |
| P2 | Linux 管道终端缺少交互参数；无 `$SHELL` 时未读取账户 Shell；GUI 启动无工作区时可能把终端放在 `/`。 | Linux 使用 `$SHELL` → 账户 Shell → bash，管道回退使用 `-i`，无工作区从家目录打开；POSIX 终端剔除 Electron 控制变量。 |
| 验证缺口 | 原 PR CI 只有 Windows 成功，macOS 被跳过；新增 Linux 分支也没有进入默认核心回归名单。 | CI 增加 Ubuntu 24.04 x64，核心回归加入平台路径、存活证明、关窗、终端与安装包选择；`full` 增加 Linux Runtime／工具测试。 |

同时补齐 Linux 的 F12 / Ctrl+Shift+I 开发工具入口与「文件管理器」中英文文案。文案复用现有真实／预览页面，没有新增 mock 数据或 Bridge 操作。

托盘行为依据：[Electron 43.8.8 `TrayIconLinux::OnImplInitializationFailed`](https://github.com/electron/electron/blob/v43.8.8/shell/browser/ui/tray_icon_linux.cc)；沙箱依据：[Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox#disabling-chromiums-sandbox-testing-only)；XDG 依据：[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)。

已核对 Linux 密钥环行为，未另加平台校验：当前同步 safeStorage API 通过 `isEncryptionAvailable()` 拒绝无密钥环的默认状态，固定密码回退需要显式调用 `setUsePlainTextEncryption(true)`，项目没有该调用。服务配置与 Hindsight 凭证已检查可用性。依据：[Electron 43.8.8 实现](https://github.com/electron/electron/blob/v43.8.8/shell/browser/api/electron_api_safe_storage.cc)、[默认关闭回退的成员定义](https://github.com/electron/electron/blob/v43.8.8/shell/browser/api/electron_api_safe_storage.h)、[显式开启回退的上游测试](https://github.com/electron/electron/blob/v43.8.8/spec/api-safe-storage.spec.ts)。实机仍需验证 GNOME Keyring / KWallet 的授权体验。

主要实现入口：[`desktop-paths.ts`](../../apps/desktop/src/platform/desktop-paths.ts)、[`host-factory.ts`](../../apps/desktop/src/host-factory.ts)、[`app-lifecycle.ts`](../../apps/desktop/src/platform/app-lifecycle.ts)、[`floating-windows.ts`](../../apps/desktop/src/floating-windows.ts)、[`terminal-pty.ts`](../../apps/desktop/src/terminal-pty.ts)、[`chrome-app-update.ts`](../../apps/desktop/src/chrome-app-update.ts)、[`preview.mjs`](../../scripts/preview.mjs)。

## 正式 Linux 包仍缺什么

| 工作 | 现状和下一步落点 |
|---|---|
| 首发范围 | 需要确定发行版最低版本、x64／ARM64、AppImage／deb／rpm。建议第一批为 x64 的 AppImage + deb，ARM64 以独立实机验收为门槛；此处仅为建议，未写入发布流程。 |
| 打包入口 | 目前只有 `pack:win` / `pack:mac`。需要 `pack:linux`、Linux builder 配置、`.desktop`／图标、沙箱与权限处理，以及匹配 Electron ABI 的 node-pty。 |
| 随包 Runtime | `prepare-installer-resources.mjs` 仍把非 darwin 目标归为 Windows；应改为真实目标平台，再接 `resources/runtime/versions` 与公钥。已有 Linux remote 包不能代替此项。 |
| 发布与审计 | `release.yml`、`release-plan.mjs`、资产命名与发布说明目前没有 Linux 桌面工件。需要原生 Linux 打包与 ELF 架构、Runtime 签名、权限及必需文件审计。 |
| 更新策略 | `runtime-platform.ts` 与 `target-platform.mjs` 的更新平台只含 Windows／macOS；Main 也未创建 Linux 更新协调器。deb/rpm 应由包管理器维护，AppImage 可另选应用内更新；不能只把 Linux 加入 allowlist。建议首包先明确手动更新，再接专用安装／回退流程。 |
| 实机验收 | Wayland/X11、GNOME/KDE、有无托盘、中文输入、多窗口、终端、文件管理器、系统密钥存储、麦克风／portal、内置网页及 OMP 18.19.0 的真实握手／对话。 |

没有新增平台包来复制 Darwin 实现：现有类通过注入提供 POSIX 能力，保留包名以控制迁移范围；平台差异仍在 Desktop 组合层。

## 验证记录

执行环境为 Windows、Node 24.13.0。依赖和已应用 overlay 的 vendor 均在本工作树独立准备。

- `npm run check -- --production`：通过，280.2 秒；架构／选择器／动效规则、全工作区类型编译、核心回归、Renderer／preload／远程 Host 生产构建。随后新增的 socket 修复另做桌面切片回归。
- `npm run check -- --only desktop`：通过，52.5 秒；包含 socket 修复后的桌面核心回归。
- `npm run test:tooling`：通过，124 / 124 项；测试部分 37.2 秒。首次运行有两项因新工作树缺少 `pi_natives` 而失败，独立安装 vendor 依赖并完成 `npm run omp:build:natives` 后，全套重跑通过；未修改 Runtime 源码或跳过失败项。
- CI YAML 与两个 matrix 的解析检查通过：默认 Windows / Linux，`full` 为 Windows / macOS / Linux。
- `git diff --check` 与新增文档的 11 处本地链接检查通过。
- Linux 专属 socket 进程测试会在 Linux 执行；Windows 上按平台跳过。
- Linux CI 配置已加入，但本地没有触发远端工作流；未在当前 Windows 机器上声称完成 Linux GUI、安装包或真实 Runtime 验收。

使用步骤见 [`docs/linux.md`](../linux.md)。
