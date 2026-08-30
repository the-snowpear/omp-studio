# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **关闭到系统托盘**：点窗口关闭不再退出应用，而是隐藏到 Windows 右下角系统托盘（Host 与 Runtime 继续运行，流式输出在后台继续）；左键托盘图标或右键菜单「打开页面」重新显示窗口，右键菜单提供「打开页面 / 退出」。纯 Main 行为（`apps/desktop/src/tray.ts` 新模块，Electron-free、注入式 seam 可无头单测），不改 preload / client-contract / Renderer。要点：托盘仅在创建成功后启用关窗隐藏（图标缺失时保持原「关窗即退出」，绝不留下无窗无托盘的僵尸进程）；流式进行中从托盘「退出」先弹原生确认框（取消为默认按钮），确认后才走既有优雅退出——忙碌判定以 residents read model 为准（任一会话 running / compacting），无 broker 视图时回退当前会话 snapshot 的 `isStreaming` / `isCompacting`；OS 关机 / 更新安装触发的 `before-quit` 不弹框，`isQuitting` 注入窗口工厂保证真实退出路径的 close 事件放行；首次隐藏弹一次「已最小化到托盘」气泡（标记持久化在 `%APPDATA%\omp-studio\tray-hint-shown`）；二次启动实例在窗口隐藏时也能唤起（second-instance 改走 `show()`）。新增 `desktop-lifecycle.test.ts`（组合层生命周期契约）与 `tray.test.ts`（文案 / 菜单 / 气泡 / 标记）。
- **Explorer 文件「更多操作」菜单**：文件树文件/目录行的 ⋯ 按钮与行右键均可打开与侧栏会话行同款的弹层菜单（`apps/renderer/src/menus.tsx` `FileRowMenu`，锚定 / 视口钳制 / 翻叠与 ThreadRowMenu 一致）。菜单项：打开（文件 = 系统默认程序，目录 = 树内展开/收起）、打开方式（子菜单列出本机已装的 VS Code / Cursor / Windsurf，末项「选择其他应用…」在 Windows 上调起系统「打开方式」对话框）、在资源管理器中打开（文件定位选中 / 目录直接打开）、复制绝对路径、复制相对路径、添加上下文。桌面能力走 workspace-shell 新增的五个文件级 IPC 通道（`fileOpen` / `fileOpenWith` / `fileReveal` / `fileAbsolutePath` / `fileOpeners`）：Renderer 只传不透明 workspaceId + 工作区相对路径，Main 解析绝对路径并强制包含性 / 存在性 / 类型校验，绝对路径不出现在入站载荷里。预览模式同款菜单：桌面依赖项禁用并给出原因，复制相对路径与添加上下文仍可用（与 @ 按钮行为一致）。
- **侧栏项目与 Explorer 展开状态记忆**：左侧「项目 / 会话列表」每个项目的展开/收起状态、下方 Explorer 文件树的目录展开状态，现在写入 localStorage（`apps/renderer/src/sidebar/expandMemory.ts`，Renderer 本地记忆，不进 Host）并在启动时恢复，不再默认只展开第一个（活动）项目；「全部收起」同样被记住。Explorer 的目录 children 是懒加载的，恢复按路径逐级推进展开；点 ↻ 刷新文件树后也按记忆恢复上次展开的目录，而不是收起一切。预览模式不读不写该记忆，避免演示 fixture 污染真实工作区。
- **流式渲染性能门禁**（`npm run perf:streaming` → `scripts/streaming-perf-gate.mjs`）：用 Playwright 起真 Chromium 加载 `apps/renderer/perf-harness.html`，喂真实 `ConversationStore` 与真实 runtime 事件，按帧推进并通过 CDP `Performance.getMetrics` 取 `LayoutDuration` / `RecalcStyleDuration` / `ScriptDuration` 的每帧增量。这是为了补掉 jsdom 单测的盲区：那里只量 React 的 commit 时长，CSS 布局、ResizeObserver、滚动写入与合成全都不在里面，所以「测试绿、真机掉帧」是可能的。
  - 判定用比值而不是绝对毫秒（机器快慢会飘，不变量不会）：单帧布局时间随历史长度的放大倍数设了棘轮上限；「流式与静止两态都必须保留工具卡高度过渡」（流式态只按卡片是否仍在运行动画，见 Changed 的动画回归条目）用 `transition-property` 的计算值断言——帧间隔被 vsync 量化成 16.7/33.3/50 的台阶，掉到 30fps 就饱和了，把这条埋在毫秒里读不出来。另有 p95 帧间隔与「间隔 >48ms 的帧占比」两条崩溃级兜底。
  - 走独立的 `.github/workflows/perf.yml`，不进主 CI 的三条门禁；`playwright@1.62.1` 与 `scripts/capture-readme-shots.mjs` 一样按需装、不写进 `package.json`，但锁定版本以保持浏览器基线可复现。门禁还会真实切换一次长会话，断言旧正文在离场阶段不被新 DOM 顶掉、新正文先隐身完成测高与贴底，并且首次可见帧没有位置跳变。
  - 本机基线（2026-08-30，90 帧 / 每帧一次产出，多次运行区间）：短历史单帧布局 2.5~4.7ms、长历史（24 轮 × 3 工具 × 1200 行输出）11.6~14.2ms，比值稳定在 3~4.7 之间。剩下的放大主要来自那张仍在跑的工具卡自己——`BASH_DISPLAY_MAX_ROWS` 是 1500 行而卡体 `max-height` 只有 320px，每帧要为十几行可见内容排上千个行盒；那是下一个可动的地方。
