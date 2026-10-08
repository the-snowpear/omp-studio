# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.9] - 2026-10-08

### Added

- 浏览器侧栏观察 OMP 使用的同一标签页，支持实例与标签选择、实时画面、导航和显式排他接管；Computer Use 增加目标、权限、截图与停止入口。
- 评测工作区加入 Ratchet：原生输入、评分器和计划审批，隔离工作区运行、轮次与费用边界、keep/revert 结果及停止控制。历史加入 Archive / Recap，诊断加入完整会话导出、GC 清理预览和连接诊断。
- 模型配置加入原生预设、有效速度档位、缓存保温状态和账户登出；子代理显示单次模型、思考档位、候选链及父子关系。支持会话标题图标、短码和生成策略。
- 产物库与对话支持 SVG、Mermaid、数值图表，以及 OBJ、PLY、WRL、X3DV、STL、glTF / GLB、USDA 图形预览；解析、纹理与关联文件通过本地受控通道并限制资源使用。

### Changed

- Runtime 固定迁移至 OMP **18.8.0**（`18.8.0-studio.20`，上游 `4ef97c8826ee012829a3e756b693a2a16a414f47`），合并 0.1.8 已发布能力；保留单 AgentSession、类型化 Bridge、原生设置注册器和生成式四组接缝补丁。[迁移说明与验收边界](docs/migrations/omp-18.8.0.md)。
- 媒体按“生成 / 语音 / 产物库”，Agent Hub 按“代理 / 后台任务 / 服务”，评测按“模型基准 / 判断批次 / Ratchet”组织。能力中心细分 Skills、Skillshare、插件、MCP、模板、资源与 IDA。
- 新界面复用 Studio 样式变量、页签、确认对话框、状态和错误提示，补齐明暗主题、密度、中英文以及预览与真实数据的共同展示路径。
- 预测输入使用原生轻量本地引擎；草稿经过私有有界通道，旧查询接口保持兼容并共用学习语料、下载与清理流程。外部历史只在明确导入后学习。
- 未显式配置时，Studio 的缓存保温默认关闭；既有显式值和独立 CLI 配置保持原样。新版完整 Setup 是应用与 Runtime 更新的兼容基线。

### Fixed

- 队列编辑、移除、纠偏和中止恢复保留图片与隐藏附件上下文，重连先查状态，不自动重发可能重复计费的请求；保留 0.1.8 草稿取回接口。
- 模型缺失时保留当前会话，展示缺失模型并等待用户选择替代模型，不静默换模型。
- 修复媒体页隐藏后仍持有播放和图形资源、服务表单与状态布局、标注提示和来源详情、录制主题、英文等待徽标压住标题，以及人工文件选择超过普通请求期限后界面失步。
- 修复显式停止 OMP 自行启动的 Edge 时，启动进程已退出导致浏览器未关闭的问题；连接用户已有浏览器时仍只断开观察连接。
- 新增 IDA 管理接口与旧版查看/编辑接口分开能力声明；数据库操作保留原生身份和版本校验，并在写入及保存关闭前生成可恢复副本。配置审批统一生命周期，切换会话或释放服务时撤销旧审批。

### Validation

- 发布以代码、迁移、补丁重放、元数据、签名工件和原生平台门禁为准。Windows 打包界面的全部图形格式、接管和资源释放人工矩阵尚未全部完成；预览截图及单元测试不等同于完整实机验收。
- macOS 本轮保留现有 CI 与代码兼容审查，不宣称完成新的实机 GUI 验证。真实 IDA 环境、付费模型/媒体/Live/Ratchet 请求、生产 Skillshare 写入及重置券消耗未纳入默认验证。

## [0.1.8] - 2026-10-01

### Added

- OMP 18.4.4 GUI：Runtime 消息组队列、可靠草稿取回、Ask 图片、子代理 BTW、模型服务档位与配置审批、命名空间技能、分页资源、输入预测、Stats/Frustration、Benchmark 阶段和 IDA 面板。[功能说明](docs/gui-18.4.4.md)。

