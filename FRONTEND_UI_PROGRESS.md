# OMP Studio 前端 UI 接入进度

最后更新：2026-08-14

## 本轮已接入

### 工作台真实选择项目

- 首页「打开本地文件夹」已启用：真实模式弹出系统目录选择器（`workspace.pick`），选中后 Host 注册到不透明项目注册表（`workspaces.json`），侧栏与首页出现该目录 **basename**，完整路径只留在 Host。
- 最近项目列表：首页与顶栏切换项目菜单、侧栏项目区均渲染 `projects.list` 真实列表；点击项目发 `workspace.open` 激活并进入工作台。
- 路径纪律：client-contract / Renderer / testkit 不出现任何绝对路径；`WorkspaceRecord` 只有不透明 `workspaceId` + basename + 时间戳。
- 切项目会重启 Runtime：选中目录后桌面按 `--cwd <dir>` 重新 spawn managed runtime（stop + start），切换期间 Runtime 状态短暂 disconnected/connecting。
- 预览模式：仍用 `PREVIEW_PROJECTS` 演示数据，点选不弹对话框、不发 `workspace.*`。

### 应用壳

- 左侧 Sidebar：品牌、项目与会话导航、新建对话、Runtime 状态。
- 顶部栏：面包屑、当前路由、Runtime 状态、Client contract 版本。
- 主工作区：与现有 Workbench 共用主列，支持首页 / 历史 / Workbench / Agent Hub 切换。
- Resync 状态横幅：Client reducer 要求 resync 时显示，并继续禁止敏感 mutation。
- Host 不可用时不再死在 Bootstrap failed 整页：Renderer 进入已迁移壳的只读态，顶部 banner 显示 `host unavailable` 与原始 TRANSPORT_ERROR；composer / 命令条保持门控关闭。
- 生产 authority lock 用进程期 named pipe / unix socket 证明 owner 存活。崩溃留下的 metadata 不再永久挡启动；在线第二实例仍失败关闭。

### 首页

- 使用 `home.get` 的 `recentThreads` 渲染最近会话。
- 使用 bootstrap / `home.get` snapshot 渲染 Runtime classification、session、mode、streaming 状态。
- 首页按钮只导航到已实现的 Workbench 和历史页。

### 会话历史

- 使用 `history.list` 的真实 Host session catalog 数据。
- 支持标题 / 摘要本地搜索。
- 显示会话标题、消息数量、状态、最后活跃时间。
- Session tree 当前以可用的 history entries 做安全降级展示。
- Resume 入口只导航到 Workbench；真实 `session.resume` 仍由 Host capability 决定。

### ver1 Workbench 迁移

基于 `ui_reference/ver1` 的源 DOM / CSS 纯文本实现完成 Workbench 视觉迁移（无图片资源，未引入 router 依赖，仍是 StudioClient 驱动的共享 renderer）：

- Sidebar 壳：品牌区、会话树、操作区、用户行等应用壳视觉。
- Topbar：面包屑、路由标识、Runtime 状态，44–48px 高。
- Workbench 画布：workbench-shell 主列 + 会话区滚动容器，文档最大宽度 768px，空态展示。
- Composer：textarea 输入框、工具行、发送按钮，命令条与 interaction 提示；输入仅在本地编辑，提交时异步发送，从不乐观声称完成。
- 右侧面板壳：panel-tabs + panel-body 的诚实禁用壳，未伪造内容。
- 底部面板壳：bottom-tabs + lifecycle-list 的诚实禁用壳，未伪造内容。
- 响应式：≤900px 时侧边栏收窄 / 隐藏次要探索区，侧面板隐藏且无横向溢出，composer 保持可用。
- 行为基线（最终复核）：composer 与命令条逐命令按 capability manifest 门控（manifest 缺失 entry 或 grade `unavailable` 一律禁用，Runtime `limited-system` 分类下禁用）；Enter 发送带 IME 组合防护，组合期间不触发发送；命令被拒绝 / 发送失败时保留输入文本，仅在命令被接受后清空；select / input(secret) 交互渲染真实控件，editor / approval 无安全提交路径时提供诚实禁用提交与可用取消；侧栏折叠开关与跳转对话区的 skip link 可用。