- **侧栏会话行「更多」菜单**：左侧对话列表每行的 ⋯ 按钮与行右键均可打开与顶栏「对话选项」同款的菜单（重命名 / Fork / Handoff / Compact / 导出 / 会话历史 / 归档），弹层稍窄；右键时菜单贴光标弹出。动作作用于所在行会话：非当前会话先打开（必要时切换工作区并 resume）再执行；预览演示行的会话动作保持禁用，归档仍为本地演示行为。

### Changed

- **空闲 Runtime Worker 驻留 TTL 从 10 分钟调至 5 分钟**：每个 Worker 常驻 ~290MB（实测 omp CLI 终端直跑空闲同为 ~250MB，属 omp 固有水位，Studio 侧仅 +40MB 桥接与会话驻留），缩短空闲回收窗口在多会话切换体验与空闲内存峰值之间重新取中。停靠子代理的会话空闲判定维持 omp 原生语义，不改。

- **网络搜索配置页重做（模型配置页第 4 个 tab）**：删除原前后端实现后按 OMP 上游 `web/search` 能力重建。新面板为「生效链路 + 双分区」布局：顶部状态卡实时推算展示当前实际会用的搜索链（显式 `providers.webSearchOrder` 优先，其后是按内置顺序凭证就绪的自动链），下面分「优先链」（拖拽/箭头排序）与「供应商库」（搜索框 + 全部/已就绪/未配置/免凭证/已排除筛选，每行显示引擎的凭证要求描述与凭证徽标）；tab 计数 chip 从 order 长度改为就绪引擎数，命令面板补上此前缺失的网络搜索入口。功能补全：read model 的每个供应商带上游 `SEARCH_PROVIDER_OPTIONS` 描述；`searxng` 新增 `categories` / `engines`（逗号分隔）、`language`、`safesearch`（0/1/2，空 = 实例默认）四个此前面板未覆盖的字段，SearXNG / Exa 高级区改为默认收起的折叠区。写入仍走单命令 `models.webSearch.set`（Host 直写 `config.yml`，密钥只写不读，`safesearch: null` 删键），入站校验、reducer 敏感命令登记与 testkit fixture 同步；预览模式 demo fixture 带描述与新字段；新增 `WebSearchPanel` 组件测试（8 例）与 adapter 新字段写入/清除测试。
- **「加入上下文」统一更名为「添加上下文」**：Explorer 文件树的 @ 按钮提示、新的「更多操作」菜单项与对话空态的 @ 提示（`shell.addContext` / `conversation.tipContext`）中英文一并更名（Add to Context → Add Context）；设置页「工作区树加入上下文」是独立设置项短语，不受影响。
- **Agent Hub 列表顺序固定为创建顺序**：卡片按 Agent 注册时间升序排列，扁平视图与树视图（组头 / 子行 / 孤立行）共用同一个比较器，键盘 `j/k` 的遍历序列随之一致。此前排序键是「状态分组 + 最后活动时间倒序」，任何一次状态翻转或 usage 更新都会把卡片顶到最上面、列表在流式过程中不停重排。缺少 `startedAt` 的归档行排在末尾并按 id 稳定排序。