- macOS（Apple Silicon，macOS 13+）桌面：
  - `npm run pack:mac` 产出 ad hoc 签名的 `.app`、首装 `.dmg` 和应用内更新用 zip。内置已签名的 `omp` Runtime，并由 `audit-mac` 审计，任一项不符即失败。
  - 窗口外观：左侧红绿灯；原生菜单栏，同时保留窗口内菜单；⌘ 快捷键与符号标签。
  - 生命周期：关窗留在 Dock，点 Dock 重开；按需阻止 App Nap；关机与注销不被拦截；不在“应用程序”文件夹时提示移动。
  - 本机工具：导入登录 shell 环境，探测 Command Line Tools，终端以 login shell 启动；支持访达、VS Code / Cursor 打开；麦克风授权（TCC）有引导。
- macOS 应用内更新对齐 v2：
  - 整包 zip 按 blockmap 差分下载，新版本在界面就绪后才提交；
  - 新版本启动失败时自动换回上一版本，同一文件不再推送；
  - Runtime 独立更新照常可用，激活前核对代码签名。
- 发布流水线可选（`include_macos`）构建 darwin-arm64 候选。资产包括：
  - `OMP-Studio-<ver>-macos-arm64.zip` / `.dmg`；
  - `OMP-Studio-Runtime-<rv>-macos-arm64.zip`；
  - `updates-darwin-arm64.json`。

  Windows 资产名不变。

### Changed

- Runtime 升至 `18.4.4-studio.38`：Host 丢失时 Runtime 自行退出（macOS 父进程看门狗），Live 音频改用短 socket 路径，会话 telemetry 采用 macOS 路径规则。
- 标题栏按 Window Controls Overlay 的实际区域让位：修正 Windows 上右侧的过度留白，以及标题栏提示气泡被误翻到下方。
- 产品文案不再写死“Windows”，文件管理器名称按平台显示（资源管理器 / 访达）。

### Fixed

- 图片消息取回失败可按原 ID 重试恢复，Composer 恢复后确认清除，不重复插入或发送。
- macOS 首次预测先创建私有锁目录；紧凑窗口下 Ask 翻页、附件与提交操作保持可见。
- 精简重复构建、测试与工件门禁，保留原生、协议、签名和更新验证。Windows/macOS 实包 GUI 各通过 19 项验收；macOS arm64 为未公证的 ad hoc 签名版本。[验收记录](docs/integration-18.4.4-macos.md)。

- 导航守卫改挂到 `webContents`：此前挂在 BrowserWindow 上，实际从未生效。外部 http(s) 链接改由系统浏览器打开。
- 权限请求只对可信渲染页放行；打包版只信任随包公钥，开发用的环境变量覆盖只在未打包时生效。
- 模型配置解析 agent 目录的方式与 Runtime 一致。

## [0.1.7] - 2026-09-25

### Added

- OMP v18.3.0 的 Studio 控制面：Agent Hub 服务与判断批次、账户/额度/重置券状态、通用标注、模型种类与角色回退链、离线 Token 计数和模型基准。
- 媒体工作台支持图片/视频生成、录音与导入转写、文本转语音和 Live 实时语音；增加按工作区/会话管理的产物库、私有流式预览与显式导入/导出。Live 沿用同一 AgentSession，隐藏窗口或断开时释放麦克风，不自动重连。
- 真实 PTY 的 Shell 录制与 `.studiocast` / `.ompcast` 回放；能力中心增加原生提示词模板、MCP 启动状态和 Skillshare 查询、安装、发布、维护、令牌管理。远程写入先展示具体确认单，新令牌仅展示一次并手动复制。

### Changed