Composer 已接线的命令：

- `core.prompt({ text })` — 发送提示词
- `core.steer({ text })` — 中途纠偏
- `core.followUp({ text })` — 追问
- `queue.enqueue({ text })` — 排队任务
- `core.abort({})` — 中止当前执行
- 保留：`runtime.pause({})` / `runtime.resume({ expectedPauseEpoch })` / `turn.retry({})`，`interaction.respond` 继续可用

对话区 transcript 内容未迁移：public Host contract 不暴露消息 transcript 读取模型，且不使用 mock transcript 填充，因此本轮不宣称与 ver1 视觉全量 parity。敏感命令在 busy / resyncRequired / runtime 不可用时禁用，保留 capability 门控。

### ver1 Agent Hub 迁移

基于 `ui_reference/ver1` 的 `agent-hub.css` + `page-agent-hub.js` 源 DOM 完成 1:1 视觉迁移（无 mock roster / transcript / IRC）：

- 二级页壳：page-head + page-nav，入口为 Topbar bot 按钮、文件菜单、PAGE_NAV、Workbench Agents 面板。
- 主 Agent 横幅：session / mode / streaming / Runtime 连接状态；打开主对话回到 Workbench。
- Roster：Flat / By parent、状态计数、搜索（IME 组合不打断）、Usage 聚合行、New Agent 入口。
- 卡片与树状：activity pill、状态点、unread / read-only / 子 Agent 标记、组头 + 竖向导线 + 叶子。
- 详情：Overview / Transcript / Jobs / Messages；j/k/↑↓ 选择、Enter 打开、t 切视图、Esc 关抽屉；≤900px 详情变抽屉。
- 数据：`OperatorStateSnapshot.agents` / `jobs`。主 Agent（`kind === "main"`）不进列表。
- 诚实禁用：`agent.send` / `agent.revive` / `agent.kill` / `agent.spawn` / `job.cancel` / transcript / IRC 不在公共 client command/query contract，禁用并标注原因，不写 mock 消息。

### ver1 能力中心迁移

基于 `ui_reference/ver1` 的 `#tpl-capabilities` + `pages.js` `initCapabilities()` 完成 1:1 视觉迁移：

- 二级页壳：page-head + page-nav，入口为 PAGE_NAV、文件菜单、Skills 抽屉头/底栏/卡片 more。
- 五分类侧栏：Skills / Plugins / MCP / Host Tools / Slash Commands，计数、垂直 tablist、方向键 / Home / End。
- Skills：三态 stepper、作用域胶囊、来源路径、本地开关；查看 / 开目录 / 删除诚实禁用。
- Plugins：已加载/失败 chip、工具 / 指令 / Hook / UI Provides；详情 / more 诚实禁用。
- MCP：status / transport、测试连接 / 日志 / 重连诚实禁用，开关仅本地。
- Host Tools / Slash：只读列表；Slash 执行诚实禁用。
- 目录：预览开用 `skillsPreview` / `capabilitiesPreview`；预览关 Skills / Plugins 走 `skills.get`（扫描 OMP / Claude / Agents / Codex / OpenCode / GitHub / 插件与市场的 configured 库存，非 Runtime loaded）。MCP / Host Tools / Slash 仍无 read model，诚实空壳。不把 `capabilities.get` / `commands.getManifest` 伪装成这五类库存。

### ver1 模型配置迁移

基于 `ui_reference/ver1` 的 `#tpl-model-config` + `page-models.js` / `page-roles.js` 完成 1:1 视觉接入，并接上常用真实读写：

