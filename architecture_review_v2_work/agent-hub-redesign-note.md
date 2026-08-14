# Agent Hub 重构说明（design-taste-frontend 审计 + ui-ux-pro-max）

> 写作时间：2026-08-10。这是重构 Agent Hub 页的决策记录，非规格文档。

## Design Read

**Reading this as:** 开发工具（OMP 的多 Agent 巡视控制台）给开发者用，简约克制、圆润扁平的语言，沿用 ver1 既有 design tokens（紫 accent、扁平表面、状态色语义）。

**Dials:** `DESIGN_VARIANCE: 5`（克制的非对称：主对话横幅 + 列表 + 详情，不搞艺术性）/ `MOTION_INTENSITY: 4`（状态脉冲、hover、selected 过渡，无滚动劫持）/ `VISUAL_DENSITY: 5`（信息密度中高，但去掉每个字段一个 chip 的噪音）。

**诚实声明：** 这不是 landing/portfolio（该技能明确 out of scope），是 dense product UI，因此只借用其"反 AI 默认值"纪律（无 emoji 图标、无过度渐变、无无意义动效、状态色语义化），具体布局走 ver1 原生设计语言 + OMP 真实行为。

## 调研结论（OMP 真实 Agent Hub，来自 vendor 源码）

来自 `omp-patch/vendor/oh-my-pi`（pin 45e12e5）：

### 权威行为（docs/agent-hub.md）
- **主 Agent 不列出**："The main agent is not listed because its conversation is the ambient session view." 用户已确认：列表不含主 Agent，主 Agent 作为顶部横幅。
- Roster 字段：`status`（running/idle/parked/aborted）、agent identity、parent、unread IRC count、model role、resolved model、age since last activity、task/current activity、cost/duration/requests/tools/tokens。
- 操作：`Enter`=open（focus 其 session / advisor 走 full-screen transcript）、`t`=flat/tree、`r`=revive（仅 parked）、`x`=kill（abort + tombstone release，立即生效）。advisor 不可 message/revive/kill（read-only）。
- 无显式 lifecycle 独立列：status 即 lifecycle，`lastActivity` 即 age。
- `history://<id>` 是子 Agent 简洁 transcript；`agent://<id>` 是 final output artifact（不是 live transcript）。Advisor 被排除在 agent-facing 工作流外。

### 数据模型（源码）
- `AgentStatus = "running" | "idle" | "parked" | "aborted"`
- `AgentKind = "main" | "sub" | "advisor"`
- `AgentRef`：id、displayName、kind、parentId、status、sessionFile、createdAt、lastActivity、activity、history（modelRole / resolvedModel / resolvedModelIsFallback / metrics / readOnly / outputPath / patchPath / branchName）
- `AgentHistorySummary.readOnly`：advisor 或 readOnly → "Read-only · 0 LoC"；否则 "Shared workspace · per-agent LoC not attributable"。
- 状态语义：`idle`=live 但空闲（TTL 后 park）；`parked`=session 已 dispose、ref+sessionFile 保留、可 revive；`aborted`=kill 墓碑（terminal，不可 revive）；`running`=有 live session。
- Hub 是 overlay，两个视图：Table（roster）+ Chat（per-agent transcript + input 行）。transcript 增量 tail session-file。
- 聚合行：`Usage — · 0/N measured`、`$cost · 时间 agent time · N req · N tools · N tok · A/B timed · C/D measured`。
- 单行 right 侧徽章：modelRole tag、model badge、age。模型 fallback 显示 `fallback → <resolved>`（warning 色）。

### Jobs（gallery fixture）
- job 字段：id、type（bash/task）、status（completed/failed/running）、label、durationMs、resultText/errorText。

## 审计结论：当前 ver1 Agent Hub 页的问题

1. **信息过载**：每行 5+ 个 chip（type + lifecycle + activity + unread + workspace + output/patch/branch），视觉噪音大，Chip 颜色把状态色挤淡。
2. **主 Agent 在列表里**（不真实，已定对齐 OMP）。
3. **`jobs.cancel` / `subagent.steer` / `subagent.revive` 等 caps** 是我之前"发明"的，OMP 没有 `steer` 独立操作（steer 就是 prompt 路径）。需校准到真实 caps（revive/kill/chat/focus）。
4. **collapse 重渲染 bug**（之前验证时发现的：点击 collapse 状态变了但视图不重渲染，`mutations:0`）。
5. 视觉：`--fs-11` 为主，小字堆叠；Chip 方角 20px、radius 混合（r-6/r-full），不够圆润扁平。
6. Transcript/Jobs/Artifacts 内容堆在详情列，没有呼吸。

## 重构方向（简约 · 圆润 · 扁平）

