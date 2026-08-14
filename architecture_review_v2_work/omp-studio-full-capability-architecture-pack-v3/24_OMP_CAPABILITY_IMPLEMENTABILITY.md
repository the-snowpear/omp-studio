# OMP 全能力桌面 GUI 可实现性矩阵

基线：`can1357/oh-my-pi` commit `45e12e5bb758198a920c6070e7e64cb33b21beac`（2026-08-10 核验）。

## 结论定义

| 标记 | 含义 |
|---|---|
| ✅ 直接实现 | 有公开结构化 RPC、机器可读 CLI，或属于 Studio 自己可安全实现的桌面能力。 |
| ⚠️ 有条件实现 | OMP 能力真实存在，但依赖运行时发现、确定性 slash、文件配置后 reload/restart、模型工具调用，或只能提供部分/只读 GUI。 |
| ❌ 暂不能直接实现 | 当前没有公开、确定性的 headless 控制面；不能做成可靠 GUI 按钮或完整状态页。 |
| ⛔ 不应实现 | 只能靠自然语言控制、私有存储写入或突破既定安全边界；架构明确禁止。 |

“有条件”不是伪实现：UI 必须显示接入通道、限制和生效时机。任何 Companion 私有导入均按实验能力处理。

## 1. 实时会话与 RPC

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| 文本 Prompt、图片输入 | `rpc-ui: prompt` | ✅ | ack 不等于 turn 完成；走 command ledger。 |
| Steer、Follow-up、Abort、Abort-and-prompt | 原生 RPC | ✅ | 需要 controller lease；abort accepted 不等于已停止。 |
| 流式文本、thinking、tool/lifecycle 事件 | RPC event stream | ✅ | 归一化后进入 `(hostEpoch, seq)` 事件流。 |
| 会话状态、stream/compact 状态、队列数、上下文占用 | `get_state` | ✅ | OMP runtime 是 live truth。 |
| Todo 状态与设置 | `get_state` / `set_todos` | ✅ | 绑定 Thread/runtime epoch。 |
| Fast Mode | `set_fast_mode` | ✅ | 不能从协议 v2 猜测，需兼容矩阵/探测。 |
| Model 列表、切换、循环 | `get_available_models` / `set_model` / `cycle_model` | ✅ | 当前 session 范围。 |
| Thinking level 设置/循环 | 原生 RPC | ✅ | 当前 session 范围。 |
| steering/follow-up/interrupt 队列策略 | 原生 RPC | ✅ | 当前 runtime 范围。 |
| 手动/自动 compaction | `compact` / `set_auto_compaction` | ✅ | completion 与 agent event 分开。 |
| 自动 retry 开关、终止 retry | 原生 RPC | ✅ | retry 终止需唯一终态。 |
| Bash 执行/终止 | `bash` / `abort_bash` | ✅ | 唯一公开的专用工具执行 RPC；需要写租约/审批。 |
| Standard Extension UI：select/confirm/input/editor/notify/status/widget/title/open URL | `extension_ui_request/response` | ✅ | 只承诺标准 rpc-ui 原语。 |
| Host Tools 注册、调用、更新、取消 | 原生 RPC | ✅ | 每个工具独立 scope/risk/approval；OMP approval 不自动继承。 |
| Host URI scheme 读写 | 原生 RPC | ✅ | 默认只读；写入 scheme 显式 allowlist。 |
| 任意 OMP tool 由 GUI 直接调用 | 无通用 `invoke_tool` RPC | ❌ | LSP/DAP/browser/task 等不能安全变成任意 GUI 按钮。 |

依据：`packages/coding-agent/src/modes/rpc/rpc-types.ts`、`docs/rpc.md`。

