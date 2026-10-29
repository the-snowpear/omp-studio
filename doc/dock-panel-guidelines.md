# 可停靠工作台改造 · 开源项目指导意见

日期：2026-10-29。状态：下述旧参考方案已由 [0.2.0 详细规格](../docs/0.2.0-ui-upgrade.md) 替代；实现入口见本节。

## 当前实现（优先于本文历史建议）

- 模型：`apps/renderer/src/dock/types.ts`、`model.ts`；四个区域 left／rail／right／bottom 加应用内浮窗，所有 13 个工具均可移动，无落点白名单。
- 存储：`dock/store.ts`；连接目标／项目／会话隔离，草稿交接、预设、同项目新会话继承、20 步撤销、旧布局一次迁移。布局不是运行资源。
- 内容：`dock/DockContext.tsx`、`PanelRegistration.tsx`、`hosts.ts`；固定 Portal target、首次显示挂载、隐藏 inert、统一几何和裁剪。
- 壳与手势：`dock/DockRegions.tsx`、`gestures.ts`；右栏上下最多两组、底栏左右最多两组、卡片／紧凑覆盖／多标签浮窗和胶囊。
- 工具元数据：`panels/registry.ts`；业务入口由 `App.tsx` 的薄注册映射提供。BTW 已纳入统一停靠，旧独立窗口组件不再用于工作台。
- 有效布局仍由 `layout/workbenchLayout.ts` 和 `useWorkbenchLayout.ts` 计算；窄窗状态不修改持久偏好。
- 菜单与设置：`dock/DockMenus.tsx`、`DockSettings.tsx`；现有快捷入口调用 open 动作定位当前位置。

使用说明：[工作台停靠与布局](../docs/workbench-docking.md)。验收结果与当前限制：[交付记录](../docs/dock-delivery-2026-10-29.md)。

本文余下内容保留为早期调研记录。旧“三槽”“大面板落点白名单”“BTW 不合并”“全局／项目共享布局”的建议均不再适用；不能用它们覆盖详细规格中的最终选择。
适用：任何要改工作台外壳（左栏 / 右栏 / 底栏 / 浮窗）的任务。

本文档是给执行任务的协作者（人或 agent）看的施工依据，不是产品说明书。它把「哪些开源项目值得读、读哪几个文件、抄什么、别抄什么」和「本项目现状、目标模型、分期验收」放在一起，避免每个任务重新调研一遍，也避免各任务各造一套布局模型。

**一句话结论**：自研「3 槽 + 浮层」，抄 VS Code 的固定 Part、Godot 的三态与落点白名单、Lumino 的树模型；不引 dockview 作为运行时依赖。

---

## 0. 怎么用这份文档

1. 先读 §1（范围）、§4（现状）、§5（目标架构）。这三节决定你能不能动手。
2. 按 §6 选一个阶段。**不要一次做完 P0–P4**；每个阶段都可以独立合并、独立回退。
3. 动手前必须读 §7（硬约束）。违反其中任何一条，`npm run check` 会直接失败，或破坏预览模式。
4. §8 是已知坑。遇到「面板换位置后终端白了 / iframe 重载了 / 对话跳位了」，先查这张表，不要现场发明方案。
5. 本文与 TypeScript 契约冲突时，以契约为准；本文与个人偏好冲突时，以本文为准。

### 0.1 给执行任务的 agent 的开场模板

```text
目标：把 OMP Studio 工作台改造成可停靠面板（左栏 / 右栏 / 底栏 / 悬空）。
先读 doc/dock-panel-guidelines.md 的 §1、§4、§5、§7，再按 §6 执行指定阶段。
本轮只做：<P0 / P1 / P2 / P3>。
硬性边界：不动 Host / client-contract / transport / studio-host；不引第三方停靠库；
对话区不可停靠；预览模式必须同时接两套数据。
完成标准：§9 对应条目全部勾上，且 `npm run check -- --only renderer` 通过。
遇到状态丢失或对话跳位，先查 §8，不要重写渲染方式。
```

---

## 1. 目标与非目标

### 1.1 目标

| 项 | 目标 |
|---|---|
| 可停靠对象 | 文件树、Changes、Git、浏览器、Agents、Computer、终端、Problems、Tests、Output、Logs、PvLogs |
| 落点 | 左栏、右栏、底栏、悬空浮窗 |
| 交互 | tab 驻留、tab 跨槽拖动、拖出浮空、拖回停靠、尺寸拖拽、布局持久化 |
| 兼容 | 窄窗退让（overlay）、预览模式、对话虚拟列表、键盘与焦点行为保持现状 |
| 默认 | 新用户与老用户升级后看到同一套默认布局；用户可重置 |

