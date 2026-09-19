# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 应用内增量更新：桌面与 Runtime 共用 Ed25519 签名清单、防回退序号、HTTP Range 差分下载与持久化事务，后台准备后手动「重启更新」；Runtime 可独立更新并保留 Stable／Canary 通道；设置 → 高级提供上一桌面版本的准备与重启恢复；旧全机安装经一次性迁移安装转入当前用户目录。[设计与验收边界](docs/updates.md)。
- 接入 BTW 持久话题与追问、`^模型` 委派标签、Claude／Codex 会话导入，以及任务 effort／服务档位、视觉问答、TypeSafe 和默认关闭的推测读取设置；新增界面同时支持真实与预览模式。
- 展示 Advisor 独立费用、实际服务模型和生成速率，补齐结构化任务结果与 Parallel／Ollama Cloud 搜索配置。

- 模型配置页的 `models.yml` / `config.yml` 结构化预览改为随图形化表单实时变化：供应商名称、Base URL、API 类型、鉴权方式、自定义模型、模型 Override 与高级项改动都会立刻反映在卡片里，角色换主模型或 Thinking 也立刻更新 `modelRoles.<id>`，不再需要保存后重进。表单有未保存改动时卡片显示为只读并由表单驱动，未接管的字段（含未来新增键与注释）仍原样保留，保存路径与 host 写入语义一致。

### Changed

- Runtime 升级至 `18.2.5-studio.6`，迁移 pi-tui 拆包接缝、异步凭据及会话接口；`/delete` 保留 `/drop` 别名。[更新和验收报告](docs/migrations/omp-18.2.5.md)。

### Fixed

- 流式输出的工具链里，自动展开的尾部工具卡改为动画展开，不再直接跳变出现；运行中的卡片收起时仍同步卸载正文，不为看不见的过渡白渲染。
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

[Unreleased]: https://github.com/the-snowpear/omp-studio/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/the-snowpear/omp-studio/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/the-snowpear/omp-studio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/the-snowpear/omp-studio/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/the-snowpear/omp-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.0