## 2. Session、历史与树

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| New session | `new_session` | ✅ | Studio 使用 opaque Session ID。 |
| Resume/switch 已登记 session | `switch_session` | ✅ | 客户端不得提交 session path。 |
| Branch by entry | `branch` / `get_branch_messages` | ✅ | 覆盖 tree 的分支子集。 |
| Handoff | `handoff` | ✅ | 保存/切换结果按 RPC 回执处理。 |
| Session rename | `set_session_name` | ✅ | 原生 RPC。 |
| Stats | `get_session_stats` | ✅ | 原生 RPC。 |
| HTML export | `export_html` | ✅ | 输出路径由 Host 选择/校验。 |
| 当前消息、分页历史、最后 assistant 文本 | `get_messages[_page]` / `get_last_assistant_text` | ✅ | 原生 RPC。 |
| 全部 session 列表、跨项目 recent/search | Host 只读索引 OMP session 根 | ⚠️ | 无结构化 RPC；只读且标明索引状态。 |
| Fresh provider context | 发现后的 `/fresh` | ⚠️ | 确定性 slash，需 completion policy。 |
| Dump/share | RPC export 或 headless slash | ⚠️ | share 有外部副作用/权限确认。 |
| Move/re-root、add/remove/list dirs | headless slash | ⚠️ | 会改变路径 scope，需重新 canonicalize/授权。 |
| 完整 session tree picker、labels、re-answer、switch summary | TUI-only `/tree` | ❌ | RPC 只有 branch 子集。 |
| Fork 整个 session | TUI/CLI `/fork` | ❌ | 当前 active rpc-ui 无等价 RPC。 |
| Clear/reset、Drop/delete、交互式 resume picker | TUI-only | ❌ | 需要上游 RPC。 |
| 直接写 session JSONL 或 history DB | 私有存储 | ⛔ | 允许只读诊断，不允许写。 |

依据：`docs/session.md`、`docs/tree.md`、`docs/session-operations-export-share-fork-resume.md`。

## 3. Slash 命令与 TUI

| 能力族 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| 列出命令/别名/参数/来源 | `get_available_commands` | ✅ | 这是 slash 清单，不是 RPC 方法清单。 |
| `security/model/fast/computer/vision/prewalk/force` | 发现后 slash-over-RPC | ⚠️ | 必须是当前构建的 headless handler。 |
| `advisor/export/dump/share/browser` | 发现后 slash-over-RPC | ⚠️ | 结构化能力有限，解析 command output。 |
| `todo/session/jobs/usage/stats/changelog/tools/context` | 发现后 slash-over-RPC | ⚠️ | 状态多为文本；不可冒充稳定结构化 RPC。 |
| `mcp/ssh/fresh/compact/shake/memory` | 发现后 slash-over-RPC | ⚠️ | 串行或可靠 request correlation。 |
| `rename/move/add-dir/remove-dir/dirs` | 发现后 slash-over-RPC | ⚠️ | 路径与 workspace lease 校验。 |
| `marketplace/plugins/reload-plugins` | CLI 优先，slash 后备 | ⚠️ | 安装/升级需要用户确认。 |
| TUI-only `settings/setup/plan/goal/vibe/loop/queue/switch` | 无 headless handler | ❌ | Studio 可另做原生配置页，但不能复用 TUI UI。 |
| TUI-only `collab/join/leave/copy/live/pause/quit` | 无 active rpc-ui 控制 | ❌ | 需要专用上游 RPC。 |
| 任意第三方 slash 命令自动变按钮 | 仅 metadata | ❌ | metadata 无 `headlessSafe`/幂等/副作用声明。 |
| 用自然语言 Prompt 代替控制 API | 模型解释 | ⛔ | 不确定、不可审计、不可幂等。 |

