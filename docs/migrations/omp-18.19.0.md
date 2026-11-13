# OMP 18.19.0：CLI-first GUI 适配

OMP Studio 继续作为 OMP CLI / AgentSession 的 GUI，不另建执行器或代理政策。目标固定为正式 **v18.19.0**、提交 `04cd1a7549a02d62ad1d24826198d52507595683`，不混入滚动 main。Studio 产品版本保持 **0.2.0**；Runtime Studio 修订和输入摘要由 [`series.json`](../../omp-patch/patches/series.json) 与 `omp:patches:regen` 管理。

## 正式版本范围

从 18.18.0 之后的十次发布升级：18.18.1–18.18.9、18.19.0。coding-agent 没有独立的 18.18.5 变更段，该版的模型变化记录在 catalog 日志中。依据为目标提交的 [coding-agent 日志](https://github.com/can1357/oh-my-pi/blob/04cd1a7549a02d62ad1d24826198d52507595683/packages/coding-agent/CHANGELOG.md) 和 [catalog 日志](https://github.com/can1357/oh-my-pi/blob/04cd1a7549a02d62ad1d24826198d52507595683/packages/catalog/CHANGELOG.md)。

| 版本 | 原生变化 | Studio 的落点 |
| --- | --- | --- |
| 18.18.1 | 显式 restore / restart 恢复原子任务；Shell locale、后台进程与工具排序修复 | Bridge/Remote UI 就绪后调用原生 restore；保留父子/job 身份，不根据历史重新 spawn。Shell 等修复直接继承。 |
| 18.18.2 | session scoped refresher / logout API、存储 scanLines、GC strip、sloppy 部分编辑、IRC 用户权限与扩展事件顺序 | fresh SessionSlot/worker 绑定新的原生 refresher；logout 传 session；维护页新增 strip；Changes 消费 perFileResults。原生 scanLines、IRC 与事件顺序不退回旧实现。 |
| 18.18.3 | Ask 改为 HTML form、原生 named data / Other / 图示，task eager/delegation 政策调整 | 现有 Deck 中的安全 FormCard / FormSession；正文瞬时读取，旧 Ask history 只读兼容；不强制覆盖原生委派政策。 |
| 18.18.4 | PromptOptions.followUps 整批 admission/handback；单次模型广告冻结；Otari 凭据授权目录 | 公共原生队列 publication 路径分组并保留 ID/图片/隐藏伴随消息；任务模型仍由 native 授权；Otari 使用原生 auth/discovery。 |
| 18.18.5 | Fable/Mythos 5.2 目录、思考/模态/价格修正 | 从固定 native catalog 重生成，不在 TypeScript 另写模型名称策略或价格表。 |
| 18.18.6 | 未批准计划 pause 修复；后台浏览器输入、MCP/LSP 与 GC strip replay 修复 | 批准状态只在真正 approve 时写 metadata；pause/discard 不批准；其余 native 修复保留。 |
| 18.18.7 | 5h/weekly/Fable governing-window 兑券政策；LiteLLM Key/User USD 预算；可撤销退出 hook；Antigravity 风险 challenge | 账户窗口内编辑对应策略；两条 USD 预算独立对齐；操作者 quit 在 drain 前调用 confirmClose；登录警告与 yes 确认由原生 challenge 经 GUI 提问完成，不代答。 |
| 18.18.8 | 原生选项附注；Fable reset 修复；浏览器 relay / 下载、恢复与 auth-gateway 修复 | Form notes 附着到相关选择；embedded DownloadItem 链与外部 Chrome pageEvents 分开；原生恢复和账户语义保留。 |
| 18.18.9 | Sofya、HN keyless/site route、instruction files / skills 去重与 source markers；Smithery 退场 | 搜索供应商与原生凭据链；HN 不变为通用默认搜索；Context 完整分类/来源定位/caveat；无 Smithery live 入口。 |
| 18.19.0 | Browser string app / argv / target / insecure、WebKit 优先与安装；taskFile 删除、原生 steps / autoParallel；系统模板、Liquid Judge、Actions 步骤；blocked Todo 退场；Ask 当前值超时 | 统一同页 Browser/Dock；Single/Steps + 一个聚焦编辑器；模型角色内系统模板与 Judge；JobInspector 原生步骤；旧 blocked 恢复为 pending；稳定 FormSession 提交当前值。 |

## 完整 GUI 工作流

### 表单与计划

- HTML 只由原生 `parseHtmlForm` 解析为展示 DTO。React 渲染命名字段、题组、图示、Other 和选项附注，不把 Host HTML/SVG 注入 privileged DOM。
- snapshot / interaction event 只带摘要、字段数、题组数、timeout；正文走瞬时 `interaction.form.read`。输入、媒体、模板正文不进命令账本或全局 reducer。
- 表单折叠、放大、题组切换、Deck 移位和元数据更新不会重建输入；只有一个 Renderer FormSession 持有草稿与 inactivity timer。输入重置时间，超时提交当前 `{data, notes, timedOut:true}`，终态/代次/AbortSignal 拒绝迟到结果。
- 新 HTML 提问可原生重答。旧 questions 提问仍可回看，但不会被伪造为新 HTML 或改写历史文件。
- 真正批准计划写原生 `approvedPlanFilePath` metadata；未批准 pause、discard、普通退出不写批准。重建、压缩和继续保持批准语义。

### 任务步骤与委派

Agent Hub 提供 Single/Steps：紧凑有序 outline 和一个选中步骤编辑器，支持键盘增删、排序。所有用户步骤在一次 native spawn 中提交，保留一个 Agent/job 身份。超过四个步骤由 native 合为最多四组提示；只在 clean yield/final 后继续，error/abort/budget 停止，显式 restore 保留剩余组。

任务模型、effort 和 solution space 对整条任务生效，不新增每步模型配置。`task.steps` 广告与 `task.autoParallel` 在现有任务设置中呈现；选择一次 Steps 不修改全局委派策略。taskFile 的 live 输入已移除，旧 metadata 只读。

### 同一原生浏览器页面

新开默认“继承 CLI”，即 **不传 app**；不能用 `app:"auto"` 偷跳过 native relay 优先级。WebKit、Chromium、relay、CDP/可执行文件及 Studio embedded 都是明确的新开选择，不重建已登录页面。

native tab descriptor 决定实际 engine、owner、target、generation、display transport 与能力。嵌入页用 WebContentsView，原生页用同页 frame/原生控制；不会重新打开相同 URL 冒充同页。接管等待当前 native action，归还、隐藏、换源和关闭观察释放租约，不关闭 CLI 页；真正关闭遵循 native owned/borrowed 生命周期。

观察保持单帧 in-flight/ACK、像素/CSS 坐标与 IME fencing、代次/文档/lease 检查、有界 buffer 和可见性预算，不逐帧生成产物文件。原生窗口仅在平台提供同-view viewer 时出现。WebMCP 只对实际 Chromium 开放；WebKit 的完整 CDP、PDF、响应体和 tracing 限制在相应工具旁说明。embedded downloads 仍使用 Electron DownloadItems，不套外部扩展的限制。

### 模型、模板、搜索与账户

- `config.yml.systemPromptTemplates` 的 pattern→文件关联位于模型角色区。用既有 CodeMirror 编辑器读取/保存文件；最长匹配、来源、SYSTEM.md 覆盖、缺失/无效 fallback 与预览由 native builder 给出，不在 client 执行 Handlebars，不写成 models.yml override。
- Liquid 进入 Judge 凭据/角色与既有评测链，不伪装 chat API；Otari 使用凭据授权的 live roster。
- Sofya 可保存原生 search credential；当前 native 并不广告 Sofya `/login` provider，GUI 不伪造登录能力。HN 保留 keyless/site route。
- LiteLLM Key/User USD 预算与 Token/百分比窗口分开；未报告金额显示未知，不填 0。只读账户刷新不触发自动兑券；5h/weekly/Fable 只写对应 native governing key，不扩大旧确认范围。

### Context、Actions、维护与 Changes

Context 保留完整 native 分类与 caveat，但摘要只使用四组稳定身份色，并提供名称、数字、表格与次级形状。source markers 跟随脱敏、截断和分页，并直接定位 native entry，不重新估算 Skills 或重复计数。

Actions 复用原生 watch read model：当前步骤摘要、有序步骤、真实 state/duration 和关联日志。Job 与工具结果共用步骤组件；未知时间不估百分比，不增设 GitHub poller或解析 ANSI。

维护仍为 scan→preview→危险确认 apply。新增 strip 的 native idle days、范围、计数与 effect；strip 不被混为压缩或删除正文，也不硬塞入第五个旧存储 category。Changes 从 perFileResults 展示真正已应用文件/hunks/统计与部分拒绝提示，旧单 path/diff 仅作 fallback。

## 默认值与兼容边界

Native AgentSession/controllers/settings/catalog/task executor/GC 是唯一执行、政策与持久化 owner。Studio 的旧 cache warming、recap、worker idle TTL 软默认已退场；用户显式配置仍优先。仅保留 GUI 呈现、鉴权与托管 Runtime 生命周期必需的进程级适配，例如不让独立 CLI updater 修改托管签名版本。

旧 Runtime/旧交互保持明确兼容分支，旧 transcript 不重写。Web/SSH 无本机私有媒体通道时显示真实原因，不复制网页或伪造 capability。macOS/WebKit viewer、真实账号与六平台制品必须按实际设备及授权单列验收，不能用 fixture 宣称通过。

## 实际验证记录（本地 2026-11-13）

所有检查在专用工作树及隔离 HOME/agent/config/cache/data/TEMP 中运行。源头固定、四组接缝由 regen 生成，原生 addon 使用 Bun 1.4.4 / Rust nightly-2026-11-08 重建。没有使用旧 `.node` 或另一工作树的 workspace dist。

| 检查 | 最终结果 |
| --- | --- |
| Runtime 类型 | 5,214 个文件，零类型错误。 |
| 原生源码规范 | 完整 7,057 文件格式检查通过。既有 native lint warning 与 Windows linker warning 仍按实际输出保留，不宣称零警告。 |
| 核心队列/表单/计划/步骤/恢复 | 14 个 suite、145 项通过；涵盖当前值、附注、跨代次、整组队列、真正批准和停止/恢复。 |
| Bridge 生命周期 | 四个文件、55 项通过；重答取消、视图关闭取消、model auth dispose 与会话切换的实际服务契约已对齐。 |
| 真实 native worker 路径 | 九个并发原生 worker 的本地假 provider 测试通过，覆盖 conversation/approval/form/pause/BTW/job/cost/cancel；没有付费模型请求。 |
| Browser / downloads | 原生专项与 Renderer/Desktop 分片通过。Windows Electron embedded smoke 的 15 个场景全部通过，包括同一 WebContents 迁移、共享 CDP、下载、权限、崩溃恢复、真实 Runtime relay 和完整重启。原生 WebKit adapter 的单元证明不替代真实 macOS viewer 验收。 |
| Models/accounts/search/Context/GC/Changes | 原生相关分片与 Renderer 专项通过；模板隐藏重开/迟到正文、来源定位、USD/未知值、单 governing window、strip 预览/效果与只审核已应用的部分编辑均有回归覆盖。 |
| GUI 直接检查 | 专属 5191 preview 的真实组件检查完成：Form Other/notes/命名数值、折叠保留与放大 footer；模板编辑、预算未知值；Context source marker 跳到指令文件；Actions 状态/有序步骤/关联日志与两种呈现；GC strip 扫描、确认、过期和演示 apply；Changes 部分告警与上下/左右对照。检查了 marks-off、宽/窄、深浅主题、1.3× 字号和既有 L1 reduced-motion。fixture 只证明呈现与交互，不冒充后端结果。 |
| 干净检出与完整重放 | 独立固定提交、独立依赖的 `studio.9` 完整 overlay + 四组接缝重放通过；134 个原生测试进程，1,039 项通过、5 项 skip、零失败；CLI worker/分发 smoke 通过，检出恢复为 clean。skip 不计为通过。 |
| canary 制品 | Windows x64 **18.19.0-studio.9** 的同源 addon、二进制、`--smoke-test`、真实身份探测、manifest/checksums/Ed25519 签名通过；仅在工作树隔离目录安装/激活用于验收，不覆盖用户安装版。 |
| production | 完整 `check -- --production` 通过（195.1s）；最终 UI 修复后 production 依赖、Renderer、preload 与远端 Host 构建通过（84.8s）。架构、选择器、动效与 diff whitespace 检查通过；最后新增 QA 页的类型与 Actions/Changes 专项复验通过。 |
| 真实 Electron / Bridge | 隔离 Windows Electron + 签名 canary 的 **20 项检查全部通过**：真实认证握手/能力、Steps/委派 read model、Liquid/Otari 无凭据目录、原生模板关联/瞬时文件读取、单窗口策略写入、Context、strip dry-run、实际 Chromium descriptor、认证私有观察、单帧 ACK、同一 target/DOM/cookie 的点击与中文文本输入、隐藏无新帧、归还保留页面、显式关闭移除目标。零付费模型请求。 |

收尾时修复的实际问题包括：表单放大仅扩大内部、外壳仍受旧 420px 上限导致提交栏越界；Edge 的原生 CDP product `Edg/…` 漏识别导致 Chromium 能力误禁用；模板隐藏后重开锁未释放；隔离普通目录的手工 `.git` 发现与 Git 实际发现不一致。旧测试也已对齐 native `onUsage`、Context 元数据与继承默认值，保留取消/迟到/未执行部分的负向契约。

激活自检实测覆盖全部 native worker 图，健康冷启动可超过 60 秒；安装器默认预算调整为 120 秒并保留超时终止/隔离，Desktop 仍使用原有 240 秒预算。一次并行验收在 120 秒内未完成，未被算作通过；最终安装后自检在 Desktop 预算内通过。隔离 wrapper 同时移除了继承的供应商 endpoint/default-model 路由，未修改用户配置。

本地证明文件位于 `tmp/upgrade-proof/`（UI 截图、Electron report/screenshot）和 `outputs/browser-native-smoke/win32.json`，不进入版本控制。GUI QA 入口为 `form-18190-harness.html`、`features-18190-harness.html` 与既有 workbench/browser harness；关闭 preview 时显示真实未连接空态，不把 fixture 放到 Host。

### 明确未验证的范围

- 真实 macOS / WebKit viewer、其他操作系统及其 Runtime 制品；本机只验证 Windows x64。
- OS 级鼠标 shield 命中、实体中文 IME、原生文件拖放与混合 DPI dock 几何；程序化中文文本通道不等同于这些硬件验证。
- 真实账户登录（含 Antigravity 风险 challenge）、凭据授权后的供应商 roster/余额、实际兑券、付费模型与远端 CI/Release。
- 实体屏幕阅读器操作；accessibility snapshot、字段标签、状态文字与键盘行为检查不替代真实辅助设备验收。

本地提交按操作者单独授权执行；上述验收未推送或合并分支、创建 PR/Release、更新远程 Release 元数据或覆盖用户已安装 Runtime。所有隔离验证数据与制品均留在专用工作树。
