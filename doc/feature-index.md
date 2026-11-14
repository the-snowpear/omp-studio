# 功能代码索引

何时打开：改某块产品功能、不知道入口时。不要整篇塞进 always-on 规则；从 [`AGENTS.md`](../AGENTS.md) 的路由表跳到对应节即可。

这是 **功能 → 文件** 的地图，不是架构愿景。协议形状以类型为准，不在这里复述。搬家后改这一份，不要在 `AGENTS.md` 复制表格。

## OMP 18.19.0 适配入口

| 功能 | Renderer / 预览 | Runtime / 协议 |
| --- | --- | --- |
| 原生 HTML 表单 | `InteractionDeck.tsx`、`deck/{FormCard,FormFields,FormSession}`、`preview/{formPreview,PreviewDeck}` | overlay `remote-extension-ui.ts`、`services/{form-presentation,interaction-port,tree-service,studio-thread-service}`；`contracts/forms.ts`；正文瞬时 `interaction.form.read`，不进 snapshot / ledger |
| 有序步骤与委派策略 | `AgentHub.tsx`、`agents/{TaskAssignmentEditor,TaskStepsView}`、`settings/TaskDelegationSettings.tsx`、`preview/taskStepsPreview.ts` | 原生 `task/executor.ts` / `task/steps.ts`，overlay `services/{agent-hub,task-options}-service.ts`；`contracts/agents-jobs.ts`；一次 spawn、同一 Agent/job，最多四组原生提示 |
| 同页浏览器与引擎选择 | `browser/{BrowserPane,BrowserStartPage,ManagedBrowserPane,NativeBrowserFrame,browserNativeBackend,useNativeBrowserObservation}`、`preview/browserPreview.ts` | overlay `services/browser-observation-{service,adapter}.ts`、`browser-tab-control.ts`；Desktop `browser-observation.ts` / `managed-browser-relay.ts`；`contracts/browser-observation.ts`；继承 CLI 时不传 `app`，embedded 显式选择 |
| 系统模板与实际来源 | `ModelConfigPage.tsx`、`models/ModelSystemTemplates.tsx`、`preview/modelServicesPreview.ts` | overlay `services/model-system-templates-service.ts`；原生 `sdk.ts` / `system-prompt.ts`；`contracts/model-services.ts`；config.yml 关联、既有编辑器与原生重渲染 |
| 原生登录、授权目录与 Judge | `models/{NativeModelAccessPane,RuntimeCredentials,useModelAuth}`、`preview/modelServicesPreview.ts` | overlay `services/model-{auth,roster}-service.ts`；原生 AuthStorage / catalog / scoped refresher；Liquid 是 Judge，不添加聊天策略 |
| 账户预算与窗口策略 | `models/{AccountStatusPane,AccountBudgetTable}`、`preview/accountsPreview.ts` | overlay `services/account-status-service.ts`；`contracts/accounts.ts`；USD Key/User 预算独立显示，5h/weekly/Fable 对应原生 governing window，只读刷新不兑券 |
| 搜索与目录 | `models/WebSearchPanel.tsx`、`preview/modelConfigFixtures.ts` | `scripts/model-catalog.mjs`、Host `omp-models-adapter.ts` / `web-routing.ts`；overlay `services/search-credentials-service.ts`；Sofya 原生凭据、HN keyless/site route，无 Smithery live 入口 |
| Context 来源与 Actions 步骤 | `contextViewer/`、`conversation/{ContextCard,JobInspector,ActionsSteps,jobActionsModel}`、对应 preview | overlay `services/{context-view-service,job-service,job-actions,job-inspect}`；`contracts/{context-view,job-actions}.ts`；四组稳定身份色，完整分类、原生来源 marker/caveat 与真实步骤时间 |
| 维护与实际文件变更 | `diagnostics/NativeMaintenancePane.tsx`、`conversation/{sessionDiff,SessionChanges,toolMeta}`、`preview/{maintenancePreview,changeDiffsPreview}` | overlay `services/maintenance-service.ts`，原生 GC strip / edit `perFileResults`；`contracts/maintenance.ts`；scan→preview→确认 apply，只审核已落盘结果 |
| 队列、批准、恢复与退出 | `composer/RuntimeQueueBar.tsx`、`deck/PlanCard.tsx`；Desktop `composition.ts` / `runtime-session.ts` | 原生 `agent-session.ts` / `approved-plan.ts` / `restoreSession`，overlay `studio-host-mode.ts` / mode service；组 ID/hold、批准 metadata、fresh scoped binding；可撤销 quit 才调用 `runtime.close.confirm` |

迁移范围和实际覆盖见 [18.19.0 迁移报告](../docs/migrations/omp-18.19.0.md)。新读表面均同时接 preview / 真实数据；正文、模板预览、媒体和高频输入保持瞬时，沿用既有 Bridge 与资源租约。

局部 GUI 验收入口：`apps/renderer/form-18190-harness.html`（FormCard/FormSession）、`apps/renderer/features-18190-harness.html`（Actions/JobInspector、部分编辑 Changes），与既有 `preview-app-harness.html` / `browser-harness.html` 共用真实组件、preview/marks 和设计 tokens；这些开发入口不接 Host、不进入生产页面导航。

## OMP 18.18.0 继承入口

| 功能 | Renderer / 预览 | Runtime / 协议 |
| --- | --- | --- |
| worker 子 Agent 与精确模型（任务文件仅历史兼容） | `AgentHub.tsx`、`preview/taskSpawnPreview.ts` | overlay `services/studio-thread-service.ts`、`task-options-service.ts`、`agent-hub-service.ts`；`contracts/agents-jobs.ts`、`runtime-upgrade.ts`；可选项瞬时 query `agent.spawn.options.read` |
| 排队压缩、历史重命名/置顶/占用 | `composer/RuntimeQueueBar.tsx`、`HistoryPage.tsx`、`preview/runtimeQueuePreview.ts` | overlay `services/queued-compaction-service.ts`、`compaction-yield.ts`、`upgrade-service.ts`；`contracts/runtime-queue.ts`；占用瞬时 query `session.lease.read` |
| 中途回复、扩展、BTW 注入、预测 | `conversation/conversationStore.ts`、`ExtensionLinks.tsx`、`btw/BtwPanel.tsx`、`composer/useWordPrediction.ts`；`preview/conversationFixtures.ts`、`btwPreview.ts`、`nextMessagePreview.ts` | overlay `services/conversation-entry-identity.ts`、`conversation-live-projector.ts`、`session-transcript-service.ts`、`extension-links-service.ts`、`btw-injection.ts`、`message-prediction.ts` |
| Shell 回放、缓存、Eval 与作业 | `conversation/ShellView.tsx`、`PromptCachePanel.tsx`、`ContextCard.tsx`、`ToolBody.tsx`、`JobInspector.tsx`；`preview/runtimeViewsPreview.ts`、`nativeToolGallery.ts`、`hubPreview.ts` | overlay `services/runtime-view-service.ts`、`job-inspect.ts`；`contracts/runtime-views.ts`、`shell-view.ts`、`runtime-features.ts`、`benchmarks.ts` |
| 模型与新设置 | `ModelConfigPage.tsx`、`settings/runtime18180Settings.ts`；`preview/modelConfigFixtures.ts`、`featureSettingsPreview.ts` | `scripts/model-catalog.mjs`、Host `omp-models-adapter.ts` / `model-role-migration.ts`、`provider-yaml-draft.ts`；overlay `services/runtime-catalog-service.ts`、`feature-settings-service.ts` |
| Live WebRTC 与语音准备 | `media/LiveAudioPane.tsx`、`webrtcCapture.ts`、`composer/DictationControl.tsx`；`preview/dictationPreview.ts` | overlay `services/live-audio-service.ts`、`dictation-capture.ts`；瞬时 `contracts/runtime-views.ts`，原生 Live controller |
| WebMCP | `browser/WebMcpPane.tsx`、`ManagedBrowserPane.tsx`；`preview/webmcpPreview.ts` | overlay `services/managed-browser-service.ts`、原生 `tools/browser/` controller 与 tab bridge；Desktop `managed-browser-relay.ts`；`contracts/webmcp.ts` |

版本变化和验收见 [18.18.0 迁移报告](../docs/migrations/omp-18.18.0.md)。

瞬时读取契约在 `contracts/runtime-views.ts`。历史 Shell 在 `runtime-view-service.ts` 仅保留当前命令的一份回放数据，`shell.view.release` 与 Runtime dispose 释放；Renderer 关闭、隐藏或切换来源时释放，回放等上一帧完成后再推进。

## 调用链

