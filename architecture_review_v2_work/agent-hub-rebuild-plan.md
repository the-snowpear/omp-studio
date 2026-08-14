# Agent Hub 重建 · 任务看板（2026-08-11）

> 跟踪用。背景：Agent Hub 页 2026-08-11 从 ver1 SPA 移除（见 memory agent-hub-redesign-constraints），现按 OMP 真实行为重建。
> 前次决策记录：architecture_review_v2_work/agent-hub-redesign-note.md（含已验证的约束与坑）。

## Design Read
- **Reading this as:** 开发工具内的 dense product UI（多 Agent 巡视控制台），沿用 ver1 原生设计语言（紫 accent #6e56cf / dark #9e8cfc、扁平无阴影、圆润半径阶梯 6/9/12/16、双主题 var(--x) tokens）。
- **Dials:** DESIGN_VARIANCE 5 / MOTION_INTENSITY 4 / VISUAL_DENSITY 7。
- design-taste-frontend 明确 out of scope（dashboard 类），只借用其反 slop 纪律；ui-ux-pro-max 用作 UX 清单（键盘导航、空/加载态、focus 环、reduced-motion、对比度）。
- ui-ux-pro-max CLI 已跑（--density 7 --motion 4）：返回 OLED dark-only 建议 → 不采纳（ver1 必须双主题），仅采纳其 stagger/feedback 类 UX 规则。

## 阶段
1. [x] 调研（2 个 haiku 子代理并行，已完成，2026-08-11）
   - A: OMP vendor 源码 Agent Hub 行为 —— 报告要点已并入下方"OMP 权威行为"
   - B: ver1 SPA 架构集成规范 —— 关键发现：移除是部分的，agent-hub.css(497行)/tpl 空壳/路由项/导航项/引入行全部存活，只缺 page-agent-hub.js（index.html:648 当前 404）
2. [x] 设计定稿（见下方"重建设计"）
3. [~] 代码实现（主会话，**从头设计全新实现**）
   - **用户指令（覆盖中途判断）**：忽略旧的 1139 行 page-agent-hub.js（有 script 顺序 blocker + j/k/t 键盘不全 + 焦点/滚动丢失等审查问题），从头设计全新实现。
   - [x] mock-data.js：+ D.hub（8 agents[含 advisor/aborted/双 parked] + main + jobs + irc + transcripts + usage 聚合 + runtime/conn，相对时间戳让 age 活）
   - [x] page-agent-hub.js：全新实现完成（~600 行；DOMContentLoaded 注册规避 script 顺序；页级 j/k/↑↓/Enter/t/r/x/Esc 键盘；sendPrompt parked 自动 revive+steer；kill confirm modal；场景 full/limited/offline/reconnecting/stale/resync/empty；搜索重聚焦；transcript 滚底；CSS.escape 兜底；语法 OK）
   - [x] agent-hub.css：追加增量（.hub-status-line / .hub-detail-placeholder / .hub-kbd-hint / tabs active / 移动端占位隐藏）
   - [x] workbench.js：renderAgents 联动 hubIntent（已有）
   - [x] index.html：page-agent-hub.js v=2；mock-data.js v=2（既有）
   - 注：base.css 已有全局 prefers-reduced-motion 收敛（pulse/spinner/skeleton 定格），新实现复用，无需另写。
4. [x] 审查 + 实测（haiku 子代理）
   - [x] 静态审查（子代理 E）：可用、无 blocker。1 major + 若干 minor。
   - [x] 浏览器实测（子代理 D，跑的就是新实现）：**21/21 PASS · 0 console error**（puppeteer-core + headless Chrome，首屏/列表行/详情/操作约束 D1-D4/键盘/Transcript/场景 G1-G6/搜索/持久化/工作台联动/深色/移动端抽屉全过）。