### 1.2 非目标（明确不做）

- 不做任意嵌套的 split 树。槽内最多 2 段（P3 才做），不做 Photoshop 式自由网格。
- 不做跨 Electron 窗口 / 多显示器弹出。那属于 `BrowserWindow`，另一个任务。
- 对话区 `.convo-col` 永远居中、不可停靠、不可关闭。
- 不新增 Host query / command，不改 `client-contract`、`transport-*`、`studio-host`、`omp-patch`。
- 不引入运行时停靠库（理由见 §2.3）。
- 不改 `btw` 现有浮窗实现（P2 只复用它的几何工具，不合并它的状态）。

---

## 2. 参考项目

### 2.1 值得读源码的

| 项目 | 许可 | 读哪几个文件 | 抄什么 | 别抄什么 |
|---|---|---|---|---|
| **VS Code** | MIT | `src/vs/base/browser/ui/grid/grid.ts`、`splitview.ts`；`src/vs/workbench/browser/layout.ts`（`adjustPartPositions`）；`src/vs/workbench/browser/parts/panel/panelPart.ts` | Part 是**固定 DOM**，用绝对定位 + `IView.layout(width, height, top, left)` 程序化摆放；一个 Part 支持 bottom/left/right 多位置 | 不抄它的 Monaco、命令系统、DI 容器；不要为了布局引入它的 `base/browser` 全家桶 |
| **Lumino（JupyterLab）** | BSD-3-Clause | `packages/widgets/src/docklayout.ts`（`SplitLayoutNode`、`TabLayoutNode`、`_insertBefore`、`ILayoutConfig`）、`dockpanel.ts` | 布局是树；`addWidget` 的 `split-left` / `tab-after` / `merge-top` 插入模式枚举；`saveLayout` / `restoreLayout` 只序列化结构 | 不抄它的 MessageLoop / Widget 基类；React 里不需要第二套生命周期 |
| **Godot 4.6 编辑器** | MIT | `editor/docks/editor_dock_manager.cpp/.h`（`save_docks_to_config`、`load_docks_from_config`、`DockSlotGrid`）、`editor/docks/editor_dock.h` | dock 三态 `slot / floating / closed`；浮窗 screen rect；split offset；恢复时用 `closed_dock_parent` 临时节点；**落点白名单**（它自己承认 Shader/Animation 不能进侧栏） | 不抄 C++ 的节点重父化；不要照搬「所有面板都能去所有位置」的错觉——它明确列了例外 |
| **Qt Advanced Docking System** | LGPL-2.1（只看设计） | `DockManager`、`DockWidget`、perspectives 相关实现 | 浮窗与主窗口是**同等级** dock container（浮窗里还能继续停靠）；grouped dragging；命名布局预设 | 不要抄任何代码（LGPL）；不要把「无 central widget」理解成对话区也能拖走 |

### 2.2 可以直接用的库（评估过）

| 库 | 版本 / 许可 | 用途 | 结论 |
|---|---|---|---|
| `dockview` / `dockview-react` | MIT，core 零依赖（React 绑定 2026-10 为 8.5.x；core 版本线不同，接入前核对 npm） | 完整停靠引擎 | **只读源码，不做依赖**。默认 `onlyWhenVisible` 渲染器会在切 tab 时卸载面板，正好命中终端/iframe 保活；React 19 StrictMode 下曾有双渲染问题报告，接入前复核 issue |
| `rc-dock` | Apache-2.0（发布线含 4.x 与 5.0 alpha，以 npm dist-tag 为准） | `dockbox` + `floatbox` 双层模型，`panelLock` 可锁面板 | 若一定要引库，这个最贴；但稳定版线偏旧、新版仍在 alpha，需锁版本并自测拖拽 |
| `@dnd-kit/core` | 6.3.x，MIT，headless | 只给拖拽坐标与落点，不碰 DOM 结构 | 自研引擎时首选；比 HTML5 DnD 稳，React 19 兼容 |
| `allotment` | 1.20.x，MIT | splitter（派生自 VS Code splitview） | 可用来替换手写的 `sb-resizer` / `sp-resizer` / `bp-resizer`，低风险；不解决 dock |
| `flexlayout-react` | MIT | IDE 风格分栏 | 浮窗是浏览器 popout，不是应用内浮层，**排除** |
| `react-mosaic` | MIT | 瓦片平铺 | 没有 dock / 浮窗概念，**排除** |

> 版本与维护状态核对于 2026-10-29。任何接入前重新核对一次 changelog；这几个库 2026 年都有破坏性大版本。

### 2.3 为什么最终建议自研

