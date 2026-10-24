# OMP 18.10.4 → 18.12.6 上游更新评估与 GUI 适配清单

状态：**只做评估，未改任何代码**。本文件回答两件事：上游这一区间更新了什么，以及哪些功能需要 Studio 额外做 GUI 适配。

## 结论摘要

1. 区间为 **11 个正式版本 + 当前 main**（18.11.0 → 18.12.6，其后还有 170 个未发布提交），3245 个提交、1822 个文件、+144,565 / −18,462 行。变更日志记录新增 49 条、行为变更 39 条、修复 323 条、破坏性变更 2 条。
2. **只有 2 条破坏性变更**，但其中 `ui.approve()` 的返回值改动直接落在 Studio 的审批通道上，配合新增的 Ask and remember 审批，是本次最大的一块 GUI 工作。
3. 上游这一区间真正"值得做界面"的新能力集中在四块：**审批缓存 / 作业可观测性（树 + widget + 步骤）/ MCP 进度与重授权 / Seance 只读会话咨询**。
4. 大量新增设置项（`prewalk.auto`、`advisor.continueSeverity`、`async.widgets`、`lsp.requestTimeout` 等）不会自动出现在 Studio：Studio 的原生偏好与特性设置都是**固定白名单**，必须逐项登记。
5. 作业数据上游已经做成 presentation-neutral（`AsyncJobTree`、`AsyncJobInspection`、`JobSnapshot.widget` 都是纯 JSON），GUI 不需要解析 TUI 渲染，**但 Studio 的作业协议目前没有这些字段**，需要扩协议。
6. `ApprovalMode` 在 Studio 协议里仍是三值联合。上游新增 `always-ask-cached` 后，若快照校验先于 UI 更新，会直接解析失败——这是最容易漏的高危点。
7. 四组接缝补丁（`main/cli`、`session/registry`、`modes/job-manager`、`extensions/sdk`）都命中了上游热点文件，升级必须走 `omp:overlay:apply → 修 → omp:patches:regen → omp:verify:patches`，不能只挪 submodule。

## 基线与规模

| 项 | 值 |
|---|---|
| Studio pin | `v18.10.4` / `687892d1046ecaf18829b45f5b86928a308258f4`（2026-10-13） |
| 上游目标 | `origin/main` / `0b5c27ab24`（2026-10-22），`git describe` = `v18.12.6-170-g0b5c27ab24` |
| 版本跨度 | 18.11.0、18.11.1、18.11.2、18.11.3、18.12.0–18.12.6，共 11 个正式版本 + 未发布段 |
| 差异规模 | 3245 commits，1822 files changed，270 added，7 deleted |
| 变更日志条目 | 新增 49 / 变更 39 / 修复 323 / 破坏 2 / 移除 1 |
| 现有 patchset | `studio.8`，4 组接缝 + overlay 121 个 TS 文件 |

## 上游更新了什么

按用户可见性归并，不逐条罗列 323 条修复。