## 4. 模型、Provider、认证、Role 与 Fallback

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| Active model 列表/切换/thinking/fast | RPC | ✅ | 当前 runtime。 |
| Models 管理列表、搜索、刷新 | `omp models --json` | ✅ | 独立管理进程，不控制 active turn。 |
| OAuth provider 列表、登录 | RPC | ✅ | secret 不返回 Renderer。 |
| Auth broker/gateway 状态 | CLI JSON | ✅ | 管理面；凭据仅在 Host。 |
| Provider/custom model 定义、endpoint、headers、compat | `models.yml` | ⚠️ | CAS、备份、验证、reload；secret 警告。 |
| OAuth logout/多账号生命周期 | auth-broker CLI | ⚠️ | TUI `/logout` 不能直接走 slash-rpc。 |
| Role aliases/default/smol/slow/vision/plan/designer/commit/tiny/task/advisor | config CLI / project config | ⚠️ | global 与 project scope 分开，生效可能需新 session。 |
| Fallback chains、context promotion、provider routing | config/models.yml | ⚠️ | 配置可做，执行与最终路由仍由 OMP。 |
| 精确展示某次 fallback 内部决策全过程 | tool/events + diagnostics | ⚠️ | 没有独立完整 RPC 时只能部分解释。 |
| 读取/显示原始 token | Host 私有 | ⛔ | 只允许提交、更新、撤销；不得回显。 |

依据：`docs/models.md`、`docs/providers.md`、`docs/settings.md`、`docs/auth-broker-gateway.md`。

## 5. Config、Plugin、Extension、Skill、Hook、Tool

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| Global config list/get/set/reset | `omp config ... --json` | ✅ | 是机器可读 settings catalog/validator，不宣称完整 JSON Schema。 |
| Active profile/agent dir | `omp config path` | ✅ | 禁止硬编码 `~/.omp/agent`。 |
| Project `.omp/config.yml` | schema-aware file adapter | ⚠️ | writer lease + expected hash + atomic replace。 |
| 启动 config overlay | `--config` | ⚠️ | 仅新进程/重启生效。 |
| Plugin/marketplace list/install/uninstall/enable/disable/upgrade | `omp plugin` CLI | ⚠️ | CLI 能力真实，但副作用、进度、确认需 Host 编排。 |
| Plugin reload | `/reload-plugins` | ⚠️ | 运行时发现并重新协商 capability snapshot。 |
| 标准 Extension 生命周期与事件语义 | OMP runtime + RPC events | ✅ | OMP 执行，Studio 观察。 |
| Extension 标准 UI | rpc-ui | ✅ | 标准原语可映射到 React。 |
| Extension 命令 | command discovery + slash-rpc | ⚠️ | 只执行可信/声明式 allowlist。 |
| 任意自定义 TUI overlay/header/footer/theme/input renderer | 无 React 兼容契约 | ❌ | 不能自动翻译任意终端组件。 |
| Active tool schema | `get_state.dumpTools` | ✅ | 只含活动工具；不含完整来源/冲突。 |
| Tool 执行与结果展示 | 普通 RPC tool events | ✅ | 由 OMP/Agent 发起。 |
| Skill 自动发现、autoload、`skill://` 读取 | OMP runtime | ✅ | 行为由真实 Harness 保留。 |
| `/skill:<name>` 执行 | runtime command discovery | ⚠️ | 通常会触发 agent turn，不是本地管理命令。 |
| Skill/agent definition configured CRUD | 原生目录/Markdown | ⚠️ | 仅 configured view；路径/格式校验与备份。 |
| Effective skill/plugin/hook/agent inventory 与 precedence winner | 无结构化 RPC | ❌ | 文件扫描不能精确复刻 runtime discovery。 |
| Hook 拦截/修改/阻断语义 | OMP runtime | ✅ | Studio 不重写 Hook engine，仅显示诊断。 |
| Custom tool 配置与模型调用 | 文件 + OMP runtime | ⚠️ | GUI 可配置/观察，不能直接 invoke。 |
| 直接加载第三方扩展代码到 Studio Host 做扫描 | Host import | ⛔ | 供应链/权限边界错误。 |

依据：`docs/extensions.md`、`docs/extension-loading.md`、`docs/skills.md`、`docs/hooks.md`、`docs/custom-tools.md`。