1. 需求边界只有「3 槽 + 浮层」，不需要 group 嵌套、drag-to-edge、popout。
2. 本仓库已有 `btw/btwGeometry.ts`：`clampRect`、`resizeRect`、`exceedsDragThreshold`、`rectAtPointer`、`resolveDropTarget`，且带测试。拖拽几何不用重写。
3. 保活、窄窗退让、预览模式三件事都必须和现有壳深度耦合。第三方库在这三处都是负资产。
4. 仓库目前没有 UI 框架依赖（全手写 CSS + tokens），引入 dockview 意味着整套主题要重写一遍。

---

## 3. 六条硬结论（每条都有出处）

| 编号 | 结论 | 出处 | 本项目落点 |
|---|---|---|---|
| R1 | 槽位只画「tab 条 + 占位框」，面板本体常驻在固定宿主层，移动只改 rect | VS Code `grid.ts` / `layout.ts` | `.panel-host` + `.panel-frame` |
| R2 | 布局是可序列化的树/表，只存 `id + 尺寸 + 权重 + 激活项`，不存 React 节点 | Lumino `ILayoutConfig`；rc-dock `SavedLayout` | `DockLayout` |
| R3 | 隐藏不等于卸载。切 tab、换槽都不能触发 unmount | dockview `onlyWhenVisible` 是反例；Lumino widget attach/detach 是正解 | `visibility` + `inert`，不用 `display:none` |
| R4 | 每个面板声明允许的落点，不做全自由 | Godot 4.6 dock 限制 | `allowedSlots` |
| R5 | 面板三态：`slot` / `floating` / `closed`；浮窗矩形必须夹取到容器内 | Godot `save_docks_to_config`；Qt ADS | `DockLayout.floating` / `closed` |
| R6 | 默认布局锁死且可重置；自定义布局是叠加层，不是默认值 | Qt ADS perspectives；Godot 不可删的 `Default` | 「重置布局」命令 + 默认预设常量 |

---

## 4. 现状测绘（动手前必须知道）

| 事实 | 位置 | 对改造的含义 |
|---|---|---|
| `App.tsx` 约 9240 行，`WorkbenchCanvas` 内含 side/bottom 全部 tab 的 JSX | `apps/renderer/src/App.tsx` | P0 必须先抽组件，否则任何停靠改造都会在大文件里失控 |
| 右栏单选：`SideTab = "changes" \| "git" \| "preview" \| "computer" \| "agents" \| "btw"` | `commandPaletteCatalog.ts` | 新模型要允许同槽多 tab 驻留 |
| 底栏单选：`BottomTab = "terminal" \| "problems" \| "tests" \| "output" \| "logs" \| "pvlogs"` | 同上 | 同上 |
| 左栏是「项目 + 文件树」上下两段 + `splitRatio`，不是 tab 栈 | `App.tsx` `#sbProjects` / `#sbFiles` / `.sb-divider` | 左槽要保留两段结构，不能直接改成单 tab 栈 |
| 布局求解器是纯函数，输出 CSS 变量 | `layout/workbenchLayout.ts`（98 行）+ `useWorkbenchLayout.ts` | **不要重写**；加 adapter，保留现有 5 组测试 |
| 布局记忆 20 个扁平字段，localStorage，scope 为 `global` 或 `project:<id>` | `settings/appSettings.ts` `LayoutMemory` | 新 schema 要带版本号和一次性迁移 |
| 层级 token 已有 `--z-panel: 30` / `--z-fab: 40` / `--z-menu: 60` / `--z-float: 70` / `--z-modal: 80` | `styles/tokens.css` | 浮窗用 `--z-float`，必须在菜单之下 |
| BTW 已实现 `float \| docked` + 拖出 + 拖回 + rect 记忆 + 测试 | `btw/useBtwWindow.ts`（389 行）、`btw/btwGeometry.ts` | P2 直接复用几何函数与指针流程 |
| 面板内容必须同时接预览与真实两套数据 | `preview/mode.ts`、`PreviewContext.tsx`、`preview/surfaces.tsx`；`AGENTS.md`「预览模式与 Mock 数据」 | 每个 panel adapter 都要有 `preview ? <Demo/> : <Real/>` |
| 侧栏 Agents tab 是**内联 roster**，不是 `SubagentsPanel.tsx` | `App.tsx` `#spAgents`；`SubagentsPanel` 只用于 `ModelConfigPage` | 抽组件时不要接错 |
| 几何变化必须通知对话层 | `conversation/conversationReflow.ts` 的 `beforeConversationLayoutChange` / `afterConversationLayoutChange`；当前调用点 13 处（`App.tsx` 9、`useWorkbenchLayout.ts` 3、`useReadingColumn.ts` 1） | 拖拽期间每帧都要包住，否则虚拟列表跳位 |
| 架构测试限制依赖方向 | `scripts/architecture.test.mjs` | renderer 不能 import Node / electron；新模块只能落在 `apps/renderer/src` |
| 面板相关的焦点、inert、Tab 陷阱目前硬编码三个 id | `layout/useWorkbenchLayout.ts` | 槽位化后要改成按槽位选择器，逐个复刻行为 |

