# OMP Studio 项目协作说明

## 项目目标

OMP Studio 是 OMP Runtime / AgentSession 的 Windows 桌面控制台与配套 Web UI。它通过类型化的 Studio Bridge 暴露运行时能力；不要以 slash 文本、ANSI 输出解析或按键宏模拟控制。

主要结构：

- `apps/desktop/`：Electron 主进程与 Windows 桌面壳。
- `apps/renderer/`：Vite + React 渲染进程 UI。
- `packages/`：协议、host、客户端、transport、平台和测试工具包。
- `omp-patch/overlay/`：Studio 自有的 Runtime 源码（`packages/coding-agent/src/studio/**` 与 `studio-*` 测试），上游没有这些路径，按普通源码维护。
- `omp-patch/patches/`：接缝补丁，只包含对上游已有文件的改动，按上游子系统分组。
- `omp-patch/vendor/oh-my-pi/`：上游 OMP submodule，overlay 与接缝补丁施加于其工作区。
- `ui_reference/`：界面参考，不是运行时产品代码。
- `backup/`：历史备份；不应作为实现或测试输入。

Host 诊断日志：`%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`

面向使用者和外部贡献者的入口是 [`README.md`](README.md)、[`docs/`](docs/README.md)、[`CHANGELOG.md`](CHANGELOG.md)、[`CONTRIBUTING.md`](CONTRIBUTING.md)。本文件是协作者的工作约定，不是产品说明书。

## 功能代码索引

改某块产品功能前，打开 [`doc/feature-index.md`](doc/feature-index.md) 按表跳到文件，不要全库盲搜。那是功能 → 文件的地图，不是架构愿景；路径变更只改索引，不要把表格复制进本文件。

| 任务 | 索引章节 |
|---|---|
| 工作台壳 / 预览 / 首页 | 工作台壳 |
| 对话、Composer、审批、Plan | 对话与 Composer |
| 会话创建 / 归档 / telemetry | 会话、归档、Telemetry |
| Agent Hub、Skills、MCP、模型 | Agent Hub、Skills、MCP、模型 |
| Git / 文件树 / 工作区 | Git / GitHub / 工作区文件 |
| 终端、设置、诊断 | 终端、窗口铬、设置、诊断 |
| Host 协议 / Runtime 进程 | Host 内核 |
| overlay / 接缝补丁 | Runtime overlay |
| 某条 query/command 落哪 | 命令落点速查 |


## 工作方式

1. 先按上面的表打开 `doc/feature-index.md` 对应节，再读相关 package 的 `package.json`、类型和测试；只改与任务直接相关的文件。
2. 修改既有文件前，先在 `backup/YYYY-MM-DD/<task>-HHmmss/` 中保存原文件，并保留其项目相对路径。
3. 不编辑 `backup/` 中的历史版本；需要恢复时复制回工作区，而不是原地修改。
4. 不覆盖已有备份。每项备份包含简短 `README.md`，写明原因、来源提交（如有）和恢复方式。
5. 不提交依赖目录、构建产物、日志、临时截图或新的单文件 `.bak`；使用规范的 `backup/` 目录。
6. 保留用户已有的未提交改动。不要执行 `git reset --hard`、批量删除或无关重构。

## 预览模式与 Mock 数据

Renderer 有全局 **预览模式**（顶栏右上角「预览」开关，三个窗口按钮左侧）。这是显示层开关，不是 Host capability，不进 `client-contract`，不改 Studio Bridge。

写新页面、新面板、新列表，或给现有壳补内容时，**必须同时接好预览 / 真实两套数据**，不要只做其中一边。

### 行为

| 状态 | 读表面（列表、树、telemetry、对话流、目录） | 写表面 |
|---|---|---|
| 预览开 | 用演示 fixture，覆盖真实 snapshot | composer、终端、pause/resume、interaction 仍走真实 API |
| 预览关 | 只用 Host / 桌面真值；没有 read model 则诚实空壳 | 同上 |

互斥：预览开时不要「空了再回退 mock」；预览关时不要偷偷填假数。现有「agents 为空就 `buildPreviewHub()`」这类逻辑已经废止。

### 接入步骤（新页面 / 改页面时照做）