| 主题 | 主要变化 | 版本 |
|---|---|---|
| 审批与权限 | 新增 **Ask and remember** 模式（`tools.approvalMode: always-ask-cached`）：文件读取也要问，可按「文件夹 / 文件」记住，分「本次会话 / 跨会话」，落 `approval-cache.db`；新增 `/forget-approvals`；扩展审批增加 `prompt.grants` 与 `{ grant, always }` 回答；工具可声明 `approvalCacheTargets` | 18.12.3 |
| 审批交互 | 审批提示收敛为 Approve / Approve `<tool>` for this session / Deny；审批待定时 composer 仍可用，发送即拒绝并 steer；Deny 行提示「Deny and send message」 | 18.11.0、18.11.3 |
| 作业可观测性 | `/jobs` 变作业树（子代理作业嵌套）；新增 `AsyncJobTree`、`AsyncJobInspection`（command/cwd/pids/exitCode/output/artifactId/widget）；**作业 widget** 由 `widget` 模型角色一次性生成规则、之后本地重算，六种可视化块（spark/bars/meter/stat/grid/text）；`wait` 卡片显示作业 tile、headline、完成度环；HUD jobs pill 显示 mini chart；状态行追加 headline；子代理任务卡显示当前步骤 | 18.11.1、18.12.3、18.12.4 |
| MCP | 工具调用上报 `notifications/progress`（工具卡与 Eval `mcp_progress`）；`/mcp reauth` 支持 ACP/RPC/print，开浏览器、打印授权 URL、运行中重连；`/mcp test`、`/mcp unauth` 项目/用户级选择修正；stdio 取消、重复执行、连接丢失语义修复 | 18.12.4、18.12.6 |
| 会话 / 模型 | 会话条目记录 omp build（version/commit/branch/diff hash/`OMP_BUILD_LABEL`），`/session` 可列；新增 `prewalk.auto`（off/suggest/on + autoTarget）；新增 `advisor.continueSeverity`；provider 连接预热；长缓存保留 `providers.cacheRetention: long`；`imageCountBudget`、`modelOverrides` | 18.11.0、18.11.3、18.12.0、18.12.1、18.12.5 |
| 新会话形态 | **`/seance`** + `task seance` agent：只读咨询已保存会话，可原位检索、不 resume、不复制工件，可选模型并追问；agent frontmatter `structured: true` | 18.11.3、18.11.0 |
| Eval / 判题 | 打印 DataFrame/Series 渲染为表格、大 dict/list 对象渲染为 JSON 树、Markdown 对象渲染为 Markdown、figure/image 附加到结果；判题支持图片附件；**移除 `display()`** | 18.12.1、18.12.4 |
| 桌面控制 | `computer.backgroundFallback`（takeover/refuse）；`el.selectText`、`el.type`、`el.press`、`menu` 选项、`win.move {takeover}`；Escape 停止本轮 computer use；`UserIntervened` / `StaleRef` / `no-ui` 等错误语义；后台输入不再抢焦点 | 18.12.2 |
| 浏览器 / 代码托管 | relay 后台标签、截图不抢焦点、`uploadFile` 大量修复；`/review` 与 `/annotate code-review` 支持 GitLab MR，新增 `mr://` URL | 18.12.2、18.12.4 |
| 扩展 | 只注册 tools/commands/flags/renderers/hooks 的扩展**延迟到 composer 可输入后加载**；`ctx.ui.getEditorComponent()`；`ui.approve()` 返回值变更（breaking） | 18.12.4、18.12.6、18.11.3 |
| 工具行为 | `read`/`grep`/`edit` 大量边界修复、bash 持久 shell 与取消、`proc://<id>/streams`、SQLite 分页、`find` 覆盖率、LSP 超时与重命名 | 全区间 |
| 协议 / 平台 | ACP `_session/steering`（可 steer 运行中 turn，`queue: "followUp"`）；ACP `session/cancel` 覆盖排队与自主运行；RPC `set_todos` 持久化；Windows 路径与 session 恢复修复 | 18.12.6、18.12.4 |
| 模型 / 厂商 | DeepSeek 搜索源、llama.cpp 9931 端口、Anthropic 2026-10-21 API 版本、Gemini/Antigravity、OpenAI Responses 缓存、Bedrock 压缩等目录与计费修复 | 全区间 |

### 破坏性变更（必须先处理）

| ID | 变更 | 对 Studio 的命中点 |
|---|---|---|
| B1 | `ExtensionUIContext.approve()` 返回 `"once" \| "session" \| "deny" \| { grant, always }`，prompt 增加 `session?` 与 `grants?` | Studio 自有的 `approveTool()` 仍返回 `boolean`（`remote-extension-ui.ts`、`interaction-port.ts` 的 port/fallback）。需要把自有契约扩成 answer 类型；若后续实现标准 `approve()`，签名必须同步 |
| B2 | 移除 eval 的 `display()`（JS 与 Python） | 需在升级后的 `check:ts` 与运行时验证：Studio 的 `evaluation-service` / `judgment-service` / Eval 卡若依赖该字段，会静默丢结构化输出 |
| B3 | `ApprovalMode` 新增 `always-ask-cached`（严格说不是上游声明的 breaking，但对强类型消费方等价） | `studio-protocol/src/contracts/commands.ts`、`state.ts`、`client-contract/src/operations.ts`、`settings/tabs.tsx`、`ComposerApprovalPicker.tsx` 全部是三值联合 |

## GUI 适配清单