- **流式对话渲染链**（描述当前工作树的事实；早前一版基于 `selectConversationViews` / `reuseTimelineRows` / 自研 `RowWindow` 窗口化的实现已回退，对应的基准数字随之作废，故不再保留）：
  - Store 侧：持久历史前缀只在结构变化时重投影，token 热流只重建有界 transient 尾部；行对象按 key + 依赖数组缓存（`rowCache`），Transcript 的 `renderItems` 与改动卡 / Plan 卡 binds 按 structure token 缓存。
  - 工具事件（`tool.started` / `tool.completed` / `tool.updated`）只标脏所属行，不再整窗重投影。
  - 时间线渲染改用 `@tanstack/react-virtual`（估高 132px + `measureElement`），单帧挂载行数上限 120。
  - `ToolBody` 按 `tool` 身份 memo；静止态折叠卡保留正文到动画结束，live 尾卡则同步卸载折叠正文，不让不可见的长输出继续参与每帧布局；bash 输出先裁尾（末尾 1500 行 / 64 KiB）再剥 ANSI 并 `useMemo`。
  - 流式 markdown 分块解析（`markdownBlocks.ts`）：扫描结果拆成引用稳定的 `frozen` 前缀与有界 `pending` 尾部，一个 chunk 只续扫检查点后的少量文本；切点只落在语义安全的空行处；mermaid 按「主题 + 源码」缓存 SVG（上限 32）；`truncateUtf8` 加长度上界快路径。
  - minimap：圆点派生按行对象缓存；`measure()` 一次 `querySelectorAll` 批量读 rect，并在圆点集合与 `scrollHeight` 都未变时整体跳过；位置变化小于阈值不重渲染轨道；滚动只更新视口条；`ResizeObserver` 只装一次、回调按帧合并。
