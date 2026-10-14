# OMP 18.10.4 适配记录

状态：功能实现和 Windows x64 本地验收已完成。用户随后授权发布 **Studio 0.1.10**，Windows x64 / ARM64 与 macOS Apple Silicon 的正式工件由原生发布流水线构建、验收后发布；[发布页文案](../releases/v0.1.10.md)和[流水线记录](https://github.com/the-snowpear/omp-studio/actions/workflows/release.yml)记录正式交付范围。

## 基线与目标

- Studio 基线：0.1.9，提交 `2c07600`。
- Runtime 基线：18.8.0-studio.20，`4ef97c8826ee012829a3e756b693a2a16a414f47`。
- 上游目标：正式版 18.10.4，`687892d1046ecaf18829b45f5b86928a308258f4`。
- Runtime：`18.10.4-studio.8`（初始本地候选为 `studio.7`）；本地开发验收基于 `0.1.9`，正式应用版本提升为 `0.1.10`。
- 补丁摘要：`sha256:d7e06b51304eaeef8d94be66599ce5d50994b59a27c0702b9677487d2e6dce6f`。
- Windows 工件：`packages/runtime-installer/dist/artifacts/win32-x64/18.10.4-studio.7/`，包含可执行文件、manifest、校验和与开发签名。它使用本地开发密钥，不是正式发行签名。
- 执行开始时重新确认了正式 Release；未采用 `main` 上尚未发布的提交。
- [完整上游比较](https://github.com/can1357/oh-my-pi/compare/v18.8.0...v18.10.4)，[发布说明](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.4)。
- 编辑前备份：`backup/2026-10-14/omp-18104-195615/`。旧 vendor 四组接缝及 overlay 与保存版本逐字节一致。

## 已确认的产品选择

全部接入本区间新增的 Studio 能力，扩展现有工作区，不增加顶级导航。子代理使用配置页中的模型链，取消单次启动覆盖。下一消息预测默认关闭；本地词语补全保留。账号凭据导入导出 GUI 暂缓。先完成 Windows 本地交付，随后用户追加 macOS 适配并明确授权 GitHub 发布；正式构建使用现有发布密钥，不使用本地开发签名。

## 从 18.8.0 到 18.10.4 更新了什么

此区间包含 17 个后续正式版本，上游比较记录 1,887 个提交。下表按发布版本概括用户可见变化与主要修复；链接指向每版完整的包级发布记录，包含未逐条展开的终端渲染、依赖和平台修复。

| 版本 | 主要新增与行为变化 | 主要修复 / 对 Studio 的影响 |
|---|---|---|
| [18.8.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.1) | 代理 OAuth 账号池；账号身份键列表；标题包含图标和短码；原生模块目录可配置 | 服务档位计费、OAuth 别名、目录刷新、图片保留、会话路径、停止与队列修复。Studio 增加账号池编辑，沿用原生限制 |
| [18.8.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.2) | 删除 task、eval agent、workpool 的单次模型覆盖 | 改善图片请求预算与过大请求恢复。Studio 启动子代理改为使用代理配置，并拒绝旧覆盖参数 |
| [18.8.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.3) | Claude Haiku 5.5 目录与推理支持；可重试 OAuth 刷新错误 | 临时刷新失败不再直接终止任务；重复打开原生模型面板得到修正 |
| [18.8.4](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.4) | 账号用量失效接口增加 provider 范围；Agent Hub 排序更稳定 | Cursor 登录续期和流结束、配额显示、模型选择优先级、缓存、长输出性能、会话模式重置等修复 |
| [18.8.5](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.5) | 按模型设置压缩点；账号发现与刷新接口变化；移除 `PI_SUBPROCESS_CMD` | 修复显式推理档位、子代理 LSP/账户继承、Windows lspmux、备用模型返回时机和停止状态 |
| [18.8.6](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.6) | 会话 Worktree 启动/退出策略；X 搜索与内容读取；考虑缓存窗口的裁剪 | Judge 角色链刷新、Advisor 角色、长会话缓存、配置热加载和已移除 Worktree 会话发现修复 |
| [18.8.7](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.7) | Git 保护、CoralBricks、按需语法下载、语音速度、标题卡改进、终端程序状态 | 浏览器下载目录、旧 relay 更新、录制临时文件、标题生成、取消后状态与内存修复；应用托管安装不由 CLI 自更新覆盖 |
| [18.8.8](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.8) | 匿名诊断导出、额外指令文件、后台作业取消；压缩数值改为基础窗口，`f` 前缀保留精确触发 | 压缩上限与小数百分比、跨模型恢复、浏览器后台页/启动超时/iframe、原生面板交互修复 |
| [18.8.9](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.9) | 多终端 fork；比例、前后对比、多指标图形增强 | fork 中未完成工具结果标记为结果未知；修复表格特殊文本处理。Studio 继承图形源码能力 |
| [18.9.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.9.0) | 下一消息预测、浏览器目标发现、扩展标注 API、回退条件、配额重置入口/到期提醒、智能图形 | 大量缓存、MCP、插件、账号池、浏览器、Computer、会话写入与重试修复；非交互自动兑换的上游变化不绕过 Studio 的既有确认策略 |
| [18.9.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.9.1) | Bedrock 可配置 Claude thinking-binding 兼容开关 | 改善不支持相关字段的网关兼容性；随原生配置/模型层继承 |
| [18.9.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.9.2) | NativeJudge；OpenAI Decisions、Cloudflare Workers AI 评判与问题分批；凭据工具接口调整 | 部分成功仍记录用量；修复评判问题数量限制、模型匹配、补丁应用、会话清理和长输出响应 |
| [18.10.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.0) | 会话 pack/unpack/moved、凭据 export/import、Ask 折叠；IPC 使用原生用户专属传输 | 共享 embedding 服务、RPC 停止和终端流式布局修复；Studio 接入会话迁移，凭据迁移 GUI 按用户选择暂缓 |
| [18.10.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.1) | Tern 的复制、Jobs、BTW、MCP 向导和上下文面板交互改进 | Studio 保持自己的工作台组织，复用对应原生行为，不复制终端布局 |
| [18.10.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.2) | 后台工具持续输出；任务默认返回文本，结构化结果可选；更多内置 Shell 命令 | Studio 原工具卡保留后台运行状态和取消结果；Anthropic 网关可禁用实验字段；会话树快捷键调整属于终端界面 |
| [18.10.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.3) | 图片 token/数量/字节预算、推理历史计数与模型规则增强；Muse Wonder 等目录更新 | 多项 API 移动和签名变化；修复多提供商图片限制、压缩预算与缓存复用，Studio 完成源码兼容 |
| [18.10.4](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.4) | 扩展可响应/重开 Plan 评审并选执行档位；闲置会话透明压缩；日期生效价格 | 移除 Codex Code Mode；修复跨模型压缩后的 Claude 拒绝、浏览器重启、历史成本和审批细节。Studio 的模型价格、评审、维护及设置同步适配 |

## 新功能在 Studio 哪里使用

| 入口 | 完整操作流程 |
|---|---|
| 模型配置 → 子代理 → 代理账号池 | 选择代理和提供商，设置不限制、仅所选 OAuth 账号或禁止该提供商；保留当前不可用的已配置账号，显示生效配置，不暴露令牌 |
| 模型配置 → 角色 → 模型压缩阈值 | 输入基础 token 数、百分比或 `f` 精确值；原生引擎预览实际窗口/触发点；开启扩展上下文先确认，空输入恢复默认 |
| 历史 → 迁移与导出 | 打包当前工作区的保存会话及工件；匿名诊断导出；选择目标工作区、检查归档、确认导入、打开导入结果。重连后能重新查询结果 |
| 历史 → 源副本已交接 | 在目标机器确认导入后单独标记源副本。须先离开被标记会话；以后恢复源副本遵循原生分支语义 |
| 诊断中心 → 会话与维护 → 存储压缩 | 扫描闲置文件、显示实际候选与活动会话跳过数、确认压缩、查看结果；一次最多审核 200 个文件，改变过的文件不沿用旧批准 |
| 设置 → 任务；Git 侧栏 → 管理会话 Worktree | 创建独立分支和目录、可选复制未提交修改、打开并创建会话；移除前检查活动会话、未提交修改和新提交，再按指纹复查 |
| 新建会话 | `worktree.onStart` 为 ask 时选择当前目录或独立 Worktree，为 create 时自动准备；第一条提示词受 Runtime 门控，不抢在目录选择之前执行 |
| Plan 卡片 / 展开评审 | 选择原生执行档位，保留全文/章节反馈及清理、压缩、保留上下文三种执行方式；GUI 与扩展共享评审 ID，陈旧/重复回应被拒绝 |
| Ask 卡片 | Hide/Show 或 Alt+H（macOS 为 ⌥H）折叠；保留回答、备注和附件状态，不将隐藏当作提交或取消。按物理键码识别 Option 组合，忽略输入法组合和长按重复事件 |
| 设置 → 交互 → 下一条消息建议 | 默认关闭；启用后在主会话回答结束、草稿为空时请求建议。Tab/右方向键只接受到草稿。费用使用原生统计，输入、切换或失焦会使旧建议失效 |
| 设置 → 上下文、任务、原生偏好 | 额外指令文件、回退条件、结构化任务、Git 保护、本地语音速度；显示保存范围和当前生效来源 |
| 评测 → 判断批次 | 从已连接的原生评判模型/聊天模型中配置 Judge；沿用已有批次创建、确认、取消、重试、部分失败和用量界面 |

真实模式只使用 Host/Runtime 数据。新面板均提供独立、带演示标记的 fixture；演示按钮不写 Host。桌面本地文件导入导出使用已授权的私有文件通道，远端 Web UI 没有该通道时明确不可用。

## 兼容性和实现边界

- 原有 Bridge 协议版本保持不变，新操作按能力协商使用。新增 feature-settings、session-portability、session-compression、session-worktrees 和 plan-review 契约，旧请求/返回结构不挪作新用途。
- 保留旧 Runtime Code Mode 字段的读取兼容；新版固定报告关闭并拒绝写入。`agent.spawn.models` 不再声明，带单次模型覆盖的旧请求明确失败。
- 账号池、压缩阈值、Worktree、会话格式和评判批次均调用原生实现。新增接缝仅暴露必要的审批、预检、导入保留策略和文件候选选择边界；所有 `.patch` 均经 regen 生成。
- Worktree 清理需要确认但桌面已退出、GUI 租约已释放时，目录会安全保留；可在退出前或重新打开后通过 Worktree 面板检查移除。没有将关机期间无法回答的确认自动当作同意。本机验证覆盖干净目录的自动退出清理。
- 完整迁移包和匿名诊断包用途不同；本地导入不覆盖同 ID 会话。文件内容有摘要校验，导入预检与压缩/Worktree 清理批准均有时效和状态复查。
- 后台输出按原生 jobId 绑定；仅保留有界的当前 Runtime 结果以支持重连。作业记录不再可验证时显示结果未知，不把旧的 running 记录当作已完成。
- 下一消息预测复用原生控制器、15 秒期限与用量记录；旧本地词语补全继续使用原来的私有通道。预测及 smoke test 的 Studio 配置不自动导入外部提示词历史。
- 共享浏览器的 detach 限制放在公共类型化服务入口，Studio 与 CLI/TUI 一致。现有观察、人工接管、Computer 和标注面继续使用原生行为；`ctx.annotations.open` 仍遵守上游明确限定的 TUI 主机边界。
- 凭据跨机器迁移 GUI 未纳入本次；0.1.9 的历史发行记录保留，0.1.10 使用新的安装包和版本化更新目录。

## 验证证据

过程日志位于未提交的 `output/omp-18104/`，截图和 Electron 报告位于 `output/playwright/omp-18104/`。

| 检查 | 结果与证据 |
|---|---|
| 全量 `npm run check` | 1,219 项 Node 测试通过，14 项平台跳过；Renderer 136 个文件 / 786 项测试通过。`root-check-final.log` |
| 0.1.10 发布前重验 | 统一版本后再次通过完整检查：1,219 项 Node 测试、787 项 Renderer 测试及 82 项元数据测试。`output/release-0.1.10/workspace-check.log`、`metadata.log` |
| 干净上游独立重放 | 4 组接缝、overlay 重放通过；101 个测试进程 / 824 项测试通过，格式、lint、类型及源码 CLI smoke 通过，验收目录恢复干净。`patch-replay-7.log` |
| 工件元数据门禁 | 81 项通过，包含 Windows / macOS 平台表、Mach-O、打包及审计契约。`metadata-2.log` |
| Windows Runtime | 原生构建、二进制 smoke、239 项能力协商与身份探测通过；签名工件已生成。`runtime-binary-7.log`、`runtime-package-7.log` |
| 隔离安装与回滚 | `18.8.0-studio.20 → 18.10.4-studio.7 → 18.8.0-studio.20 → 18.10.4-studio.7` 全程通过，未替换用户已安装的应用。`install-rollback-7.log` |
| Windows Electron | 29 项通过，0 次模型调用。覆盖私有会话包导出/导入/匿名化/同 ID 分支保留、真实与演示页面、Ask 附件、组合输入、Worktree 创建/移除/新会话选择/进入/退出清理。`electron-e2e-accepted.log`；报告 `output/playwright/omp-18104/electron-7-accepted/report.json` |
| Chromium 流式性能 | 18 项门禁通过：布局比 1.42（上限 2.5）、堆比 1.01（上限 1.25）、工具 DOM 比 1.00（上限 1.35）；最忙场景 p95 16.7 ms。`streaming-perf.log`，详细报告 `outputs/streaming-perf.json` |
| macOS 补充回归 | 快捷键和新功能测试共 13 项通过，私有文件通道 4 项通过，Desktop / Renderer 构建通过。POSIX 的 0600 / 0700 断言已加入，须在 Mac 执行。`mac-shortcuts.log`、`mac-file-grants.log`、`mac-*-build.log` |
| macOS CI | YAML 解析和 actionlint 通过。`macos-workflow-lint.log`；尚未声称已执行 Mac 原生构建 |

人工查看了迁移预检/完成、账号池选择、模型压缩点、Worktree 与存储压缩界面，覆盖中文/英文、明暗主题及 1280、1440、1920 宽度的代表性页面。截图示例：`transfer-review-dark-1440.png`、`agent-pools-selection-light-1280.png`、`model-compaction-light-1920.png`、`worktree-english-1920.png`、`compression-english-1920.png`。这不是每个页面与平台的穷举视觉矩阵。

## macOS Apple Silicon

新版能力沿用共享 Bridge、原生 Session 和桌面私有文件通道，未另建 macOS 功能副本。存储压缩继承上游 APFS 检测及压缩实现；不支持的卷会明确报告不可用。Worktree 沿用原生目录与 Git 实现；文件传输的 POSIX 权限进入回归测试。Ask 快捷键已修正 macOS Option 字符差异。

CI 增加 `workflow_dispatch → scope: macos-runtime`，使用 `macos-15` Apple Silicon runner（[GitHub 官方 runner 平台表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)）。执行源码/元数据测试、干净补丁重放、arm64 原生编译、Mach-O / codesign / Runtime 身份检查、签名工件安装，以及包含会话迁移和 Worktree 的 Electron 验收；此 scope 不运行 `pack:mac`、不生成安装包、不发布 Release。工件名为 `omp-runtime-darwin-arm64-development`，只携带开发工件及验签公钥；私钥不上传。

打包模式的 Electron 测试也已修正：目录选择、会话包选择和导出保存使用各自的隔离路径，避免把测试工作区误当成归档。正式发布选择 GitHub Actions 的 Apple Silicon runner，`include_macos=true`，与 Windows 两种架构共同通过门禁后发布。上表记录的是本机证据；Mac 原生结果以发布流水线的 `build-macos` 和 `release-gui-evidence-macos-arm64` 为准，不把 Windows 测试当作 Mac 验收。

验收不自动调用付费模型，不兑换真实重置券，不操作生产 Skillshare 或授权 IDA 数据库。模型推理、Plan 执行、预测付费路径使用替身验证生命周期；真实 Electron 验证签名连接、读写、文件传输与本机操作。macOS/ARM64 未在这台 Windows x64 机器上进行实机验证。CDP 中文组合输入测试不等同于人工操作物理输入法。

### 原生发布门禁发现并修复的问题

首轮发布（38592561039）在 Windows x64 和 macOS 的 Worktree 回归测试中发现临时目录别名导致归属误判，未发布任何工件。现在注册表、当前目录和 Git Worktree 清单均按 realpath 比较；无法解析的目录仍拒绝清理。回归测试在各平台主动创建目录别名，覆盖归属识别和审核后文件变化的保留行为。本地 7 项相关测试通过，Runtime 因此递增为 `18.10.4-studio.8`，正式工件重新构建；上表 `studio.7` 日志仍保留为初始验收证据。