量级：S ≈ 单组件/单枚举；M ≈ 一个面板或一条事件链；L ≈ 跨协议 + 服务 + 新面板。

### P0 — 阻断项，不修则现有 GUI 编译失败或状态解析失败

| ID | 功能 | 上游依据 | GUI 需要做什么 | Studio 落点 | 量级 |
|---|---|---|---|---|---|
| G01 | 审批返回值扩型 | B1 | 自有 `approveTool` 契约从 `boolean` 改为 answer 联合；审批卡把 answer 映射成提交值；fallback port 一并改 | `studio/remote-extension-ui.ts`、`services/interaction-port.ts`、`contracts/interactions.ts`、`deck/ApprovalCard.tsx` | M |
| G02 | 审批模式第 4 值 | B3 | 协议联合、快照校验、设置下拉、composer 权限 pill、i18n 全部加 `always-ask-cached`；旧值行为不变 | `contracts/commands.ts`、`contracts/state.ts`、`client-contract/operations.ts`、`settings/tabs.tsx`、`ComposerApprovalPicker.tsx` | S |
| G03 | 扩展延迟加载 vs 能力清单 | 18.12.6 | Hello 时 `operator.manifest.get` 可能不含被延迟的扩展命令。需确认 Studio 是否必须强制 eager（类似 resume / `--tools` 的分支），或增加 manifest 刷新事件并让能力页跟随 | `services/command-manifest-service.ts`、`studio-host-mode.ts`、`CapabilitiesPage.tsx` | M |
| G04 | eval `display()` 移除 | B2 | 清理任何 `display` 字段假设；Eval 卡改为读上游新的结构化结果字段 | `services/evaluation-service.ts`、`services/judgment-service.ts`、`conversation/ToolBody.tsx` | S |

### P1 — 上游新增、用户会直接在桌面端期待的能力

| ID | 功能 | 上游依据 | GUI 需要做什么 | Studio 落点 | 量级 |
|---|---|---|---|---|---|
| G05 | Ask and remember 审批 | 18.12.3 | ① 审批卡渲染 `grants`：文件夹/文件的「本次会话」「始终」最多 4 个附加选项，按钮区从 3 个改为主操作 + 「记住」菜单；② 展示该目标已被记住及其来源；③ 文件读取也进入审批流；④ 新增 `/forget-approvals` 入口（设置→权限 或命令面板）；⑤ 记录/清除后的状态回显 | `deck/ApprovalCard.tsx`、`contracts/interactions.ts`、`services/permission-control-service.ts`、`settings/tabs.tsx`、`commandPaletteCatalog.ts` | L |
| G06 | 作业树 | 18.11.1 / 18.12.4 | Agent Hub 的 Jobs tab 从扁平列表改为树：子代理作业挂在发起它的 task 下，按活跃度排序；只有自己的作业可取消 | `contracts/agents-jobs.ts`（新增 `job.tree`）、`services/job-service.ts`、`AgentHub.tsx` | M |
| G07 | 作业 inspector | 18.12.4 | 作业详情显示完整命令行、cwd、pids、退出码、输出尾部、artifact、widget；`JobSnapshot` 增加 `command` | 同上 + 新 `JobInspector` 组件 | M |
| G08 | 作业 widget 渲染 | 18.12.3 | React 实现六种块：spark（含 target 参考线、tooltip）、bars、meter、stat、grid、text；展示 title / headline / trend / stage / state / updatedAt；`async.widgets=false` 时回退为无 widget 的简洁卡 | 新 `conversation/JobWidget.tsx`、`contracts/agents-jobs.ts`（`widget` 字段） | L |
| G09 | wait 卡片作业 tile | 18.12.3 | wait 工具卡显示每个被等待作业的 tile（状态、名称、正在做什么、headline、mini widget、完成度环）；需要把 wait 结果里的 widget 持久化后仍可重绘 | `ToolBody.tsx`（wait 分支）、conversation 投影 | M |
| G10 | 子代理当前步骤 | 18.12.3 | Agent Hub 行、SubagentsPanel、任务卡显示「正在做什么」（子代理自述的 stage）与完成度估计 | `AgentHub.tsx`、`SubagentsPanel.tsx`、`contracts/agents-jobs.ts` | M |
| G11 | MCP 工具进度 | 18.12.4 | 工具卡显示 `notifications/progress` 的百分比/消息；Eval 内的 `mcp_progress` 状态行；需要 Host 侧订阅 progress 并作为 conversation 事件发布 | `contracts/conversation.ts`（tool progress 事件）、MCP 调用包装、`ToolBody.tsx` | M |
| G12 | MCP 重新授权 | 18.12.6 | MCP 面板行操作：重新授权 / 测试 / 取消授权；显示授权 URL、浏览器打开状态、失败原因；项目级与用户级同名条目要标明选中项 | `CapabilitiesPage.tsx`（MCP tab）、MCP 服务路由 | M |
| G13 | Seance 只读咨询 | 18.11.3 | 历史页/会话行入口「只读咨询」；来源会话 + 可选模型选择器；咨询视图只读、可追问、明确不 resume、不复制工件 | `HistoryPage.tsx`、conversation 新 kind、命令 manifest、session 创建路径 | L |
| G14 | Eval 结构化输出 | 18.12.1 | Eval 卡支持 DataFrame/Series 表格、JSON 树、Markdown 对象、figure/image；不能再只渲染 stdout 文本 | `ToolBody.tsx` EvalBody、`contracts/evaluation.ts` | M |
| G15 | 审批中 composer 可输入 | 18.11.0 / 18.11.3 | 审批卡存在时 composer 不再禁用；提交文本走「拒绝 + steer」，卡片与 composer 的联动提示要写清楚 | `deck/ApprovalCard.tsx`、`ComposerInput.tsx`、deck 状态机 | M |
| G16 | GitLab MR 评审 | 18.12.4 | Git 面板 PR 列表加 GitLab MR；`/review`、`/annotate code-review` 的 MR 选择；识别 `mr://` 链接 | `git/`、`annotations/` | M |