1. 用 `usePreviewMode()`（`apps/renderer/src/preview/PreviewContext.tsx`）读 `preview`。
2. 演示数据放 `apps/renderer/src/preview/fixtures.ts`，或已有的 `hubPreview.ts` / `skillsPreview.ts` / `capabilitiesPreview.ts`。优先复用 ver1 `ui_reference/ver1/assets/js/mock-data.js` 里同名块，不要另起一套故事。
3. 可复用的壳组件放 `apps/renderer/src/preview/surfaces.tsx`；页面里 `preview ? <FixtureUI /> : <真实或诚实空态 />`。
4. 预览面带「演示」标记。fixture HTML 只来自本模块静态字符串，不要 `dangerouslySetInnerHTML` Host / 用户输入。
5. 演示按钮只改本地 UI，不调 Host、不写 reducer、不伪造 `SurfaceCapabilities`。
6. 没有对应 read model 时：预览关 = 禁用壳 + 原因；预览开 = 演示数据。不要把 `capabilities.get` 等现有 query 伪装成另一类库存。

### 不要做

- 不要把 mock 写进 Host / client-contract / transport / reducer。
- 不要在预览关时留下永远显示的演示目录（Skills、能力中心、Token 热图曾经犯过）。
- 不要把底部真实终端换成假 PTY 行；Terminal 两种模式都用本机 Shell。
- 不要嵌伪造 Preview URL / iframe；侧栏 Preview 只画状态/URL/日志壳。
- 不要把演示 PID、绝对路径、token 数字当成 Host 真相。

### 发布隐藏

`apps/renderer/src/preview/mode.ts` 的 `PREVIEW_MODE_SWITCH_ENABLED`。改为 `false` 后开关消失并强制真实数据。不要另造第二套开关。

## 备份规则

本项目以 Git 提交作为长期版本历史；`backup/` 仅用于任务前快照、人工恢复点和已有历史备份的集中归档。

- 新备份位置：`backup/YYYY-MM-DD/<任务名>-HHmmss/`。
- 备份目录必须保持原始项目相对路径，并附 `README.md`，记录创建时间、原因、文件清单和恢复步骤。
- 修改已有源码、配置、脚本或文档，或执行批量移动、重命名、格式化、依赖升级前，先创建备份。
- 不覆盖旧备份；不编辑 `backup/` 中的历史版本，需要恢复时复制回工作区。
- 不备份 `node_modules/`、构建输出、缓存、日志、临时截图、可重新生成产物、机密和令牌。
- 不新增散落的 `.bak`、`.bak-*` 或 `*-backup-*` 文件；应立即归入规范目录。
- 恢复前核对备份说明和 `git diff`，恢复后运行相关测试；历史备份删除或外迁前须获项目负责人确认。

2026-08-12 已将迁移前的散落备份统一放入 `backup/legacy/`，并保留原始相对路径。`.codex-backups/` 因当前 Codex 会话占用暂留项目根目录，待会话结束并确认未占用后再移动。

## 验证

优先按改动范围验证；完整门禁：

```bash
npm run check
```

常用命令：

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run preview`（Windows：构建后启动 Electron 预览）

运行时/补丁专项命令见根目录 `package.json`，包括 `runtime:verify-source`、`omp:test:metadata` 和 `omp:verify:patches`。

## 改 OMP Runtime 源码

Runtime 侧分两层，详见 `omp-patch/README.md`：

- **overlay**（`omp-patch/overlay/`）：Studio 自有文件，上游不存在。普通编辑、普通 diff，升级上游时不会冲突。
- **接缝补丁**（`omp-patch/patches/*.patch`）：仅对上游已有文件的改动，按上游子系统分成 4 组。

工作流固定为：

```powershell
npm run omp:overlay:apply    # 把 overlay 铺进 vendor 并套用接缝补丁（幂等）
# 在 omp-patch/vendor/oh-my-pi 里改代码
npm run omp:patches:regen    # 回收 overlay、重写接缝补丁、更新 series.json
```

不要手写或手改 `.patch`，一律用 regen 生成。新接触一个上游文件时，先把它加进 `scripts/omp-seam.mjs` 的分组，否则 regen 会报错而不是悄悄丢掉改动。