## 6. Subagent、Agent Hub、Async Job、Collab

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| Subagent subscription off/progress/events | `set_subagent_subscription` | ✅ | 原生 RPC。 |
| Subagent snapshot/list | `get_subagents` | ✅ | 对外映射为 opaque Agent ID。 |
| Subagent transcript 增量读取 | `get_subagent_messages` | ✅ | 客户端不得提交 `sessionFile`。 |
| lifecycle/progress/full event | RPC frames | ✅ | 支持 Agent Hub roster/inspector 大部分只读 UI。 |
| Harness `task` spawn、batch、effort、schema、隔离、递归 | Agent 调用 task tool，RPC 观察 | ⚠️ | OMP 能做；GUI 不能 deterministic manual spawn。 |
| Async/background task 执行 | OMP task/hub | ⚠️ | 执行由 Agent；Studio 观察能力取决于事件。 |
| Async job list/status | headless `/jobs` | ⚠️ | 文本接口，优先推动结构化 RPC。 |
| Agent 主动 message/chat | 无 native RPC | ❌ | Companion private bridge 仅实验，不算当前可交付。 |
| Agent kill/revive/release | 无 native RPC | ❌ | 内部/TUI/collab 有语义，但 active rpc-ui 未公开。 |
| GUI 手动 spawn 指定 subagent | 无 native RPC | ❌ | 不能用 Prompt 假装按钮。 |
| Async job cancel | 无 native RPC | ❌ | `hub` 是模型工具/内部控制，不是 GUI API。 |
| Collab guest transcript、prompt、abort、部分 Agent Hub 控制 | Collab 协议 | ⚠️ | 独立实验适配器，不能成为核心本地通道。 |
| 从 active rpc-ui 启停 collab/读 participants | TUI-only `/collab` | ❌ | 需要专用 RPC。 |
| 直接依赖私有 AgentLifecycleManager/Collab frame | private import/frame | ⛔ | 仅隔离 POC，不进入稳定 API。 |

依据：`docs/tools/task.md`、`docs/agent-hub.md`、`docs/collab.md`。

## 7. Advisor、Memory、Autolearn、TTSR

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| Advisor enable/on/off/status/dump | 发现后的 `/advisor` | ⚠️ | headless slash 可用但不是结构化 RPC。 |
| Advisor roster/model/tool grant/instructions | `WATCHDOG.yml` / `WATCHDOG.md` | ⚠️ | 文件 CAS + reload；configured 与 effective 分开。 |
| Advisor stats/transcript | slash/只读来源 | ⚠️ | 完整结构化状态仍需上游 RPC。 |
| TUI `/advisor configure` 原样复用 | TUI-only | ❌ | Studio 应做自己的配置编辑器。 |
| Advisor 作为 peer 被 message/kill/revive | OMP 语义不允许 | ⛔ | 不应伪造。 |
| Memory 配置、autolearn 设置 | config CLI/file | ✅ | 持久配置面。 |
| Memory 状态/refresh/recall 等 | `/memory` 或 Agent tool events | ⚠️ | slash/tool 驱动，不是统一结构化 API。 |
| TTSR 配置 | config CLI/file | ✅ | 规则由 OMP 执行。 |
| TTSR inspect/test/stream effect | CLI/RPC events | ⚠️ | 取决于具体输出是否机器可读。 |

依据：`docs/advisor-watchdog.md`、`docs/memory.md`、`docs/ttsr-injection-lifecycle.md`。