### 布局
- 顶部：**主对话横幅卡**（主 Agent 摘要：name/status/duration/当前工具 + [打开主对话] 按钮）+ scope 条合并为一条（project/thread/runtime/连接态/更新时间 + New Agent）。
- 中部：**单列 Agent 列表**（左） + **详情面板**（右，宽屏 58/42）。列表行高度减小、去掉多余 chip。
- 详情 tabs：Overview / Transcript / Activity / Jobs / Artifacts 保留（内容重构，字段精简）。

### 列表行（Activity 为主）
```
[Thinking]            deps 子 Agent · agent-019fcb01
● running · 3s 前 · 12m 47s · @smol gemini-3.6-flash
依赖审计 @earendil-works/pi-* 0.82.1…
                          ⧉2 unread   read-only  ↳ 2 子
```
- Activity chip 前置（用户最关心"此刻在干嘛"），Lifecycle 用 `● running` 小圆点+文字作第二行 meta。
- 模型 role badge + resolved model 并排（OMP 真显示）。
- fallback → 显示 `fallback → sonnet-4.5` warning 色。
- workspace / output / patch / branch 收敛为一行小字（有则显示，无则不占位）。

### 详情 Overview 字段（对齐 AgentRef + history）
- 状态行：status text + age + duration（OMP 的 `running · active 12m · 3s 前` 模式）
- Task / Current（progress currentTool + args + retry state）
- Usage（cost · duration · req · tools · tok，无则 `usage —`）+ context gauge
- Lineage：Spawned by + children
- Changes：Read-only / Shared workspace + output/patch/branch paths
- Registered：createdAt

### 操作（对齐 OMP）
- 打开（Enter）→ 详情（含 transcript）；advisor → read-only transcript 视图。
- revive：仅 parked（`r`）。kill：`x`（abort + tombstone，confirm）。
- message/steer 归一到 chat 输入行（prompt 路径），无独立 steer 按钮。
- 删除我发明的 `jobs.cancel`/`subagent.steer`/`subagent.revive` caps → 换成真实能力集。

### 动效（简约）
- status pulse（running 呼吸）、row hover 背景、selected 左缘 accent 条过渡、tab 内容淡入。无滚动劫持、无 marquee。
- `prefers-reduced-motion` 关闭 pulse。

### 主题
- 沿用 ver1 `[data-theme]` light/dark tokens。所有颜色走 var(--x)。

## 实现完成 + 验证结果（2026-08-10）

### 落地文件
- `ui_reference/ver1/index.html` — `tpl-agent-hub` 模板重写（banner + scope + stats + list/detail 双列）
- `ui_reference/ver1/assets/css/agent-hub.css` — 全量重写（~740 行，圆角 12/16px、无阴影扁平、activity pill 999px）
- `ui_reference/ver1/assets/js/page-agent-hub.js` — 全量重写（1361 行，5 个 chunk + 弹窗 helper + select 补全）

### 验证清单（port 4174 实测）
- ✅ 列表 7 行（主 Agent 不在列表，banner 显示主对话）
- ✅ Activity pill 前置（Thinking），lifecycle 小圆点 + 文字次行
- ✅ 详情 5 tabs 全渲染；Overview 6 kv + 4 sections + usage + context meter
- ✅ 操作对齐 OMP：parked→Revive/Kill/Release；advisor→全禁用+只读 transcript；aborted→不可 revive
- ✅ Kill 全流程（confirm → abort → actions 收敛 + toast）
- ✅ New Agent modal 单个/批量（并发 3 排队 N）
- ✅ Limited Runtime：hub.chat/hub.revive/jobs.cancel 禁用 + 显式标注
- ✅ 场景：offline/reconnecting/none/resync/stale 全过
- ✅ 工作台联动：summary() 数字同源（3/1/1/4）、hubIntent 消费、入口徽标同步
- ✅ localStorage 持久化（scope/selected/tab 跨 reload 恢复）
- ✅ 深色模式全 var() tokens、responsive drawer（<900px 详情变抽屉 + 返回列表）
- ✅ 无 console error

### 验证中发现并修复
1. **`select()` 缺失** — chunk 2 忘了写，3 处调用会崩。补了定义（设 selected + persist + 重渲染列表与详情）。
2. **modalShell/closeModal/confirmModal 未定义** — 全用 OMP.ui 浮层系统实现；`data-mclose` 与 backdrop 点击统一关闭（初版取消按钮失效）。
3. **持久化是死代码** — 之前 `OMP.ui.state.get/set`（不存在）→ 改 localStorage `omp.agentHub.state`。
4. **`#hubListMeta` 没接** — updateCount 补写列表元信息。
5. **移动端详情列被压到 95px** — 加 <900px drawer（absolute + translateX + 返回按钮），未选中占满、选中滑入。
6. **`toggle-theme` 按钮**（`data-action`）验证深色时初判失效，实为选择器没匹配到，改用属性选择器后正常。