---

## 5. 目标架构

### 5.1 模块边界

新增两个目录，**不要**把引擎代码塞进 `App.tsx`：

```
apps/renderer/src/dock/
  dockLayout.ts        纯模型：类型、reducer、迁移、夹取、默认预设
  dockLayout.test.ts   纯函数测试（不碰 DOM）
  panelRegistry.tsx    PanelId -> 定义（标题、图标、落点白名单、render）
  useDockLayout.ts     状态 + 持久化 + 与 fitWorkbench 的 adapter
  usePanelDrag.ts      指针拖拽 + 落点判定（复用 btwGeometry）
  DockSlot.tsx         tab 条 + 占位框 + 空态
  FloatingLayer.tsx    浮窗容器（复用 btwGeometry）
  PanelHost.tsx        常驻宿主层
  dock.css             只放壳样式，复用 tokens

apps/renderer/src/panels/
  ProjectsPanel.tsx  FilesPanel.tsx  ChangesPanel.tsx  GitPanel.tsx
  BrowserPanel.tsx   AgentsPanel.tsx ComputerPanel.tsx TerminalPanel.tsx
  ProblemsPanel.tsx  TestsPanel.tsx  OutputPanel.tsx  LogsPanel.tsx  PvLogsPanel.tsx
```

规则：
- 已有组件（`git/GitStatusPanel`、`browser/BrowserPane`、`TerminalPane`、`workspaces/SessionWorktreesPane`）**不搬家**。
- `panels/*` 只做三件事：读 `PanelRenderProps`、选预览/真实分支、渲染现有组件。不允许在 `panels/*` 里写业务逻辑。
- `dock/*` 不允许 import 任何 Host、client 实现或具体面板；只依赖 `panelRegistry` 的类型。

### 5.2 数据模型

```ts
// dock/dockLayout.ts
export type DockSlotId = "left" | "right" | "bottom";

export interface SegmentLayout {
  readonly panels: readonly PanelId[];   // tab 顺序
  readonly active: PanelId | null;
  readonly weight: number;               // 0..1，段间比例
  readonly collapsed?: boolean;          // 左槽第二段折叠，对应旧 explorerOpen
}

export interface SlotLayout {
  readonly open: boolean;
  readonly visible: boolean;   // 底栏专用：整条是否在屏（旧 bottomVisible）
  readonly size: number;       // px，沿用 SIDEBAR_LIMITS / SIDE_PANEL_LIMITS / BOTTOM_PANEL_LIMITS
  readonly segments: readonly SegmentLayout[];  // 1..2 段
}

export interface FloatingLayout {
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly z: number;
}

export interface DockLayout {
  readonly v: 2;
  readonly slots: Readonly<Record<DockSlotId, SlotLayout>>;
  readonly floating: Readonly<Partial<Record<PanelId, FloatingLayout>>>;
  readonly closed: readonly PanelId[];
}
```

不变量（reducer 必须保证，测试要钉住）：

1. `PanelId` 全局唯一：同一时刻只能出现在一个 segment、一个 floating 或 `closed` 之一。
2. `projects` 永远在 `slots.left.segments[0].panels`，且永不为空。
3. 每个 segment 的 `active` 必须属于它的 `panels`；`panels` 为空时该 segment 被移除（最多保留 2 段）。
4. `slots.*.size` 必须落在对应 limits 内；`weight` ∈ (0, 1)。
5. `floating` 的 rect 必须在容器内且不小于 `MIN_FLOAT = { width: 320, height: 200 }`。
6. `v` 不匹配时走迁移，不允许直接信任存储值。

### 5.3 面板注册表