- **工具卡 / 工具链展开收起的掉帧**：症状是「静态对话里丝滑，流式进行中掉到极低帧率，连上一轮历史里的卡片也一样卡」——也就是说预算不是被动画本身吃掉的，而是被每个流式帧的固定开销吃光后剩不下给动画。实测（jsdom，只计 React 提交时间；用 `streamingFrameCost.test.tsx` 复现）：一条正在输出的 bash 工具卡，日志 1200 行时**每帧约 16ms 花在 React 上**，40 行时约 4ms——per-frame 代价随日志行数线性增长。
  - `bashDisplay` 改为按「同类别的连续行」合段：`.codeblock` 本来就是 `white-space: pre`，段内换行照原样渲染，此前一行一个 `<div>` 只是把同一份文本铺成上千个 DOM 节点，而流式期间每帧都要重建并 diff 这上千个节点（Chrome 里还要多付一份上千个行盒的样式重算与布局）。纯字符串输出（最常见）因此收敛成单个文本节点。修完后 1200 行与 40 行的每帧提交时间基本齐平（实测 16ms → 4.6ms，且不再随行数增长），测试用「长日志的提交时间不得超过短日志 2.5 倍」把它钉住。
  - 静止态在收起过渡结束后卸载正文；live 尾卡和仍在运行的工具链取消高度动画并同步卸载折叠正文：此前一张在跑的 bash 卡被收起后仍会在 320ms 内按帧重渲染上千行输出，屏幕上什么都看不见。代价是收起再展开会丢掉卡内滚动位置，与从没打开过的卡一致。
  - 行元素按身份缓存（`ConvoTranscript`）：虚拟列表每取一次测量就重渲染一次（工具卡高度过渡时每帧一次，流式时每帧一次），而 `renderItem` 过去在那里重建整个挂载窗口的元素树，带 `onReviewChanges` 的行还因为每帧新建闭包而彻底穿透 memo。现在元素按「行对象 + bind + 回调」缓存，未变的行靠引用相等整棵子树跳过。
  - 首次展开把 `open` 类推迟一帧：正文最多 1500 行代码，和一个基于时间的 250ms 过渡在同一帧提交，挂载就吃掉过渡的头 100ms（观感是先瞬间跳到大半开）。
  - `ToolItem` / `ThinkCard` memo 化，链内 toggle handler 改为稳定身份：链尾行每帧换对象会带着整条链重渲染，此前每张卡都要重算 `toolLabel` / `chainItemDetail` / `toolDiffStats`（编辑卡是逐行正则）。
  - 思考正文改成单个 `pre-wrap` 文本节点（`.think-scroll.convo-plain` 本来就是 `white-space: pre-wrap`）：原来每行两个节点的 `<span>` + `<br/>` 只是把同样的换行渲染成几千个 DOM 节点，并且每次重渲染全部重建；摘要行的全文扫描移进卡内 memo。
  - `ToolCardScroll` 只在 live 尾卡上装 ResizeObserver：此前视口里每张卡的每个正文区都装一个，还连每个直接子节点一起观察（代码块的子节点就是它的每一行），于是邻卡展开的每一帧浏览器都要给这些盒子算尺寸；跟随写入按帧合并成一次。
  - minimap 全量重测限频 700ms（尾随重测保证收敛）：`scrollHeight` 每帧变化都会让「未变则跳过」的闸门失效，此前每帧一次全子树 `querySelectorAll` + 逐节点 `getBoundingClientRect` + 最多 2000 个圆点的 `setFractions`，再带出一次 minimap 全量重渲染与 `spaceMinimapMarks`；活跃圆点的布局读取也只跟真的重测一起发生。
  - 工具卡内的滚动面板（`codeblock` / `tc-code` / `tc-diff` / `tc-json` / `tc-tree` / `think-scroll`）加 `contain: layout paint`：它们本来就是自带裁剪的滚动盒，声明之后正文追加一行不必再验证祖先链，过渡的每一帧也不必把整段代码重新排一遍。
