# 功能代码索引

何时打开：改某块产品功能、不知道入口时。不要整篇塞进 always-on 规则；从 [`AGENTS.md`](../AGENTS.md) 的路由表跳到对应节即可。

这是 **功能 → 文件** 的地图，不是架构愿景。协议形状以类型为准，不在这里复述。搬家后改这一份，不要在 `AGENTS.md` 复制表格。

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
| `@omp-studio/transport-desktop` | 固定 IPC 通道名与校验 | `packages/transport-desktop/src/channels.ts` |
| `@omp-studio/runtime-installer` | 签名工件安装 / 回滚 | `packages/runtime-installer/src/index.ts` |
| `@omp-studio/platform-win32` | 单实例锁、Job Object、私有 endpoint | `packages/platform-win32/src/index.ts` |
| `apps/desktop` | Electron 壳、Host 组装、Git/终端等本机能力 | `apps/desktop/src/host-composition.ts` |
| `apps/renderer` | UI | `apps/renderer/src/App.tsx`、`main.tsx` |
| `omp-patch/overlay` | Studio 自有 Runtime 源码 | `omp-patch/overlay/packages/coding-agent/src/studio/` |

现行架构：[`docs/architecture.md`](../docs/architecture.md)。长文历史基线：[`BACKEND_FOUNDATION.md`](BACKEND_FOUNDATION.md)、[`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md)。补丁流程：[`omp-patch/README.md`](../omp-patch/README.md)。

---

## 工作台壳

| 功能 | 入口 | 说明 |
|---|---|---|
| 挂载 / 无 Host 空态 | `apps/renderer/src/main.tsx` | `StudioClientImpl` + `createDesktopTransport`；缺桥则 `Unavailable` |
| 壳布局、侧栏、底栏、路由 | `apps/renderer/src/App.tsx` | 工作台主文件；Explorer 真树 `RealFileTree` 也在这里 |
| 会话行 ⋯ 菜单 / 行右键 | `apps/renderer/src/App.tsx`（`ThreadRowMenu` / `ThreadActionMenuItems` / `runThreadRowAction`） | 顶栏「对话选项」同款七项（弹层 208px 稍窄）；⋯ 点击锚按钮、行右键贴光标，同一弹层；作用于所在行会话：非当前会话先 `openHistoryEntry`（`resumeForAction`，必要时切工作区并 resume）再执行；预览演示行会话动作禁用（写表面不伪造目标）；临时行仅当为当前活动会话时可用，草稿行保留原生右键 |
| 悬停 tip | `apps/renderer/src/TipHost.tsx` | `[data-tip]` 门户气泡；不用原生 `title`；文案短词，未实现加「（暂未实现）」 |
| 首页 | `apps/renderer/src/HomePage.tsx` | `home.get` / `usage.get` / 历史入口 |
| 首页身份 / 头像 | `apps/renderer/src/settings/operatorProfile.ts`、`avatarCrop.ts`、`AvatarCropDialog.tsx`、`HomePage.tsx`；桌面 `chrome-profile.ts` | 显示名本地记忆；选图后圆形裁切；头像写入 `%APPDATA%\omp-studio\profile\`（覆盖，无历史）；NSIS 卸载删除 |
| 历史 / 项目会话缓存 | `apps/renderer/src/HistoryPage.tsx`、`sidebar/useProjectHistories.ts`、`sidebar/provisionalThread.ts`、`studio-host/src/session-catalog.ts` | `history.list`；侧栏按 `workspaceId` 独立加载 / 分页 / 刷新；只有 title/session/model/thinking 元数据、尚无 `message` 的空白 JSONL 不进入历史；草稿非空或提示词已发送时显示 Renderer 临时行，正式 LLM 标题到达后按 `sessionId` 接管；归档成功的 `sessionId` 会阻止迟到的 Workbench 状态复活临时行；resume / archive / drop / delete（历史页「⋮ → 删除会话」走 `session.delete`，Host 清 transcript/artifacts/遥测/绑定/租约/pin 残留） |
| 命令面板 | `apps/renderer/src/CommandPalette.tsx`、`commandPaletteCatalog.ts` | 动作目录与路由 |
| 主题 / 密度 / 上次路由 / 浮窗几何 | `apps/renderer/src/settings/appSettings.ts` | 本地 UI 记忆，不进 Host；BTW 几何在 `LayoutMemory` |
| 进入应用提示（尚未完成） | `apps/renderer/src/StartupNotice.tsx`、`settings/startupNotice.ts` | 中文全局弹窗：项目 GitHub、关闭 / 不再提醒；「不再提醒」只写 localStorage，不进 Host；GitHub 卡点开走 `ompStudioChrome.openUrl` |
| 预览开关 | `apps/renderer/src/preview/mode.ts`、`PreviewContext.tsx` | 显示层开关；`PREVIEW_MODE_SWITCH_ENABLED` |
| 预览 fixture / 壳 | `apps/renderer/src/preview/fixtures.ts`、`surfaces.tsx`、`btwPreview.ts` | 新读表面必须同时接预览与真实 |

## 对话与 Composer

| 功能 | 入口 | 命令 / query |
|---|---|---|
| 对话窗 | `apps/renderer/src/conversation/ConversationPane.tsx` | 订阅 conversation 事件 |
| 对话 hook | `conversation/useConversation.ts` | 连 `StudioClient` |
| 用户消息 Restore / 新会话 | `conversation/ConversationItemView.tsx`、`UserMessageBody.tsx`、`userMessageThumbs.ts`、`userMessageRestore.ts`、`UserMessageTreeConfirm.tsx`、`conversationEngine.ts`、`composer/serialize.ts` | 已发送用户气泡「恢复」（`undo` 图标）→ `session.tree.navigate`（leaf=该条 parent）；「新会话」（`branch` 图标）→ `session.tree.branch`（新 session 文件，切过去）。确认用应用内模态（归档同风格），不用 `window.confirm`。气泡仍画文件/技能/图片胶囊，配色与 Composer 同类胶囊一致（不刷成气泡白霜）。复制按钮与划选复制走序列化 `@` / `/skill:` / `[图N]`。图缩略图贴在气泡上方，点击预览；公开 transcript 仍剥图。预览字节落本机 IndexedDB（`omp-studio-ui` / `user-message-thumbs`），按 sessionId+itemId 重开会话仍能挂回缩略图，不进 Host。预览本地裁剪，不调 Host。busy 时 overlay 拒绝。`/branch` 提示点气泡，不打开 Changes。 |
| 客户端对话状态 | `packages/client/src/conversation-reducer.ts`、`conversation-state.ts` | 不把 mock 写进 reducer |
| 正文 markdown / 流式渲染 | `conversation/markdown.tsx`、`incrementalMarkdown.ts`、`magicKeywordMarkdown.tsx` | 非流式：整篇一次解析。流式：`IncrementalMarkdownBlocks` 冻结除尾部两块以外的顶层块，冻结块只解析 / 高亮一次并缓存元素，块之间补 `\n` 与整篇解析对齐 DOM；出现脚注 / 链接引用定义时退回整篇渲染。`MarkdownText` 与 `MessageBody` 都是 `memo` |
| 快照行复用 / 渲染节流 | `conversation/rowReuse.ts`、`conversationEngine.ts`、`useConversation.ts`、`useStableCallback.ts` | 新旧快照结构比较后复用未变行（整条没变则连数组一起复用），memo 才生效；engine 通知按动画帧合并（首次同步 + 帧尾一次）；传进对话子树的回调用 `useStableCallback` 保持恒定引用 |
| 会话切换加载 / 显示 | `conversation/sessionRowsCache.ts`、`progressiveRows.ts`、`useConversation.ts`、`conversationEngine.ts`、`App.tsx`（`selectedIsResident`） | 切回最近 5 条会话时先画上次的行（LRU，每条最多 60 行）并作为 `reuseTimelineRows` 基线，顶部照常「正在加载对话」；驻留会话在 `session.resume` 期间不读归档页（`activating` → `deferHydrate`，600ms 兜底回落），一次切换只读一遍 transcript；缩略图与 hydrate 同一次提交；首次挂载超过 16 行时按帧从尾部铺开 |
| 活动行 / 暂停恢复 | `conversation/ActivityLine.tsx`、`activityStatus.ts` | `runtime.pause` / `resume` / `core.abort` |
| 工具卡片 | `conversation/ToolBody.tsx`、`toolMeta.ts`、`bashDisplay.ts`、`useToolCardFollowScroll.tsx` | 工具展示元数据；bash 直播剥 ANSI / `\\r`；展开卡内流式输出跟底，卡内上滚同样按手势脱离（与对话区共用 `bindTailGestures`） |
| 会话变更 | `conversation/SessionChanges.tsx`、`ChangesPanel.tsx`、`TurnDiffCard.tsx` | 本轮文件改动；对话 diff 卡「审核」跳到对应轮次 |
| 滚动 / 小地图 | `useConversationScroll.ts`、`ConversationMinimap.tsx` | 贴底时跟 `contentKey` / 新行沉底；上滚**按手势**（wheel / ArrowUp·PageUp·Home / 触摸）立刻脱离，不等 scroll 事件——流式 tick 会先把视图写回底部；被工具卡内层滚动条吃掉的滚轮不算脱离。回到底部（≤1px）或滚回 72px 内自动重挂，也可点「回到最新」。「加载更早消息」在点击时抓锚点并主动脱离，页面前插后按首行 id 变化确认并还原阅读位置 |
| 空态 / 最近会话 | `ConversationEmpty.tsx`、`emptyRecents.ts`、`welcomeGate.ts` | |
| 瞬时状态 toast | `transientStatusNotice.ts` | 与持久诊断分开 |
| 子代理对话 | `subagentConversationEngine.ts`、`useSubagentConversation.ts`、`SubagentConversationPane.tsx` | live `agent.conversation.read` 仅当 viewed session === live session 且 Runtime 已连接；否则 `session.transcript.readPage`（parent `sessionId` + `agentId`）。live 缺失（`AGENT_NOT_FOUND` / was not found）也回退归档。Hub/Inspect 底部 ChipComposer 走 `agent.send`（text + 可选 images）；左下附件按钮插入文件/图片胶囊 |
| 子代理检查卡 | `SubagentInspectCard.tsx`、`subagentComposerGate.ts`、`SubagentMetrics.tsx` | 挂在 `.convo-wrap` 的 ask 式弹窗；打开/收起从底边中点变形；固定约 82% 工作区高（视口 − 标题栏 − 顶栏）；对话条卡片叠 Hub roster 用量/状态；允许输入时底部 ChipComposer 走 `agent.send`（与 Hub 流式页共用附件胶囊） |
| Agent 测试面板 | `AgentTestsPane.tsx`、`agentTestRuns.ts` | |
| Chip Composer | `apps/renderer/src/composer/ChipComposer.tsx` | Enter：`core.prompt` / 本地排队；Ctrl+Enter：`core.followUp`（带图）；插入纠偏：`core.steer` |
| 图片预览 | `composer/ImagePreview.tsx`；桌面 `chrome-image.ts` | 缩略图点击预览；复制/保存走 `ompStudioChrome`，不是 Host |
| slash 命令菜单 | `composer/commands.ts`、`CommandMenu.tsx` | 解析后走语义 command；typed 名必须在 `operations.ts` / IPC `COMMAND_NAMES`。`/clear` → `session.clearContext` → facade `#commandP4` → overlay `clearContext`；`/drop` 补当前 `threadId` 后走 Host `session.drop` |
| @ 提及 | `composer/mentions.ts` | `workspace.fileTree`、`agents.definitions.get`、查询非空时 `skills.get` |
| 模型 / 模式选择 | `ComposerModelPicker.tsx`、`ComposerModePicker.tsx` | `session.model.set`、`session.thinking.set`、plan/vibe |
| 消息队列条 | `MessageQueueBar.tsx`、`composer/queueEdit.ts` | 流式 Enter 本地排队（按 session 隔离），idle 后 `core.prompt`；「插入纠偏」`core.steer`；`/queue` 为 `queue.enqueue`，带图片时改 `core.followUp`。编辑在 Composer 内进行，条目留队；编辑队首时暂停 flush |
| 审批 / Ask 卡片 | `InteractionDeck.tsx`、`deck/ApprovalCard.tsx`、`deck/AskCard.tsx`、`deck/QueuedDeck.tsx`、`deck/askGenie.ts`、`deck/interactionGate.ts` | `interaction.respond`；Ask 紧凑卡/Ask 卡加载与退出为底边变形浮入（不改 Plan 放大缩小）。可见提问卡不复用 Composer `gated` |
| Plan 评审 | `deck/PlanCard.tsx`、`deck/PlanCreatedCard.tsx`、`planSections.ts`、`planFeedback.ts`、`conversation/toolMeta.ts`（`xd://propose`） | 出现时保持紧凑卡，点放大或对话入口才展开大卡；紧凑卡与展开卡右上角均放「保存并退出」（能力存在时显示），不再占用底部评审操作区；大卡章节批注；大卡底栏常驻全文批注（整份计划）；大卡右上角叉号收成紧凑卡；有意见 `mode.plan.review.respond` refine，空 Refine 走 dismiss 回 Composer；批准 `execute` 清上下文、`compact` 先压缩再执行、`keep` 保留上下文（`approve` 是 keep 别名）；钉在 `xd://propose` 所在 assistant 行（批准后不跟到最新轮）；执行后入口卡打开只读大卡回看正文，不再打 `mode.plan.review.open` |
| 权限档位 | `ComposerApprovalPicker.tsx`（`App.tsx` 接入） | `permissions.mode.set`；预览本地切换；历史会话先 `session.resume` 再 set；流式 / 压缩中可改，下一轮对话才写入 `tools.approvalMode` |
| BTW 旁路问答 | `apps/renderer/src/btw/`（`BtwHost.tsx`、`useBtwWindow.ts`、`useBtwSession.ts`） | `/btw` → `btw.ask`；中止 / 分支 `btw.abort` / `btw.branch`；事件 `btw.changed` |
| 会话生命周期 UI | `apps/renderer/src/sessionLifecycle.ts` | `session.create` / `resume` |
| 侧栏运行态 / 等待态 | `sidebar/threadRunning.ts`、`threadWait.ts`、`ThreadSpin.tsx`、`ThreadWaitChip.tsx` | 当前会话从 live snapshot、后台会话从 `residents.list` / `residents.changed` 摘要推导；不把后台 snapshot 注入当前会话 |

Host 侧对话事件：`packages/studio-host/src/conversation-events.ts`。  
Runtime 投影：overlay `services/conversation-live-projector.ts`、`conversation-projector-hub.ts`。  
持久 transcript：overlay `services/session-transcript-service.ts`；Host `session-archive-reader.ts`（`session.transcript.readPage`）。

## 会话、归档、Telemetry

| 功能 | Host / Desktop | Runtime overlay |
|---|---|---|
| 创建 / 恢复 / 删除 | `apps/desktop/src/session-commands.ts` | `services/session-control-service.ts` |
| 目录扫描 | `studio-host/src/session-catalog.ts` | — |
| 归档 / 解档 | `studio-host/src/session-archive-service.ts` | 切走 live 文件后再 gzip |
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
| 子代理面板 | `SubagentsPanel.tsx` | `agent.spawn/send/kill/revive/release` | 同上 + `agent-conversation-service.ts` |
| 任务代理定义 | `AgentHub` / Capabilities | `omp-agent-definitions-adapter.ts` | 磁盘 `.omp/agents/*.md`，不是 Hub live 态 |
| Skills 抽屉 | `SkillsDrawer.tsx`、`skills/skillUsage.ts` | `omp-extensibility-adapter.ts`、`skills.get` / `skills.setEnabled` | overlay `skill-prompt-expansion.ts` |
| MCP | `CapabilitiesPage.tsx` | `omp-mcp-adapter.ts`、`omp-mcp-probe.ts`、`mcp.get` / `mcp.setEnabled` / `mcp.refresh` / `mcp.test` / `mcp.logs.get` | 配置扫描 + Host 一次性探测；不是 Runtime MCPManager 连接态 |
| 能力中心 | `CapabilitiesPage.tsx` | Skills 开目录 `skills.reveal` / `skills.revealRoot`（Desktop `shell.openPath`）；Slash 页 `visibleSlashCatalog()` + `App.runSlashCommand`，不是 `commands.getManifest` | overlay `command-manifest-service.ts` 仍只服务协议 manifest |
| 模型配置页 | `ModelConfigPage.tsx`、`models/fetchedModels.ts`、`models/WebSearchPanel.tsx`（网络搜索 tab） | `omp-models-adapter.ts`、`models-yml.ts`；「自动获取模型」走 `models.provider.probe`（不传 `discoveryType`，Host 按 api 类型选模型列表地址与认证头），候选清单只进表单草稿，保存才写 `models.yml`；网络搜索配置（`web_search.*` / `providers.webSearch*` / `searxng.*` / `exa.*`）走 `models.webSearch.set`，写 `config.yml` | overlay `model-control-service.ts`（会话内切模型） |
| 发现 / 插件根 | — | `host-client-api/src/omp-discovery/**` | — |
| Token 用量 | Home / `usage/tokenUsage.ts` | `omp-usage-adapter.ts`、`usage.get` | 聚合 `omp stats.db`，不是演示数字 |

预览 fixture：`hubPreview.ts`、`skillsPreview.ts`、`capabilitiesPreview.ts`、`preview/modelConfigFixtures.ts`（含 `createPreviewFetchedModels()`）。不要把这些写进 Host。

## Git / GitHub / 工作区文件

Git **不走 Runtime Bridge**。桌面主进程实现，Facade 转调。

| 功能 | UI | 实现 |
|---|---|---|
| 状态 / 暂存 / 提交 | `apps/renderer/src/git/GitStatusPanel.tsx` | `apps/desktop/src/git-service.ts` → `git.execute` |
| 面板拆分 / 更多操作 | `git/GitPanelSplit.tsx`、`GitMoreActionsMenu.tsx` | 操作 kind 见 `client-contract/src/git.ts` `GitOperation` |
| 文件树 git 徽章 | `git/treeStatus.ts`；`App.tsx` `RealFileTree` | `git.repository.get` |
| Explorer 读写圆点 | `conversation/explorerFileActivity.ts`；`App.tsx` `RealFileTree` | 主会话 `liveTools`：读红点、写绿点；预览用 fixture `reading`/`writing` |
| log / diff | Git 面板 | `git-log.ts`、`git.diff.get` / `git.log.list` / `git.commit.*` |
| GitHub PR | Git 面板 | `apps/desktop/src/github-service.ts` → `github.execute` |
| 工作区注册 | 首页 / 设置 | `studio-host/src/workspace-registry.ts`、`workspace.open` / `pick` |
| 文件树 query | `App.tsx` `RealFileTree` | facade `workspace.fileTree`；磁盘 `apps/desktop/src/workspace-files.ts` |
| 拖放路径 | Composer / Explorer | `apps/desktop/src/dropped-paths.ts` |
| 外部编辑器 | 工作区壳 | `external-editor.ts`、`workspace-shell-ipc.ts` |

## 终端、窗口铬、设置、诊断

这些通道 **不是** Host `DESKTOP_IPC_CHANNELS`。preload 上是独立冻结对象。

| 功能 | Renderer | Desktop |
|---|---|---|
| 底栏终端 | `apps/renderer/src/TerminalPane.tsx` | `terminal-ipc.ts`、`terminal-pty.ts` |
| 标题栏 overlay | 壳 | `titlebar-overlay.ts` |
| 应用图标 | 侧栏 / 关于 `AppIcon`；`public/icon.png`、`favicon.ico` | Renderer 自带图标资源；桌面运行时在 Windows 设置 `AppUserModelId` 并把 `resources/icon.ico` 注入窗口（任务栏/窗口身份）；安装包由 `packaging/electron-builder.yml` 将同一 ICO 写入 EXE，并创建带图标的桌面与开始菜单快捷方式 |
| 系统通知 | — | `chrome-notify.ts` |
| 外部 https 链接 | 启动提示 GitHub 卡；`ompStudioChrome.openUrl` | `chrome-open-url.ts` → `shell.openExternal`（系统默认浏览器，不是 Electron 窗）；只接受 https |
| 操作者头像文件 | 首页弹窗 | `chrome-profile.ts` → `%APPDATA%\omp-studio\profile\`；升级从安装目录 `userdata\profile` 迁入；卸载 `customUnInstall` 删除 |
| 应用更新（GitHub Release） | `AppUpdateDialog.tsx`、`settings/appUpdate.ts`、`App.tsx`（左下角头像徽标与静默检测）；预览 `PREVIEW_APP_UPDATE` | `chrome-app-update.ts`、`chrome-app-update-shared.ts` → GitHub API 版本比对与全量安装包下载调起 |
| Plan 另存为对话框 | `App.tsx` `pickPlanSaveTarget` / `savePlanAndQuit`；`deck/PlanCard.tsx` 按钮 | `workspace-shell-shared.ts`、`workspace-shell-ipc.ts`、`plan-save-path.ts`（原生另存为，默认 `<工作区>/PLAN.md`，回传工作区相对路径；越界拒绝）→ Bridge `mode.plan.review.saveAndQuit` |
| 设置页 | `SettingsPage.tsx`、`settings/tabs.tsx` | 本地设置 + 少量 Host query |
| 诊断页 | `DiagnosticsPage.tsx`、`diagnosticsModel.ts`、`runtimeEnsure.ts`、`RuntimeLossBanner.tsx`、`ActionProgressBar.tsx`、`updateCheck.ts`；预览 `preview/fixtures.ts` `PREVIEW_DIAGNOSTICS`；桌面 `chrome-logs.ts` | `diagnostics.get` / `environment.get` / `capabilities.get`；启动与进页静默检查更新（超时不报错）；手动检查更新超时才提示；本地制品对比 `runtime-install.ts` `probeManagedRuntimeInstall`；安装/更新/重装 `runtime.install`；断开或启动失败时「重新连接 Runtime」走 `runtime.ensure`；已连接时「重启 Runtime」走 `runtime.ensure` `{ force: true }`，收据未连上时自动再 `ensure` 并等到 `runtime.changed` connected；Host 日志打开/导出走 chrome IPC `chrome-logs.ts`（路径不回传 Renderer）。工作台 / Hub / 空对话复用 `RuntimeLossBanner`。长操作显示分步进度条。 |
| 安全窗 / CSP | — | `apps/desktop/src/security.ts` |
| Windows 安装包 | `packaging/ui/index.html` 即 Setup 可见向导 | `packaging/installer-host`（WebView2：ProgramData 暂存 + `https://omp-installer/` 虚拟主机，不用 `$PLUGINSDIR` 的 `file://`）；`packaging/nsis/custom.nsh`（隐藏 MUI、options.ini、占用/目录规则）；`scripts/installer-dir.mjs`；`scripts/build-installer-host.mjs`。卸载仍是 MUI2。活 Runtime 在 `$INSTDIR\runtime\versions\` |
| 组装顺序 | — | `host-factory.ts` → `host-composition.ts` → `composition.ts`；入口 `main.ts` |

Host 传输通道只有：`bootstrap` / `query` / `command` / `subscribe` / `event` / `close`（`packages/transport-desktop/src/channels.ts`）。不要再加通用 `invoke(channel, payload)`。

## Host 内核（改协议行为时）

| 主题 | 文件 |
|---|---|
| Backend 生命周期 | `packages/studio-host/src/host-backend.ts` |
| 解析 / 启动 Runtime | `runtime-resolver.ts`、`runtime-session-controller.ts`、`runtime-process-port.ts` |
| Bridge 客户端 | `bridge-client.ts`、`bridge-auth.ts` |
| 状态投影 | `state-projector.ts`、`runtime-projection.ts` |
| 交互转发 | `interaction-adapter.ts`、`interaction-events.ts` |
| BTW 旁路转发 | `packages/studio-host/src/btw-events.ts`；facade `#bindBtw`；client `entities.btw` |
| 破坏性确认 | `host-confirmation.ts` |
| Windows Job Object | `windows-job-object.ts` |
| 安装态 | `packages/runtime-installer`；桌面 `apps/desktop/src/runtime-install.ts`；安装包 extraFiles `$INSTDIR\runtime\versions\`，打包后直接跑这份 `omp.exe` |

## Runtime overlay（改 omp `--mode studio-host` 时）

源码在 `omp-patch/overlay/packages/coding-agent/src/studio/`。编辑 overlay 或 vendor 后用 `npm run omp:patches:regen`，不要手写 `.patch`。

| 主题 | 文件 |
|---|---|
| 进程入口 / 服务组装 | `studio-host-mode.ts` |
| Bridge 服务端 / 分发 | `bridge-server.ts`、`bridge-dispatcher.ts`、`bridge-protocol.ts` |
| 暂停 | `services/pause-service.ts` |
| Plan / Vibe / Loop / Goal | `mode-control-service.ts`、`loop-service.ts` |
| 会话树 / fork / handoff | `tree-service.ts`、`fork-service.ts`、`handoff-service.ts` |
| Fast / prewalk | `fast-prewalk-service.ts` |
| Live（无桌面音频则 fail closed） | `live-service.ts` |
| BTW / TAN / OMFG | overlay `btw-service.ts`、`tan-service.ts`、`omfg-service.ts`；Host `btw-events.ts`、facade `#bindBtw`、client `reducer.ts` `entities.btw`；Renderer `apps/renderer/src/btw/` |
| 会话来源标记 | `session-origin.ts` |

接缝补丁（改上游已有文件）：`omp-patch/patches/0001` CLI 入口 → `0002` session → `0003` modes/pause → `0004` extensibility。分组名单：`scripts/omp-seam.mjs`。

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
| `workspace.fileTree` | `App.tsx` `RealFileTree` → `workspace-files.ts` |
| `session.transcript.readPage` | 历史 / 对话回放 → `session-archive-reader.ts` |
| `session.telemetry.read` | `useViewedSessionTelemetry.ts` → Host store / archive probe |
| `btw.ask` / `abort` / `branch` | Composer `/btw` → `useBtwSession` → facade → overlay `btw-service.ts` |
| `usage.get` | Home → `omp-usage-adapter.ts` |
| `runtime.install` | 诊断中心 → `runtime-installer` + `runtime-install.ts` |
| `runtime.ensure` | 诊断中心重新连接 / 重启、工作台与 Hub 横幅、空对话 CTA、会话恢复 → `runtime-session.ts` `ensure`（可选 `force`）+ `host-composition.ts` `ensureInstalledRuntime` |

## 不要当作产品代码

| 路径 | 原因 |
|---|---|
| `ui_reference/` | 界面参考 |
| `backup/` | 任务前快照 |
| `omp-patch/vendor/oh-my-pi/` | 上游工作区；Studio 自有逻辑在 overlay，接缝在 `patches/` |
| `doc/real-conversation/`、`doc/multi-session/` | 过程计划，默认当归档 |
| `apps/*/dist/`、`packages/*/dist/` | 构建产物 |
| 上游 `AGENTS.md` | 上游 agent 规范，不是 Studio 地图 |

## 维护

- 新功能落地后：在对应表加一行（UI + Host/Desktop + 若有 Runtime）。
- 文件重命名：改这一份，不要让 `AGENTS.md` 再列路径。
- 新 query/command：先改 `client-contract` `operations.ts`，再改 facade `switch`，最后改 UI。
- 预览面：同一功能在 `preview/` 有 fixture 的，索引行里提一句，避免只改真实路径。
