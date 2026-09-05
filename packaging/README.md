# OMP Studio Windows Installer — packaging 骨架

安装器骨架：可见向导是 `packaging/ui` 那套 720×480 HTML，由 WebView2
小宿主显示；NSIS 只负责提权和解包。浏览器里仍可直接打开原型预览。

## 目录结构

```
packaging/
  electron-builder.yml   # electron-builder 配置（NSIS target）
  installer-host/        # WebView2 宿主源码（csc 在 pack:win 时编译）
    InstallerHost.cs
  installer-shell/       # 本地 Electron 预览同一套 HTML（不打进 Setup）
  ui/                    # 安装器 UI（浏览器原型 = Setup 真界面）
    index.html
    styles.css
    app-icon.png
    README.md
  nsis/custom.nsh        # 隐藏 MUI、启动宿主、读 options.ini
  README.md              # 本文件
```

## 预览 UI 原型

```bash
# 方式一：直接浏览器打开（无服务依赖）
open packaging/ui/index.html

# 方式二：本地静态服务（推荐）
python -m http.server 4175 --directory packaging/ui
# 然后访问 http://127.0.0.1:4175
```

> `ui/README.md` 记录了窗口尺寸、页面层次、主题令牌、动效和 NSIS 落地时的降级边界。

## 运行 HTML 宿主外壳

本地用 Electron 预览真窗口（浏览/磁盘是本机的，安装进度是演示）：

```bash
npm --prefix packaging/installer-shell run dev
```

打进 Setup 的是 WebView2 宿主，不是第二份 Electron。`pack:win` 会编译
`OmpInstallerUi.exe`，NSIS 启动它并隐藏 MUI 向导。本机没有 WebView2
时回退到默认目录 + 原生进度页。

提权安装时不要用 `$PLUGINSDIR` 的 `file://`：NSIS 3 会把该临时目录锁成
Administrators-only，而 WebView2 子进程是中完整性，会 `ERR_ACCESS_DENIED`。
成熟做法是宿主把 HTML 拷到 `%ProgramData%\omp-studio\installer\ui`，
用 `SetVirtualHostNameToFolderMapping` 打开 `https://omp-installer/…`，
WebView2 缓存放 `%ProgramData%\omp-studio\installer-webview`（Users 可写）。
握手 INI 仍在 `$PLUGINSDIR`（父进程已提权，写得进去）。

## 构建真实安装器

从仓库根目录：

```powershell
npm run pack:win
```

需要先能完成本机 `omp:build:host`（Bun、MSVC、Rust、已执行过 `omp:keys`）。
产物在 `outputs/installer/`（gitignore）：

- `win-unpacked/` — 安装布局（审计用）
- `OMP-Studio-Setup-0.1.0-win-x64.exe` — NSIS Setup（未 Authenticode 签名）

`pack:win` 会：构建 workspace 与 sandboxed preload、确认
`apps/renderer/dist`、把公钥拷到 `packaging/runtime-keys`、调用 electron-builder、
再扫描 unpacked 树与 Setup exe，发现 `signing-private.pem` 或 `BEGIN PRIVATE KEY`
即失败。

已有签名 Runtime 工件时：

```powershell
npm run pack:win -- --skip-host
```

单独步骤仍可用：

```powershell
npm run omp:build:host
npm run pack:win:prepare
npx electron-builder --config packaging/electron-builder.yml --win nsis --publish never
npm run pack:win:audit
```

## 安装行为（产品契约）

原型 `packaging/ui/index.html` 左上角可切换情景预览（含卸载）。浏览器打开
仍是演示数据；Setup 里同一文件走 `?host=installer`，读注册表/磁盘真值。

静默 `/S` 不启动 HTML，占用确认仍用系统 MessageBox（相同版本默认修复，
降级默认拒绝）。electron-updater `/updated` 也不走 HTML。

NSIS 落地在 `packaging/nsis/custom.nsh`：

- 交互安装：隐藏 MUI 窗，只显示 WebView2 宿主；相同版本 / 降级 / 占用对话框在 HTML 里。
  HTML 成功后跳过空的原生自定义页，拷贝文件时 InstFiles 保持隐藏。
- `options.ini` 给出解析后的安装根和是否创建桌面快捷方式。
- 已有安装时 HTML 锁定上次目录。
- `customCheckAppRunning`：HTML 已确认结束进程则不再弹原生框；卸载仍用系统 MessageBox。

### 默认位置

所有用户、需要管理员：`%PROGRAMFILES%\OMP Studio`（通常是 `C:\Program Files\OMP Studio`）。

### 选择文件夹后是否新建

浏览或手输的是「选中的文件夹」，真正写入的是解析后的安装根。规则与 Inno `AppendDefaultDirName`、常见国内安装包一致：只在「容器」上套一层产品目录，空目录或已是产品目录则原样使用。实现：`scripts/installer-dir.mjs` 与 `packaging/nsis/custom.nsh` `ompResolveInstDir`。

| 选中路径 | 实际安装到 |
|---|---|
| 末级已是 `OMP Studio`（忽略大小写），含误套的 `...\OMP Studio\OMP Studio` | 原样使用（双层收成一层） |
| 目录里已有 `OMP Studio.exe` / 卸载器 | 原样使用 |
| 已有本应用安装（升级 / 修复 / 降级） | 上次的 `InstallLocation`，不另建 |
| 盘符根、`Program Files`、桌面、文档、下载等系统目录 | 追加 `\OMP Studio` |
| 已存在且非空的普通文件夹 | 追加 `\OMP Studio` |
| 空目录，或不存在的路径（将创建） | 原样作为安装根 |