5. [x] 修复（审查 + 实测发现，已全部修完并语法检查通过）
   - [x] major：搜索 IME/caret —— onInput 改只重建列表+usage+计数（不重建整页）+ isComposing 早退
   - [x] minor：键盘让路 overlay 菜单（.modal-backdrop, #overlayRoot .menu/[data-overlay]）
   - [x] minor：抽屉开关状态化 S.drawerOpen（select 时 <900px 自动开；drawer-back/Esc 关）
   - [x] minor：过滤后详情错位 —— detailHtml 校验 selected 仍在 visibleAgents 否则显示占位
   - [x] minor：transcript assistant 角色名 esc(a.name)（潜伏 XSS 防御）
   - [x] minor：workbench 联动用 a.hubId 而非 a.id（实测发现的关键点：a1-4 ≠ agent-*）
   - [x] nit：.send-hint 改兄弟选择器 .hub-send + .send-hint + 删冗余规则；.dot.gray 注释改实心
   - [x] nit：fmtAge/fmtDur 对 NaN/undefined 兜底 '—'
   - 遗留（有意不修）：script 顺序脆弱（已用 DOMContentLoaded 规避，测试证实旧版会整页空白、新版正常；改顺序牵涉全页 script 编排，风险大于收益，留注）。
6. [x] 复验（子代理，聚焦 3 项行为修复 + 无回归）：**11/11 PASS**
   - R1 搜索中文：逐字输入「类型」焦点保持、值正确累积、caret 插中间不跳尾、清空恢复 8 行
   - R2 移动端抽屉：render 后抽屉保持开/关状态（S.drawerOpen 生效），不再被 innerWidth 强制重开
   - R3 工作台联动：点 deps(a2)→选中 agent-019fcb01、点 preview(a3)→选中 agent-019fcb17（hubId 修复生效）
   - R4 无回归：8 行 + usage 聚合 + 详情 5 段 + j/k 正常；JS 层 0 错误（仅 favicon 404 环境噪音）
7. [x] 收尾：memory（agent-hub-redesign-constraints + MEMORY.md）已更新为"已重建"

## v3 重构（2026-08-11 第二轮，用户两条反馈驱动）
1. **树状视图重设计**：旧版用 `└` 字符缩进，不直观。改为「组头卡（父 agent 摘要：icon+pill+名+task+聚合成本+▼）+ 竖向导线 `.hub-trail` + 缩进透明叶子 `.hub-node.st-*`（左缘 2.5px 状态色条，与 pill 同一语义语言）」。孤儿（无父/父被搜索过滤）仍用整卡。键盘 j/k 按视觉线性序列（组头→子→孤儿）。
2. **卡片重设计**：`.hub-row` 平面文本版 → `.hub-card`。**id 从卡片删除**（详情/overview 仍可查）。数字行图形化：mono 大数字+单位（`.hub-num`）+ 迷你柱 SVG（`.hc-spark`/`.hb-bar.hot`，tools/tokens 各 3 档）。activity pill 从彩色填充改为「条形卡片」（surface-2 底 + border + 左侧 3px 状态色条），配 8px 实体状态点 `.hub-sd`。artifact 从裸文字改 outline chip `.hub-art`。大号 `.hc-cost` 置顶行右侧。
   - 新增 CSS 类：`.hub-card/.hc-top/.hc-name/.hc-flags/.hc-cost/.hc-task/.hc-nums/.hc-foot/.hc-age/.hc-art`、`.hub-num/.hc-spark/.hb-bar`、`.hub-sd`、`.hub-tgroup/.hub-tg-head/.tg-ic/.tg-name/.tg-task/.tg-right/.tg-cost/.tg-caret`、`.hub-tchildren/.hub-trail/.hub-tleaves`、`.hub-node/.hn-*/.st-*`、`.hub-art`。删除 `.hub-row/.hr-*`。
   - pill `.hub-act`、`.hub-role`、`.hub-unread`、`.hub-ro-tag` 样式重定义（详情面板沿用，视觉统一）。
   - index.html：agent-hub.css / page-agent-hub.js → v=3。
   - 验证：子代理浏览器实测 10 项 JSON 全过（卡片结构/无 id/树状分组/叶子色条/聚合成本求和/键盘树状导航/搜索成孤儿/选中态/0 JS 错误）。V9 深色模式初报 FAIL 系测试脚本用错 localStorage key（`omp.theme` 而非 `omp-studio-theme`）且 hash-only goto 不刷新所致；我用 `#theme=dark` 强制复测，深色下卡片/节点/组头/pill/数字全落 dark token（截图确认），V9 实为 PASS。**11/11 PASS**。