```ts
// dock/panelRegistry.tsx
export interface PanelRenderProps {
  readonly preview: boolean;
  readonly client: StudioClient;
  readonly state: ClientState;
  readonly snapshot: OperatorStateSnapshot | undefined;
  readonly capabilities: ClientBootstrap["capabilityManifest"] | undefined;
  readonly workspaceId: WorkspaceId | undefined;
  readonly sessionId: SessionId | undefined;
  readonly runtimeConnected: boolean;
  readonly onRoute: (route: PageRoute) => void;
  readonly onOpenPanel: (panel: PanelId) => void;
}

export interface PanelDefinition {
  readonly id: PanelId;
  readonly titleKey: string;             // i18n key，中英都要有
  readonly icon: string;                 // 与 Icon 组件的 name 对齐（该组件当前接受 string）
  readonly allowedSlots: readonly DockSlotId[];
  readonly floatable: boolean;
  readonly closable: boolean;
  readonly requiresRuntime: boolean;     // false 时无 runtime 也要能显示空态
  readonly render: (props: PanelRenderProps) => ReactNode;
}
```

`PanelRenderProps` 是**显式白名单**，不要图省事把 `App` 的闭包整个传进来。新增一个 props 字段要同时改所有 panel，这会逼着实现者想清楚依赖。

落点白名单（第一版，直接采用，不要重新发明）：

| PanelId | 默认 | allowedSlots | floatable | closable | 备注 |
|---|---|---|---|---|---|
| `projects` | left 段 0 | `left` | 否 | 否 | 导航骨架 |
| `files` | left 段 1 | `left` `right` `bottom` | 是 | 是 | 旧 `explorerOpen` 映射到 `segments[1].collapsed` |
| `changes` | right | `left` `right` `bottom` | 是 | 是 | 现有 `spChanges` |
| `git` | right | `left` `right` `bottom` | 是 | 是 | 现有 `spGit` + worktrees |
| `browser` | right | `right` `bottom` | 是 | 是 | 宽度不足时不要进左槽 |
| `agents` | right | `left` `right` `bottom` | 是 | 是 | 注意是内联 roster，不是 `SubagentsPanel` |
| `computer` | right | `right` | 是 | 是 | 画面比例敏感 |
| `terminal` | bottom | `bottom` `right` | 是 | 是 | 高度敏感，浮窗最小高度 240 |
| `problems` `tests` `output` `logs` `pvlogs` | bottom | `bottom` `right` | 是 | 是 | 纯读表面 |
| `btw` | right | `right` | 是 | 是 | P2 之前保持现有独立浮窗，不并入 |

### 5.4 DOM 结构

```text
.app-body (position: relative; overflow: clip)
├─ .dock-slot[data-slot="left"]          只画 tab 条 + 占位框
├─ .main-col
│  ├─ .topbar
│  ├─ .workbench
│  │  ├─ .convo-col                      固定居中，不参与停靠
│  │  └─ .dock-slot[data-slot="right"]
│  └─ .dock-slot[data-slot="bottom"]
├─ .panel-host (position: absolute; inset: 0; pointer-events: none)
│  ├─ .panel-frame[data-panel="terminal"]   常驻，rect 跟随占位框
│  └─ .panel-frame[data-panel="git"]
└─ .dock-drag-layer (拖拽预览 + 落点高亮，pointer-events: none)
```

关键点：

- `.panel-frame` 的父节点永远是 `.panel-host`，**不随槽位变化**。换槽只改 `style.transform` / `left/top/width/height`。
- `.panel-frame` 用 `key={panelId}`，不要用 `key={slot}`。
- 关闭面板才卸载；切 tab 用 `visibility: hidden` + `inert`，保留布局盒，避免 xterm/iframe 重新测量。
- 浮窗是 `.panel-frame` 的一个状态（`position: absolute` + `--z-float`），不是新的 React 根。

### 5.5 拖拽协议

1. `pointerdown` 在 tab 上：记录 `panelId`、起点、源 segment；`preventDefault()` 防选中；`setPointerCapture`。
2. 移动超过 `exceedsDragThreshold`（复用 `btwGeometry`）才进入拖拽态，避免误触。
3. 拖拽态：给 `body` 加 `is-dock-dragging`；显示 tab 的半透明 ghost；计算落点。
4. 落点判定顺序：浮窗标题栏 → 各槽 tab 条（插 tab）→ 槽体边缘 24px（分栏）→ 槽体中心（替换激活）。
5. `pointerup` 提交一次 reducer；`Escape` / `pointercancel` / 窗口失焦取消。
6. 每次几何变化包 `beforeConversationLayoutChange()` / `afterConversationLayoutChange()`。
7. 不用 HTML5 `dragstart` / `dragover`：iframe、xterm、CodeMirror 会吞事件，jsdom 也测不了。

### 5.6 保活宿主

```ts
// PanelHost.tsx 伪代码
<div className="panel-host" aria-hidden={false}>
  {mountedPanels.map((id) => (
    <div
      key={id}                                  // 稳定，不随槽位变
      className="panel-frame"
      data-panel={id}
      ref={(node) => registerFrame(id, node)}   // ResizeObserver -> terminal.fit()
      style={rectOf(id)}                        // absolute; 来自占位框测量
      inert={!isVisible(id)}
    >
      {registry[id].render(props)}
    </div>
  ))}
</div>
```