### P2 — 设置项与信息展示（不补则功能存在但用户摸不到）

| ID | 功能 | 上游键 | GUI 需要做什么 | 落点 |
|---|---|---|---|---|
| G17 | 自动 prewalk | `prewalk.auto`（off/suggest/on）、`prewalk.autoTarget` | 三值设置 + 触发时的对话内提示（已建议 / 已切换） | `FEATURE_SETTING_KEYS`、设置页 |
| G18 | 顾问续跑阈值 | `advisor.continueSeverity`（nit/concern/blocker） | 原生偏好新增枚举 | `NATIVE_PREFERENCE_KEYS`、`NativePreferencesPane.tsx` |
| G19 | LSP 超时 | `lsp.requestTimeout` | 数字设置 | 特性/原生偏好 |
| G20 | 作业 widget 开关 | `async.widgets` | 开关，与 G08 联动；关闭时隐藏 widget 而非留空壳 | 特性设置 |
| G21 | 长缓存保留 | `providers.cacheRetention: long` | provider 设置枚举（若 Studio 暴露该项） | 设置页 |
| G22 | 图片数量预算 | `imageCountBudget`、`modelOverrides` | 自定义模型编辑页新增字段 | 模型配置页 |
| G23 | 提示压缩阈值 | `sharpshooter.minPromptLength` | 数字设置（若 Studio 暴露 sharpshooter） | 原生偏好 |
| G24 | 新模型角色 `widget` | `widget` role | 角色列表新增，否则用户无法指定 widget 模型 | 模型配置 / 角色委托 |
| G25 | 会话 build 溯源 | `RuntimeIdentity` | 会话详情/诊断显示 version / commit / branch / diff / label | 会话详情、诊断页 |
| G26 | `structured` agent | frontmatter `structured: true` | Agent Hub 的 agent 编辑器加开关 | Agent Hub |
| G27 | 后台等待中的结束态 | `agent_end.awaitingAsyncWork` | 区分「等待后台作业」与「真正结束」，避免 UI 提前判定完成 | conversation 投影 |
| G28 | 子代理作业过滤 | `/jobs` 聚焦子代理时只列自己的作业 | Agent Hub 子代理视图的作业范围 | `AgentHub.tsx` |

### P3 — 可选，取决于 Studio 是否暴露对应面