- **工具卡 / 工具链收起展开动画回归流式**（取代上面「流式期间取消工具卡的高度过渡」的决策）：流式期间轮次推进、工具接力、整链在轮次结束时折叠，此前全是硬切。现在 `.tl-card` / `.batch-chain` 在流式与静止两态共用同一套 `0fr → 1fr` + opacity + translateY 的 250ms 过渡；`data-live-stream` 属性保留但只服务小地图降频等非动画用途，`.batch-chain` 的 4px 间距也并入过渡避免起跳帧跳一下。动画期间真正的开销大头——「仍在运行」的卡片正文每个发布帧都在变——改由 `BatchChain` 按 `tool.status === "running"` 逐卡判定：运行中的卡保持瞬时挂载/卸载（收起动画 320ms 里它会在看不见的卡里多重渲染上千行输出），已完成的卡正文已冻结，走完整过渡与静止态同价（滚动面板 `contain: layout paint`、`max-height` 封顶，每帧只重排卡壳与重光栅被揭开的区域）；手动收起一条仍有工具在跑的链仍同步卸载全部卡片。性能门禁的 `height-transition-suppressed-while-streaming` 断言随之反转为「流式态也必须含 `grid-template-rows`」。
- **流式长输出的行盒布局放大**（性能门禁注释里点名的「下一个可动的地方」）：一张在跑的 bash 卡保留末尾 1500 行而卡体 `max-height` 只有 320px，此前每个流式帧都为十几行可见内容排上千个行盒——这是「单帧布局时间随历史长度放大 3~4.7 倍」的主要来源。现在 `textChunks.tsx` 把长文本按 64 行切块、每块声明 `content-visibility: auto`：视口外的块由浏览器用 `contain-intrinsic-height`（块内行数 × 面板 1.65 行高）占位并跳过布局与绘制，跟底输出时每帧真正要排的只有尾部一两个块；`contain-intrinsic-width: auto` 让渲染过的块记住实际宽度，横向滚动条不随可见块漂移；回看深度不变（DOM 都在，滚动即再布局）。短文本（≤64 行）仍走单文本节点路径，不添 DOM。接入点：Bash 输出块、Think 正文、默认回退的 Output，均按文本身份 memo，流式期间只有尾块重新切块。实测（真 Chromium 门禁）：长历史（24 轮 × 3 工具 × 1200 行输出）单帧布局 7.3ms → 1.4~1.5ms，短/长比值 3.87 → 1.3~1.4；折叠/展开压进流式帧的忙碌场景 p95 帧间隔 33.3ms → 16.7ms（贴满 vsync、零卡顿帧）。`HISTORY_RATIO` 棘轮按门禁自述从 6 收到 2。
- **虚拟行行高跨挂载记忆**：`estimateSize` 固定 132px 时，切回看过的时间线要重走「估高 → 实测 → 贴底」的修正链（`settling` 隐身两帧就是为它兜底的）。`rowHeightCache.ts` 以模块级缓存按行键记住量过的行高（上限 8192 条、超限整体清空），`ConversationVirtualList` 在行挂载的 ref 回调里顺带读一次 rect 记录——不挂第二个 ResizeObserver，避免悬挂观察在长滚动会话里积累 detached 节点。重挂时未测量的行直接拿上次真实高度当估高，首次布局即接近最终值，修正与重排随之减少；行高权威仍是虚拟列表自己的测量，缓存只影响初值。
- **小地图拖动掉帧（流式 / 长会话）**：拖动视口条或轨道时每个 `pointermove` 都以输入设备频率执行「读 rect → 写 scrollTop → syncViewport 读回」，写在读后，流式期间布局每帧都是脏的，等于把一帧的全量布局按事件次数（高回报鼠标可达每秒数百次）重复付费；同时滚动事件里的 `requestMeasure(true)` 会旁路「未变则跳过」闸门，拖动期间反复做全量重测（全子树 `querySelectorAll` + 逐行 rect + `setFractions` 带出的整次 React 重渲染）。现在两个拖动路径都合并到 rAF（每帧至多一次写入）、全部读前置于写；拖动期间滑块位置由拖动几何直接写出，视口条 / 活跃点交给滚动事件路径每帧对齐；强制重测在拖动期间降级为普通节流档，pointerup 后补一次收敛。新增测试钉住「rAF 前不写、一帧只写一次」。