`rectOf(id)` 的来源：
- 在槽内：`ResizeObserver` 观察对应占位框，读 `getBoundingClientRect()`，减去 `.app-body` 的 rect。
- 浮空：直接用 `FloatingLayout.rect`。
- 折叠/关闭：`visibility: hidden`，不写 `display: none`。

### 5.7 与 `fitWorkbench` 的关系

`fitWorkbench` 继续做**唯一**的空间预算求解器，不要另写一套。

```ts
// useDockLayout.ts
function toWorkbenchPrefs(layout: DockLayout): WorkbenchPreferences {
  return {
    collapsed: !layout.slots.left.open,
    sidebarWidth: layout.slots.left.size,
    sideOpen: layout.slots.right.open,
    panelWidth: layout.slots.right.size,
    bottomVisible: layout.slots.bottom.visible,
    bottomOpen: layout.slots.bottom.open,
    bottomHeight: layout.slots.bottom.size,
  };
}
```

- 输入：`DockLayout` → `WorkbenchPreferences`。
- 输出：`WorkbenchLayout`（含 `overlay`）写回 CSS 变量，和现在完全一致。
- 用户的拖拽改的是 `DockLayout.size`，再由 adapter 送进 `fitWorkbench`。
- `workbenchLayout.test.ts` 的 5 组断言必须原样通过；新增测试只测 adapter 和 reducer。

### 5.8 持久化与迁移

- 新键：`omp.dockLayout.<scope>`，`scope` 仍为 `global` 或 `project:<id>`。
- 旧键：`omp.layoutMemory.<scope>`（`LayoutMemory`，20 字段）保留只读，用于一次性迁移。
- 迁移规则：

| 旧字段 | 新字段 |
|---|---|
| `collapsed` | `slots.left.open = !collapsed` |
| `sidebarWidth` | `slots.left.size` |
| `splitRatio` | `slots.left.segments[0].weight` |
| `explorerOpen` | `slots.left.segments[1].collapsed = !explorerOpen` |
| `sideOpen` | `slots.right.open` |
| `panelWidth` | `slots.right.size` |
| `sideTab` | `slots.right.segments[0].active` |
| `bottomVisible` | `slots.bottom.visible` |
| `bottomOpen` | `slots.bottom.open` |
| `bottomHeight` | `slots.bottom.size` |
| `bottomTab` | `slots.bottom.segments[0].active` |
| `btw*` | 不动；P2 之前仍由 `useBtwWindow` 读写 |

- 迁移失败（JSON 坏、版本未知、字段类型不对）→ 用默认预设，不抛错、不白屏。
- `rememberLayout = false` 时不写新键；`perProjectLayout = true` 时 scope 用项目 id，和现在一致。
- 写入前做一次 prune：移除不存在的 `PanelId`、越界尺寸、重复 id。

---

## 6. 分期实施

### P0 · 抽面板 + 注册表（用户零感知）

范围：
- 把 `App.tsx` 中 `#spChanges` / `#spGit` / `#spPreview` / `#spAgents` / `#spComputer` / `#spBtw` / `#bpTerminal` / `#bpProblems` / `#bpTests` / `#bpOutput` / `#bpLogs` / `#bpPvlogs` 的 JSX 抽到 `panels/*.tsx`。
- 建 `panelRegistry`，槽位仍按现在的单选 tab 渲染。
- 不改 DOM 结构、不改状态字段、不改持久化。

验收：
- `npm run check -- --only renderer` 通过。
- 手动对比改造前后：每个 tab 的 DOM 结构、类名、预览分支、空态一致。
- `App.tsx` 行数下降，且 `WorkbenchCanvas` 不再直接包含面板业务 JSX。

回退：单次提交可整体 `git revert`，不涉及数据迁移。

### P1 · 槽内多 tab + 跨槽拖动

范围：
- `DockLayout` + reducer + `useDockLayout` + 迁移。
- `DockSlot` 支持多 tab 驻留、激活切换、关闭、从「视图」菜单重开。
- tab 可在左/右/底之间拖动；不做浮窗。
- 旧 `sideTab` / `bottomTab` / `explorerOpen` 仍保留为派生值，供命令面板与快捷键使用。

验收：
- 同槽可同时驻留 ≥ 3 个面板，切 tab 不丢状态（终端 scrollback、iframe 不重载）。
- 拖动一个面板到另一槽后，原槽 tab 条移除、目标槽追加并激活。
- 刷新页面后布局还原；旧 `LayoutMemory` 用户升级后布局不丢。
- `workbenchLayout.test.ts` 全绿。
- 窄窗（宽度 800 / 640）行为与改造前一致：面板退让为 overlay，不遮挡对话。

