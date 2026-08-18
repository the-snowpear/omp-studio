# OMP Studio Windows Installer — packaging 骨架

安装器骨架：UI 先用零依赖 HTML 原型在浏览器里预览设计，
确认后再翻译成 NSIS（electron-builder）原生界面。当前原型已按
`omp-studio-installer-wizard-design.zip` 的视觉方案落地。

## 目录结构

```
packaging/
  electron-builder.yml   # electron-builder 配置（NSIS target）
  installer-shell/       # 方案 2：承载 HTML UI 的 Electron 外壳（当前为视觉阶段）
    main.cjs
    preload.cjs
    package.json
    README.md
  ui/                    # 安装器 UI HTML 原型（浏览器预览用）
    index.html            # 四步向导与交互逻辑（内联、零依赖）
    styles.css            # 亮色 / 暗色主题与动效
    app-icon.png          # 安装器品牌图标
    README.md             # 视觉方案与 NSIS 降级说明
  README.md              # 本文件
```

## 预览 UI 原型

```bash
# 方式一：直接浏览器打开（无服务依赖）
open packaging/ui/index.html

# 方式二：本地静态服务（推荐，复用 .claude/launch.json 的 "installer ui"）
python -m http.server 4175 --directory packaging/ui
# 然后访问 http://127.0.0.1:4175
```

> `ui/README.md` 记录了窗口尺寸、页面层次、主题令牌、动效和 NSIS 落地时的降级边界。

## 运行 HTML 宿主外壳

当前阶段先验证真实 Windows 窗口中的视觉效果，安装逻辑仍未接入：

```bash
npm --prefix packaging/installer-shell run dev
```

宿主使用固定无边框 `720 × 480` 窗口加载 `ui/index.html`，只通过受控
preload 暴露最小化和关闭操作。后续 NSIS 集成时，NSIS 将负责启动/打包
该宿主，目录选择、文件复制、运行时部署和回滚通过额外的安装协议接入。

## 构建真实安装器（骨架阶段，未验证）

```bash
# 需要先完整构建 desktop 产物（apps/desktop/dist + apps/renderer/dist）
npm run build

# 安装 electron-builder（workspace devDependency）
npm install -D electron-builder

# 用 electron-builder 打 NSIS 包（--win 指定 Windows 目标）
npx electron-builder --config packaging/electron-builder.yml --win nsis
```

产物输出到 `outputs/installer/`（由 electron-builder.yml 的 `directories.output` 决定）。

## 安装行为（产品契约）

原型 `packaging/ui/index.html` 左上角可切换情景预览（含卸载）。NSIS 落地应对齐下列规则。

### 默认位置

所有用户、需要管理员：`%PROGRAMFILES%\OMP Studio`（通常是 `C:\Program Files\OMP Studio`）。

### 选择文件夹后是否新建

浏览或手输的是「选中的文件夹」，真正写入的是解析后的安装根：

| 选中路径 | 实际安装到 |
|---|---|
| 末级已是 `OMP Studio`（忽略大小写） | 原样使用 |
| 已有本应用安装（升级 / 修复 / 降级） | 上次的 `InstallLocation`，不另建 |
| 其他（含空目录、桌面、文档、盘符、`D:\Dev`） | 追加 `\OMP Studio` |

不要用「目录非空就再套一层」：那会在二次安装时变成 `...\OMP Studio\OMP Studio`。

### 版本占用

| 情景 | 行为 |
|---|---|
| 全新 | 可选目录；开始菜单 + 桌面默认勾选 |
| 更旧版本 | 原地更新；目录锁定；会话在 AppData；运行时随程序文件更新；头像覆盖同一文件 |
| 相同版本 | 确认后修复覆盖程序文件；AppData 会话保留 |
| 更高版本 | 警告确认后才允许降级 |
| 进程占用 | 确认后结束 `OMP Studio.exe` 再写文件 |

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

NSIS `customInstall` 会给 `$INSTDIR\runtime` 开 Users 修改权，这样完成页拉起的未提权进程也能写 `current.json`、诊断页也能更新版本。

打包前：

```bash
npm run omp:build:host
npm run pack:win:prepare
npx electron-builder --config packaging/electron-builder.yml --win nsis
```

`pack:win:prepare` 会确认 `packages/runtime-installer/dist/artifacts/win32-x64` 存在，并把本机 `%APPDATA%\omp-studio\keys` 里的公钥拷到 `packaging/runtime-keys`（gitignore）。没有工件或公钥时直接失败，避免打出不能用的安装包。

## 从原型到 NSIS 的翻译规则

| 原型元素 | NSIS 对应 |
|---|---|
| 欢迎页 / 完成页 | MUI2 `WelcomePage` / `FinishPage` + 自定义 BMP 背景图 |
| 安装目录选择 | MUI2 `DirectoryPage` |
| 安装进度 | MUI2 `InstFilesPage`（内建进度条） |
| 卸载 | MUI2 默认卸载欢迎 / 进度 / 完成；删除范围由 `custom.nsh` 实现，不是 HTML 向导 |
| 自定义品牌色 / 字体 | NSIS branding text + MUI 图标 / 资源替换 |
| 任意现代 CSS 布局 | ⚠️ 受限于 NSIS 原生控件，需降级为简单布局 |

## 关键坑位（实现 NSIS 时注意）

1. **node-pty 原生模块**：打包时需按 Electron ABI 重编译（`@electron/rebuild`），
   electron-builder 需在 `files` 里放行原生模块并开启 `npmRebuild`。
2. **renderer 相对路径**：`apps/desktop/src/security.ts` 生产环境从
   `appPath/../renderer/dist` 加载渲染器，打包后需保持该相对结构，
   否则装出来的应用白屏。
3. **monorepo workspaces**：electron-builder 在 workspace 里打包需要显式
   指定 `appDirectory`（默认取 `package.json` 所在目录，即 apps/desktop），
   并确认 `@omp-studio/*` 工作区包被收集进产物。