- **流式帧预算的协同调度**（上一条把「每帧的 React 时间」压下来之后，剩下的掉帧出在布局与测量的争抢上；真机复现见下面的 `npm run perf:streaming`）：
  - 流式期间取消工具卡的高度过渡：`ConversationPane` 按「尾行是否在产出」在 scroller 上写 `data-live-stream="1"`，CSS 据此把 `.tl-card` / `.batch-chain` / `.turn-diff-panel` 的 `grid-template-rows: 0fr → 1fr` 从过渡列表里摘掉，只留 `opacity` / `transform`（合成器属性，不触发布局）。高度过渡的每一帧都要求浏览器把卡内全部正文重排一遍（一张 bash 卡可以是上千行），而流式期间主线程已经没有空闲帧留给它——于是两边一起掉。静止态与 `prefers-reduced-motion` 的行为不变，展开动画照旧。（此决策已被下方「工具卡 / 工具链收起展开动画回归流式」条目按新需求取代。）
  - `ToolCardScroll` 的 ResizeObserver 不再观察每个直接子节点（代码块的子节点就是它的每一行），只观察滚动盒本身；不改变盒尺寸的增长本来就会以一次 render 到达，由 layout effect 里的跟随写入接住。
  - 对话跟底收敛成单一写入者：`useConversationScroll` 用一个只观察最终 `.convo-doc` 与滚动盒的 `ResizeObserver` 负责测高后的 `scrollTop` 写入；`ConversationVirtualList` 不再从 virtualizer 的 `onChange` 另起 rAF 写滚动位置。无 `ResizeObserver` 的环境才走 `contentKey` layout-effect 回退。此前一个流式帧可能由两条路径各强制布局一次，且两个写入者在手势那一帧还可能给出不同结论。
  - 流式 markdown 分块改成真正的增量扫描：`scanStreamingMarkdown` 把行扫描位置、围栏状态与有界待定尾部作为检查点带到下一帧，已经确定的块提升进引用稳定的 `frozen` 前缀；渲染层分别 memo `frozen` / `pending`，不会每帧重新遍历和解析全部历史切点。链接引用定义只从上一条未完整行继续扫描，一旦发现仍保持整篇同一解析域。逐字符重放与全量扫描逐帧等价、重复调用幂等以及长前缀引用不变均由测试钉住。
  - 小地图在流式期间把全量重测的闸门从 200ms 放宽到 700ms，并且只在真的重测了那一次才顺带做活跃圆点判定（它另外要两次 `getBoundingClientRect` 加一遍轨道 `querySelectorAll`，而流式期间圆点根本没动）。

- **Runtime 工具输出合流**：`conversation.tool.updated` 与文本 delta 一样进合流缓冲（每工具一份，16ms 或 4 KiB 未发送尾部触发 flush），并按「客户端已经收到的前缀」而不是「上一次宿主快照」决定 append / replace。此前每个 runtime 更新直接发一帧，且在 partial 不是前缀延长时（bash 的 `\r` 进度行、JSON 形状的 partial）会把整段保留输出（上限 256 KiB）重发一次。控制事件与工具结束仍先 flush，顺序不变。
- **Runtime 投影器去掉死队列**：`#enqueue` / `#compactQueue` / `#drain` 里的相邻合并、队列压缩与丢包分支永远不会触发——`#emitParsed` 入队后立刻同步 drain，队列长度恒为 1——现已整块删除，改为直接投递。流控仍是同步语义：慢 listener 反压 Runtime，而不是让队列增长、或按启发式丢掉 delta（那条路径一旦被启用会造成正文永久缺失，只能等 `message.completed` 自愈）。
- **切换会话的过场**：此前切一次会话要闪两次版式——engine 按新 identity 重建，第一份快照是零行的 `loading`，于是先硬切成居中的「正在准备对话 + 对话图标」占位（外加一条「正在加载对话」横幅），读完再硬切成 transcript；即使已有 fade-through，新快照在 `leaving` 期间到达也会把旧 DOM 提前换掉，随后虚拟列表的估高、实测与贴底又暴露出一两次位置跳变。现在走稳定的 fade-through：上一段 transcript 原地淡出（140ms）→ 骨架屏兜住空窗（**无时限**）→ 新 transcript 隐身稳定两帧（`settling`）→ 叠着骨架淡入（320ms）。
  - 离场期间始终把上一屏的 ReactNode **引用**原样交给 React，即使新快照已经到达也不提前替换；整棵子树按引用相等跳过重渲染，DOM、滚动位置、虚拟列表状态全部留在屏上淡出。新正文随后在 `opacity: 0` 下挂载，等虚拟列表测高和唯一的跟底写入完成两帧后才可见，因此首次可见帧已经贴底且没有二次跳位。
  - 骨架屏（`ConversationSkeleton`）是 `position: sticky; height: 0` + 绝对定位内层，对文档高度零贡献——这是硬约束：`ConversationVirtualList` 的 `scrollMargin` 用 `getBoundingClientRect` 相对滚动容器量算，占真实高度就会把虚拟行反向补偿掉；同理正文只动 `opacity`，位移只由骨架自己做。内层高度压在视口以下，卸载时 `scrollHeight` 不缩、贴底位置不回跳。
  - 一套编排适配所有加载时长：读取落在淡出窗口内则在离场结束后直接进入不可见稳定期，骨架一帧都不出现；骨架自己还有 60ms 入场闸门 + 可逆 transition，稍慢的读取只留一次呼吸感；长读取才看到完整骨架，2.4s 后补一行说明。连点侧边栏切换时同一片骨架全程不重建。
  - 相位机是纯函数（`conversationSwitchPhase.ts`），在 render 内按 props 派发，新阶段与新快照落进同一次提交（不留错帧）；`idle` 阶段不挂任何 transition / animation，流式每帧零额外代价。`prefers-reduced-motion` 下跳过淡出、只留静态骨架。

