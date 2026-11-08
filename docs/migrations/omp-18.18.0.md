# OMP 18.18.0：Runtime 与 Studio 适配

本次从 **OMP 18.13.2-studio.44 / Studio 0.1.17** 升级到 **OMP 18.18.0-studio.48**，上游固定为 **v18.18.0**、提交 `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`。`studio.47` 完成首次双平台与六平台产物验收，合并前审查将 Runtime 推进至 `studio.48`，修正记录见文末。Runtime 的 Studio 修订号由 `omp:patches:regen` 生成，记录于 [`series.json`](../../omp-patch/patches/series.json)。Studio 产品版本和发布流程没有自动推进。

两个上游标签之间有 8 次发布、2,189 个提交、4,118 个文件变化。完整列表见 [v18.13.2…v18.18.0](https://github.com/can1357/oh-my-pi/compare/v18.13.2...v18.18.0)。下表按首次引入的版本归类；18.18.0 日志重复列出的部分 18.17.0 功能只计一次。包级细节以目标提交的 [coding-agent](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/coding-agent/CHANGELOG.md)、[catalog](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/catalog/CHANGELOG.md)、[ai](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/ai/CHANGELOG.md) 和 [natives](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/natives/CHANGELOG.md) 日志为依据。

## 逐版变化

| 版本 | 功能与行为变化 | Studio / GUI 的处理 |
| --- | --- | --- |
| [18.13.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.13.3) | 手动压缩开始/结束事件；429 后可立即走备用模型链；不打开历史会话即可重命名；Advisor 折叠行数；按 global/project 读取原始分层配置；`tools.xdevNotices`；Bun 最低版本升至 1.4.4 | 手动压缩进入现有进度与历史投影；历史页直接重命名；增加重试、Advisor 与挂载通知设置。分层写入保留原生来源与覆盖关系。 |
| [18.14.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.14.0) | `out://` 中途回复；`taskFile`；会话置顶；外部 WebRTC Live；Prewalk from/into；原生 WebMCP controller；精确 provider/model selector；Eval JSON 树；模型目录压缩，移除原始 `models.json` 导出；原生 rsync/ast-grep；Git Guard、启动及搜索改进 | 实时和历史均显示中途回复，任务继续运行；Agent Hub 增加任务文件；历史置顶；Web/SSH Live；Prewalk 模型设置；WebMCP 面板；bundled registry 生成模型目录；Eval JSON 可展开。 |
| [18.14.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.14.1) | 运行结束后压缩的队列入口；只读会话 lease 查询；按提示次数检查自动标题；Codex Daybreak Blue 开关；`reasoning_effort_map` 与 `reasoning_required`；Anthropic 图片请求预算提高 | 类型化压缩入队/取消/状态；历史占用信息；标题刷新、Daybreak 设置；模型发现与 reasoning 映射保持原生语义。图片预算由 Runtime 继承。 |
| [18.14.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.14.2) | 受配置授权的单次精确模型选择，项目只能收紧；`task.maxEffort`；Judge 备用候选超时；设置父层重载；Bash `PI_TOOL_CALL_ID`；Git Guard 与工具修复 | 从原生策略查询可选模型；传递精确模型和 effort，展示实际运行模型；补齐任务策略与 Judge 设置；保留原生审批和模型冲突规则。 |
| [18.15.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.15.0) | Modular Cloud；后台作业用途及一次性 caption；Eval 内核死亡后首个 cell 提示状态丢失；Snapcompact 重复压缩及非图像模型改善；无凭据时尝试备用链；修复压缩期间后台结果丢失、子 Agent 启动时漏任务、SDK 信号接管 | Modular 入口；作业用途/caption；Eval 用原生状态事件显示重启提示并保留输出正文。其余修复由 Runtime 继承。caption 继续受 `async.widgets` 和 `widget` 模型配置控制。 |
| [18.16.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.16.0) | Mistral Vibe 浏览器登录；Factory 模型及动态价格；Hindsight 全局记忆；BTW 注入；最多四条预测及无正文遥测；Bash 精简统计；Eval completion attempts；跨仓库 Review；恢复历史列表优化 | 登录和模型目录；全局记忆开关；BTW 每条回答的发送/重试状态；一次预测提供多候选，Tab/Right 只填草稿；精简字节和 JSON attempts；Review 原生仓库/PR/MR 选择。 |
| [18.17.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.17.0) | 子 Agent worker threads；Shell Raw/Pseudo、变量、层和回放；提示缓存状态；手动 Skills；Keenable；搜索失败供应商明细；Responses WebSocket；Anthropic message threads；Devin 登录；`^模型:档位`；`chillax`；语音依赖按需加载；ovnfs 自动使用；`edit.mode=none`；CLI 自动更新；TUI 动画和扩展 transcript presenter | 线程控制与跨线程交互；Shell 查看器；Context 缓存详情；设置/供应商/登录；Composer effort 标签；语音准备与重试。托管 Runtime 更新仍由 Studio 安装与验签负责。TUI 适用范围见后文。 |
| [18.18.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.0) | Shell trace 非 UTF-8 字节及中文长变量崩溃修复；任务文件审批绑定与空白保留；MCP OAuth、resource 及并发归属修复；浏览器重连；扩展模型跨线程序列化；Hindsight 持久重试；transcript、Shell、LSP 和会话恢复修复 | 采用原生 trace 解析；增加中文/非 UTF-8、任务文件绑定、worker 并发和历史身份回归。新的接缝保留上游修复。 |

## 已接入的产品能力

| 入口 | 行为 |
| --- | --- |
| Agent Hub / 子对话 | 原生 `AgentSessionHandle` / `AgentViewSession` 支持本地和 worker 代理；审批、Ask、暂停、恢复、终止、BTW、作业归属、费用与预算继续可用。任务文件的解析目标、来源和授权绑定来自原生 task 流程。 |
| Runtime 队列 | 压缩可在运行中排队，等当前工作让出执行权后执行；后续输入、图片和技能伴随消息保持顺序。压缩任务可取消；普通消息可编辑或提升为纠偏。取消、切换和显式恢复保留消息组身份。 |
| 历史页 | 不先启动目标会话即可重命名、置顶和查询占用。当前 Runtime 持有的会话由所属实例修改，包括 worker 子会话；外部持有的会话遵循原生 lease 规则。 |
| 对话 | `out://` 是中途正文，不结束任务；实时和历史保持顺序及身份。已声明显示的扩展消息作为扩展通知呈现；隐藏上下文、Advisor 和代理间通信不冒充助手回复。 |
| BTW | 仅本轮原生允许注入的回答出现入口。运行中 steer，空闲时 prompt；入队前失败可重试，成功接纳后不因模型失败重复发送。 |
| Composer | 一次原生预测最多四条候选；输入前缀选择匹配项，插入后可用 Tab 再选。只改草稿，Enter 选择菜单项不发送。旧单条通道继续可用。effort 模型标签使用原生解析。 |
| Context 卡及详情 | warm/cold、原因、保留期、缓存量、下一次重发量和保温状态；没有原生值时不填假数。 |
| Shell 卡 | 按打开和可见状态读取 `ShellVizPresentation`；Raw/Pseudo、变量、展示层、分屏和时间回放。解析与非 UTF-8 处理在 Runtime；关闭可视化时显示原因。普通对话事件不复制整份 trace。 |
| 作业 / Eval | 作业用途与 caption；Bash 精简前后字节和截断元数据；Eval 原生 JSON/table/Markdown views、内核重启和状态丢失提示，JSON 中的 completion attempts 可展开。 |
| 模型配置 | bundled registry 生成 4,963 个模型的目录；精确 selector、reasoning 映射/必需性、Responses stateful/WebSocket 字段；message-thread 与工具名前缀策略作为只读事实显示。Factory 图像回退、Codex 搜索与 Judge 的旧配置迁移匹配原生目标；Keenable、DeepSeek 的选择与凭证入口保持可用。YAML 预览与写入使用同一映射。 |
| 能力 / 设置 | Modular、Mistral、Devin、Keenable；任务模型授权、worker 上限、标题刷新、429 备用链、Daybreak、手动 Skills、Hindsight global、Judge 超时、Prewalk、新工具开关及 Spotlight 实验设置。 |
| 扩展 / Review | 注册链接通过类型化操作交回所属扩展；正文和工具结果仍由 React 渲染。Review 使用原生结构化 command handler 与仓库/PR/MR 选择流程。 |
| Live / 听写 | 本机桌面保留音频通道；Web/SSH 的浏览器持有麦克风、播放轨道和 WebRTC peer，账号与任务属于选定 Runtime。SDP 使用瞬时 query，不写命令账本。静音关闭麦克风 track；取消、切换、隐藏和断连停止音频。Live 与听写互斥。 |
| 本地语音准备 | 原生组件与模型准备进度、错误和重试；预测复用原生权重准备，不另造安装器。 |
| 托管浏览器 | WebMCP 直接调用原生 controller；工具绑定真实 page/document 身份，导航或重连后重新查询。可调用性取决于实际 Chromium 能力。 |

新增展示均有 Renderer fixture，遵守预览开关和 `marks`；预览数据不进入 Host、Bridge 或持久队列。原有停靠、会话隔离和能力协商继续生效。

## 原生继承与 TUI 适用范围

原生 Bash 5.3、rsync、ast-grep、Tokenizer、数据库/provider 性能、搜索取消、自动扫描缓存、Git Guard、Snapcompact、凭据回退、Hindsight 投递重试、MCP OAuth/resource/并发归属和扩展模型跨线程修复均随同一 Runtime 继承。

TUI 主题、彩色 Markdown、快捷键、motion/spinner/maxFps、scrollback 链接浏览器、终端 `omp zsh/bash/sh` 交互及扩展自定义 TUI 组件保持上游终端使用范围。Studio 保留 React 正文、现有主题和工作台快捷键；`registerTranscriptPresenter` 和 assistant-text 自定义组件不转换为 React。扩展语义工具、消息、链接和交互继续接入。

上游 `update.auto` 管理独立 CLI；Studio 托管 Runtime 的安装、验签、自检、切换和回滚仍由现有安装器负责，Studio host 不启动上游后台自更新。

## 接口与接缝

- 保留 Bridge/Host/transport 分层，只增加必要的类型与分发。新接口包括 `agent.spawn.options`、`session.lease.inspect`、`session.cache.get`、`shell.view.read`、`extensions.links.list/activate`、`browser.webmcp.list/invoke`、`session.compaction.enqueue/cancel/status`、`session.history.rename/pin`、`btw.inject` 和瞬时 `live.webrtc.*`。任务输入增加 `taskFile`、精确模型和 effort。
- Studio 跨线程交互挂到原生线程服务；worker 分配真实持久消息 ID，主线程不再强转远端 handle。显示身份元数据保留在 Studio 私有事件中。
- 手动/自动压缩共享等待及进度；Eval 用原生 status event 传递重启状态，不解析终端输出推断控制状态。
- 四组 `.patch` 都由 regen 生成，Studio 自有文件回收为 overlay。模型目录使用 bundled registry API；构建使用隔离 Bun 1.4.4 和 Rust `nightly-2026-10-06`。
- 恢复点为 `codex/backup-omp-18.13.2-studio.44-20261107`，开发分支为 `codex/omp-18.18.0`。其他工作流新增的文件查看器及未提交内容保留。
- 2026-11-08 收尾前另建 `codex/backup-omp-18.18.0-continuation-20261108`，并在 `tmp/omp-18.18.0-continuation/` 保存当时 78 个未提交文件的差异与文件副本；备份和测试产物均不提交。

## 默认值

保留用户显式配置与 Studio 原有软默认，其余采用上游值。worker 上限默认 4，第 9 个并发子 Agent 开始进入工作线程。回复详细度保持上游低默认；BTW 注入、多条预测、单次任务模型授权、Hindsight 全局记忆和 Spotlight 默认关闭。Daybreak 采用上游默认开启并提供关闭入口。`out://` 随 Studio 正文展示能力启用，显式 `out.enabled=false` 优先。

## 验证记录

源码、模拟服务与产物检查不代替真实账号和设备验收。

全量回归补齐了三处实际兼容问题：旧配置中的 Keenable / DeepSeek 搜索选择不再丢失，Codex Web 使用 `openai-codex/gpt-6-luna`，Judge 使用 `typesafe/jev-1.14.0`；压缩任务不再提供 Runtime 不支持的纠偏操作；远端 Host 的短 socket 目录按 46 字节的占用证明名称预留空间，避免 macOS 默认临时目录下启动失败。DeepSeek Search 是上游 18.12.2 已有的能力，本次补齐的是 Studio 入口与配置迁移。

JSDOM 的共享可见性替身、缓存读取、多项队列、WebRTC 条件和异步高亮回归与当前行为一致。完整多窗口流程测试使用该文件独有的 15 秒执行时限；安装器缓存回归检查并发读取只哈希一次，避免依赖异步执行时序决定的在途加入次数。CI 在打包工具检查前准备 Bun 1.4.4、Runtime 依赖和原生模块，供新版模型目录复现测试读取 bundled registry。

原生构建使用带 Studio 接缝的 Rust 源码，并保留构建前的受控类型声明；编译完成后还原管理的接缝和 overlay，再从干净上游基线执行重放。Windows 安装器同时修正 8.3 短目录名的运行中应用识别，以及 ANSI INI 在英文系统上丢失中文路径的问题；交接文件显式使用 UTF-16，回归覆盖 emoji 路径。

实际跨平台回归还修正了 Advisor 首次保存：创建 WATCHDOG 所在目录后再取得原生文件锁，避免 macOS 上 agent 目录尚不存在时保存失败。安装器按展开后的完整进程映像路径比较所属目录和程序名，覆盖程序以 8.3 短文件名启动的情况。该 Runtime 改动通过 regen 将修订号推进为 `studio.47`，四组接缝补丁内容保持一致。

| 检查 | 当前结果 |
| --- | --- |
| Runtime 类型与格式 | 全 workspace 通过；干净重放中 coding-agent 检查 5,108 个文件。 |
| 9 个并发 Agent | 实际 worker 路径通过：对话、Bash 审批、Ask、暂停/恢复、子会话重命名、BTW、job owner、费用上限、取消和退出清理。 |
| 压缩 / BTW / out | 针对性回归通过，覆盖图片伴随消息、切换后恢复、注入并发/失败/接纳、中文与 emoji raw delta、持久 ID 和历史重开。 |
| 模型 / 任务文件 | 原生 exact-model 7 项、task-file-approval 18 项通过；授权撤回、effort 上限及文件/链接替换保留原生行为。 |
| Shell | worker 回归通过中文、非 UTF-8 Bash 及原生 presentation；GUI 使用可见读取和 preview。 |
| WebMCP | 原生浏览器 12 项通过，覆盖调用、跨域 iframe、导航、取消与能力缺失；Studio preview 完成工具选择和调用。 |
| Eval | 原生 completion 58 项、kernel-restart 3 项通过；GUI JSON 分支展开和重启提示回归通过。 |
| 预测 | 一次请求最多四条、Advisor 后定位、编辑/重连不重复请求，以及 Tab/Right/菜单只填草稿的回归通过。 |
| WebRTC | 本机 Edge 的真实 peer 与测试信令端完成连接、静音、取消、切换和断连，使用合成音频。Chrome 156 在本机未产生 ICE 候选，已确认超时清理。 |
| 生产与全量 Studio 检查 | 产品源码提交 `73f5b55` 独立检出后，`npm run check -- --production --all` 通过：架构、选择器、全量编译、全部包与 Renderer 回归、Vite 生产包及远端 Host bundle。Renderer 为 237 个测试文件、1,667 项测试。后续多窗口文件时限调整通过该文件的完整回归。 |
| 打包工具 | 准备 Bun、Runtime 依赖与同源 Windows 原生模块后，隔离工作区的全部 110 项脚本测试通过；能力清单顺序修正后的 artifact 专项 19 项通过。 |
| 完整补丁重放 | studio.47 本地 Windows：121 个 suite、968 项通过、0 失败、5 项平台/原生 UI 跳过；macOS arm64 CI：121 个 suite、970 项通过、0 失败、3 项跳过。两者 CLI smoke 通过，checkout 恢复干净。 |
| Windows 产物 | studio.47 原生 Windows x64 CI 构建通过；下载到本地后，使用项目发布公钥验证 Ed25519 签名和全部 checksums，认证握手、快照 smoke、命令清单与优雅退出通过。身份为 `18.18.0-studio.47`，307 个能力的声明顺序与二进制哈希一致。 |
| 隔离提交 | Studio / Host 产品源码提交 `73f5b55` 独立检出并使用自己的 workspace 包依赖，完整检查通过；未包含另一工作流的文件查看器修改。CI / 测试时限修正为 `2961afe`，原生构建清理为 `6b9d07a`，安装器修正为 `c8fb309`。 |
| 原生 CI | [macOS arm64 full job](https://github.com/the-snowpear/omp-studio/actions/runs/42410033397/job/128515963221) 与 [Windows 独立 full CI](https://github.com/the-snowpear/omp-studio/actions/runs/42413586730) 均已完成并通过：生产检查、全部应用测试、原生模块构建、打包/更新工具测试及完整补丁重放。Windows CI 提交 `65a7675` 仅调整平台矩阵，产品源码与 `b6f5ec6` 一致。 |
| 六平台远端环境 | [studio.47 原生构建与环境验收](https://github.com/the-snowpear/omp-studio/actions/runs/42410036495) 全部通过：Windows、Linux、macOS 的 x64 / arm64；验证目标架构、签名、checksums、Runtime 身份及完整环境包。 |

2026-11-08 已完成 `studio.47` 验收收尾。macOS arm64 与六平台环境验收使用提交 `3edc0f6`；该次产品源码为 `b6f5ec6`，两者只相差背景视频可见性和多窗口流程两项测试的等待修正，产品代码、Runtime overlay 与接缝相同。功能索引已同步模型默认迁移与受原生授权约束的单次模型/effort 入口。

Windows 重放中跳过的项目为两项需要原生浏览器观察 UI 的检查、物理桌面截图、Unix 短 socket 目录回退和 Host 被杀后的 watcher 退出。WebMCP 的独立原生浏览器 suite 已单独通过；其覆盖不能替代上述原生窗口观察检查。

未以真实账户测试 Mistral/Devin/Modular 登录、付费模型、Hindsight 服务投递、Codex Live 云端或物理麦克风。Web/SSH 媒体仍需安全来源、权限及目标环境网络可达；实际远端账号与物理音频单列为覆盖限制。没有自动触发产品 Release 或替换用户已安装的 Runtime。

## 0.2.0 合并前审查

审查覆盖 Studio 适配增量、四组接缝、渲染数据流与 Runtime 读取生命周期，重点检查包体积、重复读取、回放开销和内存保留。修正使用现有瞬时 query 和原生解析，Studio npm 依赖、通用校验层及发布流程均未新增。此次 Runtime 改动全部位于 overlay，四份接缝补丁与 `studio.47` 相同，修订号由 regen 推进至 `studio.48`。

| 问题 | 修正 |
| --- | --- |
| WebMCP 选择工具后列表缩为单项，快速切换时旧元数据覆盖新选择 | 保留完整工具目录，复用现有请求序号，只接受当前选择的参数信息。 |
| 历史占用随搜索重复探测，并将读取写入命令账本 | `session.lease.read` 按真实目录读取，搜索只过滤 UI；占用集合使用 Set 查找。任务选项使用 `agent.spawn.options.read`。两个 query 与原有 command 名称分开，保留旧 command 的返回格式。 |
| Shell 每个回放步骤重新扫描会话、读取完整文件和恢复 native trace | 同一打开命令共用一次文件读取与一份原生回放对象；关闭、隐藏、切换来源和 Runtime dispose 释放。已从活动上下文移除的命令可从原会话文件回放。 |
| 慢回放请求仍按定时器持续入队，关闭的卡片也创建观察器 | 收到上一帧后再推进；只在展开时建立可见性观察器。 |
| BTW 注入记录间接保留整轮记录、图片和上下文 | 仅保留身份、回合索引与显示文本，发送、重试和历史状态沿用既有行为。 |
| Dock 测试结束后尚有保存定时器 | 测试退出前触发既有 pagehide 保存流程，产品 Dock 代码无需新增环境检查。 |

生产包对比使用 `0.2.0` 基线 `59185f6` 与审查后的源码。首屏统计 HTML 入口及其静态 JavaScript 导入闭包；每份文件采用同一 gzip 参数。

| 指标 | 0.2.0 基线 | 审查后 |
| --- | ---: | ---: |
| 首屏 JS 模块数 | 5 | 5 |
| 首屏 JS gzip | 955,876 字节 | 967,458 字节（+11.3 KiB，+1.2%） |
| 全部 JS chunk 数 | 29 | 29 |
| 全部 JS gzip | 2,661,743 字节 | 2,678,255 字节（+0.6%） |

新增回归覆盖 WebMCP 切换、目录过滤、慢回放帧与释放、活动上下文移除后的回放。连续三次回放只读取一次会话文件，关闭后再打开重新读取；预览与真实通道沿用同一 UI。

| 验证 | 结果 |
| --- | --- |
| Studio | 架构、选择器、全部 workspace 编译、全部 Node/桌面测试通过；Renderer 全量复验通过。最终窗口可见性改动另通过 ShellView 回归与生产检查。Vite、preload 与远端 Host bundle 均通过。 |
| Runtime 干净重放 | 独立 checkout 与自己的 workspace 依赖完成 Runtime 类型检查、122 个 suite、969 项通过、0 失败、5 项原有平台/设备跳过；CLI smoke 通过，checkout 恢复干净。 |
| Windows Runtime | 使用已验收且源码未变的同源 native addon，重新构建 `studio.48`；`--version`、`--smoke-test`、认证握手、命令清单、快照与优雅退出通过。身份为 `18.18.0-studio.48`，上游仍为 `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`。 |

此次审查保留原有真实账号和设备覆盖限制。六平台签名产物记录属于 `studio.47`；`studio.48` 的发行产物由后续发布构建按当前源代码生成。