## v3.5 微调（2026-08-11 第三轮，用户三条反馈）
1. **Activity pill 整粒色化**：去掉左缘 3px 色条（`.hub-act::before` 删除），改为整粒状态色胶囊：软底 tint（`--{color}-soft`）+ 状态色文字 + 全圆 `--r-full`（与 `.chip` 语言一致）。变体：thinking=accent / tool=blue / waiting=amber / idle=green / parked=surface-2+text-3 / aborted=red。卡片、树状叶子、组头、详情共用 `.hub-act`，一处改全改。
2. **顶部重构**：`.hub-scope` 行整行删除；`Full Parity Runtime / 已连接 / 更新于 HH:MM:SS` 三字段并入主 Agent 横幅卡 `.hub-main .hm-sub`（新增 `.hm-conn`，含连接状态小点 `.hm-dot`，`#hubUpdated` 元素保留、age tick 照常刷新）；**演示场景按钮删除**（`scopeHtml()`、`case 'scenario'` handler 移除；SCENARIOS/scenarioMenu/applyScenario 留作休眠 harness，无 UI 入口，可整删）；**New Agent 按钮移到 usage 聚合行右侧**（`.hub-usage` 改 flex + spacer，窄屏 wrap）。
3. **详情卡 pill 上移右上角**：`.hub-act` 从 `.hub-detail-actions` 移到 `.hd-title` 末尾（spacer 推右，flush 右缘），样式同第 1 点。
4. 验证：puppeteer 断言全过（tinted bg 非 surface-2、radius 999px、::before 无、`.hub-scope` 计数 0、`.hm-conn` 含 runtime+已连接+更新于、usage flex + 右侧 New Agent、详情 pill 在 hd-title 且不在 actions、树状组头 pill 同 tint、dark 下 tint 正确、0 JS 错误）。index.html → v=4。

> 旧子代理 C/D 报告的是旧文件，与新实现无关，仅其"环境接线/选择器/场景"类发现可复用。

## OMP 权威行为（源码调研要点，vendor pin 45e12e5）
- 入口：TUI Alt+A / Ctrl+S；GUI 无对应，页面即 Hub。
- 两个视图：Table（roster + inspector，宽屏并排 SPLIT_MIN_WIDTH=96，窄屏 Tab 切换）+ Chat（全屏 transcript viewer + 输入行）。
- 行结构：状态 glyph → bold id → dim displayName → ↳ parentId → advisor 时 read-only → ⧉N unread | 右侧 role badge → model badge（fallback → provider/model warning 色）→ age。第二行：description/task/activity + · + metrics（无则 usage —）。
- 摘要区：状态计数（只显示 >0）+ 聚合行 `$cost · active/span agent time · N req · N tools · N tok · A/B timed · C/D measured`；无人汇报时 `Usage —·0/N measured`。
- Inspector：状态行（status · duration · active age）/ 模型行 / Task / Current（currentTool+args、lastIntent、retryState attempt/max）/ Usage（metrics + context gauge 10 格）/ Lineage（Spawned by · N children · Registered）/ Changes（Read-only · 0 LoC | Shared workspace · per-agent LoC not attributable；Output/Patch/Worktree branch）。
- Chat：transcript 增量 tail（250ms 轮询）；输入行仅 `!advisor && (remote || lifecycle)`；发送 = parked 先 revive 再 `session.prompt(text,{streamingBehavior:"steer"})` —— steer 即 prompt 路径，无独立 steer API。
- 键位：j/k/wheel 选择，Enter/click 激活（sub → focus 会话并关 Hub；advisor → chat），t 切 flat/tree，r revive 仅 parked，x kill（advisor 拒绝；abort + tombstone release），Esc 关。
- 状态：running（有 live turn）→ idle（live 待工，TTL arm）→ parked（TTL 到期 dispose，ref+sessionFile 保留，可 revive）→ aborted（kill tombstone 终态，不可复活）。
- 排序：STATUS_ORDER(running<idle<parked<aborted) → lastActivity 降序 → id；首刷后锁行序。age tick 5s。
- hub 工具 op（agent-facing）：send|wait|inbox|list|jobs|cancel|start|ps|logs|stop|restart|describe；jobs.cancel owner-scoped（只能取消自己 spawn 的后代）。
- advisor：观察记录非 peer —— 不可 message/revive/kill，agent-facing 列表排除 advisor 与 aborted（GUI 观察台仍显示）。
- 空态文案：No agents in this session / Finished, parked, and killed subagents remain with the session that created them. / Resume that session with omp --continue, or spawn a task here.
- history://<id> = 简洁 transcript；agent://<id> = 最终输出 artifact。