回退：保留旧键只读；把 `useDockLayout` 的读写指回 `LayoutMemory` 即可降级。

### P2 · 悬空浮窗

范围：
- `FloatingLayer` + `usePanelDrag` 的浮空分支。
- 浮窗标题栏拖动、四边/四角 resize、边界夹取、z 序（点击置顶）。
- 拖到槽 tab 条或槽体 → 停靠；关闭浮窗 → `closed`。
- 复用 `btwGeometry` 的 `clampRect` / `resizeRect`，不要复制一份。

验收：
- 浮窗不能拖出 `.app-body`；缩到最小尺寸后不能继续缩。
- 浮窗不遮挡菜单（`--z-float < --z-menu`）、不遮挡模态（`--z-float < --z-modal`）。
- 拖动浮窗时对话区不重排（浮窗不占布局空间），松手后也不跳位。
- 终端浮窗内 `fit()` 正常，resize 后 PTY 列数更新。

回退：`floatable` 全部置 false，浮窗代码保留但不可达。

### P3 · 左栏模块化 + 槽内 2 段

范围：
- 文件树可拖出左栏，拖走后左槽第二段显示空态（「把面板拖到这里」）。
- 任意槽允许 2 段（上下或左右），段间可拖比例。
- `projects` 段不可拖走、不可关闭。

验收：
- 文件树拖到右栏后，左栏仍显示项目列表；拖回后恢复原来的上下比例。
- 2 段布局刷新后还原；关闭其中一段后另一段占满。
- 不做 3 段及以上（reducer 直接拒绝）。

回退：`maxSegments` 常量改回 1，UI 自动退化为单段。

### P4 · 布局预设（可选）

范围：
- 内置 2–3 套预设（默认 / 专注对话 / 调试），命令面板可切换。
- 「重置布局」清除自定义，回到默认预设。
- 导出/导入 JSON（可选）。

验收：
- 无论用户把布局拖成什么样，「重置布局」一步回到默认。
- 预设切换不丢面板内容状态（仍走同一套 `.panel-frame`）。

---

## 7. 不可违反的约束

| 约束 | 说明 | 检查方式 |
|---|---|---|
| 依赖方向 | 只有 `apps/renderer` 可以依赖 `react`；renderer 不能 import Node 内置模块或 `electron` | `npm run check -- --fast`（`arch` 组） |
| 不改 Host | 纯显示层改造；不新增 query/command，不改 `client-contract` / `transport` / `studio-host` | diff 审查；`npm run check -- --only renderer` |
| 预览模式 | 每个 panel adapter 必须有 `preview ? <Demo/> : <Real/>`；预览开启时不得调用 Host；演示数据不得写 reducer / localStorage | 手动开预览跑一遍；`AGENTS.md`「预览模式与 Mock 数据」 |
| 布局不进 Host | `DockLayout` 只存 localStorage，不进 `ClientState`、不进 `client-contract` | 类型审查 |
| 对话重排 | 每次几何变化必须包 `beforeConversationLayoutChange()` / `afterConversationLayoutChange()` | 拖拽时观察虚拟列表是否跳位 |
| 焦点与 inert | 面板隐藏时设 `inert`；关闭时把焦点还给触发按钮；Tab 陷阱行为与现状一致 | 键盘走查：打开/关闭/切 tab/Escape |
| i18n | 新文案同时加 `i18n/locales/zh.ts` 与 `en.ts` | `npm run check -- --only renderer` |
| 选择器 | 不新增原生 `<select>`，普通单选走 `AppSelect` | `npm run check:selects` |
| 测试尺度 | 只测 reducer/迁移/夹取等纯函数 + 关键交互；不写拖拽 e2e，不为校验器写测试 | `scripts/core-suites.mjs` |
| 不引第三方停靠库 | 见 §2.3；确需引入先单独提案 | 依赖 diff |

---

## 8. 已知坑与对策