```
Renderer (apps/renderer)
  → @omp-studio/client (StudioClientImpl + reducer)
  → transport-desktop / preload `window.ompStudio`
  → apps/desktop ipc.ts
  → host-client-api facade.ts
      ├─ Host 自有：session catalog / archive / models.yml / skills 磁盘扫描 / git
      └─ Runtime Bridge：studio-host → overlay `packages/coding-agent/src/studio/**`
```

语义命令与 query 的权威名单：`packages/client-contract/src/operations.ts`。  
Runtime `kind` 的权威名单：`packages/studio-protocol/src/contracts/commands.ts`。  
Facade 分发：`packages/host-client-api/src/facade.ts`（`query` / `command` 的 `switch`）。

## 包职责

| 包 | 职责 | 先读 |
|---|---|---|
| `@omp-studio/studio-protocol` | Bridge / Host 帧、命令 kind、校验 | `packages/studio-protocol/src/index.ts` |
| `@omp-studio/client-contract` | Renderer 可见的 query/command/read model | `packages/client-contract/src/operations.ts` |
| `@omp-studio/client` | 客户端状态机、对话 reducer、收据选择器 | `packages/client/src/studio-client.ts` |
| `@omp-studio/host-client-api` | 产品 Facade：query/command → Host 或 Runtime | `packages/host-client-api/src/facade.ts` |
| `@omp-studio/studio-host` | Runtime 进程、Bridge、ledger、catalog、telemetry | `packages/studio-host/src/host-backend.ts` |
| `@omp-studio/transport-desktop` | 固定 IPC 通道名与信封解析 | `packages/transport-desktop/src/channels.ts`、`ipc-envelope.ts` |
| `@omp-studio/runtime-installer` | 签名工件安装 / 回滚 | `packages/runtime-installer/src/index.ts` |
| `@omp-studio/platform-win32` | 单实例锁、Job Object、私有 endpoint | `packages/platform-win32/src/index.ts` |
| `apps/desktop` | Electron 壳、Host 组装、Git/终端等本机能力 | `apps/desktop/src/host-composition.ts` |
| `apps/renderer` | UI | `apps/renderer/src/App.tsx`、`main.tsx` |
| `omp-patch/overlay` | Studio 自有 Runtime 源码 | `omp-patch/overlay/packages/coding-agent/src/studio/` |

现行架构：[`docs/architecture.md`](../docs/architecture.md)。长文历史基线：[`BACKEND_FOUNDATION.md`](BACKEND_FOUNDATION.md)、[`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md)。补丁流程：[`omp-patch/README.md`](../omp-patch/README.md)。

## 检查门禁与架构约束

改工程底座（编译、测试、包结构）时看这里；日常改产品功能不用打开。

| 事 | 文件 | 说明 |
|---|---|---|
| 一次检查跑什么 | `scripts/check.mjs` | 组 `arch` / `selects` / `motion` / `types` / `packages` / `renderer` / `production`；支持 `--fast`、`--only <组\|包>`、`--all`、`--production` |
| 核心回归名单 | `scripts/core-suites.mjs` | `check.mjs`、`test-core.mjs`、CI 共用一份，改名单只改这里 |
| 分层与 Electron 边界 | `scripts/architecture.test.mjs` | 包依赖无环、依赖方向白名单、electron 只在 desktop、react 只在 renderer、renderer 不碰 Node、Host 不 import testkit、预览开关唯一、contracts 不长校验器、不写输出校验器 |
| 选择器规则 | `scripts/check-renderer-selects.mjs` | 普通单选必须用 `AppSelect`，例外在文件内的 `allowed` 表 |
| 动效规则 | `scripts/check-renderer-motion.mjs` | 组件 CSS 不写字面时长 / 裸曲线 / `transition: all` / 自己的 reduced-motion；`@keyframes` 不重复不闲置；`motion.ts` 数值表与 `tokens.css` 相等；可直接查系统偏好的文件在 `REDUCED_QUERY_OWNERS` |
| 增量编译 | `tsconfig.base.json` 的 `incremental` | 缓存落各包 `dist/.tsbuildinfo`；`tsc -p` 单包热编译约 2 秒 |
| 发布 Runtime 复用 / 远程构建 | `.github/scripts/find-runtime.sh`、`.github/workflows/{runtime-artifacts,release,remote-environments}.yml`、`scripts/release-plan.mjs`；`package.json` 的 `build:remote` | 每平台准备一次签名 Runtime，桌面与 SSH 共用；按已提交输入复用历史产物，远程任务跳过 Renderer / Electron 二进制 |
| 发布下载 / 原生编译缓存 | `.github/actions/cache-{release-downloads,desktop-native,runtime-build}/action.yml`、`scripts/release-cache.mjs`；`.github/workflows/release-cache.yml` | main 预热六个平台 Rust/Bun、Windows npm/Electron/NSIS/WebView2/node-pty；可手动验收远程候选，不发布版本；见 `docs/releasing.md` |
| 沙箱 preload 构建回归 | `scripts/preload-bundle.mjs`、`preload-bundle.test.mjs`；`apps/desktop/src/ipc-validation.ts` | 禁止 bundle 外部加载 Node/Host 模块；production 检查执行 bundle 并验证桌面桥接挂载 |

> 命令与用法以 [`AGENTS.md`](../AGENTS.md) 的「验证」一节为准，这里只放文件落点。

---

## 工作台壳

| 功能 | 入口 | 说明 |
|---|---|---|
| 窗口配色与焦点 | `apps/renderer/src/dock/windowTint.ts`、`WindowFrame.tsx`、`dock.css`；`conversationWorkspace/{Header,Tabs,Workspace}.tsx`、`drag.ts`、`workspace.css`；`dock/DockDragPreview.tsx` | 对话按稳定的打开顺序取色，工具及其实例按类型取色；标题栏保留底色，当前窗口以同色边线与轻微外发光表示焦点；顶部窗口标签、浮窗内工具标签和拖动预览共用色调，深浅主题与真实／预览共用外壳 |
| 挂载 / 无 Host 空态 | `apps/renderer/src/main.tsx` | `StudioClientImpl` + `createDesktopTransport`；缺桥则 `Unavailable` |
| 壳布局、侧栏、底栏、路由 | `apps/renderer/src/App.tsx`（启动与连接）、`SecondaryPage.tsx`、`workbench/{AppShell,WorkbenchCanvas,AppTopbar,BottomPanelChrome}.tsx`、`sidebar/{AppSidebar,WorkspaceTree}.tsx`、`DeferredPanel.tsx`、`pageIntents.ts`、`shellModelLoader.ts` | 首页、历史、统计及非当前重面板首次可见才加载；二级页头由轻量 `SecondaryPage` 持有；会话动作 `workbench/sessionActions.ts`、重命名 `history/useSessionRename.ts`，分支操作 `git/useWorkbenchBranches.ts`、文件动作 `files/useWorkspaceFileActions.ts`；草稿、共享读取与稳定 Dock 宿主继续由现有服务持有 |
| 动效体系 | `apps/renderer/src/styles/tokens.css`（Motion 段：节奏阶梯 `--dur-*`、曲线 `--ease-*`、位移 `--shift-*`、循环 `--loop-*`）、`styles/motion.css`（配方 `--motion-*`、`omp-enter` / `omp-exit` 页面与标签切换、主题整窗溶解、循环、减弱动效）、`motion.ts`（`MOTION_MS` / `MOTION_EASE` / `motionReduced()` / `transitionMs()`）、`pageTransition.ts`（`useDeferredKey` / `useDeferredPresence` / `useOverlayPresence` / `useOverlappingTabs`）、`themeTransition.ts` | 所有动效从这里取模式和数值，规则见 `motion.css` 头注：纵深走竖向（页面盖在工作台上、编辑器盖在列表上，只有上层位移），同级走横向（按导航 / 标签顺序从右或左进）；离场比入场短一档；减弱动效（系统偏好、应用内开关、低配档位）统一为 `data-perf-tier~="L1"`，动画压到末帧、过渡 0s、循环静止；`perf/tiers.css` 只剩 L2 / L3 的少画规则 |
| 独立页面与工作台显隐 | `apps/renderer/src/conversationWorkspace/{Workspace,Context}.tsx`、`pageMotion.ts`、`workspace.css`；`workbench/AppShell.tsx`、`App.css` | 独立页面保留全局导航，共享侧栏、对话顶栏、右栏、底栏及展开按钮统一退出显示；工作台正文、共享栏和外置工具宿主沿用同一退场时钟，去掉正文重复动画；页面铺满导航外的可用空间，沿用原内容居中与高度规则；返回复用原宿主、草稿和布局，跨页面 Pin 保持原规则 |
| 可折叠主导航 / 更新提示 / 头像 | `apps/renderer/src/NavRail.tsx`、`useIdentityFlight.tsx`、`SidebarFooter.tsx`、`motion.ts`（`transitionMs` / `transitionDelayMs`）、`workbench/AppShell.tsx` / `sidebar/AppSidebar.tsx`、`styles/sidebar.css`（`.sb-footer`）、`HomePage.tsx`、`icons.tsx`（`workbench`） | 最左 56px icon rail：工作台、首页、会话历史、能力中心、模型配置、设置；顶部页面标签栏保留，与 rail 激活态同一时长/缓动同步。折叠/展开共用一个贴在 rail 右边线、垂直居中、随边线滑动的握把（宽度 18、`::before` 撑到 28×52），指针靠近这条线两侧才淡入（`pointermove` 距离判定 + 缓存线位置，不用覆盖层，短窗不抢入口按钮点击）；rail 宽度走 250ms 布局动画，动画期间每帧 `dock.hosts.flush()` 重测固定定位的停靠面板，否则 Explorer 内容会落后它的卡片。收起后内容补回 56px，头像与 OMP 状态回到侧栏底部 `.sb-footer`（旧样式），展开又回 rail 底部；两处头像共用同一个环境菜单，锚点取实际点击的那个。工作台入口用独立 `workbench` 图标（三块面板），不与标题栏 `layout`（切换左栏）同形；更新入口仅在检测到时渲染。两处头像的交接由 `useIdentityFlight` 用 fixed 幽灵完成：rail 收起时头像会被 56px 的裁切带走、底栏那只又跟着侧栏整体右移 56px，两只从不在同一点；幽灵从源头像矩形飞到目标头像矩形（时长/缓动直接读 rail 的 `transitionDuration` / `transitionTimingFunction`），飞行期间两处真身 `visibility: hidden`，落地那帧显形，减动效档直接换。折叠/展开是「一整套动作、同一根时钟」：rail 宽度 250ms 的同时，底栏高度走 `grid-template-rows: 0fr→1fr` 从底边长出来，上方对话区与文件区在同一条 flex 里被逐帧挤压，中间那条可拖动的 `.sb-divider` 平滑移动；文件面板是 fixed 的 body，动画期间逐帧 `hosts.flush()`，技能抽屉的 `--drawer-bottom` 逐帧跟随；头像由幽灵搬运；分隔线从左画出来、名字/状态/chevron 依次展开（延迟按 `--dur-slow` 的比例写）；折回时先让标签淡出 60ms，再用 `transition-delay` 收盒子，卸载计时读 `transitionMs + transitionDelayMs`。幽灵与底栏卸载都不进 React state（根类名 + WAAPI），否则 `AppShell` / `AppSidebar` 会在动画首尾各重渲染一次、卡在收尾那两帧上 |
| 模块化停靠 / 布局预设 | `apps/renderer/src/dock/{types,model,store,hosts,gestures,dragPreview,cardDrag,leftCards,railClip}.ts`、`DockContext.tsx`、`PanelRegistration.tsx`、`panelMeters.tsx`、`panelChrome.tsx`（标签图标 / 站点图标 / 业务关闭）、`DockRegions.tsx`、`DockLauncher.tsx` + `launcher.css`（右栏／底栏空态「新标签页」工具入口；标签栏全屏按钮与 `DockFullscreen`，portal 到 body、标题栏以下铺满、Esc 退出，正文层级由 `hosts.ts` 认 `data-dock-fullscreen`）、`DockDragPreview.tsx`、`DockMenus.tsx`、`toolGroups.ts`、`DockSettings.tsx`；`panels/registry.ts` | 左栏全宽区段、对话内悬浮卡片、右栏／底栏标签组与浮窗；单页浮窗只留标题栏，多页才出现标签行；浮窗无组握把，右栏与底栏握把只在指针靠近标签行左端时展开；标签按宽度收缩，最后一个标签后紧跟「新建标签」+（在滚动容器外，标签少时贴着标签、满时停在行右缘不滚走），新建即把所选工具移入该组并激活；标签／组操作改右键（单标签菜单含整组操作，底栏工具条只留折叠与隐藏）；「新建标签 / 添加工具」按 `toolGroups.ts` 分成常用 / 工作区与版本 / 会话与上下文 / 自动化 / 诊断与输出（常用含 Browser、BTW，子 Agent 实例挂在其末尾），分类标题条与切换模型的分类列表同构、各带色相；真实拖动预览复用稳定宿主，卡片列表与图标使用统一占位和让位机制，支持浮窗、整组和跨区拖入；浮窗内容同步底角，展开快照按工具区可见范围逐帧裁切，另有会话隔离、预设、布局撤销；多实例面板有两族：子 Agent（`agent-detail:`）与网页标签（`browser-page:`，`layout.browserPages` / `lastBrowserPage`，× 经 `PanelDefinition.close` 关闭网页而非隐藏，预设只留通用 `browser` 锚点，见 `dock/browserPages.test.ts`）；使用说明 `docs/workbench-docking.md` |
| 工具正文宽版布局 | `apps/renderer/src/layout/useWideLayout.ts`；Changes `conversation/ChangesPanel.tsx`（`ChangesBrowser`）、子 Agent `agents/AgentDetailPanel.tsx`、Agents `agents/AgentRosterPanel.tsx`、Git `git/{GitWorkbench,GitCommitGraph,GitDiffResizer}.tsx` + `github.css`、BTW `btw/BtwPanel.tsx` + `styles/btw.css`、Environment `environment/EnvironmentCard.tsx`、Context `conversation/ContextCard.tsx`、Token 计数 `usage/TokenCounterPane.tsx`；Explorer `styles/sidebar.css`、Git 快捷卡 `git/gitQuickCard.css`、Problems / Tests `styles/workbench.css` 只用容器查询 | 按正文自身宽度（回调 ref + ResizeObserver，带 24px 回差）切宽版，浮窗最大化、全屏标签组或拉宽侧栏都触发；宽版各自重排：Changes 文件列表 + 单文件 Diff（↑↓/Home/End）、子 Agent 对话 + 常驻详情栏（隐藏「详情」页签）、Agents 列对齐表格、Git 更改与 Diff 并排（无选中时 `GitDiffPlaceholder`）/ 历史与提交详情并排、BTW 话题列表、Environment 概览卡片、Context 环形图、Token 计数左右分栏；窄版 DOM 与样式不变，对话正文与输入框位置固定、跨阈值不重挂；预览 / 真实共用同一组件；说明 `docs/workbench-docking.md`「浮窗与隐藏」 |
| 主对话拖出 / 统一窗口 / 混合吸附 | `apps/renderer/src/conversationWorkspace/{Workspace,WorkspaceEmpty,Context,Header,Tabs}.tsx`、`workspaceEmpty.css`、`{model,store,client,drag,hosts}.ts`；`workbench/AppShell.tsx`（会话行、常驻共享栏与局部加载）；共用 `dock/{WindowFrame,DockDragPreview,SnapLayout}.tsx`、`{windows,snap,windowProjection,pointerDrag,windowDrag,windowOrder,workbenchGeometry}.ts`、`NativeFloat.tsx`、`DockMenus.tsx` | `WorkbenchWindows` 唯一保存对话与工具的窗口几何、最小化／最大化、分区与恢复位置；Dock 保留工具组，窗口属性只读投影；递归分割树、六种模板、首次吸附自动安置主区、角落就地拆分、联动分界线与混合窗口补齐；单个可见对话最大化回普通主区；`openFromDirectory` 在窗口模式另开会话、已有视图只聚焦，单对话沿用主区切换；空主区提供主题适配的窗口入口与收回操作；主区没有对话时顶栏左侧换成窗口标签栏（`Tabs.tsx` 的 `WindowTabs`，按窗口管理器顺序列出对话与工具窗口；对话标签由 `Header.tsx` 经 `hosts.ts` 的 `setTab` 发布，工具标签由各对话 Dock 内的 `ToolWindowTabs` 经 `setToolTabs` 发布；+ 是当前对话 Dock 借出的 `WindowTabAdd`，复用 `DockToolsButton` 的「新建标签」菜单并在顶上加新建对话），项目／分支／标题与 Fork／Handoff 移入窗口标题行（`Header.tsx`），顶栏右侧不变，档位按整行宽度（`layout/useCompactTopbar.ts`）；共享栏常驻、目录按连接缓存、会话初始化复用；稳定宿主保持草稿和工具，工具来源与跨会话停靠限制不变；窗口布局 v4 迁移旧对话／工具坐标，真实／预览隔离；说明 `docs/workbench-docking.md` |
| 窗口吸附热区 / 拖动容错 | `apps/renderer/src/dock/snap.ts`（`windowSnapHit` / `WindowSnapTracker`）、`windows.ts`、`gestures.ts`、`pointerDrag.ts`；`conversationWorkspace/drag.ts`、`LayoutPreview.tsx` | 对话／工具共用扩大热区、24px 退出缓冲与16px 深入切换；首次角落吸附保留原主对话在对侧全高，预览借用稳定正文和完整窗口外壳，取消回原位；工具预览按当前共享栏之外的区域测量；侧边全高只合并拖入侧，保留对侧分区、空位及比例；Ctrl／Command 暂停吸附，合法工具停靠优先，布局选择器才整体换模板 |
| 最小化胶囊拖动 | `apps/renderer/src/dock/MinimizedCapsule.tsx`、`pointerDrag.ts`、`dock.css`；接入 `DockRegions.tsx`、`conversationWorkspace/Workspace.tsx` | 对话、普通工具和 Pin 胶囊单独自由拖动，点击恢复；复用 6px 拖动阈值及 Esc／失焦取消，拖动不触发恢复。稳定按钮宿主脱离容器裁切，位置限制在当前窗口内；本次运行按窗口身份记忆，真实／预览隔离，布局锁定时禁止拖动；全窗口模式仍用顶部标签恢复 |
| 对话停靠到工具区域 | `dock/conversationPanels.ts`、`types.ts`（`PanelContentAdapter`）、`store.ts`、`DockContext.tsx`、`DockDragPreview.tsx`；`conversationWorkspace/{Workspace,store,drag}` | 对话复用右栏／底栏标签、左栏卡片及工具浮窗分组；`conversation:` 面板借用同一正文宿主，窗口几何仍由 `WorkbenchWindows` 持有，Dock 只保存停靠与组成员；支持拖回浮窗、取消、撤销和恢复，保持来源会话；预设不携带具体对话身份，不把对话嵌套到自己的工具列 |
| 浮窗 Pin / 独立系统窗口 | Renderer `dock/pins.ts`、`store.ts`、`SurfaceContext.tsx`、`NativeFloat.tsx`、`DockRegions.tsx`、`DockMenus.tsx`；Desktop `floating-windows.ts` / `floating-windows-shared.ts`、`chrome-api.ts`、`main.ts` | 五档 pin、工作区／应用共享组、多实例 Agent 描述符、跨文档稳定宿主；仅桌面独立窗口；真实／预览隔离；关闭取消、最小化保留、重启恢复；验收入口 `pin-harness.html` 与 `scripts/pin-window-smoke.cjs` |
| 会话行 ⋯ 菜单 / 行右键 | `workbench/menus.tsx`（`ThreadRowMenu` / `ThreadActionMenuItems`）、`workbench/AppShell.tsx`（`runThreadRowAction`） | 顶栏「对话选项」同款七项（弹层 208px 稍窄）；⋯ 点击锚按钮、行右键贴光标，同一弹层；作用于所在行会话：非当前会话先 `openHistoryEntry`（`resumeForAction`，必要时切工作区并 resume）再执行；预览演示行会话动作禁用（写表面不伪造目标）；临时行仅当为当前活动会话时可用，草稿行保留原生右键 |
| 悬停 tip | `apps/renderer/src/TipHost.tsx` | `[data-tip]` 门户气泡；不用原生 `title`；文案短词，未实现加「（暂未实现）」 |
| 通用单选下拉 | `apps/renderer/src/AppSelect.tsx`、`styles/components.css` | 普通单选统一用 `AppSelect` + `option` / `optgroup`；受控 value/onChange、主题、键盘、超过 10 项自动搜索；`npm run check:selects` 阻止产品源码新增原生 select |
| 首页 | `apps/renderer/src/HomePage.tsx` | `home.get` / `usage.get` / 历史入口 |
| 首页身份 / 头像 | `apps/renderer/src/settings/operatorProfile.ts`、`avatarCrop.ts`、`AvatarCropDialog.tsx`、`HomePage.tsx`；桌面 `chrome-profile.ts` | 显示名本地记忆；选图后圆形裁切；头像写入 `%APPDATA%\omp-studio\profile\`（覆盖，无历史）；NSIS 卸载删除 |
| 历史 / 项目会话缓存 | `apps/renderer/src/HistoryPage.tsx`、`sidebar/useProjectHistories.ts`、`sidebar/provisionalThread.ts`、`studio-host/src/session-catalog.ts` | `history.list`；侧栏按 `workspaceId` 独立加载 / 分页 / 刷新；只有 title/session/model/thinking 元数据、尚无 `message` 的空白 JSONL 不进入历史；草稿非空或提示词已发送时显示 Renderer 临时行，正式 LLM 标题到达后按 `sessionId` 接管；归档成功的 `sessionId` 会阻止迟到的 Workbench 状态复活临时行；resume / archive / drop / delete（历史页「⋮ → 删除会话」走 `session.delete`，Host 清 transcript/artifacts/遥测/绑定/租约/pin 残留） |
| 命令面板 | `apps/renderer/src/CommandPalette.tsx`、`commandPaletteCatalog.ts` | 动作目录与路由 |
| 主题 / 密度 / 上次路由 | `apps/renderer/src/settings/appSettings.ts` | 本地 UI 记忆，不进 Host；旧 `LayoutMemory` 只作为迁移输入，新布局与 BTW 几何由 `dock/store.ts` 保存；侧栏项目展开与 Explorer 目录展开记忆在 `sidebar/expandMemory.ts` |
| 对话阅读宽度 / 窄窗口预算 | `settings/ConversationWidthSettings.tsx`、`settings/ConversationWidthContext.tsx`、`layout/{useReadingColumn,useWorkbenchLayout,workbenchLayout}.ts`、`conversation/conversationReflow.ts`；使用说明 `docs/conversation-width.md` | AppSettings 全局偏好，标准/宽松/填满/自定义；读取实际 `.convo-wrap` 宽度、正文与输入列共用净宽；左/右/底面板临时首选/有效布局与窄窗退让；离底阅读消息/块锚定，贴底仍由唯一 writer 负责；预览演示值不写真实存储。 |
| 工作台使用教程 | `apps/renderer/src/onboarding/{OnboardingHost,OnboardingTour,scenes}.tsx`、`timelines.ts`、`onboardingState.ts`、`onboarding.css`；`workbench/AppShell.tsx`（帮助菜单、`help.tutorial` 菜单命令、根部轻量 `OnboardingHost`）；Desktop `app-menu-shared.ts` / `platform/app-menu.ts` | 内容、舞台及 CSS 首次打开时加载。首次进入 0.2.0 自动弹出，必须走完 8 步才出现关闭按钮（不计停留时长），看完写 localStorage `omp.onboarding.completed`（改 `ONBOARDING_TOUR_ID` 可让老用户重看）；「帮助 → 使用教程」随时重开且随时可关。舞台是 640×400 低保真画布整体缩放，只有形状与图标、无文字；动画关键帧在 `timelines.ts` 用编排秒写、生成 CSS，整体节奏只改 `scenes.tsx` 的 `ONBOARDING_TEMPO`；元素的非动画样式即减少动效档位下的静帧。首启时教程先于启动提示；测试 `setup.ts` 关闭自动弹出，harness 页标记已看完（`preview-app-harness.html?tour=1` 保留） |
| 进入应用提示（尚未完成） | `apps/renderer/src/StartupNotice.tsx`、`settings/startupNotice.ts` | 中文全局弹窗：项目 GitHub、关闭 / 不再提醒；「不再提醒」只写 localStorage，不进 Host；GitHub 卡点开走 `ompStudioChrome.openUrl` |
| 预览开关 | `apps/renderer/src/preview/mode.ts`、`PreviewContext.tsx` | 显示层开关；`PREVIEW_MODE_SWITCH_ENABLED` |
| 预览 fixture / 壳 | `apps/renderer/src/preview/fixtures.ts`、`surfaces.tsx`、`btwPreview.ts`；`conversationFixtures.ts`、`conversationScenarios.ts`、`contentGallery*.ts`、`ContentGallerySamples.tsx`、`changeDiffsPreview.ts` | 新读表面必须同时接预览与真实；内容图鉴（t15）集中展示全部工具种类（排除 Ask）、正文/GFM、引用胶囊、代码高亮、图形和结果变体；末尾直接复用组件展示二进制 GLB 与未闭合围栏/命令/SVG/Mermaid 流式样例，无审批/Plan 演示弹窗；侧栏各会话独立故事，正文排版（t11）、多 Shell 命令（t13）、失败修复/空结果/长日志（t14）、工具图鉴（t10），保留空白/流式/中断/压缩；Git 与 Changes 使用逐文件差异，Problems/Tests/Logs 覆盖不同状态与长路径 |

模块内部分工：模型配置的草稿转换、Provider 发现、表单与角色控件位于 `models/config/`；Agent Hub 的投影、能力、导航、卡片、详情与作业行位于 `agents/hub/`。桌面网页活动由 `managed-browser-activity.ts` 管理，`managed-browser.ts` 连接 Electron 事件；30 秒闲置宽限期后节流，操作、下载、媒体和可见页面保持运行。

## 对话与 Composer

| 功能 | 入口 | 命令 / query |
|---|---|---|
| 通用标注 | `annotations/{Annotations,AnnotationDialog,AnnotationSourceView}.tsx`、`preview/annotationsPreview.ts`；Dock `annotations` 面板；Runtime `services/annotation-service.ts` | 每次关闭后打开均居中浮窗并聚焦压暗背景，拖动后解除遮罩；已打开时仅聚焦现有窗口；复用上下文查看器的停靠、置顶、缩放与最小化；`annotations.capture/prepare`；来源导航、行/选区/全文批注、定位/编辑/撤销、未完成草稿恢复与过期确认；只插入主 Composer；`artifacts.saveText/text.read` 保存重开快照 |
| 对话窗 | `apps/renderer/src/conversation/ConversationPane.tsx` | 订阅 conversation 事件 |
| 对话加载 / Store | `conversation/conversationSource.ts`、`conversationStore.ts`、`conversationEngine.ts`、`useConversation.ts` | `conversation.open` 先订阅后打开；目标级 watermark 去重；首屏 / replay / 实时增量统一进入有界 Store；App 只订阅低频 metadata，token 热流只更新 `ConversationPane` |
| 用户消息 Restore / 新会话 | `conversation/ConversationItemView.tsx`、`UserMessageBody.tsx`、`userMessageThumbs.ts`、`userMessageRestore.ts`、`UserMessageTreeConfirm.tsx`、`conversationEngine.ts`、`composer/serialize.ts` | 已发送用户气泡「恢复」（`undo` 图标）→ `session.tree.navigate`（leaf=该条 parent）；「新会话」（`branch` 图标）→ `session.tree.branch`（新 session 文件，切过去）。确认用应用内模态（归档同风格），不用 `window.confirm`。气泡仍画文件/技能/图片胶囊，配色与 Composer 同类胶囊一致（不刷成气泡白霜）。复制按钮与划选复制走序列化 `@` / `/skill:` / `[图N]`。图缩略图贴在气泡上方，点击预览；公开 transcript 仍剥图。预览字节落本机 IndexedDB（`omp-studio-ui` / `user-message-thumbs`），按 sessionId+itemId 重开会话仍能挂回缩略图，不进 Host。预览本地裁剪，不调 Host。busy 时 overlay 拒绝。`/branch` 提示点气泡，不打开 Changes。 |
| 对话客户端上下文 | `client-contract/src/index.ts`、`client/src/studio-client.ts`；Desktop `host-composition.ts`、`runtime-session.ts`、`ipc.ts`；`transport-desktop`、`transport-web`、Desktop `remote/{transport,wire,server}.ts` | 每场对话绑定工作区／会话，独立 bootstrap、订阅和回执；关闭上下文仅释放订阅，共享 Host / SSH 连接继续保留 |
| Client 全局状态 | `packages/client/src/reducer.ts` | 不保存 transcript / live message / tool output；`conversation.changed` 只推进 transport cursor，对话真值由 Renderer 目标级 Store 持有 |
| 正文 markdown / 流式渲染 | `conversation/markdown.tsx`、`markdownBlocks.ts`、`magicKeywordMarkdown.tsx` | 非流式整篇 `react-markdown`（remark-gfm；production 由有界 lowlight Worker 异步补色，dev/显式回滚用 rehype-highlight）解析；流式扫描结果拆成引用稳定的 `frozen` 前缀与有界 `pending` 尾部，检查点只续扫新增文本和少量上下文，渲染层分别 memo 两段，不再每帧重建全部历史切点。未闭合代码围栏不进入 `react-markdown`，直接复用 `CodeFrame` 的安全 `<pre><code>` 样式，闭合后恢复完整 Markdown，代码框即时显示、语法颜色异步补齐。普通切点只落在空行处且要求下一行确实开启新块；围栏内部、松散列表、缩进续行、setext 下划线都不切。链接引用定义从上一条未完整行增量检测，命中后整段保持同一 Markdown 解析域。mermaid 在流式中降级为 `<pre>`，收尾后经可见性、大小/复杂度预算和串行队列渲染；按完整渲染配置 + 源码缓存 SVG（32 项 / 4MiB） |
| 快照行复用 / 渲染节流 | `conversation/conversationStore.ts`、`conversationViewModel.ts`、`conversationEngine.ts`、`subagentConversationEngine.ts` | Store 限 2,000 items / 24 MiB，live block 256 KiB、tool output 64 KiB，pending / notice / live message / live tool 均有硬上限；增量按 RAF 合并，流式 chunk 在帧边界压成文本。持久历史前缀只在结构变化时重投影，token 热流只投影有界 transient 尾部；工具事件（`tool.started` / `tool.completed` / `tool.updated`）只标脏所属行而不整窗重投影；Transcript 的 binds / keys 按结构 token 缓存。`rowCache` 在 trim / hydrate / restore 等结构路径按活跃 key 剪枝，不保留被窗口淘汰的正文。主会话和每个已打开子代理各持有独立 Store；不可见时停止订阅，关闭时释放 |
| 时间线虚拟化 | `conversation/ConversationVirtualList.tsx`、`ConvoTranscript.tsx`、`rowHeightCache.ts` | 基于 `@tanstack/react-virtual` 动态测高与 overscan；挂载行硬上限 120；未测量的新面板只临时渲染末尾 20 行，禁止回退为全量 DOM；预览 fixture 可全量渲染。行高按行键跨挂载记忆（`rowHeightCache.ts` 模块级、上限 8192），重挂时估高直接取上次实测值，测量仍是权威。`ConvoTranscript` 的行元素按「行对象 + bind + 回调」缓存身份：虚拟列表每取一次测量就重渲染一次（工具卡高度过渡时每帧一次，流式时每帧一次），未变的行靠引用相等整棵子树跳过，`onReviewChanges` 也不再每帧新建闭包穿透 memo |
| 会话切换加载 / 显示 | `conversation/useConversation.ts`（`retainConversationWhileRemounting`）、`ConversationPane.tsx`、`conversationSwitchPhase.ts` | 同一 sessionId 的 engine 重挂期间保留上一份 transcript；跨会话时旧 ReactNode 在 `leaving` 全程保持，即使新快照提前到达也不换 DOM。新 transcript 在 `settling` 中以 `opacity: 0` 挂载两帧，等虚拟列表实测高度与唯一跟底写入完成后再淡入，避免首屏估高、实测和贴底造成一两次可见跳位 |
| 活动行 / 暂停恢复 | `conversation/ActivityLine.tsx`、`activityStatus.ts` | `runtime.pause` / `resume` / `core.abort` |
| 工具卡片 | `conversation/ToolBody.tsx`、`BatchChain.tsx`、`toolMeta.ts`、`bashDisplay.ts`、`useToolCardFollowScroll.tsx`、`textChunks.tsx` | 工具展示元数据；`ToolBody` 按 `tool` 身份 memo（派生层复用 ToolView 对象，流式期间只有在跑的那张卡重渲染）；`ToolItem` / `ThinkCard` 同样 memo，链内 toggle handler 保持稳定身份。正文首次展开才挂载、收起过渡结束后卸载；收起/展开的 `0fr → 1fr` 高度过渡在流式与静止两态共用，只有「仍在运行」的卡片（正文逐帧在变）按 `tool.status` 逐卡瞬时挂载/卸载，手动收起仍有工具在跑的链才同步卸载整链卡片。`bashDisplay` 按「同类别的连续行」合段（`.codeblock` 是 `white-space: pre`，纯字符串输出因此是单个文本节点），`streamingFrameCost.test.tsx` 用「长日志提交时间 ≤ 短日志 2.5 倍」钉住；长输出（Bash 块 / Think 正文 / 默认 Output）再经 `textChunks` 按 64 行分块、块上 `content-visibility: auto`，视口外跳过布局与绘制（短文本仍是单文本节点）；卡内滚动面板声明 `contain: layout paint`；bash 直播剥 ANSI / `\\r`，先裁尾（末尾 1500 行 / 64 KiB）再处理并 `useMemo`；展开卡内流式输出跟底，卡内上滚同样按手势脱离（与对话区共用 `bindTailGestures`）；`ToolCardScroll` 只在 live 尾卡上装 ResizeObserver，跟随写入按帧合并 |
| 会话变更 | `conversation/SessionChanges.tsx`、`sessionDiff.ts`、`ChangesPanel.tsx`、`TurnDiffCard.tsx`、`ChangesDockMeter.tsx` | 本轮文件改动；`sessionDiff` 从成功的会话工具结果重建可审核 hunks；对话 diff 卡「审核」跳到对应轮次；`ChangesDockMeter` 在面板正文之外发布折叠卡摘要（最近一轮文件数 + 行增减），与 `panels/registry.ts` 的 `meter` 标记配套 |
| 滚动 / 小地图 | `useConversationScroll.ts`、`ConversationMinimap.tsx` | 贴底时由一个观察最终 `.convo-doc` 与滚动盒的 ResizeObserver 写 `scrollTop`；虚拟列表不再有第二条 rAF 写入路径，无 ResizeObserver 环境才由 `contentKey` layout effect 回退。上滚**按手势**（wheel / ArrowUp·PageUp·Home / 触摸）立刻脱离，不等 scroll 事件；被工具卡内层滚动条吃掉的滚轮不算脱离。回到底部（≤1px）或滚回 72px 内自动重挂，也可点「回到最新」。「加载更早消息」在点击时抓锚点并主动脱离，页面前插后按首行 id 变化确认并还原阅读位置。minimap 圆点按行对象缓存派生（`markCache`），`measure()` 一次 `querySelectorAll` 批量读 rect 并在「圆点集合与 scrollHeight 都未变」时整体跳过，全量重测限频到 700ms；活跃圆点布局读取只在真的重测时同行，滚动事件只更新视口条；位置变化小于 0.002 不重渲染轨道；`ResizeObserver` 只装一次、回调按帧合并。视口条 / 轨道拖动按 rAF 合并（每帧至多一次 `scrollTop` 写入、读全部前置于写），拖动期间强制重测降级、pointerup 后补一次。轨道贴在对话区**左边缘**（`.minimap` 的左右让位、预览浮层与工具菜单方向按同一条边成对改） |
| 空态 / 最近会话 | `ConversationEmpty.tsx`、`emptyRecents.ts`、`welcomeGate.ts` | |
| 瞬时状态 toast | `transientStatusNotice.ts` | 与持久诊断分开 |
| 子代理对话 | `subagentConversationEngine.ts`、`useSubagentConversation.ts`、`SubagentConversationPane.tsx` | live 走 `conversation.open` 的 `{parentSessionId, agentId}` target，按 child `conversationSessionId` 接增量；历史走 `session.transcript.readPage`；多个可见目标独立持有引擎和订阅，隐藏暂停、关闭释放，断连保留已读内容；共享正文样式与 `agent.send` 附件输入；`conversationReveal.ts` / `ConvoTranscript.tsx` / `ConversationVirtualList.tsx` 先挂载虚拟行再定位来源或恢复锚点 |
| 子代理卡片 / 悬停预览 | `conversation/BatchChain.tsx`、`SubagentHoverContext.ts`、`SubagentHoverPreview.tsx`、`subagentHoverPreview.css`、`preview/subagentConversation.ts` | 36px 图标、状态胶囊与任务单行省略，移除冗余的最近动态；悬停或聚焦 300ms 后在卡片所属窗口挂载只读浮层，复用完整 `ConvoTranscript`、子代理 Hook、虚拟列表与跟底。父会话/执行环境/运行代次隔离；只在显示期间读取、订阅并登记实际子会话可见租约，移开/点击/Escape/原对话滚动/切换会话/失焦即释放。真实模式空态与离线保留，预览模式按需播放本地流式 fixture，演示标记遵守 marks |
| Agent 名册 / 停靠详情 | `agents/AgentRosterPanel.tsx`、`AgentRosterMeter.tsx`、`agentPresentation.ts`、`AgentDetailPanel.tsx`、`agents.css`、`conversation/subagentViewState.ts` | 名册支持标准／固定单行极简，折叠和图标态显示聚合状态；名册、委派卡片与 Dock 菜单统一打开会话级 Agent 实例，原生标签可拆分、合组及应用内浮动；Dock 保存实例和布局，预设只保存通用落点；多个可见子对话共享主窗正文与输入组件，并按目标隔离草稿、队列、内容页签及阅读锚点；不可见时暂停热流与本地队列，运行代次变化禁止旧队列自动发送 |
| Agent 测试面板 | `AgentTestsPane.tsx`、`agentTestRuns.ts` | |
| Chip Composer | `apps/renderer/src/composer/ChipComposer.tsx`、`composer/useComposerDraft.ts`、`composer/draftStore.ts` | Enter：`core.prompt` / 本地排队；Ctrl+Enter：`core.followUp`（带图）；插入纠偏：`core.steer`；精确草稿与目标级草稿簿不走击键 React state，140ms trailing 发布，状态边界与命令式恢复立即发布 |
| 空输入「继续」播放键 | 发送位 `workbench/WorkbenchCanvas.tsx`（stop / continue / send 三臂）、`composer/dispatch.ts`（`composerContinueEnabled`）、`conversation/conversationViewModel.ts`（`tailInterrupted`）、`conversation/conversationStore.ts`（`lastTurnInterrupted`）；overlay `studio/services/session-control-service.ts`（`continueTurn`）、`studio/state-projector.ts`（`lastTurnOutcome`） | 上一回合停在「没有最终汇报」的尾巴上（报错 / 手动中止 / 崩溃补记）且输入框为空时，发送位换成播放图标。命令 `core.continue`：先 `restoreInterruptedTurn()`，否则发**隐藏 synthetic** 的 `manual-continue.md`（不产生用户气泡）。旧 Runtime 无该能力时降级走 `turn.retry`。判定来源是 `OperatorStateSnapshot.lastTurnOutcome`，不是 transcript 字段 |
| 图片预览 | `composer/ImagePreview.tsx`；桌面 `chrome-image.ts` | 缩略图点击预览；复制/保存走 `ompStudioChrome`，不是 Host |
| slash 命令菜单 | `composer/commands.ts`、`CommandMenu.tsx` | 解析后走语义 command；typed 名必须在 `operations.ts` / IPC `COMMAND_NAMES`。`/clear` → `session.clearContext` → facade `#commandP4` → overlay `clearContext`；`/drop` 补当前 `threadId` 后走 Host `session.drop` |
| @ 提及 | `composer/mentions.ts` | `workspace.fileTree`、`agents.definitions.get`、查询非空时 `skills.get` |
| 模型 / 模式选择 | `ComposerModelPicker.tsx`、`ComposerModePicker.tsx`；`WorkbenchCanvas.tsx` 准备目标会话 | `session.model.set`、`session.thinking.set`、plan/vibe；冷会话选择模型先通过 `session.create` / `session.resume` 携带启动模型，再执行切换 |
| 消息队列条 | `MessageQueueBar.tsx`、`composer/queueEdit.ts`、`composer/dispatch.ts`（`composerOwnerSessionId` / `composerRunningForTarget`） | 流式 Enter 本地排队（按 session 隔离），idle 后 `core.prompt`；会话归属由 `composer/dispatch.ts` 判定：新建会话 `session.create` 回执落地前快照仍指向旧会话，此时 Enter 不进排队，而是等新会话创建后发送；第一条等待创建期间再次 Enter 保留输入框草稿，同步 dispatch 锁阻止同帧重复发送。草稿与侧栏当前行也不归到旧会话；「插入纠偏」`core.steer`；`/queue` 为 `queue.enqueue`，带图片时改 `core.followUp`。编辑在 Composer 内进行，条目留队；编辑队首时暂停 flush |
| Runtime 已提交队列 | `composer/RuntimeQueueBar.tsx`、`preview/runtimeQueuePreview.ts` | `session.queue.get/remove/promote/edit/restore`；原生对象 ID 区分重复正文；编辑保留图片及隐藏上下文；Studio 中止后保留原生组，显式恢复才排队；真实模式不回填演示 |
| 历史会话模型恢复 | `models/SessionModelRecovery.tsx` | 原生 `session.restore.inspect` 只读检查；显式选择后 Host `session.resume` 携带 model，Desktop 将 `--model` 传给目标 Worker；失败保留已有 Worker |
| Composer 服务档位 | `composer/ComposerSpeedControl.tsx`、`ComposerModePicker.tsx` | `session.speed.get/set`；按能力显示四档；旧 Runtime 保留 Fast 布尔入口；全局 Slow 策略提示确认 |
| 审批 / 原生表单 / 旧 Ask | `InteractionDeck.tsx`、`deck/{ApprovalCard,FormCard,FormFields,FormSession,AskCard,QueuedDeck}`、`askGenie.ts`、`interactionGate.ts` | `interaction.form.read` 瞬时正文 + `interaction.respond`；native DTO、单一 inactivity timer、图示安全边界和 lease fencing；折叠/队列保留输入；旧 Ask 仅兼容。沿用底边浮入，不复用 Composer gated |
| Plan 评审 | `deck/PlanCard.tsx`、`deck/PlanCreatedCard.tsx`、`planSections.ts`、`planFeedback.ts`、`conversation/toolMeta.ts`（`xd://propose`） | 出现时保持紧凑卡，点放大或对话入口才展开大卡；紧凑卡与展开卡右上角均放「保存并退出」（能力存在时显示），不再占用底部评审操作区；大卡章节批注；大卡底栏常驻全文批注（整份计划）；大卡右上角叉号收成紧凑卡；有意见 `mode.plan.review.respond` refine，空 Refine 走 dismiss 回 Composer；批准 `execute` 清上下文、`compact` 先压缩再执行、`keep` 保留上下文（`approve` 是 keep 别名）；钉在 `xd://propose` 所在 assistant 行（批准后不跟到最新轮）；执行后入口卡打开只读大卡回看正文，不再打 `mode.plan.review.open` |
| 权限档位 | `ComposerApprovalPicker.tsx`（`workbench/WorkbenchCanvas.tsx` 接入） | `permissions.mode.set`；预览本地切换；历史会话先 `session.resume` 再 set；流式 / 压缩中可改，下一轮对话才写入 `tools.approvalMode` |
| BTW 旁路问答 | `apps/renderer/src/btw/`（`BtwPanel.tsx`、`useBtwSession.ts`）；窗口统一由 `dock/` 管理，旧独立浮窗 / 胶囊 / 几何实现已移除 | `/btw` → `btw.ask`；中止 / 分支 `btw.abort` / `btw.branch`；事件 `btw.changed` |
| 会话生命周期 UI | `apps/renderer/src/sessionLifecycle.ts` | `session.create` / `resume` |
| 侧栏运行态 / 等待态 | `sidebar/threadRunning.ts`、`threadWait.ts`、`ThreadSpin.tsx`、`ThreadWaitChip.tsx` | 当前会话从 live snapshot、后台会话从 `residents.list` / `residents.changed` 摘要推导；不把后台 snapshot 注入当前会话 |
| 对话环境卡 | `environment/EnvironmentCard.tsx`、`environmentCardModel.ts`、`environmentCard.css`、`icons.tsx`（`changes`）、`preview/environmentCardPreview.ts` | 对话工具区（rail）：项目名与次级路径同行排列，路径靠右且可省略截断，文件夹图标作为视觉锚点；路径为 `WorkspaceRecord.root` 的父目录，只用于显示。运行环境与 Runtime 版本弱化呈现，未连接时图标转琥珀/红；内缩分隔线下方为分支和未提交变更，紧凑行距，红绿比例条紧贴卡片底边；rail 卡片统一使用 16px 圆角，独立挂载的 Environment 内容层同步裁切底部内圆角。只读投影既有读模型，不新开 query；项目行打开 Files、分支行打开 Git、变更行打开 Changes；预览走同形 fixture |
| 对话上下文卡 | `conversation/ContextCard.tsx`、`contextCard.css`、`SessionCompactionInput.tsx`、`useSessionCompaction.ts`、`preview/contextCardPreview.ts`；注册 `panels/registry.ts` 与 `workbench/WorkbenchCanvas.tsx` | 默认放在 Environment 下方，可折叠/移动；折叠为标题+用量百分比+短进度条，悬停/键盘聚焦时右侧拖动指示渐显并将用量平滑内推，所有对话卡片的拖动指示统一保留 14px 右侧留白；最小图标态由外圈按完整窗口比例绘制消息/工具/指令文件/系统提示与 Skills 的四组身份色分段，与展开卡片共享固定颜色、名称/数字和次级形状；详情保留完整原生分类、source markers 与 caveat；剩余空间保留中性底线，悬停显示各类用量，未知用量显示中性状态。三态共用一份实时 telemetry 与按需历史读取，初始折叠也读取用量；展开显示容量、分类 tokens/百分比与剩余空间。对话工具区所有卡片及图标的菜单通过标题/图标右键或 Shift+F10 打开，移除卡片的三个点按钮。无数据时显示空态；当前运行会话的详情打开可停靠的 `ContextInspector`，历史会话仅展示用量记录。预览与真实共用组件，演示标记遵守 marks；旧布局仅首次补入卡片，保留用户隐藏/移动选择。 底栏提供立即压缩与会话阈值输入：无单位且小于 100 按百分比，其他数字和 k/m 按 tokens；Enter/保存确认，Esc 撤销，清空恢复继承。`session.compaction.get/set` 通过 Runtime 的 `services/session-compaction-{service,policy}.ts` 写入带 sessionId 的 custom 元数据，优先于模型策略、重开保留、分叉不继承；`session.compaction.read` 由 Host archive reader 离线读取，历史对话保存前恢复对应会话。原生触发点接在 `session-maintenance.ts`，上下文构成接在 `context-usage-runtime.ts`；预览值按演示对话隔离。 |

Host 侧对话事件：`packages/studio-host/src/conversation-events.ts`。  
Runtime 投影：overlay `services/conversation-live-projector.ts`、`conversation-projector-hub.ts`；流式 block 实时限制 256 KiB，完成后释放正文/工具输出，只保留固定容量的幂等 tombstone。合流缓冲有两份且都是无损的：文本按 block（16ms 或 64 字符），工具输出按 tool call（16ms 或 4 KiB 未发送尾部），append / replace 按「客户端已收到的前缀」决定；控制事件与工具结束先 flush，顺序不变。投递是同步的（无队列）：慢 listener 反压 Runtime，不丢事件。
持久 transcript：overlay `services/session-transcript-service.ts`；Host `session-archive-reader.ts`（`session.transcript.readPage`）。

会话切换数据入口：Renderer `conversationWorkspace/projectReads.ts`、`client.ts`；Host `apps/desktop/src/project-read-services.ts`、`packages/host-client-api/src/shared-reads.ts`；归档 `session-archive-{reader,pool,worker}.ts`。说明：[会话切换重构](../docs/session-switch-refactor-20261110.md)。

## 会话、归档、Telemetry

Time Travel：`history/TimeTravel{Activation,Dialog,Pane}.tsx`、`history/useTimeTravelSettings.ts`、`history/timeTravel.css`、`settings/TimeTravelSettings.tsx`；预览 `preview/timeTravelPreview.ts`，验收入口 `time-travel-harness.html?preview=1`。Host `time-travel-service.ts` / `time-travel-port.ts` 组装 `studio-host/time-travel-store.ts` 与 `session-archive-reader.ts`；契约 `client-contract/time-travel.ts`、`studio-protocol/contracts/time-travel.ts`；Runtime overlay `services/time-travel-boundary.ts`、`tree-service.ts`，回合边界接缝在 `agent-session.ts`。说明见 [Time Travel](../docs/time-travel.md)。

| 功能 | Host / Desktop | Runtime overlay |
|---|---|---|
| 创建 / 恢复 / 删除 | `apps/desktop/src/session-commands.ts` | `services/session-control-service.ts` |
| 目录扫描 | `studio-host/src/session-catalog.ts` | — |
| 归档 / 解档 | `studio-host/src/session-archive-service.ts` | 切走 live 文件后再 gzip |
| Archive / Recap 查询 | `HistoryPage.tsx`、`history/NativeArchivePane.tsx`、`preview/archivePreview.ts` | `archive.sessions.list/recaps.list/prompts.search/session.inspect`；native Archive、限量列表和详情、不接受文件路径 |
| 永久删除 / 残留清理 | `studio-host/src/session-delete-service.ts`；历史页 `HistoryPage.tsx`「⋮ → 删除会话」 | — |
| 线程绑定 | `studio-host/src/thread-binding-store.ts` | — |
| 多会话经纪 / 居民摘要 | `studio-host/src/session-broker.ts`、`session-registry.ts`；桌面 `runtime-session.ts`、`host-composition.ts`；facade `residents.list` | — |
| 租约 / 代次 | `studio-host/src/session-lease-store.ts` | overlay `services/interaction-port.ts` |
| 命令账本 / 收据 | `command-ledger.ts`、`receipt-registry.ts` | overlay `command-arbiter.ts` |
| live telemetry | `session-telemetry-store.ts`、`telemetry-probe.ts` | `session-telemetry.ts`、`session-telemetry-probe.ts` |
| 已归档 telemetry 读 | facade `session.telemetry.read` | overlay 测试 `studio-archived-session-telemetry.test.ts` |

Renderer 读当前查看会话：`apps/renderer/src/telemetry/useViewedSessionTelemetry.ts`。

## Agent Hub、Skills、MCP、模型

| 功能 | UI | Host 适配 | Runtime |
|---|---|---|---|
| Agent Hub 页 | `apps/renderer/src/AgentHub.tsx`、`conversation/SubagentConversationPane.tsx`、`conversation/persistedSessionAgents.ts` | 名册：`session.agents.list` 与 live `snapshot.agents` 合并（仅 viewed session === live session 时叠 live）；写操作（spawn/send/kill/revive/release/`job.cancel`）仅 live 会话；历史 Transcript 不读 live `agent.transcript.read`，用「打开」走归档对话；详情「打开」走 `agent.conversation.read`，缺失或非 live 则 `session.transcript.readPage` + `agentId`；聊天附件胶囊经 `agent.send` | overlay `services/agent-hub-service.ts`、`job-service.ts` |
| 批量评审 | `judgments/JudgmentsPane.tsx`、`preview/judgmentsPreview.ts` | `judgments.list/create/read/cancel/close/retry`；有界分页、付费操作前确认、结果保存产物库 | overlay `services/judgment-service.ts`；native `eval/judgment-batch-bridge.ts` 独立观察游标 |
| 子代理面板 | `SubagentsPanel.tsx` | `agent.spawn/send/kill/revive/release` | 同上 + `agent-conversation-service.ts` |
| 子代理配置模型与路由详情 | `AgentHub.tsx`、`models/AgentModelDetails.tsx`、`preview/agentModelPreview.ts` | 启动使用代理配置；`agent.spawn.options`、`agent.model.inspect` | 18.14.2 起支持由原生配置授权的单次精确模型/effort；`services/task-options-service.ts` 提供可选项，`agent-model-service.ts` 验证父子归属并报告实际 serving model/thinking |
| 隔离子任务 / 多补丁 | `AgentHub.tsx`、`conversation/persistedSessionAgents.ts` | archive 的 `session_init.isolated` 经 Desktop 投影；历史只读 | `AgentHistorySummary.isolated/nestedPatchPaths` → overlay Hub 的 `canRevive`；send/revive 均在 Runtime 拒绝不可恢复的隔离任务 |
| 任务代理定义 | `AgentHub` / Capabilities | `omp-agent-definitions-adapter.ts` | 磁盘 `.omp/agents/*.md`，不是 Hub live 态 |
| Skills 抽屉 | `SkillsDrawer.tsx`、`skills/skillUsage.ts` | `omp-extensibility-adapter.ts`、`skills.get` / `skills.setEnabled` | overlay `skill-prompt-expansion.ts` |
| MCP | `CapabilitiesPage.tsx`、`capabilities/McpRuntimePane.tsx` / `mcpRuntime.css`、`McpAuthActions.tsx`；会话连接状态总览、筛选、工具展开与按服务器授权回执 | `omp-mcp-adapter.ts`、`omp-mcp-probe.ts`、`mcp.get` / `mcp.setEnabled` / `mcp.refresh` / `mcp.test` / `mcp.logs.get` | 配置扫描 + Host 一次性探测；独立 `mcp.runtime.status` 从 native manager 读取当前连接、工具身份/只读提示、连接方式、来源与原生脱敏的失败原因；授权/登出/重连完成后重读真实状态；stdio 只显示重连 |
| 提示词模板 | `capabilities/PromptTemplatesPane.tsx` / `promptTemplates.css`、`preview/runtimeCatalogPreview.ts`；来源与名称筛选、自动查看首项、原文参数高亮、引号参数与展开预览；公共标题/读取在 `RuntimeCatalogShared.tsx`，入口重导出 `RuntimeCatalogPanes.tsx` | `templates.list/get/prepare`；保留已加载版本身份、分页与刷新；版本未变时切换页签保留参数/展开结果，参数修改清除旧展开，确认后插入主 Composer，不发送 | `services/runtime-catalog-service.ts`；当前 session 已加载模板及版本，原生位置参数/Handlebars/无占位符参数追加语义 |
| 评测工作区（四模块、历史与导出） | evaluation/EvaluationWorkspace.tsx、EvaluationConfig.tsx、EvaluationResults.tsx、EvaluationActivity.tsx、evaluationPolling.ts；preview/evaluationPreview.ts | Host evaluation-coordinator.ts；Desktop evaluation-workspace.ts、runtime-session.ts；evaluations.*；读取单路串行、事件合并、隐藏窗口暂停，历史按事件刷新；使用说明 docs/evaluation.md | overlay services/evaluation-workspace-service.ts、evaluation-ratchet-runner.ts；原生 bench / if-bench / judge_batch / ratchet |
| 模型基准测试 | `models/BenchmarkPane.tsx`、`preview/benchmarksPreview.ts` | `benchmarks.list/start/read/cancel/close`；报告保存产物库 | `services/benchmark-service.ts` + `cli/bench-cli.ts` 结构化进度/中止；原生工作负载/指标 |
| 能力中心 | `CapabilitiesPage.tsx` | Skills 开目录 `skills.reveal` / `skills.revealRoot`（Desktop `shell.openPath`）；Slash 页 `visibleSlashCatalog()` + `App.runSlashCommand`，不是 `commands.getManifest` | overlay `command-manifest-service.ts` 仍只服务协议 manifest |
| 模型配置页 | `ModelConfigPage.tsx`、`models/fetchedModels.ts`、`models/providerYaml.ts`（卡片 YAML 文本产出）；表单→models.yml 节点映射在 `packages/client-contract/src/provider-yaml-draft.ts`，与 Host 的 `toYamlProvider` 由 `packages/host-client-api/test/provider-yaml-draft-parity.test.ts` 钉齐、`models/WebSearchPanel.tsx`（网络搜索 tab）、`models/WebRoleChain.tsx` / `webSearchChain.ts`（统一搜索链）、`models/useSearchCredentials.ts`（Runtime 凭据）；列表拖拽共用 `models/useListReorder.ts` | `omp-models-adapter.ts`、`models-yml.ts`；「自动获取模型」走 `models.provider.probe`（不传 `discoveryType`，Host 按 api 类型选模型列表地址与认证头），候选清单只进表单草稿，保存才写 `models.yml`；编辑器下方的 `models.yml` / `config.yml` 结构化卡片由当前表单草稿派生（`deriveProviderSlice` / `deriveRoleSlice`），表单有未保存改动时即时刷新并转为只读，未接管字段与源文件一致；网络搜索 tab 为「可排序搜索链 + 供应商库」：点击「加入链条」追加末尾，模型型供应商先选具体模型；链条拖拽/箭头排序后第一项映射 `modelRoles.web`、其余映射 `retry.fallbackChains.web`，保存前只改草稿（含供应商描述与凭证状态、searxng 全量字段）；配置（`web_search.*` / `providers.webSearch*` / `searxng.*` / `exa.*`）走 `models.webSearch.set`，写 `config.yml`；凭据统一在供应商弹窗管理，经 `search.credentials.list/set/remove` 读取当前 Runtime、按 CLI 登录来源保存、按凭据 ID 删除；Exa/Firecrawl 支持可选密钥，无上方重复入口 | overlay `services/search-credentials-service.ts`（CLI AuthStorage / logoutCredential）、`model-control-service.ts`（会话内切模型） |
| 发现 / 插件根 | — | `host-client-api/src/omp-discovery/**` | — |
| Token 用量 | Home / `usage/tokenUsage.ts`；顶栏 `usage/TokenUsagePanel.tsx`、`tokenUsagePanel.css`、`TokenCounterPane.tsx`；预览 `preview/tokenUsagePreview.ts` | `omp-usage-adapter.ts`、`usage.get`；顶栏 `session.telemetry.read` | 首页聚合 `omp stats.db`；顶栏真实/预览共用紧凑详情面板，含总量、构成、本轮指标与折叠明细；上下文查看器入口位于 Context 构成弹窗，离线计数入口打开独立可停靠工具 |
| 动态价格 / 图片能力 | `ModelConfigPage.tsx` | `omp-models-adapter.ts`；`client-contract/src/model-pricing.ts` 解析只读分时价/长上下文价；固定覆盖与价格元数据分开 | 保留上游 catalog policy，历史费用只读已记录 usage |
| 模型参数自动适配 | `models/ModelParameterEditor.tsx`、`modelParameterDraft.ts`、`fetchedModels.ts`；预览 `preview/modelAdaptationPreview.ts` | `models.adaptation.resolve`、`models.catalog.refresh` → `host-client-api/src/model-adaptation.ts`；完整 thinking / 原始参数与来源旁文件由 `omp-models-adapter.ts` 读写；目录生成 `scripts/model-catalog.mjs` | 只写原生 models.yml 支持字段，保留 Runtime 请求编码；[使用与维护](../docs/model-adaptation.md) |
| 角色路由与模型压缩 | `ModelConfigPage.tsx`、`models/config/RoleControls.tsx`：统一列布局，失效分配仍可切换，搜索／键盘选择，清除分配恢复自动路由；`models/ModelCompactionPane.tsx`、`models/modelCompaction.css` 同时用于角色总览与详情；预览 `preview/modelCompactionPreview.ts` | `models.roles.set` 保留原生空 selector 清除语义；压缩保存后经 `preferences.features.get` 重读生效值并刷新 Runtime 模型目录 | `services/feature-settings-service.ts` 复用原生 `planModelCompactionPoint` / `setModelCompactionPoint`，保留扩展窗口确认、前缀继承及配置来源优先级；保存回执等待 `reapplyModelPolicies` 完成 |

预览 fixture：`hubPreview.ts`、`skillsPreview.ts`、`capabilitiesPreview.ts`、`preview/modelConfigFixtures.ts`（含 `createPreviewFetchedModels()`）。不要把这些写进 Host。

## Git / GitHub / 工作区文件

Git **不走 Runtime Bridge**。桌面主进程实现，Facade 转调。

| 功能 | UI | 实现 |
|---|---|---|
| 状态 / 暂存 / 提交 | `apps/renderer/src/git/GitStatusPanel.tsx`、`git/useGitRepository.ts`、`git/GitDockMeter.tsx` | `apps/desktop/src/git-service.ts` → `git.execute`；仓库读按 client/workspace 共享订阅与在途请求，失效通知合并补读；`GitDockMeter` 复用同一份仓库状态，在面板正文之外发布 `git` / `git-quick` 折叠卡摘要 |
| 对话区 Git 快捷卡 | `git/GitQuickCard.tsx`、`git/useGitQuickReads.ts`、`git/GitWorkspaceContext.tsx` | 独立 `git-quick` 停靠工具；纯图标切换更改 / 历史 / Issues / PR，按工作区记忆；历史支持列表 / 历史树切换并记忆；按视图读取 5 条提交或 3 条协作条目；与完整 Git 共享工作区状态、提交草稿、远端和操作；Git 拖到对话工具列时使用快捷卡预览和落点；旧 rail Git 布局迁移在 `dock/model.ts` |
| Composer 项目上下文条 | `workbench/WorkbenchCanvas.tsx` 项目上下文条、`workspaces/ExecutionTargetPicker.tsx` | 只在还没发送消息的新对话显示整条（项目 / 分支 / 执行位置 / Git 增删统计），贴在 Composer 上沿；已开始的对话整条隐藏，项目和分支看顶栏；点击统计展开右侧 Git 页签；预览 / 真实共用 `onOpenGit` |
| 面板拆分 / 更多操作 | `git/GitPanelSplit.tsx`、`GitMoreActionsMenu.tsx` | 操作 kind 见 `client-contract/src/git.ts` `GitOperation` |
| 文件树 git 徽章 | `git/treeStatus.ts`；`sidebar/WorkspaceTree.tsx` `RealFileTree` | `git.repository.get` |
| Explorer 读写圆点 | `conversation/explorerFileActivity.ts`；`sidebar/WorkspaceTree.tsx` `RealFileTree` | 主会话 `liveTools`：读红点、写绿点；预览用 fixture `reading`/`writing` |
| log / diff | Git 面板；工作区 Diff：`git/GitPatch.tsx`，复用 `conversation/ChangesPanel.tsx` 的上下 / 左右对照控件与行展示 | `git-log.ts`、`git.diff.get` / `git.log.list` / `git.commit.*` |
| GitHub Issues / PR | `git/GitWorkbench.tsx`（更改 / 历史 / Issues / PR）、`git/GitHubPanel.tsx` | `apps/desktop/src/github-service.ts`、`github-reads.ts`；按远端查询与 `github.execute`；预览：`preview/githubPreview.ts` |
| Git 提交 / Issue / PR 输入框引用 | `composer/gitCommitReference.ts`、`githubReference.ts`、`GitHubReferencePreview.tsx`、`ChipComposer.tsx` | Git 快捷卡历史行可引用提交信息与变更文件清单；Issue / PR 收录正文、讨论及可选文件 Diff；发送 / 恢复 / 剪贴板保留胶囊；浏览器验收：`github-harness.html?preview=1&marks=off` |
| 工作区注册 | 首页 / 设置 | `studio-host/src/workspace-registry.ts`、`workspace.open` / `pick` |
| 文件树 query | `sidebar/WorkspaceTree.tsx` `RealFileTree` | facade `workspace.fileTree`；磁盘 `apps/desktop/src/workspace-files.ts` |
| 通用文件窗口 / 编辑与预览 | `files/{FileDockInstances,FilePane,FileTextEditor,PdfPane,SpreadsheetPane,OfficePane}.tsx`、`fileDocuments.ts`、`fileLinks.tsx`；Dock `file-view:` 实例 | `workspace.file.inspect/readText/readChunk/writeText` → `workspace-files.ts`；桌面 `file-resources.ts` 的 `omp-file:` Range 通道覆盖本地 / SSH；保存版本冲突、共享缓冲、布局恢复与关闭确认；预览 `preview/filesPreview.ts`，说明 `docs/file-viewer.md` |
| 文件窗口头部 / 状态栏 / Git 标记 / 添加到对话 | `files/{FileHeader,FileStatusBar}.tsx`、`gitMarks.ts`（hunk → 行号旁标记）、`fileActions.ts`（`workbench/AppShell.tsx` 的 `fileViewerActions` 复用 Explorer 文件菜单动作与 Composer 胶囊）、`filePreferences.ts`（换行 / 字号） | Git 改动走 `git.diff.get`（`target: "working"`），Diff 视图复用 `git/GitPatch.tsx`；预览补丁 `previewFilePatch` |
| 可选 Office 预览组件 | `files/FileViewerSettings.tsx`；更新与维护的「可选组件」 | Desktop `office-component.ts` / `office-process.ts` / `office-component-manifest.ts` / `file-viewer-ipc.ts`；仅主动安装，独立签名工件；打包 `scripts/office-component.mjs`，独立验收 `office-component-smoke.mjs`，手动 workflow `office-component.yml` |
| Explorer 文件 ⋯ / 右键菜单 | `apps/renderer/src/menus.tsx`（`MenuItem` / `FileRowMenu`）、`sidebar/WorkspaceTree.tsx` `RealFileTree`；`useRowMenuAnchor` 与会话行共享定位；预览 `preview/surfaces.tsx` 同款 | 打开 / 打开方式（已装编辑器子菜单 + 系统「打开方式」）/ 资源管理器定位 / 复制绝对路径 = workspace-shell 文件级通道（`workspace-shell-shared.ts` `fileOpen` / `fileOpenWith` / `fileReveal` / `fileAbsolutePath` / `fileOpeners`，Main 强制包含性校验）；复制相对路径 = Renderer 剪贴板；「添加上下文」复用 @ 按钮的 Composer 胶囊链路；目录「打开」= 树内展开；预览态桌面项禁用 |
| 拖放路径 | Composer / Explorer | `apps/desktop/src/dropped-paths.ts` |
| 外部编辑器 | 工作区壳 | `external-editor.ts`（`listExternalEditorCommands` 同时供「打开方式」子菜单）、`workspace-shell-ipc.ts` |

## 终端、窗口铬、设置、诊断

这些通道 **不是** Host `DESKTOP_IPC_CHANNELS`。preload 上是独立冻结对象。

| 功能 | Renderer | Desktop |
|---|---|---|
| 底栏终端 | `apps/renderer/src/TerminalPane.tsx`、`terminalSessions.tsx` | `terminal-ipc.ts`、`terminal-pty.ts`、`terminal-batch.ts`、`remote/terminal.ts`；本地/SSH 共用有界输出合批与退出尾部排空 |
| 正文命令块执行 | `conversation/CommandBlock.tsx`、`commandBlock.css`、`markdown.tsx`；共用高亮语法 `highlight/commandLanguages.ts`；预览 `preview/conversationFixtures.ts` | `terminal-shared.ts` 的 `create.command` → `terminal-command.ts` / `terminal-pty.ts` / `remote/terminal.ts`；识别 bash/sh/zsh 与 pwsh/powershell/ps1，显式点击后在当前对话工作区创建独立终端，整块脚本作为 Shell 参数执行并显示底栏输出；流式未完成时禁用，预览仅本地演示；Worker 与开发高亮共用命令名/选项着色，PowerShell 两条路径均注册别名 |
| GPU / 低配档位 | `apps/renderer/src/perf/{tierControl,tiers}.ts`、`tiers.css` | `perf-profile.ts` 判定、`perf-profile-cache.ts` 解析磁盘缓存、`perf-profile-shared.ts` 固定只读 preload；最新快照与用户减少动效偏好叠加，重复档位不写 DOM |
| Shell 录制 / 回放 | `recordings/TerminalRecordingControls.tsx`、`RecordingPlayer.tsx`、`format.ts`、`recording.worker.ts`；产物库录制项 | `terminal-recording.ts` + 固定 terminal recording IPC；真实 PTY 输出流写入产物库；支持 `.studiocast` 和上游 `.ompcast` 只读回放，无额外 AgentSession/TUI |
| 标题栏 overlay | 壳 | `titlebar-overlay.ts` |
| 应用图标 | 侧栏 / 关于 `AppIcon`；`public/icon.png`、`favicon.ico` | Renderer 自带图标资源；桌面运行时在 Windows 设置 `AppUserModelId`（`app-icon.ts` `resolveAppUserModelId`；`npm run preview` 经 `OMP_APP_USER_MODEL_ID` 用独立 `.preview` ID 与`OMP Studio (Preview).lnk`，不得与安装版共用——开始菜单里同 ID 的第二个快捷方式会让任务栏/通知变成该快捷方式的图标）并把 `resources/icon.ico` 注入窗口（任务栏/窗口身份）；安装包由 `packaging/electron-builder.yml` 将同一 ICO 写入 EXE，并创建带图标的桌面与开始菜单快捷方式 |
| 系统通知 | — | `chrome-notify.ts` |
| 系统托盘 / 关闭到托盘 | —（纯 Main 行为，无 Renderer 面，不进 preload/client-contract） | `tray.ts`（Electron-free，Main 注入 Tray/Menu/nativeImage：菜单文案 zh/en、左键打开、首隐气泡与 `%APPDATA%\omp-studio\tray-hint-shown` 标记、退出确认框文案）+ `main.ts`（close 事件拦截为 hide，托盘不可用时保持关窗即退出；`DesktopWindow.show()`）+ `composition.ts`（`requestQuit` 确认门：`host-composition.ts` `isBusy()` 以 residents 流式/压缩为准，回退当前会话 snapshot；`isQuitting` 注入窗口工厂放行真实退出） |
| 外部 https 链接 | 启动提示 GitHub 卡；`ompStudioChrome.openUrl` | `chrome-open-url.ts` → `shell.openExternal`（系统默认浏览器，不是 Electron 窗）；只接受 https |
| 操作者头像文件 | 首页弹窗 | `chrome-profile.ts` → `%APPDATA%\omp-studio\profile\`；升级从安装目录 `userdata\profile` 迁入；卸载 `customUnInstall` 删除 |
| 应用更新（GitHub Release） | AppUpdateDialog、settings/appUpdate、settings/updates、settings/UpdateAutomationSettings、settings/UpdateSettings、settings/DesktopUpdateRecovery（更新与维护页）；预览 PREVIEW_APP_UPDATE / PREVIEW_DESKTOP_RECOVERY / PREVIEW_UPDATE_PREFS | Main update-coordinator / unified-updates-ipc 管理后台准备、持久化事务、统一重启；update-discovery 验签按组件/通道/架构发现；differential-artifact + electron-update-adapter 分块下载/全量回退及静默 NSIS；共享 v2 清单和 ZIP 在 runtime-installer。旧 chrome-updates 保留本地导入与诊断维护；新打包应用禁用旧在线 startApp/startRuntime。 |
| Plan 另存为对话框 | `workbench/WorkbenchCanvas.tsx` `pickPlanSaveTarget` / `savePlanAndQuit`；`deck/PlanCard.tsx` 按钮 | `workspace-shell-shared.ts`、`workspace-shell-ipc.ts`、`plan-save-path.ts`（原生另存为，默认 `<工作区>/PLAN.md`，回传工作区相对路径；越界拒绝）→ Bridge `mode.plan.review.saveAndQuit` |
| 设置页 | `SettingsPage.tsx`、`settings/{catalog,LocalSettings,SettingsPanels,ModelServicesSettings,UpdateSettings,SettingsScope,Runtime1844Rows,MemoryCredentialPane,UnsupportedSettings,tabs}.tsx` | 按用途分类和中英文／配置键搜索；本机偏好与 Runtime 配置分开，Runtime 默认保存到用户配置，可切换会话覆盖；未接入功能集中展示；预览只改演示状态 |
| 背景（图片 / 视频 / 动图） | `background/BackgroundSettingsPane.tsx`、`AppBackgroundLayer.tsx`、`BackgroundProvider.tsx`、`backgroundLibrary.ts`；预览 `preview/backgroundPreview.ts` | 纯 Renderer 本地：偏好 `omp.background`、文件 IndexedDB `omp-studio-backgrounds`；`[data-backdrop]` 让结构壳、卡片和控件按层次透出（菜单 / 弹窗保留高不透明度与背景模糊）；`ompStudioChrome.setTheme` 仅额外带标题栏 tint。不进 Host / client-contract |
| 字体与字号 | `settings/FontSettings.tsx`、`settings/typography.ts`、`styles/typography.css`；`terminalTheme.ts` | 外观与布局页三组独立字体与字号；本地设置、系统字体搜索／手填、预览示例隔离；xterm 原实例更新及虚拟行高重测；使用说明 `docs/fonts.md` |
| 预测输入 | `composer/useWordPrediction.ts`、`settings/PredictionSettingsPane.tsx`；desktop `prediction.ts` | 原生 WordCompletionProvider；默认本地 n-gram，模型下载和外部历史显式选择；私有通道不进入 Bridge 事件 |
| 标题图标与短码 | `history/useSessionTitles.ts`、`history/SessionTitleMark.tsx` | `session.titles.inspect`；原生当前/保存标题元数据；保留稳定会话身份与现有原生重新生成流程 |
| 原生运行偏好 | `settings/NativePreferencesPane.tsx`、`settings/Runtime1844Rows.tsx` | `preferences.native.get/set/clearOverride` 与 `runtime.settings.get/set` 暴露原生白名单；按用途分组并显示范围与来源；Hindsight 服务检查和编辑模式生效值随 Runtime 返回；OTLP 下次启动生效 |
| Hindsight 令牌 | `settings/MemoryCredentialPane.tsx`；Desktop `memory-credentials{,-ipc,-shared}.ts`、`remote/connected-services.ts`；Runtime `studio/hindsight-credential.ts` | 本机按目标及服务地址加密存储，私有 Worker 通道在初始化前注入低优先级凭据；SSH 经认证连接传入远端内存，断连清除；配置和环境变量优先 |
| 原生维护 / 完整导出 | `diagnostics/NativeMaintenancePane.tsx`、`preview/maintenancePreview.ts` | `maintenance.gc.preview/apply/status`、`maintenance.session.export`、`maintenance.export.status`、`maintenance.connection.check`；native GC 与 dump-all ZIP/HTML；Desktop `session-commands.ts` + `runtime-media-files.ts` 私有文件提升入库 |
| 诊断页 | `DiagnosticsPage.tsx`、`diagnosticsModel.ts`、`runtimeEnsure.ts`、`RuntimeLossBanner.tsx`、`ActionProgressBar.tsx`、`updateCheck.ts`；预览 `preview/fixtures.ts` `PREVIEW_DIAGNOSTICS`；桌面 `chrome-logs.ts` | `diagnostics.get` / `environment.get` / `capabilities.get`；`chrome-updates.ts` 提供网络下载、本地导入、回滚并重启、清理旧 Runtime，`settings/updates.ts` 按 jobId 等待终态；启动与进页静默检查更新（超时不报错）；手动检查更新超时才提示；本地制品对比 `runtime-install.ts` `probeManagedRuntimeInstall`；安装/更新/重装 `runtime.install`；断开或启动失败时「重新连接 Runtime」走 `runtime.ensure`；已连接时「重启 Runtime」走 `runtime.ensure` `{ force: true }`，收据未连上时自动再 `ensure` 并等到 `runtime.changed` connected；Host 日志打开/导出走 chrome IPC `chrome-logs.ts`（路径不回传 Renderer）。工作台 / Hub 复用 `RuntimeLossBanner`：工作台里悬浮在对话区顶部（`.convo-wrap > .banner.is-floating`），不占布局高度；空对话不再放重新连接 / 诊断入口。长操作显示分步进度条。 |
| 安全窗 / CSP / 图形沙箱 | — | `apps/desktop/src/security.ts`、`graphic-protocol.ts`；`apps/renderer/graphic-preview.html`：图形 iframe 无父文档/Node/IPC，打包内置资源只读协议，WASM 权限仅限图形 iframe |
| 应用开发者工具 | — | `apps/desktop/src/development-tools.ts`、`main.ts`：Windows 开发预览主窗口的 F12 / Ctrl+Shift+I，独立 DevTools 窗口；打包版不注册；macOS 沿用原生菜单，不是内置 Browser 网页的 DevTools |
| Windows 安装包 | packaging/ui、installer-host | packaging/electron-builder.yml / nsis/custom.nsh：当前用户安装、旧全机迁移、静默升级；scripts/build-update-assets-v2.mjs、verify-update-assets-v2.mjs、publish-update-release.mjs + .github/workflows/release.yml：多架构签名差分工件与独立 Runtime 发版；详见 docs/updates.md。 |
| 组装顺序 | — | `host-factory.ts` → `host-composition.ts` → `composition.ts`；入口 `main.ts`。生产桌面先创建基础 Host/facade，`runtime-startup.ts` 拥有后台 Runtime 初始化及维护串行任务；更新试运行等待终态 |

Host 传输通道只有：`bootstrap` / `query` / `command` / `subscribe` / `event` / `close`（`packages/transport-desktop/src/channels.ts`）。不要再加通用 `invoke(channel, payload)`。

## 平台层（Windows / macOS / Linux）

平台差异集中在 `apps/desktop/src/platform/`，其余模块沿用 `{ platform, env, … }` 注入，不再散落 `process.platform`。Windows 的路径、文件名与行为由金样测试逐字钉住。

| 主题 | 文件 | 说明 |
|---|---|---|
| 数据 / 日志 / Runtime / 更新目录 | `apps/desktop/src/platform/desktop-paths.ts`、`scripts/runtime-signing-keys.mjs` | Windows `%APPDATA%` / `%LOCALAPPDATA%` 不变；macOS 在 `~/Library/Application Support/omp-studio`；Linux Host 状态与密钥在 `$XDG_CONFIG_HOME/omp-studio`（空或相对值回退 `~/.config`）；打包资源 win32 取 exe 目录，POSIX 取 `process.resourcesPath` |
| 登录 shell 环境 | `platform/login-env.ts` | macOS 访达 / Linux 应用菜单启动时，Host 创建前从登录 shell 取环境写入 `process.env`；按平台补工具目录，Linux 缺失 LANG 时用 `C.UTF-8`；终端启动保留继承环境；结果记 host 日志 `desktop.login_env` |
| Command Line Tools 垫片 | `platform/developer-tools.ts`、`git-process.ts` | 解析到 `/usr/bin/git` 且 CLT 缺失时不执行垫片（它会弹系统安装框），直接报 `CAPABILITY_UNAVAILABLE` |
| 进程树终止 | `platform/process-tree.ts`；`studio-host/src/posix-process-group.ts` | Windows `taskkill /t /f`；POSIX 以独立进程组启动并 `kill(-pgid)`，已回收的组长不再发信号 |
| 单实例权威锁 | `apps/desktop/src/authority-liveness.ts`、`host-factory.ts`、`platform/desktop-paths.ts`；`platform-win32/src/authority-lock.ts`（`pathStyle`） | Windows named pipe；POSIX unix socket，连不上即残留，核对 uid 与 dev/ino 后回收；Linux 使用固定 `/tmp` 和 uid 隔离的 authority scope，避免多用户碰撞与 `TMPDIR` 漂移 |
| Owner-only 权限 | `host-factory.ts` `applyOwnerOnlyPermissions` | Windows `icacls`；macOS `chmod 0700/0600` 后 `lstat` 复核 |
| Runtime 平台表 | `runtime-installer/src/runtime-platform.ts`；`scripts/target-platform.mjs` | 入口 `omp.exe` / `omp`、更新平台（含 Linux x64）、PE / Mach-O / ELF 架构校验；两张表由测试钉齐 |
| mac 构建预检 | `scripts/mac-toolchain.mjs` | Node arm64 且未转译、CLT、Bun ≥ 1.4.2、Rust host `aarch64-apple-darwin` |
| 窗口外观 | `platform/window-chrome.ts`、`titlebar-overlay.ts`；renderer `App.css` `.app-titlebar`、`TipHost.tsx` | Windows 右上 caption overlay（可随主题换色）；macOS `hidden` + 红绿灯 `trafficLightPosition`，overlay 不换色；标题栏两侧由 `env(titlebar-area-x/width)` 让位，TipHost 按同一留白翻转气泡 |
| 原生菜单栏 | `platform/app-menu.ts`、`app-menu-shared.ts`；renderer `workbench/AppShell.tsx` `runMenuCommand` | 仅 macOS；Edit 全用 role；自定义项经 `omp-studio:desktop:menu-command` 发 allowlist 命令 ID；这些组合键归菜单独占，renderer keydown 在 macOS 桌面跳过（`nativeMenuOwnsShortcuts`）；打包版无 Reload / DevTools |
| 生命周期 | `composition.ts`、`platform/app-lifecycle.ts`、`platform/app-nap.ts` | macOS 关窗隐藏到 Dock，`activate` 重开，⌘Q 走 `requestQuit`；关机 / 注销有界关停且不拦截；忙时才持 `prevent-app-suspension`；不在「应用程序」时提示移动；relaunch 去掉 `-psn_*` |
| 托盘 | `tray.ts`、`app-icon.ts` `resolveTrayIconPath`；`apps/desktop/resources-darwin/trayTemplate*.png`（`scripts/generate-tray-template.mjs` 生成） | macOS 用菜单栏模板图，首项「打开 OMP Studio」；模板图不在 Windows 的 `resources/` 内 |
| Linux 客户端 / 安装包 | `host-factory.ts`、`platform/app-lifecycle.ts`、`floating-windows.ts`、`terminal-pty.ts`；`scripts/{preview,pack-linux,linux-bundle,audit-linux,linux-package-smoke}.mjs`、`.github/workflows/{ci,release}.yml` | POSIX Host、XDG 状态、原生 PTY、沙箱与窗口恢复；Ubuntu 24.04 / glibc 2.39 x64 的 AppImage / deb，签名 Runtime 放 `resources`；CI 安装 / X11 / Wayland 验收，Release 默认带 Linux；见 `docs/linux.md` |
| Linux 更新与下载 | `update-coordinator.ts` 的 `manualDesktopDownload`；`settings/appUpdate.ts`、`AppUpdateDialog.tsx`；`scripts/{release-assets,build-update-assets-v2,publish-update-release}.mjs`；`website/shared/release.ts` | Linux 签名清单提供 AppImage / deb 手动下载，Runtime 仍可在线更新；最低桌面版本阻止不兼容下载；三套官网入口识别真实 Linux 附件 |
| 终端 shell | `terminal-pty.ts` | macOS 账户 shell → `$SHELL` → `/bin/zsh`，login 启动（`-l`，管道 `-il`）；剔除 `ELECTRON_*`，设 `TERM_PROGRAM`；进程组终止；无工作区时 cwd 为家目录 |
| 外部编辑器 / 打开方式 | `external-editor.ts`；`main.ts` 打开方式 | macOS 查 `/Applications`、`~/Applications` 中的 VS Code / Insiders / Cursor / Windsurf，再查登录 PATH；「打开方式」选择框从 `/Applications` 开始；`rundll32` 仅 Windows |
| 麦克风 / TCC | `chrome-media-access.ts`；renderer `media/microphoneAccess.tsx` | macOS 先查 `getMediaAccessStatus`，未决时 `askForMediaAccess`；拒绝后 renderer 提供「打开系统设置」（固定 URL）；其他平台不经这一步，采集时序不变 |
| 钥匙串锁定 | `service-definitions.ts` `SecureStorageLockedError` | safeStorage 解密失败报可恢复的锁定错误，不清空已存数据 |
| macOS 打包 | `scripts/pack-mac.mjs`、`mac-bundle.mjs`（由 `electron-builder.yml` 派生配置、TCC 用途字符串、ad hoc 签名选项）、`audit-mac.mjs`；`packaging/mac/*.plist`；`scripts/preload-bundle.mjs`（与 pack:win 共用） | `npm run pack:mac` 产出 ad hoc 签名 `.app`、首装 `.dmg`、`ditto` 更新 zip；Runtime 与公钥走 `Contents/Resources`，签名跳过 `runtime/**`；审计复验 Runtime 签名、`codesign --deep --strict`、zip 往返；说明见 `packaging/README.md` |
| Windows 安装与卸载向导 | `packaging/ui/{index.html,styles.css,wizard.js}`、`installer-host/InstallerHost.cs`、`nsis/custom.nsh`；`scripts/installer-{wizard,maintenance,ui}.test.mjs` | 当前用户安装，真实 NSIS 进度、运行中退出重试、快捷方式选择、完成退出与原生回退；说明见 `packaging/README.md` |
| macOS 整包更新 | `apps/desktop/src/mac-app-installer.ts`（preflight：App Translocation / 目录可写 / 空间；`ditto --noqtn` 解到同级隐藏目录，`codesign --deep --strict`、bundle id、版本、arm64 校验）；`mac-app-swap.ts`（退出后由旧 Electron 以 Node 模式跑的 helper：两次 rename 交换，`started` / `healthy` / `clean-exit` 标记，未启动或崩溃即换回）；`update-coordinator.ts` `desktopCommit: "confirmed"`、`failedApp`、`preflightDesktop`、`trackAppBaselineWithoutBase` | 健康（renderer 就绪）后 `confirmDesktopStartup` 才提交；换回的版本同一文件不再推送；换回后当前 Runtime 与桌面协议不兼容时回到上一 Runtime；v1 索引在 macOS 恒为 none；发布页下载选 `macos-arm64.dmg` |
| Runtime 签名预检 | `apps/desktop/src/platform/code-signature.ts` | macOS 激活 Runtime 前先 `codesign --verify --strict`，签名坏了给出明确原因而不是自检时被 SIGKILL |
| Runtime 副本去 quarantine | `apps/desktop/src/platform/quarantine.ts`；`runtime-installer` `prepareStaging` | macOS 从包内播种 Runtime 时，在安装器私有暂存副本上清除 `com.apple.quarantine`，随后照常 Ed25519 验签；签名 bundle 本身不动 |
| Renderer 平台 | `apps/renderer/src/platform.ts`、`keyboard/shortcuts.ts`、`platformCopy.ts` | preload 冻结 `platform`，Web UI 回退 `navigator`；根元素 `data-platform`；⌘ / Ctrl 判定与标签（Windows 标签逐字不变）；「资源管理器 / 访达」文案；macOS 保留系统浮动滚动条 |

macOS host 日志：`~/Library/Application Support/omp-studio/logs/host-YYYY-MM-DD.log`。

## Host 内核（改协议行为时）

| 主题 | 文件 |
|---|---|
| SSH 工作位置与连接管理 | `apps/renderer/src/workspaces/{ExecutionTargets,ExecutionTargetPicker,RemoteScopeNotice,SshPasswordDialog}.tsx`、`{remoteTransport,remoteStatus}.ts`；`apps/desktop/src/remote/{manager,ipc,shared,errors}.ts`；有界重连、健康检查、目标代次同步；用法见 `docs/ssh-workspaces.md` |
| SSH Headless Host / 部署 / 安装 | `apps/desktop/src/remote/{main,host,server,transport,wire,platform,authority,deploy,install}.ts`；`scripts/bundle-remote-host.mjs`；阶段状态见 `doc/ssh-workspace-progress.md` |
| SSH 账密认证 / 终端 | `apps/desktop/src/remote/{authentication,terminal}.ts`；`apps/desktop/ssh-askpass/`；`scripts/build-ssh-askpass.mjs`；Renderer `terminalSessions.tsx`；验收交接见 `doc/ssh-workspace-test-prompt.md` |
| 后台评测任务与报告 | `packages/studio-host/src/evaluation-coordinator.ts`、`apps/desktop/src/evaluation-workspace.ts`；Host 共享所有者由 `host-composition.ts` 的 `evaluationOwner` 传入各对话上下文 |
| Backend 生命周期 | `packages/studio-host/src/host-backend.ts` |
| 解析 / 启动 Runtime | `runtime-resolver.ts`、`runtime-session-controller.ts`、`runtime-process-port.ts`；Desktop `runtime-session.ts` 的 `runtime.launch.stage` 分别记录校验、Bridge 准备、握手、快照和命令清单耗时；共用 `packages/runtime-installer/src/file-digests.ts`，Electron 的 ≥32 MiB 文件在短生命周期 Worker 中按 1 MiB 读取校验，其他场景保留主线程异步流 |
| 托管 Runtime 日常快速启动 | `packages/studio-host/src/managed-runtime-acceptance.ts`、`host-backend.ts`、`runtime-resolver.ts`；验收文件 `<profile>/runtime-acceptance.json`。首次／升级／契约变化完整探测；日常对新鲜内容指纹匹配的签名版本复用能力验收，连接仍需真实握手。系统／自定义 Runtime 不复用；修改验收规则时递增 `MANAGED_ACCEPTANCE_POLICY` |
| Bridge 客户端 | `bridge-client.ts`、`bridge-auth.ts` |
| 状态投影 | `state-projector.ts`、`runtime-projection.ts` |
| 交互转发 | `interaction-adapter.ts`、`interaction-events.ts` |
| BTW 旁路转发 | `packages/studio-host/src/btw-events.ts`；facade `#bindBtw`；client `entities.btw` |
| 破坏性确认 | `host-confirmation.ts` |
| Windows Job Object | `windows-job-object.ts` |
| POSIX 进程组 / 短 socket | `posix-process-group.ts`；`socket-paths.ts`（`sun_path` ≤ 103 字节，私有 0700 目录；Bridge、探针与 live audio 共用，Runtime 经 `OMP_STUDIO_SOCKET_DIR` 取得） |
| 工作区路径同一性 | `workspace-path.ts`（registry、catalog、归档、删除共用；Windows 大小写不敏感，macOS realpath + `/private` 别名 + NFC；overlay `session-telemetry-probe.ts` 同规则） |
| 安装态 | `packages/runtime-installer/src/installer.ts`、`signed-artifact.ts`（Runtime，启动前核对 EXE 摘要、同版本损坏修复、重复激活保留回滚点）；`packages/runtime-installer/src/app-payload.ts`（应用负载，同版本相同签名内容支持重复下载后激活）；桌面 `apps/desktop/src/runtime-install.ts`、`payload-root.ts`（启动验签/回退）。更新维护在 `host-composition.ts` / `runtime-session.ts` 停止空闲居民进程并恢复会话；候选启动失败时恢复旧 Runtime 和原会话，Facade 拒绝并发写命令；下载/导入将验签确认的通道传给 `runtime.install`。安装包 extraFiles `$INSTDIR\runtime\versions\`，打包后直接跑这份 `omp.exe` |

## Runtime overlay（改 omp `--mode studio-host` 时）

源码在 `omp-patch/overlay/packages/coding-agent/src/studio/`。编辑 overlay 或 vendor 后用 `npm run omp:patches:regen`，不要手写 `.patch`。

| 主题 | 文件 |
|---|---|
| 进程入口 / 服务组装 | `studio-host-mode.ts`；Bridge 就绪前 `ensureOnDisk()` 固定空会话身份，首次发消息前也能重连恢复 |
| 队列分组 / 待恢复输入 / Worker 回收 | `services/runtime-queue-service.ts`、`session-gui-service.ts`、`studio-host-mode.ts`；接缝 `session/agent-session.ts` 统一分组、身份和修改入口 |
| 会话压缩阈值 / 标题元数据 | `services/session-compaction-policy.ts`、`session-titles-service.ts`；接缝 `session/session-manager.ts` 自定义条目索引、原生标题槽读取 |
| Bridge 服务端 / 分发 | `bridge-server.ts`、`bridge-dispatcher.ts`、`bridge-protocol.ts` |
| 暂停 | `services/pause-service.ts` |
| Plan / Vibe / Loop / Goal | `mode-control-service.ts`、`loop-service.ts` |
| 会话树 / fork / handoff | `tree-service.ts`、`fork-service.ts`、`handoff-service.ts` |
| Fast / prewalk | `fast-prewalk-service.ts` |
| 条件 Loop / Prewalk 重启 | `services/loop-service.ts`、`fast-prewalk-service.ts`；Renderer `ComposerModePicker.tsx` |
| 实验上下文 / Plan 自动保存 / 配额等待 | `services/runtime-settings-service.ts`、`mode-control-service.ts`、`state-projector.ts`；Renderer `settings/{SettingsPanels,ModelServicesSettings,tabs}.tsx`、`conversation/ActivityLine.tsx` |
| Live 实时语音 | `live-service.ts`、`services/live-audio-service.ts`；Renderer `media/LiveAudioPane.tsx`、`liveCapture.ts`、`live-capture.worklet.js`；Desktop `live-audio.ts` |
| BTW / TAN / OMFG | overlay `btw-service.ts`、`tan-service.ts`、`omfg-service.ts`；Host `btw-events.ts`、facade `#bindBtw`、client `reducer.ts` `entities.btw`；Renderer `apps/renderer/src/btw/` |
| 会话来源标记 | `session-origin.ts` |
| 父进程看门狗 | `parent-watchdog.ts`；`studio-host-mode.ts` `abortForHostLoss`（`OMP_STUDIO_PARENT_PID`，目前只有 macOS 传；Host 消失后中止 turn 并退出，不走 drain） |

接缝补丁（改上游已有文件）：`omp-patch/patches/0001` CLI 入口 → `0002` session → `0003` modes/pause → `0004` extensibility。分组名单：`scripts/omp-seam.mjs`。

## OMP 18.13.2 新增迁移面

| 功能 | Renderer / Host | Runtime overlay |
|---|---|---|
| 费用预算与会话树统计 | `models/SessionBudgetPane.tsx`、`workbench/AppTopbar.tsx` Token 面 | `services/session-options-service.ts`、`session-telemetry.ts` |
| 上下文只读快照 | `contextViewer/ContextInspector.tsx`（+ `ContextOverview` / `ContextCategoryList` / `ContextEntryList` / `ContextEntryPane` / `contextViewMath.ts` / `contextViewer.css`）、`preview/contextViewPreview.ts`；Dock `context-viewer` 面板；facade `context.view.*` query | `services/context-view-service.ts`；每次关闭后打开均居中浮窗并压暗背景，已打开时仅聚焦现有窗口；开始移动即解除遮罩，缩放保留，合组／最小化／Pin 时也解除。跟随当前会话，打开或手动刷新时采样，关闭或切换来源 release，不写账本正文；暂时不可见保留快照；窄面板切换列表与正文，分类横向滚动条常驻，低高度折叠详细指标；列表按类别或工具分组（`childKey`）过滤，`preview` 只带脱敏后前 480 字符 |
| 语音输入 / 草稿听写 | `composer/DictationControl.tsx`、`dictationSession.ts`、`dictationEditor.ts`、`dictationKeyboard.ts`；`settings/DictationSettingsPane.tsx`；`media/liveCapture.ts`；Desktop `dictation-audio.ts` 固定私有通道与单份内存恢复；隔离演示 `preview/DictationDemo.tsx`；[使用说明](../docs/dictation.md) | `services/live-audio-service.ts`、`dictation-capture.ts`、`dictation-configuration.ts`；`dictation.inspect/open` v2 元数据控制，原生 STTController 的正文/进度只走认证音频事件 |
| 受限目录 / 空闲维护配置 | `settings/FeatureSettingsPane.tsx`、`conversation/conversationViews.ts`；Desktop `conversation-views.ts` | `services/feature-settings-service.ts`、`idle-maintenance-service.ts` |
| WATCHDOG 配置 | `settings/AdvisorConfigPane.tsx` | `services/advisor-config-service.ts` |
| `local://` 文件原位编辑 | `capabilities/LocalFilesPane.tsx`、`ResourcesPane.tsx`；`/local` | `services/resource-service.ts` |
| Worktree 恢复范围 | 历史页工具区 `history/ResumeScopePane.tsx`，共用 `history/SessionPicker.tsx` / `sessionPicker.css` 的列表、搜索、键盘选择和预览；`preview/resumeScopePreview.ts`；Desktop 注册目标 workspace | `services/session-worktrees-service.ts`（原生 picker / continuation；配置默认范围、目录/状态/消息元数据和原生首条请求/对话摘录） |
| 新模型发现与兼容 | `ModelConfigPage.tsx`、`models/fetchedModels.ts`；Host `omp-models-adapter.ts` | 原生 model discovery / catalog；模型目录由 `scripts/model-catalog.mjs` 生成 |
| 自动压缩日志 | `diagnostics/SessionCompressionPane.tsx` | `services/maintenance-service.ts` |
| 扩展模式切换 | 既有 Plan / Vibe / Goal / Loop UI | `services/extension-modes.ts`，共用 mode owners 与 `mode_changed` |

使用入口、版本区间及验收边界见 [`docs/migrations/omp-18.13.2.md`](../docs/migrations/omp-18.13.2.md)。

## 命令落点速查

只列常改的；完整表仍以 `operations.ts` 为准。

| 命令 / query | 主要落点 |
|---|---|
| `core.prompt` / `steer` / `followUp` / `abort` | Composer → facade → overlay `session-control-service.ts` |
| `queue.enqueue` | `MessageQueueBar.tsx` → 同上 |
| `runtime.pause` / `resume` | `ActivityLine` → overlay `pause-service.ts` |
| `session.create` / `resume` / `drop` | `session-commands.ts` + catalog |
| `session.delete` | `session-commands.ts` + `session-delete-service.ts`（清 transcript/artifacts/遥测/绑定/租约/pin） |
| `session.archive` / `unarchive` | `session-archive-service.ts` |
| `session.model.set` / `thinking.set` | Composer 选择器 → overlay `model-control-service.ts` |
| `interaction.respond` | `InteractionDeck` → Host adapter → overlay `interaction-port.ts` |
| `permissions.mode.set` | 工作台权限档 → overlay permission control（流式记下一轮） |
| `agent.*` / `job.cancel` | Agent Hub → overlay `agent-hub-service.ts` / `job-service.ts` |
| `models.*` | `ModelConfigPage` → `omp-models-adapter.ts`（写 `models.yml` / `config.yml`） |
| `skills.*` / `mcp.*` / `plugins.setEnabled` | 抽屉 / Capabilities：`skills.reveal` / `skills.revealRoot` 开系统目录；`mcp.refresh` / `mcp.test` / `mcp.logs.get` 为 Host 探测；Slash 执行走 Composer `runSlashCommand` |
| `git.*` / `github.*` | Git 面板 → `git-service.ts` / `github-service.ts` |
| `workspace.fileTree` | `sidebar/WorkspaceTree.tsx` `RealFileTree` → `workspace-files.ts` |
| `session.transcript.readPage` | 历史 / 对话回放 → `session-archive-reader.ts` |
| `session.telemetry.read` | `useViewedSessionTelemetry.ts` → Host store / archive probe |
| `btw.ask` / `abort` / `branch` | Composer `/btw` → `useBtwSession` → facade → overlay `btw-service.ts` |
| `usage.get` | Home → `omp-usage-adapter.ts` |
| `runtime.install` | 诊断中心 → Host `runtime.install` → `runtime-install.ts` + `packages/runtime-installer/src/installer.ts`；下载/导入工件通过 Main 私有 `pendingArtifact` 交接 |
| `runtime.ensure` | 诊断中心重新连接 / 重启、工作台与 Hub 横幅、空对话 CTA、会话恢复 → `runtime-session.ts` `ensure`（可选 `force`）+ `host-composition.ts` `ensureInstalledRuntime` |

## 不要当作产品代码

| 路径 | 原因 |
|---|---|
| `ui_reference/` | 界面参考 |
| `backup/` | 历史归档（只读，不再新增） |
| `omp-patch/vendor/oh-my-pi/` | 上游工作区；Studio 自有逻辑在 overlay，接缝在 `patches/` |
| `doc/real-conversation/`、`doc/multi-session/` | 过程计划，默认当归档 |
| `apps/*/dist/`、`packages/*/dist/` | 构建产物 |
| 上游 `AGENTS.md` | 上游 agent 规范，不是 Studio 地图 |

## 维护

### 流式性能与资源释放

| 功能 | 入口 | 边界 |
|---|---|---|
| Host 工具增量 replay / 后台缓冲 | `packages/studio-host/src/replay-text-buffer.ts`、`conversation-coalescer.ts`、`conversation-events.ts`、`runtime-session-controller.ts` | 头截断不变；合并在 streamSeq 前；控制/打开为屏障；非 ASCII 保留原事件边界 |
| 可见 pane / 隐藏发布 | Renderer `conversation/conversationViews.ts`、`ConversationPane.tsx`、`SubagentConversationPane.tsx`、`conversationStore.ts`；Desktop `conversation-views.ts`、`main.ts` | 固定 chrome 方法；实际 child ID；多窗口并集；旧 preload 保持兼容；预览不登记 |
| 有界 Mermaid | `conversation/LazyMermaid.tsx`、`mermaidQueue.ts`、`renderCache.ts` | 20,000 单元 / 600 行 / 分数 1,500；串行、可取消等待、32 项 / 4MiB 缓存 |
| 异步语法高亮 | `highlight/HighlightedCode.tsx`、`pool.ts`、`protocol.ts`、`highlight.worker.ts`、`compute.ts`；`conversation/markdown.tsx` | 生产默认 Worker，dev 默认原路径；即时 CodeFrame；安全 token；源码/队列/缓存/Worker 均有界 |
| 性能数值采样 | `studio-protocol/src/performance-diagnostics.ts`；Renderer `rendererPerformance.ts`、`rendererResources.ts`；Desktop `chrome-performance*.ts`、`desktop-performance.ts`；overlay `services/runtime-performance.ts` | 每 60 秒采样，门控写本地日志；不读正文、不唤醒 Runtime；数值 helper 保留行为测试 |
| 会话切换专项采样 | Renderer `sessionSwitchPerformance.ts`、`conversationWorkspace/{Workspace,store,hosts,client}`、`conversation/{useConversation,useConversationReading}.ts`；`session-switch-perf.html`；`scripts/{build-session-switch-perf.mjs,sample-session-processes.ps1,native-session-perf.mjs,native-session-perf-seed.mjs,manual-session-switch-capture.js,capture-session-switch.ps1}` | 默认关闭，纯数值有界记录；同一离线 fixture 对比开发 / 生产；隔离配置下真实 Electron / Host 与 Windows 分进程采样；深度 DOM 计数仅显式快照或导出时读取；操作见 [`docs/session-switch-performance.md`](../docs/session-switch-performance.md) |
| 性能门禁与回滚 | `scripts/host-replay-bench.mjs`、`streaming-perf-gate.mjs`、`render-work-bench.mjs`、`native-visibility-smoke.cjs`、`compare-streaming-perf.mjs`；Renderer `performanceOptions.ts` | 合成 fixture，输出 `outputs/perf/`；独立生产/file harness；默认选择和命令见 [`docs/performance.md`](../docs/performance.md) |

- 新功能落地后：在对应表加一行（UI + Host/Desktop + 若有 Runtime）。
- 文件重命名：改这一份，不要让 `AGENTS.md` 再列路径。
- 新 query/command：先改 `client-contract` `operations.ts`，再改 facade `switch`，最后改 UI。
- 预览面：同一功能在 `preview/` 有 fixture 的，索引行里提一句，避免只改真实路径。

## OMP 18.2.5 新能力

| 功能 | 入口 | Runtime / Host |
|---|---|---|
| BTW 话题与追问 | `btw/BtwPanel.tsx`、`btw/useBtwSession.ts`；预览 `preview/btwPreview.ts` | `btw.history.list/read`、`btw.followUp`、`btw.images.resolve` → overlay `btw-service.ts` / `upgrade-service.ts`；复用原生 `runBtwTurn`、BtwHistoryStore、图片路径识别与加载；失败／中止后续问、图片重放／回显、带图分支、后台阅读与快捷键；使用说明 `docs/btw.md` |
| 模型委派标签 | `composer/mentions.ts`、`composer/editorDom.ts`、`ModelDelegationList.tsx` | `session.models.mentions` → overlay `upgrade-service.ts`；原生 ModelMentionRegistry |
| 调度、视觉、判断与推测设置 | `settings/ModelServicesSettings.tsx`、`models/RuntimeCredentials.tsx`、`ModelConfigPage.tsx` | `runtime.settings`、`runtime.auth.*`；capability 与严格白名单 |
| 外部会话导入 | 历史页工具区 `SessionImportPanel.tsx`；Claude / Codex 标签、搜索与列表＋预览弹窗共用 `history/SessionPicker.tsx` / `sessionPicker.css`，原目录失效时就地选择目标工作区；预览 `preview/runtimeUpgradeFixtures.ts` | `session.import.*` → 原生 importer，Desktop 私有解析路径、登记工作区且不激活；导入完成后显式打开 |
| Advisor 费用／实际模型／生成速率 | `workbench/AppTopbar.tsx` token 面板、`conversation/SubagentMetrics.tsx` | overlay `session-telemetry.ts`、`state-projector.ts`、`agent-hub-service.ts` |

迁移明细与验证：[OMP 18.2.5](../docs/migrations/omp-18.2.5.md)。

## OMP 18.3.0 适配

| 功能 | UI | Runtime / Host / Desktop |
|---|---|---|
| 服务控制、加密保存配置 | `services/ServicesPane.tsx`，Agent Hub；预览 `preview/servicesPreview.ts` | `contracts/workbench.ts` → overlay `services/workbench-service.ts` → 原生 launch broker；Desktop `service-definitions.ts`、`chrome-services.ts` |
| Background tasks 统一窗口与卡片 | `backgroundTasks/{BackgroundTasksDock,BackgroundTasksPanel,BackgroundTaskMenu}.tsx`、`useBackgroundTasks.ts`、`conversation/JobInspector.tsx`；预览 `preview/backgroundTasksPreview.ts`；验收 `background-tasks-harness.html?preview=1&marks=off&window=1` | 主对话 jobs 与 Agent 创建服务；精确匹配原生 session owner / legacy agent owner；命令直接看过程、服务按 Runtime `previewUrl` 打开/复用 Browser 标签，右键看启动日志；卡片小图标、单行、无额外底栏。地址来自 Agent `bash.previewUrl` 经原生 launch broker 持久化和 Studio 投影，不由用户填写；类型 `contracts/workbench.ts`、overlay `services/workbench-service.ts`，接缝 `tools/bash.ts` / `launch/{services,protocol,broker}.ts` |
| 媒体产物库、存储位置 | `MediaPage.tsx`、`media/ArtifactLibraryPane.tsx`；预览 `preview/mediaPreview.ts` | Host `artifact-library.ts`；Desktop `chrome-artifacts.ts`（固定导入/导出 IPC、私有流式协议）；`session.delete.deleteManagedArtifacts` 默认 false |
| 媒体生成 / 转写 / TTS | `media/MediaWorkbench.tsx`、`AudioCapturePane.tsx`；预览 `mediaWorkbenchPreview.ts` | `contracts/media.ts`、overlay `services/media-service.ts` / `media-files.ts`；Desktop `runtime-media-files.ts`、`media-upload.ts` |
| Live 实时语音 | `media/LiveAudioPane.tsx`；预览 `liveAudioPreview.ts` | `contracts/live-audio.ts`、overlay `services/live-audio-service.ts`；Desktop `live-audio.ts` 固定 PCM 通道 |
| 离线 Token 计数 | `usage/TokenCounterPane.tsx`、`tokenCounter.css`；`panels/registry.ts` 的 `token-counter` | `tokens.count` → Workbench → 原生 tokenizer；用量弹窗/顶栏更多/添加工具打开，默认独立浮窗，可拖动、停靠、缩放、隐藏与恢复；预览只用 fixture，移动不清空输入或结果 |
| 模型种类、角色链、搜索迁移 | `ModelConfigPage.tsx`、`models/runtimeModels.ts`、`WebRoleChain.tsx` | `runtime.models.list`；Host `model-role-migration.ts`、`web-routing.ts`、`omp-models-adapter.ts` |
| Claude 重置确认与策略、MCP 启动等待 | `settings/ModelServicesSettings.tsx`、现有 InteractionDeck | overlay `runtime-settings-service.ts`、`studio-host-mode.ts` 与 AgentSession consent hook |
| 账户、额度、重置券只读状态 | `models/AccountStatusPane.tsx`；预览 `preview/accountsPreview.ts` | `accounts.status` → overlay `services/account-status-service.ts`；手动刷新，不调用自动兑券 heartbeat |

范围和验收进展：[OMP 18.3.0](../docs/migrations/omp-18.3.0.md)。

## OMP 18.4.4 Runtime 适配

配置读取与写入改用上游注册句柄；接缝配置默认值移至 `task/settings.ts`。搜索与图像候选及旧配置迁移见 `packages/host-client-api/src/model-role-migration.ts`、`web-routing.ts`；现有子代理档位覆盖支持 `ultrafast`。版本变化、兼容范围和未接入 GUI 的新能力见 [迁移报告](../docs/migrations/omp-18.4.4.md)。

GUI 适配及本地验收记录：[实施记录](../docs/migrations/omp-18.4.4-gui.md)。

| 功能 | GUI | Runtime / Host |
|---|---|---|
| Runtime 消息组队列、取回、纠偏 | `composer/RuntimeQueue.tsx`；App 已移除自动 flush effect | `contracts/session-gui.ts`、overlay `services/session-gui-service.ts`；Desktop `session-commands.ts` 私有附件提升；失败保留 Runtime 恢复记录，Composer 恢复后 `session.queue.ack` 清除，原 ID 重试不自动发送 |
| 会话服务档位 | `composer/ServiceTierPicker.tsx`；`preview/sessionGuiPreview.ts` | `session.tier.get/set`，原生模型支持矩阵与会话覆盖 |
| 新设置及配置来源 | `settings/Runtime1844Rows.tsx` | `contracts/gui-settings.ts`；overlay `runtime-settings-service.ts`、`cfg-service.ts` |
| Runtime 技能身份 | `skills/runtimeSkills.ts`、`composer/mentions.ts`、`SkillsDrawer.tsx`、`composer/serialize.ts` | `session.skills.list` 返回原生解析名称、来源及 scope |
| 独立任务范围 | `AgentHub.tsx` 的 `solutionSpace` 输入 | `agent.spawn` → `agent-hub-service.ts` → 原生 task |
| Benchmark 详细阶段 | `models/BenchmarkPane.tsx`、`preview/benchmarksPreview.ts` | `benchmarks-protocol.ts`、`services/benchmark-service.ts` → 原生 detailed benchmark |
| 本地输入预测、语料与模型管理 | `composer/ChipComposer.tsx`、`settings/PredictionSettings.tsx`；预览 `preview/predictionPreview.ts` | `prediction.query` 经 Facade/controller/Bridge 临时查询；`prediction.control` 管理语料和显式下载；overlay `services/prediction-service.ts` + 原生 `predict/client.ts`、`predict/daemon.ts` |
| 统计页（整页内嵌原生面板） | 入口在首页 Token 用量卡右上角（侧栏与二级导航刻意不再放，避免重复入口）；统计页的二级页头返回按钮回首页（`SecondaryPage` 的 `backRoute`，其余二级页仍回工作台）；`StatisticsPage.tsx` 把二级页头以下整块区域交给 iframe，**不加工具条/外框/内边距**（面板自带范围切换与 Sync DB）；深链 `#/overview?range=all`；只有连接中与失败态是 Studio 自己的界面；预览 fixture 在 `preview/fixtures.ts` 的 `PREVIEW_STATS_TOTALS`，不伪造内嵌 | `stats.dashboard` → `omp-usage-adapter.ts` 的 `dashboard()`：先探测 `x-omp-stats-dashboard` 身份头，未运行则用**托管 Runtime 的 omp.exe** 拉起 `omp stats`（PATH 兜底）并轮询就绪；并发调用共享一次启动；拉起时带 `OMP_STATS_NO_OPEN=1`，Runtime 侧 `omp stats` 据此不调 `openPath`，面板只出现在应用内（「在浏览器打开」回退按钮仍显式开浏览器）。CSP `frame-src 'self' http://127.0.0.1:3847` 只放行这份内嵌；`installCspHeaders` 只给渲染进程自身文档打 CSP，不能盖到被框的仪表盘，否则 `frame-ancestors 'none'` 会让整页白屏 |
| MCP instructions 策略 | `CapabilitiesPage.tsx` MCP 行；预览 `capabilitiesPreview.ts` | `mcp.setInstructions` → `omp-mcp-adapter.ts`，只修改生效的原生来源，保留连接信息，新会话加载 |
| Bedrock Messages 请求兼容 | `ModelConfigPage.tsx` 模型高级设置 | `ModelOverridePatch.bedrockMessagesApi` → `omp-models-adapter.ts` 的 `compat.bedrockMessagesApi`；`provider-yaml-draft.ts` 保持 YAML 预览与写入一致 |
| 子代理 BTW、独立话题与追问 | `btw/AgentBtwPane.tsx`；Agent Hub BTW 标签、`agents/AgentDetailPanel.tsx` 与侧栏入口；预览 `preview/agentBtwPreview.ts` | `agent.btw.read/ask/abort` → Workbench `services/agent-btw-service.ts`；原生 child AgentSession + `StudioBtwService`，父会话/目标实例凭据绑定，目标失效中止；不使用主 BTW 状态槽 |
| IDA 数据库、分页视图及修改确认 | `capabilities/IdaPane.tsx`；预览 `preview/idaPreview.ts`；文件树二进制入口 | `contracts/ida.ts` → `services/ida-service.ts`；原生 Python worker 在串行执行边界校验数据库身份与版本，单次 review token，读取和执行可取消 |
| Ask 回答与备注图片 | `deck/AskImages.tsx`、`AskCard.tsx`、`QueuedDeck.tsx`、`askContent.ts`；复用 `composer/ChipComposer.tsx`；预览 `preview/deckFixtures.ts` | `contracts/ask-attachments.ts`；正文按光标混排图片胶囊，独立缩略图预览；渲染层文档保留位置，按原生 `[Image #N]` 顺序提交；转换期间禁止提交/换题，过期卸载丢弃未完成读取 |
| 分页会话资源 | `capabilities/ResourcesPane.tsx`、`LocalFilesPane.tsx`、`resources.css`；共享 `CapabilityEditor.tsx`；预览 `preview/resourcesPreview.ts` | `contracts/resources.ts` → `services/resource-service.ts`；原生 local/omp/attachment/conflict handler，内容版本绑定、文件越界拒绝 |
| 无付费调用 Electron 验收 | `scripts/full-gui-e2e.mjs` | 独立应用配置、原生配置与工作区；签名握手、真实读取、预览操作、CDP 中文组合输入；证据 `outputs/full-gui-e2e/` |


## OMP 18.8.0 / Studio 0.1.9

| 功能 | UI | Runtime / Host / Desktop |
|---|---|---|
| 工作区与样式 | workspaces/Workspace.tsx、MediaPage.tsx、evaluation/EvaluationPage.tsx、AgentHub.tsx | 原生任务与既有 Bridge；preview 与真实组件复用 |
| 模型预设、速度与保温 | models/ModelPresetsPane.tsx、SessionOptionsPane.tsx | session-options-protocol.ts → session-options-service.ts；旧 session.tier 接口保留 |
| 原生配置与审批 | settings/NativePreferencesPane.tsx、deck/ApprovalCard.tsx | native-preferences-service.ts、configuration-approval.ts；cfg-service.ts 复用同一原生审批主机 |
| 队列编辑和恢复 | composer/RuntimeQueueBar.tsx；旧 Runtime 回退 RuntimeQueue.tsx | runtime-queue-service.ts；session.queue.entry.remove 与旧 session.queue.remove 保持独立结果结构 |
| 子代理与标题 | models/AgentModelDetails.tsx、history/SessionTitleMark.tsx | agent-model-service.ts、session-titles-service.ts；保留 agent-btw-service.ts |
| 预测输入 | composer/useWordPrediction.ts、settings/PredictionSettingsPane.tsx | prediction-service.ts 私有通道；prediction-engine.ts 复用语料、锁与下载；旧 prediction.query/control 保留 |
| Archive 与维护 | history/NativeArchivePane.tsx、diagnostics/NativeMaintenancePane.tsx | archive-service.ts、maintenance-service.ts；完整导出走私有文件通道 |
| 聊天托管浏览器与接管 | 每个网页一个 Dock 标签：`browser/BrowserDockInstances.tsx`（同步、标签定义、链接）、`browserDockSync.ts`（纯规划器）、`browserSessions.ts`（按聊天共享状态 hub）；单网页面板 `ManagedBrowserPane.tsx`（含通用 Browser 新标签页 `BrowserStartPanel`）、`BrowserToolbar.tsx`、`BrowserStartPage.tsx`、`BrowserReferenceTray.tsx`、`BrowserViews.tsx`（下载 / 设置）、`BrowserPane.tsx`（原生可用性与旧观察视图）、`useBrowserPresentation.ts`、`managedBrowser.css`；演示 `preview/managedBrowserPreview.ts`、`ManagedBrowserDemoPage.tsx`；验收页 `browser-harness.html?preview=1` | Desktop `managed-browser{,-store,-relay,-ipc,-shared,-picker,-address,-favicon}.ts`（读取不加载网页、呈现时加载；`close-handoff` 等 Agent 当前一步后关闭并交还；站点图标转 ≤32KB data URL）；Runtime `managed-browser-service.ts` 与 `tools/browser` 接缝；同聊天原生网页、持久空间、下载、权限、跨窗口迁移与 Runtime 重绑；说明 `docs/browser.md`，验收 `scripts/browser-native-smoke.cjs` |
| 浏览器元素引用与链接 | `composer/browserReference.ts`、`referenceCodec.ts`（浏览器 / GitHub / Git commit 共用长度帧编解码）、`{ChipComposer,serialize,ingest,types}`；`browser/{browserLinks.tsx,terminalBrowserLinks.ts}`；`conversation/markdown.tsx`、`TerminalPane.tsx` | 固定 Desktop 选择事件提供定位与截图；`workbench/WorkbenchCanvas.tsx`（`insertBrowserReferences`）将引用与图片加入 Composer；消息 / 终端链接由 `BrowserDockInstances` 接住，可直接打开时新建网页标签，否则在新标签页上「接管并打开」，菜单可选系统浏览器 |
| 兼容浏览器观察 | `browser/BrowserPane.tsx` 的 LegacyBrowserPane | `browser-observation-service.ts`、`browser-tab-control.ts`；Desktop `browser-observation.ts` 固定 IPC，Web / SSH / 旧 Runtime 按现有能力显示 |
| Computer Use | `browser/ComputerPane.tsx` 兼容入口、`computer/{ComputerWorkspace,ComputerFrameView,ComputerActivity,ComputerStructure,ComputerSettings}.tsx`、`computer/workspaceSource.ts`；共享 `composer/ImagePreview.tsx`；`conversation/ToolBody.tsx` 同帧联动 | 新版 `computer-workspace-protocol.ts` / `computer-workspace-service.ts`、native computer run/action/frame 事件与停止策略；Host 独立 query/event；Desktop `computer-frames.ts` 私有资源与保留；旧 `computer-observation-service.ts` 保留。说明 `docs/computer-use.md`，隔离验收 `computer-harness.html` |
| IDA 管理与编辑 | `capabilities/IdaPane.tsx`、`IdaDatabaseTools.tsx`、`ida.css`、`CapabilityEditor.tsx`；数据库列表、版本化分页视图、确认编辑与 Python 控制台 | ida-details-service.ts 新管理接口、ida-service.ts 保留发布协议；同一原生 IDA Broker |
| Ratchet | evaluation/RatchetPane.tsx | ratchet-service.ts、ratchet-boundary.ts；原生隔离、审批与评分 |
| 图形预览 | `graphics/{GraphicPreview,GraphicScene,SvgFigureImage}.tsx`、`previewActivity.ts`、`graphic-result-cache.ts`、`conversation/{NumericMarkdownTable,LazyMermaid}.tsx` | Worker 与 GPU 仍限制并发；32 MiB / 12 项几何缓存复用滚动回看的结果，GPU 在离屏且滚动结束后释放，以最后一帧和固定视口保留内容高度；静态图表保留，图片异步解码，重渲染等滚动停止；Three/X_ITE、本地资源包；Desktop chrome-artifacts.ts |
| 录制与标注 | recordings/RecordingPlayer.tsx、annotations/Annotations.tsx、terminalTheme.ts | 既有产物库、录制和标注协议；隐藏页面释放媒体资源 |

发布范围和验证：[OMP 18.8.0](../docs/migrations/omp-18.8.0.md)。0.1.8 既有 Stats、Frustration、Ask 图片、技能命名空间及子代理 BTW 路径保留。

## OMP 18.10.4 开发适配

| 功能 | UI | Runtime / Host / Desktop |
|---|---|---|
| 账号池、压缩阈值与新设置 | `models/AgentAccountRules.tsx` / `useAgentAccountPools.ts`（并入 `SubagentsPanel` 详情、列表摘要和统一保存；全局账号草稿与 Runtime 生效值分别读取，`accounts.pool.get/set` 按代理写入，保留项目／会话覆盖）、`ModelCompactionPane.tsx`、`settings/FeatureSettingsPane.tsx` | `contracts/feature-settings.ts` → `services/feature-settings-service.ts`；原生设置注册器、OAuth 身份键和压缩预览 |
| 会话迁移与匿名导出 | `history/SessionPortabilityPane.tsx` | `contracts/session-portability.ts` → `services/session-portability-service.ts`；`session-commands.ts` 注入私有文件授权并注册目标工作区；`runtime-media-files.ts` 保持媒体与会话包授权分离 |
| NTFS/APFS 透明压缩 | `diagnostics/SessionCompressionPane.tsx` | `contracts/session-compression.ts` → `services/session-compression-service.ts`；原生 GC 候选选择和文件身份复核 |
| 会话 Worktree 与启动选择 | `workspaces/SessionWorktreesPane.tsx`（含 `WorktreeLaunchGate`）；任务设置、Git 侧栏、主 Composer | `contracts/session-worktrees.ts` → `services/session-worktrees-service.ts`；原生创建/退出规划，Bridge 退出清理；首条提示词门控 |
| Plan 执行档位与扩展评审 | `deck/PlanExecutionPicker.tsx`、`PlanCard.tsx`、`workbench/WorkbenchCanvas.tsx` | `contracts/plan-review.ts` → `mode-control-service.ts`；`ExtensionRunner.bindPlanReviewActions`，评审 ID 与重复响应门控 |
| 下一消息预测 | `composer/useWordPrediction.ts`、交互设置 | 私有 `prediction-channel` 的 `next` 输入/事件；`services/message-prediction.ts` 复用原生 `ComposerPredictionController` |
| 后台工具结果与重连 | `conversationStore.ts`、`conversationViewModel.ts` | `conversation-live-projector.ts` 有界结果缓存；`session-transcript-service.ts` 按原生 jobId 补当前结果 |
| Ask 折叠 | `deck/AskCard.tsx`、`QueuedDeck.tsx` | 本地显示状态，回答/附件保留，不产生提交或取消 |
| Judge 模型配置 | `judgments/JudgeModelPane.tsx`、`JudgmentsPane.tsx` | 既有 `runtime.models.list` 和 `runtime.settings.get/set`；原生 NativeJudge 与批次用量 |

本版移除创建子代理时的单次模型覆盖和 Codex Code Mode 设置入口。旧协议读取兼容保留，废弃写操作明确拒绝。[完整版本变化与验收](../docs/migrations/omp-18.10.4.md)。

## OMP 18.12.6 适配

| 功能 | UI | Runtime / Host / Desktop |
|---|---|---|
| Ask and remember、记住授权、审批时输入 | `ComposerApprovalPicker.tsx`、`deck/ApprovalCard.tsx`、`InteractionDeck.tsx`、`workbench/WorkbenchCanvas.tsx` `steerPastApproval` | `interactions.ts` 的 `session` / `grants`；overlay `remote-extension-ui.ts`（`approve()`、`approveTool`）、`interaction-port.ts` `approvalAnswerFromValue`；接缝 `extensions/wrapper.ts` 经上游 `requestApproval()` |
| 忘记已记住的审批 | `settings/SettingsPanels.tsx` 权限页 | `approvals.forget` → `services/runtime-feature-service.ts` → 上游 `clearApprovalGrants()` |
| 作业树 / 详情 / widget / wait tile | `AgentHub.tsx`、`conversation/JobWidget.tsx`、`JobInspector.tsx`、`jobTree.ts`、`ToolBody.tsx` | `services/job-service.ts`、`state-projector.ts`（`jobAgents`、widget 订阅）、`jobs.inspect` → `services/job-inspect.ts` |
| 等待后台作业、MCP 进度、Eval 视图 | `workbench/WorkbenchCanvas.tsx` 活动行、`ToolBody.tsx` McpBody / EvalBody | `services/conversation-live-projector.ts`（`awaitingAsyncWork`、`tool.updated.progress`、`cells[].views`） |
| MCP 重新授权 / 退出 / 重连 | `capabilities/McpAuthActions.tsx` | `mcp.auth.*` → `services/mcp-auth-service.ts`（上游 `oauth-reauth.ts`） |
| Seance 只读咨询 | `HistoryPage.tsx`、`history/SeanceDialog.tsx` | `seance.ask` → `services/seance-service.ts`（task 工具 + seance agent） |
| 会话构建来源 | `DiagnosticsPage.tsx` | `state-projector.ts` `runtimeIdentity` |
| 新设置、`widget` 角色、`imageCountBudget`、`structured` | `NativePreferencesPane.tsx`、`FeatureSettingsPane.tsx`、`ModelConfigPage.tsx`、`SubagentsPanel.tsx` | 两组设置白名单、`model-kinds.ts`、`omp-models-adapter.ts`、`omp-agent-definitions-adapter.ts` |

新 Runtime 操作集中在 `contracts/runtime-features.ts`（overlay 镜像 `runtime-features-protocol.ts`）。[完整版本变化与验证](../docs/migrations/omp-18.12.6.md)。