- Runtime 固定升级至 OMP v18.3.0（`18.3.0-studio.12`），同步模型种类、原生角色、按角色排列的回退链及旧版 web/judge 配置迁移。浏览器侧栏暂缓。[版本差异与适配范围](docs/migrations/omp-18.3.0.md)。
- Claude 重置券保留首次使用前询问，并通过 Studio 审批界面接收确认；默认不自动消耗。服务默认会话归属，保存不自动启动；删除会话默认保留媒体产物，级联删除须明确选择。
- 流式工具回放改为有界增量存储；后台对话按可见目标降低中间更新频率，恢复窗口立即补齐，审批与终态保持即时。
- 生产构建将代码高亮移到有界 Worker，保留即时显示的代码框；Mermaid 增加大小预算、串行队列、取消和缓存上限。开发模式保留旧高亮路径。
- 增加 Main/Host、Renderer、Runtime 本地数值性能日志和可重复基准；会话关闭后释放 Engine 发布快照及计数登记。维护与回滚见 [性能文档](docs/performance.md)。
- 会话切换时，运行工具卡在不可见的稳定阶段完成初始展开，避免正文淡入后继续移位；正常工具交接与手动展开动画保留。

### Fixed

- 对齐 OMP 新版 find/wait/process/agent 工具展示，非文件写入不再误入文件变更列表。
- 异步视频任务恢复时继续查询原任务，避免重复提交；会话切换、窗口隐藏或连接关闭时释放 Live 麦克风资源。
- 桌面 Runtime 冷启动与 Bridge 连接统一使用 30 秒期限，避免初始化尚未完成就提前超时。

### Validation