## 8. MCP、LSP、DAP、Browser、Computer 与其他工具

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| MCP server CRUD | user/project `mcp.json` | ⚠️ | active profile path、CAS、OAuth secret 边界。 |
| MCP list/test/reload/reconnect/reauth/unauth/enable/disable | `/mcp` | ⚠️ | headless slash 文本面。 |
| MCP tools/resources/prompts 执行 | OMP runtime，RPC tool events | ✅ | 模型驱动；Studio 保留执行语义。 |
| MCP effective inventory/status 的结构化 GUI | 无专用 RPC | ❌ | 文本/文件只能部分实现。 |
| LSP 配置与自动发现 | user/project `lsp.json` | ⚠️ | 配置可做，生效按 OMP lifecycle。 |
| LSP diagnostics/definition/references/hover/symbol/rename/code action/reload | `lsp` tool，RPC 观察 | ⚠️ | 模型可用；GUI 不能直接调用动作。 |
| DAP launch/attach/breakpoints/step/evaluate/stack/variables 等 | `debug` tool，RPC 观察 | ⚠️ | 模型可用；GUI 不能直接调用动作。 |
| Debug profiler/raw protocol/TUI selector | TUI-only `/debug` | ❌ | 没有 headless state/control RPC。 |
| Browser open/run/screenshot/ARIA/click/type/evaluate 等 | `browser` tool，RPC 观察 | ⚠️ | 模型驱动；后端/审批由 OMP。 |
| Browser 管理命令 | `/browser` | ⚠️ | headless slash，运行时发现。 |
| Computer screenshot/AX/坐标输入/clipboard/wait | `computer` tool，RPC 观察 | ⚠️ | 模型驱动，需用户审批。 |
| Web search、GitHub、image、security scan、review/resolve 等内置工具 | OMP tool，RPC 观察 | ⚠️ | OMP 可执行；无 generic GUI invoke RPC。 |
| Studio Preview dev-server/热刷新/控制台/网络/DOM/截图 | Studio Host 自有 | ✅ | 不是 OMP 原生能力；按不可信 Preview 隔离。 |
| 让 OMP Agent 操作 Studio Preview | Host Tools/Host URI | ✅ | scope 固定、分级审批、取消/输出上限。 |

依据：`docs/mcp-config.md`、`docs/lsp-config.md`、`docs/tools/*`、`docs/computer-use.md`。

## 9. CLI 管理与兼容入口

| OMP 能力 | Studio 接入 | 结论 | 关键边界 |
|---|---|---:|---|
| `config/models/auth-broker/auth-gateway/stats/usage/dry-balance` | 独立 CLI + JSON | ✅ | 管理/诊断进程，不碰 active session。 |
| `plugin/agents/ttsr/browser-relay/worktree/gc/update/setup/install` | 独立 CLI | ⚠️ | 副作用、平台差异、进度、取消和确认需编排。 |
| `commit/cleanse/bench/share/join/say/shell/ssh/search/read/grep/gallery` | 独立 CLI | ⚠️ | 多为长任务/交互或终端 UX，不宣称 RPC 语义。 |
| ACP 兼容第三方编辑器 | `omp acp` | ⚠️ | 可测试/可选暴露，不作为 Studio 主后端。 |
| `launch` TUI 全部体验 | 启动终端回退 | ⚠️ | 可嵌入终端，但不是原生 React GUI parity。 |
| OMP 自更新 | `omp update` | ⚠️ | 必须确认、校验 binary 路径并在升级后重新探测。 |

## 汇总结论

- **直接实现的核心**：完整聊天与流式会话、模型/思考/队列/压缩/重试、Bash、标准 Extension UI、Host Tools/URI、主要 Session RPC、登录、活动工具 schema、Subagent 观察与 transcript、全局配置/模型管理，以及 Studio 自有 Preview。
- **有条件实现的核心**：确定性 headless slash、项目/Provider/MCP/Role/Skill/Plugin 文件配置、Agent 驱动的 LSP/DAP/browser/computer/task 工具、Advisor、Memory/TTSR、只读 session 索引、Collab 实验接入。
- **当前不能作为可靠 GUI 控件的核心**：Agent message/kill/revive/release/manual spawn、async cancel、完整 effective discovery、任意 tool direct invoke、完整 session tree/fork/drop/clear/picker、active rpc-ui collab 管理、任意自定义 TUI。
- **明确禁止**：用自然语言替代控制协议、写 OMP 私有 session/DB、把 secret 发给 Renderer/Preview、加载不可信扩展到 Host、以私有 ABI/Collab frames 作为稳定产品合同。