### Fixed

- **滚动期间 minimap 圆点漂移与周期性卡顿**：虚拟列表只挂载窗口内的行，窗口外圆点的位置靠「当前挂载行」之间插值——窗口随滚动移动时锚点集跟着变，同一圆点每次重测（滚动中每 200ms 一次）都得出不同分数，表现为点位上下漂移，且每次分数变化都触发整条轨道重渲染（滚动中周期性卡一下）。现在实测过的行中心累积在持久锚点缓存里，插值永远在最近两个已实测锚点之间进行：窗口移动不再改变已定分数，重复重测被 `fractionsShifted` 整体短路（挂架实测同区域往返滚动第二轮 style 重写与位移归零）；圆点集合增删或文档高度变化（流式、卡片展开）时缓存失效回到逐窗重建。行首次进入视口时仍会从插值一次性修正为实测，属收敛而非漂移。
- **空闲/流式期间整应用卡顿（动画十几帧、minimap 拖动 ~20fps）**：两个互相喂养的问题。(1) React 19 的 `setProp` 对 `dangerouslySetInnerHTML` 按**对象引用**比较，而 `Icon` 每次渲染内联新建 `{{ __html }}`——整棵应用 ~550 个图标在每次 React 提交时都整段重写 innerHTML，实测每秒近 2 万次 SVG 子树重建；改为按图标名缓存值对象后引用稳定，React 直接跳过。(2) `useComposerCollisionCollapse` 的 `measure()` 无条件改写 `data-collapse`，而它自己挂在同一个 bar 的 ResizeObserver/MutationObserver 又被这些布局变化唤醒，形成 rAF 级自持循环（每轮还带两次读 `scrollWidth` 的强制布局）；改为值未变化不写。两项修复后空闲期自持 rAF 循环从 ~18Hz 归零，流式期间主线程占用从 ~900-1060ms/s 降到 ~620-750ms/s（style 重算分量 228ms/s → ~20-40ms/s）。性能挂架没暴露此问题，因为它只挂 ConversationPane + Minimap、不含 composer。
- **流式快速输出时最末行侵占下方内容**：虚拟行以绝对定位叠放，`react-virtual` 的 resize 处理按 rAF 延后一帧、React 再一帧才提交新的 `totalSize`，文本换行长高的那一两帧里行盒会越过列表容器的旧高度，把新增的最末行画到下方活动状态行等内容上，测量追上后才被推下去——快速输出时反复可见。`.convo-virtual-list` 声明 `overflow: clip` 裁掉越界部分：新行改为随「测量落地 + 跟底滚动」的同一帧出现并整体上移，而不是先盖在别的内容上。
- **子代理停止后的统计与计时**：停靠（park）会 dispose 子会话，`liveUsage` 随之消失，工作台卡片与 Agent Hub 因此退回「按当前时间算时长」并把落盘 usage 整行盖掉，表现为 `3435.8s` 一直爬、`0 tok  req 0`、`usage —`。现在：runtime 保留每个 Agent 最后一次实测 usage（按 `createdAt` 绑定，避免同名重注册串号），session 消失后以 `lastActivity − createdAt` 的 `span` 形式继续上报；roster 合并只用落盘记录补 live 缺失的 `usage` / `startedAt`，不再让无 usage 的 live 行清空归档数据；两个页面的时长只在 `starting/running/reviving` 时跟当前时间走，停止后冻结在最后活动时刻，且分钟级时长改显示 `8m 7s` 而不是 `487.1s`。异步派发瞬间写下的 `pending` 进度行（token/请求/时长全是占位 0）不再当统计渲染，运行中的 `toolCount` 也终于计入 tools。
- **切会话 / 重挂载时 transcript 闪空**：`ConversationPane` 此前无条件读新引擎的空快照，`useConversation` 的 `retainConversationWhileRemounting` 因此形同虚设。现在同一会话重建引擎期间保留上一份行，跨会话仍照常清空。
- **中止轮丢失已完成的工具结果**：`turn.aborted` 只在非中止分支把 live 工具结果折进持久 item，随后无条件删掉 live 工具，已经跑完的调用会退化成 `missing`。现在中止也折叠结果；仍挂在中止行上的工具保留并落到终态状态，等下一轮开始再回收。
- **上滚后被流式拽回底部**：虚拟列表的跟随写入读的是 `follow`（React state，比手势晚一次渲染），与 `useConversationScroll` 的 layout effect 构成两个权威。两者现在共用同一个同步 `pinned` ref。


