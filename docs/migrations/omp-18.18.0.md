# OMP 18.18.0：Runtime 与 Studio 适配

本次从 **OMP 18.13.2-studio.44 / Studio 0.1.17** 升级到上游 **v18.18.0**，固定提交为 `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`。Runtime 的 Studio 修订号以 [`series.json`](../../omp-patch/patches/series.json) 为准，由 `omp:patches:regen` 生成。Studio 产品版本和发布流程没有自动推进。

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
| Runtime 队列 | 压缩可在运行中排队，等当前工作让出执行权后执行；后续输入、图片和技能伴随消息保持顺序。取消、切换和显式恢复保留消息组身份。 |
| 历史页 | 不先启动目标会话即可重命名、置顶和查询占用。当前 Runtime 持有的会话由所属实例修改，包括 worker 子会话；外部持有的会话遵循原生 lease 规则。 |
| 对话 | `out://` 是中途正文，不结束任务；实时和历史保持顺序及身份。已声明显示的扩展消息作为扩展通知呈现；隐藏上下文、Advisor 和代理间通信不冒充助手回复。 |
| BTW | 仅本轮原生允许注入的回答出现入口。运行中 steer，空闲时 prompt；入队前失败可重试，成功接纳后不因模型失败重复发送。 |
| Composer | 一次原生预测最多四条候选；输入前缀选择匹配项，插入后可用 Tab 再选。只改草稿，Enter 选择菜单项不发送。旧单条通道继续可用。effort 模型标签使用原生解析。 |
| Context 卡及详情 | warm/cold、原因、保留期、缓存量、下一次重发量和保温状态；没有原生值时不填假数。 |
| Shell 卡 | 按打开和可见状态读取 `ShellVizPresentation`；Raw/Pseudo、变量、展示层、分屏和时间回放。解析与非 UTF-8 处理在 Runtime；关闭可视化时显示原因。普通对话事件不复制整份 trace。 |
| 作业 / Eval | 作业用途与 caption；Bash 精简前后字节和截断元数据；Eval 原生 JSON/table/Markdown views、内核重启和状态丢失提示，JSON 中的 completion attempts 可展开。 |
| 模型配置 | bundled registry 生成 4,963 个模型的目录；精确 selector、reasoning 映射/必需性、Responses stateful/WebSocket 字段；message-thread 与工具名前缀策略作为只读事实显示。YAML 预览与写入使用同一映射。 |
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

## 默认值

保留用户显式配置与 Studio 原有软默认，其余采用上游值。worker 上限默认 4，第 9 个并发子 Agent 开始进入工作线程。回复详细度保持上游低默认；BTW 注入、多条预测、单次任务模型授权、Hindsight 全局记忆和 Spotlight 默认关闭。Daybreak 采用上游默认开启并提供关闭入口。`out://` 随 Studio 正文展示能力启用，显式 `out.enabled=false` 优先。

## 验证记录

本节在最终验收后补齐实际结果；源码与产物检查不代替真实账号和设备验收。

| 检查 | 当前结果 |
| --- | --- |
| Runtime 类型与格式 | 全 workspace 通过，coding-agent 检查 5,107 个文件；后续测试调整由干净重放复核。 |
| 9 个并发 Agent | 实际 worker 路径通过：对话、Bash 审批、Ask、暂停/恢复、子会话重命名、BTW、job owner、费用上限、取消和退出清理。 |
| 压缩 / BTW / out | 针对性回归通过，覆盖图片伴随消息、切换后恢复、注入并发/失败/接纳、中文与 emoji raw delta、持久 ID 和历史重开。 |
| 模型 / 任务文件 | 原生 exact-model 7 项、task-file-approval 18 项通过；授权撤回、effort 上限及文件/链接替换保留原生行为。 |
| Shell | worker 回归通过中文、非 UTF-8 Bash 及原生 presentation；GUI 使用可见读取和 preview。 |
| WebMCP | 原生浏览器 12 项通过，覆盖调用、跨域 iframe、导航、取消与能力缺失；Studio preview 完成工具选择和调用。 |
| Eval | 原生 completion 58 项、kernel-restart 3 项通过；GUI JSON 分支展开和重启提示回归通过。 |
| 预测 | 一次请求最多四条、Advisor 后定位、编辑/重连不重复请求，以及 Tab/Right/菜单只填草稿的回归通过。 |
| WebRTC | 本机 Edge 的真实 peer 与测试信令端完成连接、静音、取消、切换和断连，使用合成音频。Chrome 156 在本机未产生 ICE 候选，已确认超时清理。 |
| 生产检查 / 完整重放 / Windows 产物 / 原生 CI | 集成验收中；最终结果在交付前补充。 |

未以真实账户测试 Mistral/Devin/Modular 登录、付费模型、Hindsight 服务投递、Codex Live 云端或物理麦克风。Web/SSH 媒体仍需安全来源、权限及目标环境网络可达；实际远端账号与物理音频单列为覆盖限制。没有自动触发产品 Release 或替换用户已安装的 Runtime。