| 现象 | 根因 | 对策 | 验证 |
|---|---|---|---|
| 换槽后终端空白 / scrollback 丢失 | 面板被条件渲染或换了父节点，xterm 重建 | 宿主层固定父节点，只改 rect；`visibility` 而非 `display:none` | 终端里 `seq 1 200`，拖到另一槽，内容仍在 |
| 浏览器 iframe 重新加载 | 同上，DOM 节点被销毁 | 同上；iframe 不换 `src`，不在移动时改 `key` | 打开一个带表单的页面，填字后移动，内容仍在 |
| 切 tab 后 CodeMirror 失焦/丢撤销栈 | 面板 unmount | 同上 | 在 Git diff 里编辑，切走再切回 |
| 对话跳位 / 滚动位置乱 | 拖拽每帧改了布局但没通知对话层 | 每个几何写入都包 reflow 钩子 | 长对话滚动到中部，拖右栏宽度，观察是否跳 |
| 窄窗下浮窗盖住对话 | 只按 `DockLayout` 渲染，没走 `fitWorkbench` 的 overlay 退让 | 尺寸与可见性仍由 `fitWorkbench` 求解；浮窗在窄窗下强制收起为 tab | 宽度 640 / 800 各走一遍 |
| 老用户升级后布局全丢 | 只读新键，没迁移旧 `LayoutMemory` | §5.8 迁移表 + 失败回退默认 | 手动写一份旧键 JSON，刷新验证 |
| 刷新后浮窗跑到屏幕外 | 存了绝对坐标但窗口变小 | 读取时 `clampRect` 到当前 `.app-body` | 改窗口尺寸后刷新 |
| 浮窗盖住菜单/模态 | z-index 用错 | 浮窗用 `--z-float`，菜单 `--z-menu`，模态 `--z-modal` | 打开浮窗后开菜单、开归档确认框 |
| 拖拽时文本被选中 / 点击被吞 | 没 `preventDefault`、阈值太小 | pointerdown 阻止默认；4px 阈值；`is-dock-dragging` 期间 `user-select: none` | 单击 tab 只切换，不进入拖拽 |
| 面板关闭后无法找回 | 只做了 ×，没做「视图」菜单 | `closed[]` + 菜单里列全部可关闭面板 | 关掉 Git，从菜单重开 |
| 预览模式漏了某个面板 | adapter 只写了真实分支 | registry 里每个 panel 都强制 `preview` 分支；缺 fixture 时显示带「演示」标记的空态 | 开预览逐个 tab 走查 |
| 布局 JSON 越来越大 / 引用已删面板 | 直接存了整个对象 | 只存 id + 数值；读取时 prune 未知 id | 手动改 JSON 注入不存在的 id，刷新不崩 |

---

## 9. 验收清单

### 结构

- [ ] `.panel-frame` 的父节点在面板整个生命周期内不变
- [ ] 槽位 DOM 里只有 tab 条和占位框，没有面板内容
- [ ] `dock/*` 不 import 任何具体面板；`panels/*` 不 import `dock/*` 的实现细节
- [ ] `App.tsx` 不再包含 12 个 tab 的业务 JSX

### 行为

- [ ] 同槽多 tab 驻留，切 tab 不丢状态
- [ ] 跨槽拖动，源槽与目标槽的 tab 条同时正确
- [ ] 拖出浮空 / 拖回停靠 / 关闭 / 重开
- [ ] 浮窗夹取、最小尺寸、z 序
- [ ] 布局刷新还原；重置回到默认
- [ ] 窄窗 overlay 行为与改造前一致

### 兼容

- [ ] 预览模式每个面板都有演示数据与「演示」标记
- [ ] 无 runtime 时 `requiresRuntime` 面板显示 `Deferred` 空态，不报错
- [ ] 键盘：Tab 顺序、Escape、焦点归还
- [ ] 中英文案齐全
- [ ] `npm run check -- --only renderer` 通过
- [ ] 旧 `LayoutMemory` 迁移成功，且迁移后旧键不再写入

---

## 10. 参考链接

- VS Code 布局：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/grid.ts>
- VS Code Workbench Layout：<https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/layout.ts>
- Lumino DockLayout：<https://github.com/jupyterlab/lumino/blob/main/packages/widgets/src/docklayout.ts>
- Godot Editor Dock Manager：<https://github.com/godotengine/godot/blob/master/editor/docks/editor_dock_manager.cpp>
- Qt Advanced Docking System：<https://github.com/githubuser0xFFFF/Qt-Advanced-Docking-System>
- dockview：<https://dockview.dev>
- rc-dock：<https://github.com/ticlo/rc-dock>
- dnd-kit：<https://dndkit.com>
- allotment：<https://github.com/johnwalley/allotment>

---

## 附：本文档不做的事

- 不提供逐行代码。落地时以 `dock/dockLayout.ts` 的类型和 §5 的接口为准。
- 不评估性能。拖拽期间的帧率需要实测，若掉帧，先关掉浮窗阴影/过渡，再考虑 rAF 合并。
- 不覆盖多窗口、跨屏、系统级置顶。那些需要 `BrowserWindow` 与桌面层配合，另开任务。
