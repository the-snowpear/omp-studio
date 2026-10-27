# OMP Studio 项目协作说明

## 项目目标

OMP Studio 是 OMP Runtime / AgentSession 的桌面控制台（Windows 与 macOS Apple Silicon）与配套 Web UI。它通过类型化的 Studio Bridge 暴露运行时能力；不要以 slash 文本、ANSI 输出解析或按键宏模拟控制。

主要结构：

- `apps/desktop/`：Electron 主进程与 Windows / macOS 桌面壳；平台差异集中在 `apps/desktop/src/platform/`。
- `apps/renderer/`：Vite + React 渲染进程 UI。
- `packages/`：协议、host、客户端、transport、平台和测试工具包。
- `omp-patch/overlay/`：Studio 自有的 Runtime 源码（`packages/coding-agent/src/studio/**` 与 `studio-*` 测试），上游没有这些路径，按普通源码维护。
- `omp-patch/patches/`：接缝补丁，只包含对上游已有文件的改动，按上游子系统分组。
- `omp-patch/vendor/oh-my-pi/`：上游 OMP submodule，overlay 与接缝补丁施加于其工作区。
- `ui_reference/`：界面参考，不是运行时产品代码。
- `backup/`：历史备份；不应作为实现或测试输入。

Host 诊断日志：`%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`；macOS：`~/Library/Application Support/omp-studio/logs/host-YYYY-MM-DD.log`

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
| macOS / Windows 平台差异 | 平台层 |
| Host 协议 / Runtime 进程 | Host 内核 |
| overlay / 接缝补丁 | Runtime overlay |
| 检查门禁 / 架构约束 | 检查门禁与架构约束 |
| 某条 query/command 落哪 | 命令落点速查 |


## 工作方式

1. 先按上面的表打开 `doc/feature-index.md` 对应节，再读相关 package 的 `package.json`、类型和测试；只改与任务直接相关的文件。
2. 版本历史以 Git 为准：直接改，按任务提交；需要回退用 `git revert` / `git restore`。不再要求任务前复制到 `backup/`。
3. 不提交依赖目录、构建产物、日志、临时截图或 `.bak` 文件。
4. 保留用户已有的未提交改动。不要执行 `git reset --hard`、批量删除或无关重构。

## 防御性代码与测试的尺度

目标是快速、可靠地交付，不是层层设防。

- 参数校验只做一处：Host facade 或真正执行操作的服务（文件越界、git 参数注入这类安全检查放在服务里）。IPC / transport 只检查信封形状，不逐字段校验，不校验 Host 自己的输出，不深拷贝。
- 新增 query / command 只需改契约类型、facade 分发和实现，不要为它另写边界校验器。
- 测试只测用户能感知的行为和真实出过的 bug；不要为校验器、内部结构、"拒绝畸形输入"写成套测试，也不要为了测试改夹具绕圈。
- 唯一的例外是 `scripts/architecture.test.mjs`：它只锚定已经写进本文的分层决策（依赖方向、electron / react 边界、预览开关唯一），不限制内部重构。改决策就同一次提交里改表和代码，diff 就是记录。
- 发布前的检查只拦真正会发坏包的问题（签名、架构、产物缺失）。不在发布流程里重跑源码测试或 GUI 验收。

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

Git 提交就是版本历史和恢复点，日常改动不再做 `backup/` 快照。

`backup/`（gitignored）只保留已有的历史归档，不要编辑其中内容；删除或外迁前须获项目负责人确认。仅在操作无法用 Git 恢复时（例如改写远程 Release 元数据、动用户本机数据）才另存快照。

## 验证

只有一个检查入口：`scripts/check.mjs`。按改动范围选切片，不要每次都跑全量。

```bash
npm run check                          # 架构约束 + 选择器规则 + 编译 + 核心包/渲染测试
npm run check -- --fast                # 只做架构约束、选择器规则和编译
npm run check -- --only studio-host    # 只编译该包依赖闭包，再跑它的核心测试
npm run check -- --only renderer       # 编译渲染层依赖，再跑核心渲染测试
npm run check -- --all                 # 跑每个包的全部测试文件，不只核心名单
npm run check -- --production          # 追加 Vite 生产包与远端 Host 产物（发布前、CI）
node scripts/check.mjs --list          # 看有哪些组和包
```

组：`arch`、`selects`、`types`、`packages`、`renderer`、`production`；`--only` 也接受包名。失败只打末尾 40 行，CI 里会写成错误注解。

编译是增量的（`tsconfig.base.json` 的 `incremental`，缓存落在各包 `dist/.tsbuildinfo`），全量编译按依赖分层并行。改一个包时用 `--only <包>`，别重编 12 个包。

核心回归名单在 `scripts/core-suites.mjs`，`check.mjs`、`test-core.mjs` 和 CI 共用这一份。不要把页面细节、演示 fixture 或性能基准加入默认门禁；新测试应验证实际行为。

### 架构约束（`scripts/architecture.test.mjs`）

检查第一步就跑，改坏了秒级报错，不靠 review 记：

- workspace 包之间的值依赖无环
- 包只能依赖 `ALLOWED_INTERNAL_DEPS` 里声明的方向（例如 `client` 不能反向依赖 `studio-host`）
- 只有 `apps/desktop` 可以依赖、导入 `electron`
- 只有 `apps/renderer` 可以依赖 `react` / `react-dom` / `@testing-library/*`
- `apps/renderer` 源码不能直接 import Node 内置模块或 `electron`，必须走 preload
- `packages/*/src` 不能 import `@omp-studio/testkit`（演示数据留在渲染层 preview）
- `PREVIEW_MODE_SWITCH_ENABLED` 只有 `preview/mode.ts` 一处定义，只有 `preview/` 读它

改分层是决策不是失误：同一次提交里改表和代码，diff 就是记录。

其余命令：

- `npm run build`（完整构建，含生产包）
- `npm test`（按需运行完整工作区测试）
- `npm run test:tooling`（打包、签名、更新脚本改动时运行）
- `npm run preview`（Windows：构建后启动 Electron 预览）

普通 PR / main CI 跑 `npm run check -- --production`：架构规则、类型、核心测试和生产包各一次；纯文档改动跳过。完整双平台与 Runtime 检查通过 CI 的 `full` 手动运行，性能 workflow 也只手动触发。发布负责打包和产物校验，不重复跑源码测试。

运行时/补丁专项命令见根目录 `package.json`，包括 `runtime:verify-source` 和 `omp:verify:patches`，只在相关改动或升级上游时按需运行。

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
