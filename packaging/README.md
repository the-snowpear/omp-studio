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

## 从原型到 NSIS 的翻译规则

| 原型元素 | NSIS 对应 |
|---|---|
| 欢迎页 / 完成页 | MUI2 `WelcomePage` / `FinishPage` + 自定义 BMP 背景图 |
| 安装目录选择 | MUI2 `DirectoryPage` |
| 安装进度 | MUI2 `InstFilesPage`（内建进度条） |
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