- 完成源码、补丁重放、Windows 原生 Runtime、隔离安装/回滚、Electron 媒体/PTY、本地安装包及流式性能验证。真实云端付费媒体、Live、判断/基准请求、Skillshare 生产写入与 Claude 重置券消耗尚未实测；具体范围见[验收报告](docs/migrations/omp-18.3.0.md#external-acceptance-decisions)。

## [0.1.6] - 2026-09-20

### Added

- 应用内增量更新：桌面与 Runtime 共用 Ed25519 签名清单、防回退序号、HTTP Range 差分下载与持久化事务，后台准备后手动「重启更新」；Runtime 可独立更新并保留 Stable／Canary 通道；设置 → 高级提供上一桌面版本的准备与重启恢复；旧全机安装经一次性迁移安装转入当前用户目录。[设计与验收边界](docs/updates.md)。
- 接入 BTW 持久话题与追问、`^模型` 委派标签、Claude／Codex 会话导入，以及任务 effort／服务档位、视觉问答、TypeSafe 和默认关闭的推测读取设置；新增界面同时支持真实与预览模式。
- 展示 Advisor 独立费用、实际服务模型和生成速率，补齐结构化任务结果与 Parallel／Ollama Cloud 搜索配置。
- 模型配置页的 `models.yml` / `config.yml` 结构化预览改为随图形化表单实时变化：供应商名称、Base URL、API 类型、鉴权方式、自定义模型、模型 Override 与高级项改动都会立刻反映在卡片里，角色换主模型或 Thinking 也立刻更新 `modelRoles.<id>`，不再需要保存后重进。表单有未保存改动时卡片显示为只读并由表单驱动，未接管的字段（含未来新增键与注释）仍原样保留，保存路径与 host 写入语义一致。

### Changed

- Runtime 升级至 `18.2.5-studio.6`，迁移 pi-tui 拆包接缝、异步凭据及会话接口；`/delete` 保留 `/drop` 别名。[更新和验收报告](docs/migrations/omp-18.2.5.md)。
- 本版是首个以 v2 增量更新目录发布的桌面版本：0.1.5 及更早的安装经签名迁移索引引导运行一次完整 Setup（旧全机安装同时迁移到当前用户目录），此后进入应用内增量更新流程。

### Fixed

- 流式输出的工具链里，自动展开的尾部工具卡改为动画展开，不再直接跳变出现；模型连续产出多个工具、链条从一张卡增长到多张卡时，前一张卡在原地动画收起、新卡动画进场，不再因子树重挂载瞬间消失。运行中的卡片收起时仍同步卸载正文，不为看不见的过渡白渲染。
- 主会话流式运行时 `/btw` 直接打开旁路历史；模型标签在回退、分支与消息恢复后保持可编辑。
- 会话流式期间点「新建会话」（同项目「＋」、顶栏新建或归档后新建）后发送的提示词不再被记入上一个会话的本地排队消息：`session.create` 回执落地前，输入框与排队条目的会话归属按新会话判定，提示词改为等待新会话创建后发出；该窗口内的草稿、侧栏当前行标记与临时标题也不再归到旧会话。

## [0.1.5] - 2026-09-13

### Added

- 支持按 Shell 退出码控制的 while/until 循环、类型化 Prewalk 重启及基于对话内容的自动命名。
- 增加 Plan 自动保存、配额重置等待与实验笔记式上下文设置（均默认关闭；实验上下文需重启 Runtime 生效，状态区明确区分配置值、生效值与待重启状态）。
- 模型配置页接入 Muse Code / Command Code，支持只读分时价格、长上下文定价区间与扩展上下文窗口展示。

### Changed

- OMP Runtime 固定迁移至 v18.1.18（`18.1.18-studio.5`），全面同步 overlay、接缝补丁与运行时身份校验。
- Windows 打包支持 `OMP_PACK_OUTPUT_DIR` 独立目录输出，保障发布工件审计隔离。

### Fixed

- 隔离 Agent 停靠后禁止复活与隐式发送唤醒，并正确展示嵌套仓库补丁。
- 优化重试等待期限及断流恢复重连状态；修复循环条件在暂停、取消、切换会话及 Vibe 激活竞态下的迟到提交问题。
- 模型能力适配真实图片发送策略，修复零价格被丢弃及固定价格覆盖继承动态费率的缺陷。

## [0.1.4] - 2026-09-06

### Added

- 签名更新资源发布：应用负载、完整 Setup、Runtime 四件套与更新索引统一通过 Ed25519 验签和 SHA-256 校验。
- Runtime canary 独立发现签名预发布资源，与稳定版分别记录更新序号；应用仍跟随稳定版。
- 建立正式发行签名身份，配置 GitHub release 环境，并记录密钥保管、发布与恢复流程。

### Changed

- Runtime 更新至 18.1.10 系列，并同步 Studio Bridge 扩展。
- tag 发布自动重建 Runtime；手动发布支持经过验证的应用负载和 Runtime 最低 Main 版本配置。
- 本版要求完整 Setup 升级，建立新的更新和恢复基线；已试用旧签名索引的安装请手动运行 Setup。

### Fixed

- 修复应用负载下载完成后取消或退出导致同版本无法重试的问题。
- 下载前检查客户端契约和 Studio 协议兼容性，不兼容时转为完整安装包。
- Runtime 候选版本激活后若无法恢复会话，自动尝试恢复上一版本与原会话。
- 修复更新取消测试在异步文件操作结束前清理目录造成的竞态。
- 修复 Windows 短路径或目录别名导致工作区内拖入文件被误判为外部文件的问题。
- 修复显式指定 Runtime 工件目录后仍混入其他扫描目录、导致安装版本选错的问题。

## [0.1.3] - 2026-09-04

### Added

- **系统托盘驻留与后台运行**：支持在关闭窗口时隐藏至系统托盘，维持 Host 与流式任务后台持续运行；提供托盘右键快捷菜单（打开/安全退出）、流式退出二次确认拦截与多实例唤起支持。
- **Explorer 文件「更多操作」菜单**：工作区文件树文件与目录行新增快捷操作菜单（⋯ 及右键），支持外部编辑器（VS Code / Cursor / Windsurf）打开、系统资源管理器定位、路径复制与「添加上下文」。
- **侧栏与文件树展开状态持久化**：侧栏项目折叠状态与 Explorer 目录展开层级自动持久化至本地存储，应用重启或刷新后自动恢复上次展开状态。
- **端到端流式渲染性能门禁**：新增 `npm run perf:streaming`（`scripts/streaming-perf-gate.mjs`），引入自动化 Chromium 环境与 CDP 性能指标监控，保障长会话生成时的渲染帧率与布局稳定性。
- **侧栏会话行快捷操作菜单**：侧栏每条会话行支持更多操作菜单（⋯ 及右键），提供重命名、Fork、Handoff、Compact、导出与归档等能力。

### Changed

- **流式对话渲染链路重构与性能优化**：
  - 时间线改用虚拟滚动（`@tanstack/react-virtual`）与行高跨挂载记忆缓存，显著提升长会话浏览与流式更新性能。
  - 引入增量式 Markdown 流式解析（`markdownBlocks`），支持块级语义切分与 Mermaid 图表渲染缓存。
  - 长输出文本采用分块懒布局（`content-visibility: auto`），抑制长输出期间的样式重算与布局开销。
- **网络搜索配置中心重做**：
  - 重构模型设置中的网络搜索面板，提供可视化搜索链拖拽排序、就绪状态实时预览与 23 款主流搜索引擎品牌图标接入。
  - 支持应用内直接录入与持久化 API 密钥，无缝衔接底层运行时凭证库；支持上游 OAuth 认证与环境变量说明。
  - 补齐 SearXNG、Exa 等搜索引擎的高级检索参数与配置项。
- **UI 动效与交互平滑化**：
  - 工具卡与批量链展开/折叠过渡动画在流式生成期间保持平滑。
  - 优化会话切换过渡效果，引入渐变淡出与骨架屏（Skeleton），消除切换会话时的版式突变与空白跳跃。
  - 全局统一「加入上下文」文案与中英文本地化翻译为「添加上下文」（Add Context）。
  - Agent Hub 列表展示统一按创建时间升序排列，避免流式更新时的列表位置频繁重排。
- **资源开销与生命周期调优**：
  - 空闲 Runtime Worker 驻留回收 TTL 从 10 分钟调整为 5 分钟，降低多会话驻留时的常驻内存占用。
  - 优化小地图（Minimap）流式同步与滚轮事件，合并 rAF 写入批处理，消除高频布局抖动。

### Fixed

- **流式视口跟随与滚动抖动**：修复新消息发送瞬间与长输出时的列表跳动问题，统一跟底写入逻辑，避免用户手动上滚浏览后被强制拽回底部。
- **界面高频重渲染与自持循环**：消除应用内图标在更新时的重复 innerHTML 解析，修复 Composer 尺寸折叠监听导致的无效 rAF 循环。
- **恢复任务进度胶囊 (Task Progress Dock)**：恢复输入框上方的实时 Todo 任务追踪与当前轮次文件改动（Diff）预览面板。
- **「回到最新」悬浮按钮体验**：悬浮按钮固定定位至输入框右上角，支持用户手动脱离底部后快速跳转并自动显隐。
- **子代理停靠与用量统计**：修复子代理在 Park 停靠后用量统计显示归零与计时器异常爬升的问题，正确保留最终用量与耗时。
- **跨会话切换历史显示**：修复切换会话或组件重新挂载时 Transcript 偶发闪空的问题。
- **轮次中止时工具结果丢失**：修复在轮次被用户手动中止时已完成工具调用结果丢失的问题。

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

[Unreleased]: https://github.com/the-snowpear/omp-studio/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/the-snowpear/omp-studio/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/the-snowpear/omp-studio/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/the-snowpear/omp-studio/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/the-snowpear/omp-studio/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/the-snowpear/omp-studio/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/the-snowpear/omp-studio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/the-snowpear/omp-studio/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/the-snowpear/omp-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.0