| ID | 功能 | 说明 |
|---|---|---|
| G29 | computer 新 API | `backgroundFallback`、`el.selectText/type/press`、`menu`、`win.move takeover`、Escape 停止、`UserIntervened`/`no-ui`。只有存在 Computer 面板或审批卡时才需要展示新错误与设置 |
| G30 | DeepSeek 搜索源 | 设置里的搜索引擎列表新增一项 |
| G31 | `proc://<id>/streams` | 若 Studio 资源浏览器支持 `proc://`，需加 streams 视图 |
| G32 | agent 间 wait | Agent 可等待另一 agent 回复；Agent Hub 若要画等待关系才需要 |
| G33 | `ctx.ui.getEditorComponent()` | 仅当 Studio 的 remote UI 实现自定义编辑器包装时需要 |
| G34 | ACP `_session/steering` | Studio 不走 ACP；可参考其语义：审批卡打开时 steer 应取消审批卡、`followUp` 排队 |
| G35 | `tui.completeScrollback` | TUI 专属滚动修复，GUI 不适用 |

## 明确不需要 GUI 的部分

- 323 条修复中的绝大多数：provider 兼容、catalog/计费、OAuth、grep/read/edit 边界、bash 持久 shell、LSP mux、session 恢复、Windows 路径、浏览器 relay、下载与安装。
- 连接预热、prompt cache 保留策略、压缩算法与阈值内部实现。
- 纯 TUI 的渲染、滚动、状态行布局修复（`tui.completeScrollback`、HUD 重绘等）。
- 各厂商目录新增与模型价格调整，随 Runtime 自动继承。

## 迁移与实施风险

1. **接缝必然重生成**：`0001`（`cli.ts`、`cli/args.ts`、`flag-tables.ts`、`launch-help.ts`、`package.json`）、`0002`（`session/**`、`agent-registry.ts`、`approved-plan.ts`）、`0003`（`modes/**`、`job-manager.ts`、`builtin-modes.ts`）、`0004`（`extensions/**`、`sdk.ts`、`tools/context.ts`）都是上游高频改动区。按 README 的四步走，不手改 patch。
2. **overlay 以类型错误暴露问题**：`approve` 签名、`display` 移除、`ApprovalMode` 四值、`Settings` 新字段、`JobSnapshot` 新字段、`ExtensionApprovalAnswer`。先在 vendor 内跑 `bun check:ts` 拿快速信号。
3. **作业 widget 依赖 TUI 包类型**：`JobWidgetView` 定义在 `@oh-my-pi/pi-tui/tools/job-widget`，但注释明确它是「plain JSON，随 `JobSnapshot.widget` 传输并持久化」。Host 只需透传，不要 import TUI 渲染器；React 侧重写六种块。
4. **协议兼容矩阵要更新**：新增 `job.tree`、`job.inspect`、tool progress 事件、approval grants 都改 `client-contract` 与能力清单；旧 Runtime 必须被显式判为不支持，而不是静默降级。
5. **设置白名单是硬门槛**：`NATIVE_PREFERENCE_KEYS` 仅 11 项、`FEATURE_SETTING_KEYS` 仅 13 项。新键不改白名单，GUI 里完全不可见，也不会报错——容易被当成"上游没生效"。

## 建议实施顺序

1. **先过编译**：G01–G04（含 `always-ask-cached` 联合、扩展加载时序确认）。
2. **审批体验**：G05、G15——这是与 TUI 差距最大、也最容易出安全问题的一块。
3. **作业可观测性**：G06–G10（协议 → 服务 → 树 → widget → wait 卡）。
4. **MCP 与 Eval**：G11–G12、G14。
5. **Seance 与 GitLab**：G13、G16（可独立排期）。
6. **设置批量补齐**：G17–G28。
7. **按需评估**：G29–G35。

## 上游比较入口

- 代码比较：`git -C omp-patch/vendor/oh-my-pi log --oneline 687892d104..origin/main`
- 变更日志：`git -C omp-patch/vendor/oh-my-pi show origin/main:packages/coding-agent/CHANGELOG.md`
- 作业 widget 设计说明：`origin/main:docs/bash-tool-runtime.md`
- 审批缓存：`origin/main:packages/coding-agent/src/tools/approval-cache.ts`、`approval-targets.ts`、`approval.ts`