## 重建设计（本次定稿）
- 布局：hub-page（max 1080）= [conn 横幅?] + 主 Agent banner 卡 + scope 条（runtime/连接/更新时刻 + New Agent + 场景演示下拉）+ roster 头（Flat/By parent seg · 状态计数 · 搜索）+ usage 聚合行 + 双列（58/42 list|detail）。
- 详情：head（名/id/kind/父级/状态行）+ 操作行 + tabs（Overview/Transcript/Jobs/Messages）。键盘：j/k/↑↓ 选行、Enter=chat、r=revive、x=kill、t=切视图、Esc=关抽屉（页级 capture 监听，输入框聚焦时不抢）。
- Transcript tab：消息流 + 发送行（steer 语义；parked 发送即 revive+prompt；idle=prompt；advisor/aborted/无 sessionFile=只读横幅）。
- 场景（演示下拉，持久化仅 runtime）：full / limited（hide hub.chat/hub.revive/jobs.cancel，禁用+原因）/ offline / reconnecting / stale / resync / empty。
- 数据：OMP_DATA.hub（runtime/conn/missingCaps/agents[7: running×2, idle, waiting(idle), parked×2(其一 tombstoned 演示 resync 复活), aborted, advisor] + main + jobs + irc + transcripts + usage）。mock 时间戳为相对脚本加载时刻偏移，age tick 5s 实时刷新。
- workbench 联动：Agents 面板行点击 → sessionStorage 'omp.hubIntent' + goto('agent-hub')；页尾"打开 Agent Hub"链接；hub 页消费 intent 选中并滚动。
- 样式：复用 agent-hub.css 全量，新增 .hub-status-line / .hub-resync-note / .hub-detail-placeholder / .hub-kbd-hint / 无 unread 时 hr-flags 隐藏。

## 实现文件
- assets/js/mock-data.js：+ D.hub（约 250 行，含 fmtNow 相对时间戳）
- assets/js/page-agent-hub.js：新（页面控制器 + 渲染 + 交互 + 场景）
- assets/css/agent-hub.css：追加增量块
- assets/js/workbench.js：renderAgents 联动（hubIntent）

## 硬约束（来自前次验证，必须遵守）
- 列表不含主 Agent；主 Agent 为顶部 banner 卡。
- Activity pill 前置（999px）；lifecycle 小圆点+文字次行。
- 只实现 OMP 真实能力：open / chat / revive(仅 parked) / kill(confirm) / jobs 查看；advisor 只读。不发明 caps（无 steer 独立按钮，steer=chat 路径）。
- Limited Runtime 场景：hub.chat / hub.revive / jobs.cancel 禁用 + 显式标注原因。
- 持久化用 localStorage `omp.agentHub.state`（OMP.ui.state 不存在）。
- 移动端 <900px 详情变抽屉（absolute + translateX + 返回按钮）。
- 工作台联动：OMP.agentHub.summary() 同源数字 + sessionStorage `omp.hubIntent`。
- 动效克制：running 呼吸脉冲、hover、selected 左缘 accent 条、tab 淡入；prefers-reduced-motion 关闭。
- 全色走 var(--x) tokens；无 emoji 图标；无阴影（扁平，border + surface 阶梯出层次）。
