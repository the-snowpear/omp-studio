# OMP 18.12.6 适配记录

状态：Runtime 升级、补丁重放和本区间新功能的 Studio / GUI 适配已完成，源码与测试层面验证通过；尚未在真实桌面会话里逐项点验，也未发版。上一份评估见 [omp-18.12.6-assessment.md](omp-18.12.6-assessment.md)。

## 基线与目标

- Runtime 基线：`18.10.4-studio.8`，`687892d1046ecaf18829b45f5b86928a308258f4`。
- 上游目标：正式版 **v18.12.6**，`45c35e40c46166dc726ccc52f5d27f40f2449f99`（2026-10-21）。`main` 上另有 170 个未发布提交，全部是修复，本次不跟。
- Runtime 版本：`18.12.6-studio.1`（上游版本变化，补丁集版本从 `studio.1` 重新起算）。
- 工具链不变：Bun 1.4.2（上游仍为 `bun@>=1.4`），Rust `nightly-2026-10-06`。Cargo 新增 `html-escape`、升级 `html-to-markdown-rs`，首次编译多几个 crate。
- [完整上游比较](https://github.com/can1357/oh-my-pi/compare/v18.10.4...v18.12.6)：3,245 个提交（含 main 未发布段时的数字），11 个正式版本。

## 从 18.10.4 到 18.12.6 更新了什么

下表按版本概括新增与行为变化；修复只给数量，完整内容见上游 `packages/coding-agent/CHANGELOG.md`。

| 版本 | 主要新增与行为变化 | 修复数 |
|---|---|---|
| 18.11.0 | 审批待定时 composer 仍可输入（发送 = 拒绝并 steer）；审批提示压缩为一行；会话条目记录写入它的 omp 构建；agent frontmatter `structured: true`；Tern 麦克风与本地流式听写 | 39 |
| 18.11.1 | `/jobs` 作业树（子代理作业挂在 task 下）；eval `judge()` 支持图片；`ctx.ui.getEditorComponent()` | 48 |
| 18.11.2 | `lsp.requestTimeout`；auth-gateway 按客户端限定模型与账号；todo 更新随下一次工具调用发送 | 48 |
| 18.11.3 | **破坏**：扩展 `ui.approve()` 返回 `once/session/deny`；`/seance` 只读咨询已保存会话；`prewalk.auto`；自定义模型 `imageCountBudget`；状态行显示 profile | 15 |
| 18.12.0 | `sharpshooter.minPromptLength`；所有内置厂商连接预热；`models.yml` 显式上下文窗口优先 | 36 |
| 18.12.1 | **破坏**：移除 eval `display()`；打印 DataFrame / 大对象 / Markdown 自动渲染为表格 / JSON 树 / Markdown，图形附加为图片；`advisor.continueSeverity` | 1 |
| 18.12.2 | `computer.backgroundFallback` 与一批后台桌面操作 API；DeepSeek 搜索；relay 浏览器后台标签；`tui.completeScrollback`；默认 judge 改为 Jev 1.14 | 22 |
| 18.12.3 | **Ask and remember** 审批模式 `always-ask-cached` 与 `/forget-approvals`；作业 widget（新 `widget` 模型角色）；子代理当前步骤；wait 卡作业 tile；`proc://<id>/streams` | 35 |
| 18.12.4 | MCP 工具进度；GitLab MR 评审；`PI_SESSION_ID` 环境变量；agent 之间可 wait 回复；SQLite 读取分页 | 46 |
| 18.12.5 | `providers.cacheRetention: long` 对 GPT-5.6+ 保留 12 小时缓存 | 5 |
| 18.12.6 | `/mcp reauth` 支持 ACP / RPC / print；只注册工具 / 命令的扩展延迟到首帧后加载；ACP `_session/steering`；项目与用户级 MCP 同名时取项目级 | 5 |

## Runtime 适配（补丁层）

- 四组接缝补丁按 3-way 重放，15 个文件冲突、34 处，全部手工合并；上游未改的接缝文件直接套上。
- **扩展延迟加载**：上游只在 TUI 首帧之后调用 `loadDeferredExtensions()`，Studio Host 不画 TUI，因此 `main.ts` 在 `studio-host` 模式下保持即时加载，否则扩展命令与工具永远不会出现。
- **审批**：上游把审批统一进 `requestApproval()`，并新增会话级批准与「记住」授权。Studio 的远程审批改为经同一个函数，`approveTool` 返回上游的 `ExtensionApprovalAnswer`；Studio 远程 UI 另实现了标准 `approve()`，内置工具的审批也走 Studio 审批卡，不再退回普通选择框。
- **启动代理**：上游新增 `awaitReady`，与 Studio 自加的 `waitForReady` 含义相同；Studio 改用上游字段，这块接缝变小。
- **TUI 图表**：渲染端直接引用的 `renderChartSvg()` 改为返回 SVG 字符串；渲染端从根元素读尺寸与无障碍标签，不为此加接缝。
- 角色默认链从 `priority.json` 移到 catalog 的 KDL 规则；Host 的镜像校验测试改读 KDL。
- 补丁行数：`+2,092 / −409`（之前 `+2,118 / −422`）；overlay 208 个文件（新增 6 个）。

## 新功能在 Studio 哪里使用

| 功能 | Studio 入口 | 主要落点 |
|---|---|---|
| 第 4 种审批模式 Ask and remember | Composer 权限胶囊「Remember」；设置 → 权限下拉 | `ComposerApprovalPicker.tsx`、`settings/tabs.tsx`、协议四值联合 |
| 记住授权 | 审批卡「记住…」菜单：按文件夹 / 文件，本会话或跨会话；有会话级批准时「本会话允许」可用 | `deck/ApprovalCard.tsx`、`interactions.ts` 的 `session` / `grants` |
| 忘记已记住的审批 | 设置 → 权限「已记住的审批 · 全部忘记」；命令面板搜「忘记审批」 | `approvals.forget` → `clearApprovalGrants()` |
| 审批时可输入 | 运行中且有审批卡时，Enter 先拒绝该调用再 steer；排队栏「插入纠偏」同理 | `App.tsx` `steerPastApproval` |
| 作业树 / 详情 / widget | Agent Hub 后台作业页为树；点作业打开详情（命令、cwd、pid、退出码、输出尾部、widget）；六种 widget 块 | `AgentHub.tsx`、`conversation/JobWidget.tsx`、`JobInspector.tsx`、`jobs.inspect` |
| wait 卡作业 tile、子代理当前步骤 | 对话内 wait / task 卡；Agent Hub 子代理行显示 stage 与完成度 | `ToolBody.tsx`、`agent-hub-service.ts` |
| 等待后台作业 | 回合因等待后台作业暂停时不判定完成，活动行显示「等待后台任务」 | `conversation-live-projector.ts`、`App.tsx` |
| MCP 工具进度 | MCP 工具卡进度条与消息；Eval 显示 `mcp_progress` | `tool.updated.progress`、`McpBody` |
| MCP 重新授权 / 退出 / 重连 | 能力中心 → MCP → 会话连接 | `capabilities/McpAuthActions.tsx`、`mcp.auth.*` |
| Eval 结构化输出 | Eval 卡内表格、JSON 树、Markdown | `ToolBody.tsx` EvalBody |
| Seance 只读咨询 | 历史页会话行「只读咨询」 | `history/SeanceDialog.tsx`、`seance.ask` |
| 会话构建来源 | 诊断页「本会话由哪些构建运行」 | `snapshot.runtimeIdentity`、`DiagnosticsPage.tsx` |
| 新设置 | 原生偏好：`advisor.continueSeverity`、`lsp.requestTimeout`、`sharpshooter.minPromptLength`；特性设置：`prewalk.auto`、`prewalk.autoTarget`、`async.widgets`、`computer.backgroundFallback` | 两组白名单 + 设置面板 |
| 新模型角色 `widget` | 模型配置 → 角色 | `model-kinds.ts` |
| 自定义模型 `imageCountBudget` | 模型配置 → 自定义模型 / 覆盖 | `omp-models-adapter.ts` |
| agent `structured: true` | 子代理编辑器开关 | `SubagentsPanel.tsx` |

新增 Runtime 操作统一放在 workbench 模块 `contracts/runtime-features.ts`（overlay 镜像 `runtime-features-protocol.ts`）：`approvals.forget`、`jobs.inspect`、`mcp.auth.reauth|unauth|reconnect`、`seance.ask`。

## 有意不做

- **GitLab MR 评审**：Studio 的 Git 面板没有评审入口；`/review <MR 链接>` 在 Composer 里已可用。单独做 MR 列表应另起任务。
- **`providers.cacheRetention`**：不是新设置，只是 `long` 的含义变了。
- **DeepSeek 搜索、`proc://` streams、ACP steering、`tui.completeScrollback`、`getEditorComponent()`、agent 之间的 wait 关系图**：Studio 没有对应界面，或只影响 TUI。
- **列出已记住的审批**：上游没有列举 API，只能整体清除。

## 兼容性和边界

- `ApprovalMode` 在协议、Host、渲染端全部是四值；以前未知模式会被显示为 `yolo`，现在 `always-ask-cached` 原样显示。
- 审批答复仍接受旧的 `true`（按「仅本次」处理）；只有 Runtime 提供的选项才会被采纳，其余一律拒绝。
- MCP 重新授权最长等待 5 分钟，Seance 可能运行较久；两者都是普通 workbench 命令，未额外设置客户端超时。
- Seance 用历史条目的 `sessionId` 作为来源选择器，前提是它等于已保存会话的头部 id。

## 验证证据

- vendor：`bun run check:tools`（lint / 格式）与全部包 `check:types` 通过；`omp:verify:patches` 使用的 101 个测试文件全部通过；`ci:test:smoke` 通过。
- 根目录：`npm run check`（构建 + 核心回归）通过；渲染端完整 vitest 135 个文件 / 775 个测试通过；host-client-api 215 个测试通过；`scripts/runtime-artifact.test.mjs` 19 个测试通过。
- 新增行为测试：审批答复映射、`approveTool` 优先级、作业树分组、widget 六种块、`awaitingAsyncWork` 不关闭回合、MCP 进度到达工具卡、Eval 表格视图、MCP 退出删除 `auth` 块、新原生偏好往返。
- **未验证**：未编译签名 `omp.exe`，未在桌面会话中实际点验审批记住、OAuth 浏览器回调、Seance 与作业 widget。