- 二级页壳：PAGE_NAV 与文件菜单进入「模型配置」；页内供应商 / 角色 tab。
- 预览开：ver1 fixture（`preview/modelConfigFixtures.ts`），保存只改本页。
- 预览关：`models.get` 读本机 `models.yml` + `omp config get modelRoles` + `omp models --json`。密钥只回 `hasSecret`，YAML 预览已打码。
- 真写：`models.provider.upsert` / `delete` 改 models.yml；`models.roles.set` 合并写入全局 `modelRoles`（`omp config set` 只写全局）。
- OAuth：`models.login.start` 试短生命周期 `omp --mode rpc`；需要浏览器时由 Main `openExternal`。需要交互贴码或 sidecar 失败则提示 `omp login <provider>`。
- 诚实禁用：Discovery 刷新、YAML 反写、自定义角色、项目作用域。角色 Fallback 链已移除（config.yml 的 `modelRoles` 只支持 角色 → selector 映射，不接真即不展示）。
- 保存后不宣称当前会话已热切换（`runtimeEffect: new-session`）。

## 暂缓 / 未伪造

- ver1 文件树、Git 分支状态：当前 public contract 没有对应 read model。
- 完整 Session tree 分支导航、Time Travel checkpoint：当前 Host 没有 tree read model。
- 克隆仓库、临时工作区：涉及外部进程与脚手架，属于未接入的高风险能力。
- UI reference 中的 telemetry token、Preview 地址、PID、绝对路径：不从 mock 迁移，避免越过安全 contract。
- ver1 的原始 `OMP_DATA`、`mock-data.js` 和页面脚本：未接入 React Renderer。
- Fork / Handoff / Compact 等会话操作：当前 public contract 没有对应 capability。
- 真实的 Changes / Diff / Preview / Terminal / Problems / Tests / Logs 面板：属于未接入的独立 capability surface，仅保留诚实禁用壳。
- Agent Hub transcript / job 控制 / spawn / revive / kill：公共 client command contract 未暴露对应 mutation，页内为诚实禁用壳，不做 mock。
- 能力中心 create / delete / folder / MCP 连接 / slash 执行：公共 contract 无对应 mutation；页内诚实禁用。Skills / Plugins 预览关为 configured 库存，不是 Runtime effective/loaded。
- 模型配置 Discovery 探测 / YAML 反写 / 自定义角色 / 项目 `.omp/config.yml`：本轮诚实禁用或只读。角色 Fallback 链 UI 已整体移除。
- ver1 对话 transcript 视觉：public Host contract 无消息 transcript read model，且不使用 mock transcript；不迁移（见上文）。

## 验证

```text
npm run typecheck -w @omp-studio/renderer
npm run build -w @omp-studio/renderer
```

预览：双击根目录的 `启动预览.cmd`。

验收清单：

- 路由 home / history / workbench / agent-hub / capabilities / model-config 均可访问，仍为共享 StudioClient 驱动的 renderer，无 Electron / Node 依赖、无 router 依赖。
- Workbench 路由包含完整 ver1 工作台 chrome：Sidebar、Topbar、画布、textarea composer、右侧面板壳、底部面板壳。
- textarea composer 可输入并提交命令（异步执行，不乐观声称完成）。
- 未支持的表面为诚实禁用的壳（禁用态 + 说明），无 mock 数据填充。
- 现有 bootstrap / query / subscription / reducer / Home / History 流程保持不变。
- ≤900px 无横向溢出，composer 保持可用。
- Host 组合失败或 bootstrap TRANSPORT_ERROR 时进入只读壳，而不是 Bootstrap failed 整页。

## 下一步建议

1. 为 Session tree 增加 Host read model 和 query contract；
2. 为页面路由增加持久化的选中会话，但不保存敏感路径或 token；
3. 待 Host 把 `agent.*` / `job.cancel` / transcript 纳入公共 client command/query contract 后，再给 Agent Hub 接真实 mutation（当前保持诚实禁用壳）；Fork / Handoff / Compact、Terminal、Preview 同理。
4. MCP / Host Tools / Slash 仍待独立 read model；CapabilityManifest / CommandManifest 可另开 Runtime Manifest 段，不要塞进现有五 tab。`skills.get` 已覆盖 OMP / Claude / Agents / Codex / OpenCode / GitHub / 插件与市场的 configured Skills / Plugins（非 Runtime loaded）。