## [0.1.1] - 2026-08-16

### Added

- **供应商模型自动获取能力**：模型配置 · 供应商新增 / 编辑页「模型」区块新增「自动获取模型」按钮。支持直接读取该供应商的模型列表接口（OpenAI 兼容 `/models`、Anthropic `/v1/models`、Google Generative AI、Ollama `/api/tags` 等），解析提取上下文窗口（Context Window）、输出上限（Max Output）及思考/视觉能力，生成可勾选清单一键导入 Custom Models。

### Fixed

- **运行时动态新增模型切换报错**：修复在供应商页新增模型后返回工作台切换报错 `runtime rejected the request arguments` 的问题。在模型切换未命中时主动触发 `modelRegistry.refresh("offline")` 热重载本地配置，与 OMP 内置 `/model` 保持一致，无需重启即可无缝热生效。
- **全新环境 Runtime 初始化与冷启动**：修复在电脑原先未安装 OMP 且无 `~/.omp` 目录的纯净环境下 Runtime 解析失败与初始化异常问题，完善自动初始化与环境骨架补齐逻辑。
- **思考强度格式校验与序列化**：修复在新建供应商与添加模型时，思考强度（Thinking Budget）格式解析与离散/数值模式映射问题，确保配置正确保存与加载。
- **Host 账本与错误回执展示**：优化失败回执文案，优先保留 Runtime 真实的拒绝原因（如 `Model is not available: provider/id`），避免统一被压缩为固定的无意义报错。

## [0.1.0] - 2026-08-15

- 初始正式版本发布，提供 OMP Studio 桌面工作台、Session 管理、审批模式与工具链集成。

[0.1.1]: https://github.com/the-snowpear/omp-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.0