不要用「只要末级不是产品名就一律套一层」：那会把用户建好的空目录 `D:\Dev` 变成 `D:\Dev\OMP Studio`。也不要只看「目录非空」而不看末级名：二次安装选中已有产品目录时会变成 `OMP Studio\OMP Studio`。

### 版本占用

| 情景 | 行为 |
|---|---|
| 全新 | 可选目录；开始菜单 + 桌面默认勾选 |
| 更旧版本 | 原地更新；目录锁定；会话在 AppData；运行时随程序文件更新；头像覆盖同一文件 |
| 相同版本 | 确认后修复覆盖程序文件；AppData 会话保留 |
| 更高版本 | 警告确认后才允许降级 |
| 进程占用 | 确认后结束 `OMP Studio.exe`（及安装目录下的 `omp.exe`）再写文件 |

交互安装的占用对话框在 HTML 里；`customInit` 的系统 MessageBox 只留给静默 `/S`
（相同版本默认修复，降级默认拒绝）。electron-updater `/updated` 跳过版本确认。

### 卸载

没有单独的 HTML 卸载向导；真实卸载仍是 electron-builder 的 MUI2 卸载段。原型左上角「卸载」情景只用来核对文案与删除范围。

| 删除 | 保留 |
|---|---|
| `%PROGRAMFILES%\OMP Studio` 程序文件（含正在跑的 `$INSTDIR\runtime\versions\...\omp.exe`、`runtime-keys\`） | `%APPDATA%\omp-studio` 里的会话、日志、`workspaces.json`；旧版若在 AppData 留下过 `runtimes` 也不主动删 |
| 开始菜单 / 桌面快捷方式 | `%APPDATA%\omp-studio-endpoints` |
| `%APPDATA%\omp-studio\profile`（头像） | |
| 旧版 `$INSTDIR\userdata` | |

实现落在 `packaging/nsis/custom.nsh`：

- `customUnInstall` / `customRemoveFiles` **升级时也会执行**（先卸旧版再装新版）。必须 `${ifNot} ${isUpdated}` 才删头像，升级只清程序文件、留下 `userdata` 给首次启动迁移。
- 覆盖了 `customRemoveFiles` 就不能再依赖默认的 `RMDir /r $INSTDIR`。真卸载要先 `SetOutPath $TEMP` 再整目录删除，否则安装目录会剩文件。
- 所有用户安装时 `$APPDATA` 默认是 ProgramData；删头像前 `SetShellVarContext current`。
- `deleteAppDataOnUninstall` 只对 oneClick 有效，向导式安装不能靠它。

### 快捷方式

- 开始菜单：始终创建，直接放在所有用户开始菜单根（`menuCategory: false`），不套公司名子目录。
- 桌面：全新默认创建（公共桌面）；`createDesktopShortcut: true`（不要 `always`），升级时不把用户删掉的图标加回来。
- 完成页默认勾选「运行 OMP Studio」。
- 不写入 PATH。

安装范围为所有用户（`perMachine: true`）。头像在 `%APPDATA%\omp-studio\profile\`，上传覆盖、无历史；卸载时删除该目录。

### Runtime 工件

安装目录里的 `runtime\versions\<ver>\omp.exe` 就是**正在跑的 Runtime**（electron-builder `extraFiles` 直接铺成 `RuntimeInstaller` 布局）。首次启动核验签名并写 `runtime\current.json`；诊断页的安装/更新也写这个目录。公钥在 `runtime-keys\`（不含私钥）。卸载随程序文件删掉这份 `omp.exe`；AppData 里的会话和日志仍保留。

NSIS 保持 Program Files 的默认安全 ACL，`custom.nsh` 故意不向标准 Users 开放 `$INSTDIR\runtime` 的修改权限以防提权漏洞；安装包通过管理员权限部署，更新操作在提权桌面主进程中安全执行并完成验签自检。

打包前：

```bash
npm run pack:win
```

`pack:win:prepare` 会确认 `packages/runtime-installer/dist/artifacts/win32-x64` 存在，并把本机 `%APPDATA%\omp-studio\keys` 里的公钥拷到 `packaging/runtime-keys`（gitignore）。没有工件或公钥时直接失败，避免打出不能用的安装包。Renderer 打进 `resources/renderer/dist`，对应 `resolveRendererEntry` 的 asar 相对路径。

## 可见向导

Setup 显示 `packaging/ui` 的 720×480 HTML（WebView2），不再用 MUI2 原生页。
浏览器打开仍可预览情景开关；`?host=installer` 隐藏原型铬，走真实目录/占用。
缺少 WebView2 时 NSIS 回退到默认安装位置 + 原生进度。卸载仍是 MUI2。
HTML 经 ProgramData 虚拟主机加载，不是 NSIS 临时目录上的 `file://`。

## 关键坑位（实现 NSIS 时注意）

1. **node-pty 原生模块**：打包时需按 Electron ABI 重编译（`@electron/rebuild`），
   electron-builder 需在 `files` 里放行原生模块并开启 `npmRebuild`。
2. **renderer 相对路径**：`apps/desktop/src/security.ts` 生产环境从
   `appPath/../renderer/dist` 加载渲染器，打包后需保持该相对结构，
   否则装出来的应用白屏。
3. **monorepo workspaces**：electron-builder 在 workspace 里打包需要显式
   指定 `appDirectory`（默认取 `package.json` 所在目录，即 apps/desktop），
   并确认 `@omp-studio/*` 工作区包被收集进产物。
