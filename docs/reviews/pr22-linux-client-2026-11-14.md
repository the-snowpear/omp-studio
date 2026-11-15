# PR #22：Linux 客户端接入审查

初次审查：2026-11-14；发布准备更新：2026-11-15。

结论：[#22](https://github.com/the-snowpear/omp-studio/pull/22) 及后续补齐工作已合入并推送到 `0.2.0`，PR 已标记合并。独立工作树中补齐了 AppImage / deb、签名 Runtime、Linux 更新目录、发布资产校验与安装验收流程，并与目标分支新加入的英语本地化和文件浏览器整合。首发范围和使用限制以 [Linux 客户端说明](../linux.md) 为准；测试包与正式 Release 使用不同的签名身份。

## 基线与恢复

- 审查原提交：`cfdf45ba1ae1f95b9ecc19afd3a14f637925de7c`，作者 oliclice；保留作者信息 cherry-pick 为 `ea7b3cc`。
- 独立工作分支：`codex/linux-client`，以当前 `0.2.0` 的已提交代码为起点。
- 起点／恢复引用：`codex/linux-client-base` → `6c2be11`。整合时先保存原工作树的未提交文件，再恢复其改动与官网删除计划；vendor 工作区保持原状。官网重构草稿的新入口同步补上 Linux 下载展示。
- 处理了 `CHANGELOG.md` 和 `scripts/preview.mjs` 的移植冲突，保留当前 OMP 18.19.0、演示数据启动参数及生产预览的 CDP 重载逻辑。
- PR 描述中的 Fedora 44 / Wayland 实测针对 OMP 18.13.2；这是作者的已有证据，不是本次 OMP 18.19.0 的 Linux 实机验收。

## 已修复的问题

| 级别 | 原补丁的问题与影响 | 本次处理 |
|---|---|---|
| P1 | Linux 的 Tray 构造成功不代表图标可见。Electron 可以在 D-Bus、GTK 初始化失败后静默降级；原补丁仍设置关闭到托盘，导致没有托盘宿主的桌面关窗后失去入口。 | Linux 主窗口关闭走保存／退出确认；保留多窗口工作流，最后一个浮窗关闭时恢复隐藏的主窗口。托盘构造异常只在 Linux 降级。 |
| P1 | Linux 预览无条件追加 `--no-sandbox`，会取消所有 Chromium 子进程的操作系统沙箱，包含内置网页，而非只解决开发机 helper 权限。 | 去掉自动关闭沙箱，提供针对 Electron sandbox helper 的启动说明。 |
| P1 | Linux 默认 `/tmp` 是全系统共享目录，而原 authority scope 固定为 `authority`。第一位用户创建目录后，其他 uid 会被既有权限检查拒绝。自定义 `TMPDIR` 还可能使两个进程检查不同的存活证明。 | Linux authority scope 带当前 uid；桌面 socket 根固定 `/tmp`。沿用已有服务的 0700、所有者和陈旧 socket 检查。 |
| P2 | `XDG_CONFIG_HOME ?? ...` 把空字符串或相对路径当成配置根，导致 profile 不是绝对路径，或把本地签名私钥写入工作目录。 | Desktop 与签名脚本都遵循 XDG 的绝对路径规则；空／相对值回退家目录，增加跨平台路径一致性回归。 |
| P2 | 旧更新检查把所有非 macOS 平台交给 Windows `.exe` 选择器。Linux 会得到错误的 Setup 下载链接。 | 按平台显式选安装器。Linux 从签名目录提供 AppImage / deb 下载，桌面手动升级，Runtime 保留签名在线更新。 |
| P2 | Linux 管道终端缺少交互参数；无 `$SHELL` 时未读取账户 Shell；GUI 启动无工作区时可能把终端放在 `/`。 | Linux 使用 `$SHELL` → 账户 Shell → bash，管道回退使用 `-i`，无工作区从家目录打开；POSIX 终端剔除 Electron 控制变量。 |
| 验证缺口 | 原 PR CI 只有 Windows 成功，macOS 被跳过；新增 Linux 分支也没有进入默认核心回归名单。 | CI 增加 Ubuntu 24.04 x64，核心回归加入平台路径、存活证明、关窗、终端与安装包选择；`full` 增加 Linux Runtime／工具测试。 |

同时补齐 Linux 的 F12 / Ctrl+Shift+I 开发工具入口与「文件管理器」中英文文案。文案复用现有真实／预览页面，没有新增 mock 数据或 Bridge 操作。

托盘行为依据：[Electron 43.8.8 `TrayIconLinux::OnImplInitializationFailed`](https://github.com/electron/electron/blob/v43.8.8/shell/browser/ui/tray_icon_linux.cc)；沙箱依据：[Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox#disabling-chromiums-sandbox-testing-only)；XDG 依据：[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)。

已核对 Linux 密钥环行为，未另加平台校验：当前同步 safeStorage API 通过 `isEncryptionAvailable()` 拒绝无密钥环的默认状态，固定密码回退需要显式调用 `setUsePlainTextEncryption(true)`，项目没有该调用。服务配置与 Hindsight 凭证已检查可用性。依据：[Electron 43.8.8 实现](https://github.com/electron/electron/blob/v43.8.8/shell/browser/api/electron_api_safe_storage.cc)、[默认关闭回退的成员定义](https://github.com/electron/electron/blob/v43.8.8/shell/browser/api/electron_api_safe_storage.h)、[显式开启回退的上游测试](https://github.com/electron/electron/blob/v43.8.8/spec/api-safe-storage.spec.ts)。实机仍需验证 GNOME Keyring / KWallet 的授权体验。

主要实现入口：[`desktop-paths.ts`](../../apps/desktop/src/platform/desktop-paths.ts)、[`host-factory.ts`](../../apps/desktop/src/host-factory.ts)、[`app-lifecycle.ts`](../../apps/desktop/src/platform/app-lifecycle.ts)、[`floating-windows.ts`](../../apps/desktop/src/floating-windows.ts)、[`terminal-pty.ts`](../../apps/desktop/src/terminal-pty.ts)、[`chrome-app-update.ts`](../../apps/desktop/src/chrome-app-update.ts)、[`preview.mjs`](../../scripts/preview.mjs)。

## 发布准备落实

| 工作 | 现状和下一步落点 |
|---|---|
| 首发范围 | x64 / AVX2（x86-64-v3），Ubuntu 24.04 / glibc 2.39、libstdc++ 13.2；AppImage + deb。当前 Runtime 本机构建使用 modern 模块；无 AVX2 的 CPU、ARM64 桌面、RPM、Flatpak 和软件源另行支持。 |
| 打包入口 | `pack:linux` 派生 builder 配置，提供 `.desktop`、图标和匹配 Electron ABI 的 PTY。自有 `packaging/linux/AppRun` 避免 builder 在用户命名空间不可用时隐式关闭沙箱。deb 推荐 CJK 字体，并声明文件重命名所需的 Perl。 |
| 随包 Runtime | 使用真实目标平台；签名 Runtime 与公钥放在 `resources/runtime/versions` 和 `resources/runtime-keys`。新安装可离线验签、复制并激活 Runtime。 |
| 发布与审计 | Release 默认选择 Linux x64，必须收齐选中平台候选。独立解包 AppImage / deb，校验 ELF、glibc、资源、执行权限、启动脚本和 Runtime 签名；Linux 安装包与 Runtime ZIP 的摘要进入签名目录。 |
| 更新策略 | `updates-linux-x64.json` 区分 AppImage 与 deb 手动下载；不自动替换系统安装包。兼容的 Runtime 可在线更新和回滚；需要更高桌面版本时先提示手动升级。 |
| 自动化与实机范围 | CI 验证安装后的真实 Runtime、文件工具、PTY、会话恢复、Chromium composition 与剪贴板，并配置 X11 / Wayland 和重装 / 卸载验收。AppImage 的 Ubuntu CI 用固定路径 AppArmor 规则满足 userns 前提。实体 IBus/Fcitx、GNOME/KDE 窗口策略、系统密钥环授权、麦克风和 portal 仍属于实机验收范围。 |

没有新增平台包来复制 Darwin 实现：现有类通过注入提供 POSIX 能力，保留包名以控制迁移范围；平台差异仍在 Desktop 组合层。

## 初次审查验证记录

执行环境为 Windows、Node 24.13.0。依赖和已应用 overlay 的 vendor 均在本工作树独立准备。

- `npm run check -- --production`：通过，280.2 秒；架构／选择器／动效规则、全工作区类型编译、核心回归、Renderer／preload／远程 Host 生产构建。随后新增的 socket 修复另做桌面切片回归。
- `npm run check -- --only desktop`：通过，52.5 秒；包含 socket 修复后的桌面核心回归。
- `npm run test:tooling`：通过，124 / 124 项；测试部分 37.2 秒。首次运行有两项因新工作树缺少 `pi_natives` 而失败，独立安装 vendor 依赖并完成 `npm run omp:build:natives` 后，全套重跑通过；未修改 Runtime 源码或跳过失败项。
- CI YAML 与两个 matrix 的解析检查通过：默认 Windows / Linux，`full` 为 Windows / macOS / Linux。
- `git diff --check` 与新增文档的 11 处本地链接检查通过。
- Linux 专属 socket 进程测试会在 Linux 执行；Windows 上按平台跳过。
- Linux CI 配置已加入，但本地没有触发远端工作流；未在当前 Windows 机器上声称完成 Linux GUI、安装包或真实 Runtime 验收。

后续安装验收还发现并修复了：安装器架构文件名与签名目录不一致、构建依赖将错误退出码改回成功、新版预测通道被多余字段白名单拒绝，以及语言能力未同步到签名工件定义。相关回归沿用现有套件，不放宽签名或平台检查。

## 整合后的源码与界面验证

- Windows / Linux 核心 CI：[43677113306](https://github.com/the-snowpear/omp-studio/actions/runs/43677113306)，两端 `check --production` 均通过；包含当前英语本地化、文件浏览器和 Linux 变更。
- 工具脚本：133 项，Windows 执行的 132 项通过，1 项 Linux 启动器行为由 Ubuntu 打包任务执行。串行复跑通过；此前并发运行有一项 Windows WebView2 安装向导时序失败，单项重跑也通过。
- Linux 更新弹窗与字典：19 项通过，覆盖真实／预览路径和同一已挂载弹窗的 `zh → en → zh`，预览提示保留并随语言变化。
- 官网重构草稿：类型检查与生产构建通过；用明确标识的 Release 测试数据，在 1440px / 390px 浏览器检查五种下载入口、Ubuntu 的 deb 默认项，以及 ARM Linux／尚无 Linux 包时的回退，均未出现横向溢出。这不是已发布版本的下载证明。

## 最终安装包验收

- [构建与签名验收 43677778069](https://github.com/the-snowpear/omp-studio/actions/runs/43677778069)：基于 `57fd986`，Ubuntu 24.04 x64 原生构建 `18.19.0-studio.12`；AppImage / deb 独立解包审计通过，AppImage、deb、Runtime ZIP 和更新清单的签名／摘要复验通过。Linux 启动器的 5 项回归全部通过。
- [安装和续聊验收 43679774005](https://github.com/the-snowpear/omp-studio/actions/runs/43679774005)：复用上述已审计安装包，X11 deb、X11 AppImage、Wayland deb 全部通过。每种形态都验证了首次教程、签名 Runtime、GUI 登录 PATH、真实 PTY、原生文件工具、v2 预测通道、Chromium 中文 composition、剪贴板、重启恢复，以及重新连接原会话后再次发送并完成回复。重装和卸载保留用户数据。
- 三个报告均为 `app.isPackaged=true`、`sandboxDisabled=false`。AppImage 验收采用安装说明中明确的固定路径 AppArmor userns 前提；没有关闭系统全局策略或 Chromium 沙箱。
- [测试包附件](https://github.com/the-snowpear/omp-studio/actions/runs/43677778069/artifacts/14147422303) 保留 14 天，使用开发签名与分支版本 `0.2.0`，不是正式 Release。下次发版需按常规流程统一新版本号与发行说明；不能复用已公开的 `0.2.0` / `0.2.1` tag。

使用步骤与最新验收范围见 [`docs/linux.md`](../linux.md)。
