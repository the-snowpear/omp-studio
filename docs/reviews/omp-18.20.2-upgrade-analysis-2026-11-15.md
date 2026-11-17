# OMP 18.19.0 → 18.20.2：升级与 Studio／GUI 适配分析

日期：2026-11-15。**本文件是升级前分析，不是迁移完成或验收通过记录。**

本轮只获取正式版本源码、核对净变化、干跑现有接缝并分析 Studio 接入。没有切换当前 vendor、更新版本固定、重生成补丁、构建／安装新版 Runtime，或执行真实登录、付费请求。Studio 产品版本仍为 0.2.0。

## 一、结论

- 上游最新正式版是 **18.20.2**；GitHub Release 与 npm 一致，查询时 upstream main 也正好指向该版本。
- 仓库声明的比较基线是 **18.19.0-studio.10**。中间有 **18.20.0、18.20.1、18.20.2** 三次正式发布，没有另一个 18.19.x 发布区间。
- 这不是简单换版本号：现有接缝涉及 144 个文件，其中 66 个被上游修改，24 个文件不能直接 `git apply`。但四组补丁的三方合并预检均通过，**形式上的迁移不需要从零重做 Runtime fork**。
- 仍有必须处理的语义／接口变化：Seance 旧参数、Advisor 工厂接口、模型缓存的多策略读取、凭据作用域目录、托管 ACP 分类与就绪、语音 provider 接线，以及部分 Host 自执行操作没有继承原生修复。
- 最值得补到 GUI 的新能力是 **选择性 `/commit`、新的辅助请求政策、暂停 Provider 的显式恢复、Antigravity CLI 就绪状态、指定账户 Benchmark、流式分叉与富文本有序粘贴**。现有电脑状态和 generic 扩展选择器也需要补全。
- **18.20.0 变更日志有撤回、重复和版本归属错误。** 本报告以两个正式 tag 的最终源码差异为准，不据此要求重做 HTML Form、Steps、Actions、WebKit、Liquid 或 secrets 格式迁移。

## 二、“当前版本”需要分开看

| 层面 | 本轮读到的实际状态 | 如何解释 |
| --- | --- | --- |
| Studio 主仓库 | 分支 `0.2.0`，产品版本 `0.2.0` | 不需要因为 OMP 升级而自动改变 Studio 产品版本 |
| Gitlink、upstream.json、series.json、已保存 overlay 身份 | `18.19.0-studio.10`，`04cd1a7549a02d62ad1d24826198d52507595683` | **本报告的源码比较基线** |
| 活动 vendor HEAD／package.json／Bridge 身份 | `18.18.0-studio.1`，`b5a6b2f7e5b6606b6562e678ead83f21738f34a0` | 活动检出尚未与主仓库保存的 18.19 适配同步，而且有未提交改动 |
| 本机默认 profile 的 current.json | `18.13.2-studio.44` | 只是该目录的激活记录；没有读取正在运行进程的认证 Hello，**不能据此断定当前窗口使用此版**，也不覆盖其他 profile／开发预览 |
| 最新正式版 | `18.20.2`，`7c49c11aa5bbaf3f418406583096168ad5b8c6dc` | 只在独立分析检出中获取，未激活 |

固定记录见 [upstream.json](omp-patch/upstream.json)、[series.json](omp-patch/patches/series.json) 和 [Bridge 身份](omp-patch/overlay/packages/coding-agent/src/studio/bridge-server.ts:26)。

**下一轮升级不能直接覆盖当前脏 vendor，也不能把活动 18.18 当作已完成的 18.19 基线。** 应先保留并核对未回收改动，再从主仓库保存的 overlay／接缝重建新版。当前构建包装器已经检查 source／identity／series 一致性；按其条件，现有错位状态会先被拦住，而不是可靠地产出新版包。

### 正式发布范围

下表发布时间使用北京时间；commit 数包含 merge，不代表独立功能数。

| 版本 | 发布时间 | 固定提交 | 相对上一正式版 commits |
| --- | --- | --- | ---: |
| 18.20.0 | 2026-11-13 07:40 | `c308970263ae13744ea15ab67302e3dac840e266` | 614 |
| 18.20.1 | 2026-11-15 01:29 | `b7fe8c7f43c378faa0863e79f5509f9dde16ad9a` | 549 |
| 18.20.2 | 2026-11-15 04:08 | `7c49c11aa5bbaf3f418406583096168ad5b8c6dc` | 3 |

整个区间：**1,166 commits，其中 913 个非 merge；982 个净变更文件，60,918 行新增、9,697 行删除。** 大量是上游实现、测试、生成数据和合并历史，不能把这些数字等同于 Studio 必改代码量。

来源：[完整比较](https://github.com/can1357/oh-my-pi/compare/v18.19.0...v18.20.2)、[18.20.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.20.0)、[18.20.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.20.1)、[18.20.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.20.2)。

## 三、正式版本之间真正更新了什么

以下按用户工作流归并净变化，不逐条抄 1,166 个提交。日志中不成立的条目另见第八节。

### 18.20.0

| 领域 | 新增／变化／修复 | 用户能感知的影响 |
| --- | --- | --- |
| 模型与 Judge | 新增 Gemini Decision 1、Nace Drex judges；Google／Vertex／Zen／OpenRouter／Vercel／Kilo 增加 Gemini 4 Hydrogen；Google transports 支持 Hydrogen 的 `xhigh` | 更多判别模型与模型／思考档位；Judge 不是普通聊天 Provider |
| Find | 新增 `find.verifyModel`、`find.hitThreshold`；后者未配置时保持 0.2 | 可单独选择段落验证模型、调整命中阈值；不等于替换所有 Find 排序用的 Judge |
| 编辑政策 | 新增默认开启的 `encourageEdits` | 可决定是否要求通过 edit 工具修改文件 |
| Benchmark | `omp bench --account` 可指定 OAuth 账户，priority 被拒不再误报成功 | 性能比较和账户排错更准确 |
| SSH 发现 | 列举／补全支持 OpenSSH `Host` 与 `Include` | 更完整地识别既有 SSH 配置；不意味着 Studio 应重新建另一套 SSH 连接器 |
| LSP | OMP 默认接管服务器注册的文件监听；支持外部更改、目录迁入迁出、Windows watcher、Linux watch-limit 降级和网络盘溢出恢复；`watchFiles:false` 保留服务器 watcher | 减少陈旧诊断、重复监听和监听风暴 |
| Shell | 后台任务、子 shell、命令替换保留启动时变量、参数、函数、别名、选项快照 | 后台与前台命令环境更一致 |
| 编辑／搜索 | 修复 hashline PUT 边界、格式化后 edit 输出、归档 JSON 查询、NUL／二进制 grep、控制字符、脚本诊断、工具别名和 yield 解码 | 真正的文件改动、输出和搜索定位更可靠 |
| 会话／协作 | 修复 MCP 重复载荷、直接回复等待丢失、子代理误完成 todo、worker inline extension 警告；没有 formDialog 的 Ask 回退保留上下文与 checkbox | 原生工具和多代理行为更稳定；Studio 完整 HTML Form 主链不需要换协议 |
| 模型请求／费用 | 修复冷缓存发现、Codex 兄弟账户等待、账户 apiKey 使用、fallback revision、稳定 context-hook 下 Anthropic cache；Advisor／Sharpshooter 失败退避 | 减少错误切换、重复尝试和缓存浪费 |
| 浏览器 | Chromium eval globals、四种 selector wait state、跨导航等待、隐藏元素 hover、浏览器／cmux timeout 与取消恢复修复；观察不再仅截到 100 项，加强密码遮蔽和参数处理 | 页面操作和观察更准确，超时／取消更可控 |
| 响应性／小包 | secrets 的字面量 gating／缓存优化；Snapcompact 分阶段让出事件循环；Mnemopi 不再把小数、价格和 IP 误作版本事实；Spotlight 多路径 read 按一次调用处理，`:raw` 保留原文 | 长会话更顺畅，搜索与记忆结果更准确 |
| Computer／平台 | `typeText/axType` 返回 `{unconfirmed, focusReturn}`；Windows typing／modifier／focus hand-back 修复，macOS StaleRef／键盘／密码／Secure Input 修复，Linux AT-SPI／Qt／X11 修复 | 输入是否确认、焦点是否归还更真实；原生 addon 需要同源重建 |
| SDK／网关 | OAuth resolution 提供真正请求用的 apiKey，LoopGuard 支持 exemptionAlias，Snapcompact 新扫描类型；scoped client token 不能控制上游 headers、计费归属和 transport | 原生接入和网关边界收紧，不能继续依赖被禁止的字段 |

### 18.20.1

| 领域 | 新增／变化／修复 | 用户能感知的影响 |
| --- | --- | --- |
| **选择性提交** | 新增 `/commit`、逐代理 change journal、selective Eval `commit` 流水线；支持指定代理／子代理、其他仓库、二进制、非 UTF-8、symlink、mode、初始提交与 `no_verify`；由 `commit.enabled` 控制 | 只提交归属目标代理的修改，保留用户和其他代理的工作。旧 `omp commit` 和 commit 包不是本次首次出现 |
| **辅助请求政策** | 新增 `--no-judge`、`--no-spotlight`、`--offline` 与 `models.noJudge/noSpotlight/offline` | noJudge 限制 Judge 到活动 provider；noSpotlight 限制 Spotlight 到活动 provider；offline 应用两者并限制相关自动／子任务路由。**不是断网，也不是无条件关闭所有 Judge／Spotlight** |
| **暂停旧 Antigravity OAuth** | `google-antigravity` 默认暂停；保存登录保留；`auth.unpausedProviders`／SDK 显式恢复，项目配置不能自行解禁 | 需向操作者解释“凭据存在但暂停”，不能自动替他们接受风险 |
| Bash 权限 | path-scoped allow rules、项目／overlay prepend、`bash.allowedEnvVars`、每规则 `env`；复合命令逐段展示允许／待审批信息 | 权限范围和审批摘要更清楚；仍由原生整体执行、判定授权 |
| Todo／TTSR | todo 批量 done/drop/rm 与计数；`todo.midRunNudges` 支持 off/capped/backoff；每规则 `repeatMode` 支持 once/after-gap/always | 减少长轮次遗忘，控制提醒频率 |
| 扩展／模型继承 | 新增 `session_clear` hook／event；子代理继承模型时保留 `@upstream` provider pin；顶层扩展与 worker inline 继承语义更明确 | 清上下文和子任务绑定更准确，不需要换一套 AgentSession |
| 输入／历史 | 原生富文本粘贴转 Markdown、图片保留原位置；Ctrl+R 单条 prompt 删除；扩展链接主题色、BTW Branch 等 TUI 呈现改进 | 其中输入转换与 prompt-history 是 React GUI 的新增能力，不能仅升级 Runtime 就宣称已支持 |
| 分叉 | `/fork` 与 transcript fork 先中止活动回复，再立即分叉 | 原生 TUI 的新工作流；Studio 当前 busy 禁用仍在，需有序接线才能跟上 |
| 搜索／Spotlight 默认值 | grep 上下文默认 0／0，多文件每文件上限 20→10、单文件 200→50；Spotlight thinking low→med，常重读源内容更完整 | grep 更省输出；Spotlight 默认更深入，也可能增加请求费用。上下文配置键本身不是新键 |
| 模型／目录 | Chutes 原生登录与发现；Antigravity Hydrogen 合并为可选四档 thinking 的单模型；Google／Vertex Argon、Carbon、Hydrogen 输出上限 262,144；更新 Command Code 价格、Go Haiku thinking、Devin CLI 身份 | 目录、有效参数和价格必须从原生重生成，不在 Studio 手写模型策略 |
| Provider 修复 | Gemini 长回答跨 segment 续写；Vertex API／签名、Bedrock 区域／中断、Cursor roster／context、OpenRouter 按 key 缓存、reasoning replay、MiMo 区域、Perplexity 登录、配额恢复、Judge 重试、stop/frequency-penalty | 更完整的回答、更准确的上下文／账单、较少无效重试 |
| 会话／后台任务 | Loop 遇 provider 错误暂停；晚到 ACP 结果留到下一 prompt；删除／移动目录恢复、fallback thinking 恢复、server compaction fallback、快速新文件编辑 LSP 修复 | 不反复重发、不启动不可见轮次，恢复更可靠 |
| 删除／隔离任务 | 删除会话尽力清 history／recap／title／stats／子代理记录；ACP 删除不生成空白后继；隔离 merge-back 按仓库串行，保留原未提交修改和基线 commits | 删除更完整，隔离任务回并更安全。Studio 的 Host 自执行删除需要单独对齐 |
| 等待／WebKit | 连续且单独的 wait 可直达 **240 秒**；ABKit 固定 0.1.1，修复 plain-HTTP cookie，保留 dev／较新／其他应用管理的安装 | 少空轮询，更可靠的 WebKit 登录；不是第一次新增 WebKit |
| Native | `lsTree()` 返回 `{path,mode}[]`；commitCreate 增加 indexPath/expectedHead/noVerify；ovnfs 原生搜索、fd 并发／网络遍历、mount 边界，以及 binary patch、worktree、SVG 字体、Shell timeout、cp／test 修复 | 新提交工作流和原生操作更可靠；不能继续使用旧 addon 冒充新源码 |
| 展示／小包 | Markdown checkbox、iTerm2 resize、tmux 动画、IRC 展开、resume 滚动修复；Stats 时序／回答计数／本地日期、Spotlight worker 重建；Collab guest rejoin 状态恢复；Wire 附件 blob；不估算未发送 thinking 费用 | TUI／Stats／协作稳定性改进，不等于新增整个 Collab 或自主质量循环 |

### 18.20.2

核心新增是 **独立的 `antigravity-cli` Provider，使用 `antigravity-acp` API 和官方 `agy acp`**：

- 托管下载 agy、SHA-512 校验、版本路径和最多每日更新检查；可用 `PI_AGY_PATH` 指定已有程序。
- Google 登录、可刷新／分发的隔离凭据、host tools、跨工具步骤与历史变化保留会话。
- Gemini、Claude、GPT-OSS 目录；模型按原生支持选择 thinking，**GPT-OSS 不是任意档位，原生固定 medium**。
- 运行 ACP 仍需 PATH 上的 **`nc`（netcat）**。登录流程不检查 nc，因此“登录成功”与“能发对话请求”不是同一件事。
- 不等于恢复被暂停的旧 `google-antigravity`；两者是不同 Provider／传输。
- 同版另缩短主代理、Advisor、Live 的部分提示词约定说明；没有依据把它扩写为新的通用修复大版本。

原生 agy 平台映射包含 Windows／macOS／Linux／Android 的 x64／arm64 与 Linux musl 判断；本轮没有验证各平台远端 manifest 和实际二进制。Studio 产品目标仍是 Windows、macOS Apple Silicon，其他平台主要涉及其远端 Host／Runtime 制品，不据此扩张桌面支持承诺。

原生证据：[新 Provider 提交](https://github.com/can1357/oh-my-pi/commit/c3b7bed169)、[binary 管理](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/providers/antigravity-cli/binary.ts)、[ACP 启动与 nc 检查](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/providers/antigravity-cli/host.ts#L775-L801)。

## 四、Runtime 适配：本轮实际检查结果

### 接缝干跑

在独立干净 18.19.0、18.20.2 检出分别检查当前四组接缝；未修改活动 vendor。

| 接缝 | 目标文件 | 上游同文件改动 | 普通 apply 失败文件 | 18.19 基线预检 | 18.20.2 三方预检 |
| --- | ---: | ---: | ---: | --- | --- |
| 0001 CLI／配置／入口 | 13 | 9 | 1 | 通过 | 通过 |
| 0002 Session／任务／持久化 | 35 | 12 | 4 | 通过 | 通过 |
| 0003 Modes／Pause／Jobs | 19 | 3 | 0 | 通过 | 通过 |
| 0004 SDK／工具／媒体／Native | 77 | 42 | 19 | 通过 | 通过 |
| **合计** | **144** | **66** | **24** | **四组通过** | **四组通过** |

另检查 **296 个 overlay 文件**：没有与上游文件路径碰撞，也未发现丢失的相对 import 路径。

这些结果只证明路径／补丁文本能否落入源码。**没有证明所有导出符号、方法签名、可选参数行为、worker、native addon 或 GUI 兼容。** 三方预检通过不等于已完成适配、编译通过或产物可用。

### 已定位的接口与语义事项

- **生产 overlay：Seance 的 `includeGlobal` 已移除。** [现调用](omp-patch/overlay/packages/coding-agent/src/studio/services/seance-service.ts:34) 仍在 object literal 传旧字段；[新版签名](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/task/seance.ts#L110-L153) 已无该字段、全局短 ID 查找无条件执行。静态确认需要修正，不是新增一层校验。
- **测试／SDK：`advisorTools` 从数组改为 `AdvisorToolFactory`。** [现有 export 测试](omp-patch/overlay/packages/coding-agent/test/studio-session-export-native.test.ts:30) 仍传数组。新版每个 Advisor 使用独立工具 slate，不能为兼容旧接口重新共享有状态工具。
- **语音：新增 active-provider getter 是行为依赖。** 可选参数可能不造成类型错误，却使保留的 Studio 固定配置与 offline 政策不一致；见下一节。
- **新提交：Slash 返回 `{prompt}` 不是新契约，但新 `/commit` 使用了它。** 现有 GUI 路由只消费 output/toast，升级后会暴露原有结果处理缺口。
- **原生 ABI：** typeText/axType 的结果、lsTree 的 entry 对象、新 commit options 与平台接口要通过同源 addon／二进制验收。对 Studio 自有 overlay 和 Desktop 的直接调用检索未发现 lsTree/typeText/axType 调用；未逐一审完全部原生消费者，不能虚构一批 Studio Git 重写任务。
- **会话边界：** 保留新 transcriptEpoch、session_clear、stale Eval kernel release、后台结果 admission、正确的退出所有权、topLevelExtensions／worker inline 继承语义；不要用旧 Studio 接缝覆盖这些原生修复。

Bun 最低／固定构建线仍是 **1.4.4**，Rust 仍为 **nightly-2026-11-08**；本轮未发现必须升级这两条工具链的净变化。Cargo 主要扩展既有平台依赖的 features。新源码仍需重新安装对应锁文件依赖、构建同源 native addon，并产出带 Studio Bridge 的签名 Runtime；**下载官方 omp 二进制不能替代 Studio Runtime 构建**。

## 五、Studio／GUI 需要适配的地方

优先级含义：P0 为升级底座／数据正确性；P1 为现有入口修正或高价值新功能；P2 为可后续补全的交互。不是本轮实施授权。

### P0：底座与读取正确性

| 事项 | 现状与具体风险 | 下一轮落点 |
| --- | --- | --- |
| 固定版本／活动检出错位 | 主仓库保存 18.19，vendor 仍为 18.18，直接覆盖会损失未回收工作 | 保留差异，重建新版；统一 gitlink、upstream.json、series、两处 UPSTREAM_COMMIT／版本常量、目录 provenance |
| 接缝／SDK | 24 个普通 apply 拒绝，且 Seance 参数、Advisor 工厂等不能只靠三方文本合并 | 在 vendor 修源码，再用 regen 生成四组接缝；不手写 patch |
| **模型缓存多策略** | 新缓存主键是 `(provider_id, materialization_policy)`，最多保留三个策略，freshness／authority 在侧表。Host 仍 `SELECT ... WHERE authoritative=1`，不筛策略、不合并 freshness | 改 [getAvailable](packages/host-client-api/src/omp-models-adapter.ts:1656)，优先使用原生有效、凭据作用域快照；不能把所有版本行混作当前真值 |
| **OpenRouter 授权目录** | 原生已按 key＋endpoint 隔离且 authoritative；Studio 内置目录仍 `credentialScoped:false`，过滤还固定取 BUILTIN_MODEL_CATALOG | 重生成原生目录并修 [过滤边界](packages/host-client-api/src/omp-models-adapter.ts:2162)；在线推荐目录刷新不能替代这项修正 |
| **Provider/API 分类** | 无 preset 的 Runtime provider 在 [providersFromAvailable](packages/host-client-api/src/omp-models-adapter.ts:1170) 默认成 openai-completions，普通 probe 拼 HTTP /models | 托管 ACP 必须独立、真实分类。`antigravity-acp` 不在 models.yml ApiSchema，不能简单塞进 HTTP 下拉再保存 |
| **Google Decisions 探测** | 有效 YAML API 为 google-decisions，原生用 x-goog-api-key；Host 现有探测分类可能发 Bearer | 对齐执行服务中的探测和认证分类；Nace 的 nace-systemone 也需正确呈现为 Judge |

缓存混读风险来自静态源码比较：有共存旧／新策略或不同凭据缓存时，可能展示旧能力、价格、可用状态。**不代表原生 Runtime 会越权派发请求。** 证据：[原生 cache](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/catalog/src/model-cache.ts#L80-L137)、[OpenRouter scope](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/catalog/src/provider-models/cache-provider-id.ts)、[Studio catalog](catalog/model-catalog-v1.json:111837)。

### P1：需要修正现有接入、补到 GUI 的功能

#### 1. `/commit`：不是补一个菜单就完成

真实 Composer 与能力中心已合并 Runtime manifest，**新 `/commit` 会进入真实菜单**；preview 仅用静态目录，不会自动新增。功能索引中的静态 slash 说明落后于当前实现，下一轮应同改索引。

成功路径是原生生成 `{prompt}` → overlay 转交 result → Desktop 保留 result → GUI 只读取 output/toast。静态推断：可能显示“已执行”，但未开始提交工作流。

必须补原生命令结果的消费语义，不要把 `/commit` 文本发给模型或操作 TUI。需要独立操作面时，可复用既有 Git／Changes 的壳，但**归属、提交单元与预览来自原生 change journal／draft**，不能从 transcript diff 猜“哪些是某个 Agent 的工作”。应区分主代理／指定子代理、保留他人更改、预览实际提交范围、显式确认；no_verify 不能静默开启。

原生 Eval commit namespace 已能经现有 Eval 卡承载，所以没有 Commit 专属 ToolBody 不意味着不可执行。旧普通 Git 提交保持 Host 自有操作，不另建提交执行器。

证据：[真实菜单](apps/renderer/src/workbench/WorkbenchCanvas.tsx:506)、[传给 Composer](apps/renderer/src/workbench/WorkbenchCanvas.tsx:2623)、[忽略结果的处理](apps/renderer/src/workbench/WorkbenchCanvas.tsx:2063)、[overlay invoke](omp-patch/overlay/packages/coding-agent/src/studio/services/command-manifest-service.ts:151)、[原生 selective 目录](https://github.com/can1357/oh-my-pi/tree/v18.20.2/packages/coding-agent/src/commit/selective)。

#### 2. 模型政策、暂停与托管 Provider 就绪

- 新增 models.noJudge/noSpotlight/offline 的有效值、来源与说明。当前 Studio 白名单／设置行未接；**不能把 noJudge 文案写成关掉所有 Judge，或把 offline 写成断网。** 路由限制由 Runtime 执行，Renderer／facade 不重复预检。
- 旧 google-antigravity 显示“凭据保留但暂停”、原生原因及显式风险恢复。普通 enabled/disabled 不是 unpaused；项目不能自行恢复，读取或登录不得自动代操作者接受风险。
- 新 antigravity-cli 显示托管安装／登录／运行就绪的区别，包括缺 nc 的准确原因。本机分析 shell 的 PATH 上 **nc 和 ncat 均未发现**；未查询所有 Desktop／SSH 的实际 PATH。nc 缺少会在选择此 Provider、进入 ACP startTransport 时失败，**不是所有 Runtime 启动都失败**。
- 原生 OAuth provider 名单和 onAuth/onPrompt 通道已经动态接入，Chutes、Nace、Antigravity CLI 不需要再维护一份登录 provider-ID 白名单。
- GUI 当前登录等待 360 秒，原生 CLI 登录可到 600 秒；需对齐等待、取消与生命周期，避免界面先报结束而 Runtime 仍在登录。
- 新模型、Judge、价格／限额从固定原生 catalog 重生成。补 google-decisions／nace-systemone 的 API／快捷凭据呈现，保持 Judge kind／角色，不当作普通聊天表单。
- 新 CLI 没有对应内置账户 usage adapter：显示未知，不能借用旧 Antigravity 配额，也不能把目录零价格当作免费承诺。

落点：[feature 白名单](omp-patch/overlay/packages/coding-agent/src/studio/feature-settings-protocol.ts)、[NativeModelAccessPane](apps/renderer/src/models/NativeModelAccessPane.tsx)、[useModelAuth 超时](apps/renderer/src/models/useModelAuth.ts:69)、[RuntimeCredentials](apps/renderer/src/models/RuntimeCredentials.tsx)、Host 模型适配与构建／供给链。

#### 3. 语音：固定配置也必须遵守活动 Provider 限制

新版 STT 在 offline 下依赖 getSessionProvider。纯原生 resolver 缺 getter 会筛空；Studio 保留的固定配置分支先取 configuration.model，却总在 [准备语音](omp-patch/overlay/packages/coding-agent/src/studio/services/live-audio-service.ts:465) 只传 sessionId／configuration，不传 provider。

按新版代码与现有分支静态比对：本地路径最终拒绝启动；云路径可能先开始录音，但上传前仍会拒绝。**没有证据声称已经跨 Provider 上传。** 下一轮要接入活动 provider，并使 inspectDictationConfiguration 的可用性、配置身份与固定配置遵守同一原生政策，而不是只修类型或把 UI 报为 ready。

#### 4. 恢复／删除／流式分叉

- **已删除／移动 cwd：** 原生可在当前目录恢复，但 Studio resume.prepare 仍返回保存的 selected.cwd，Desktop 启动前拒绝缺失目录。必须区分历史记录 cwd 与操作者选定的有效执行 cwd；不能宣称跨工作区恢复已经自动继承。落点：[session-worktrees-service](omp-patch/overlay/packages/coding-agent/src/studio/services/session-worktrees-service.ts:205)、[runtime-session](apps/desktop/src/runtime-session.ts:1403)。
- **删除 native 索引：** 上游删除清 history／recap／title／stats 等；Host 自己 unlink/rm，Desktop 清 Studio telemetry／绑定／租约／pin，尚未接原生 purge。已有 native 索引行的会话从 GUI 删除后可能留统计／记忆残留。需要把原生索引清理纳入既有删除流程，不在 Host 再复制一套 Runtime DB 政策。落点：[SessionDeleteService](packages/studio-host/src/session-delete-service.ts:150)、[原生 purge](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/session/session-db-purge.ts#L168-L183)。
- **流式 fork：** 新能力在原生 TUI controller 中先 await abort、再 fork；底层 fork 并不会自动中止。Studio 服务和菜单仍拒绝 busy。若跟进，应实现有序中止→settle→分叉及正确 rebind，**不能只删 guard**。旧 idle fork 并非因为此次升级坏掉。落点：[ForkService](omp-patch/overlay/packages/coding-agent/src/studio/services/fork-service.ts:17)、[菜单](apps/renderer/src/workbench/menus.tsx:288)。

#### 5. 电脑面板的真实安全／可用状态

普通 Computer 工具文本会继承 Secure Input 警告，但 Studio 面板丢弃 secureInput／secureInputApp，仍只把 quartz 当检测可靠，Esc 显示只看 globalEscape。

新版 Windows 已有 WTS／input desktop 的锁定、断连、安全桌面识别。GUI 应展示 **effective Escape、Secure Input 持有应用、输入未确认／焦点归还**，并拆分锁屏可靠性与休眠未知；不能继续笼统说 Windows 完全无法检测，也不能把 displayAsleep:false 当作已证实醒着。Native 是实际控制／安全状态 owner，不把原生权限开关交给假 capability。

落点：[computer-workspace-service](omp-patch/overlay/packages/coding-agent/src/studio/services/computer-workspace-service.ts:358)、[ComputerWorkspace](apps/renderer/src/computer/ComputerWorkspace.tsx:203)、[原生警告](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/tools/computer/protocol.ts#L75-L77)。真实 macOS Secure Input／Windows 锁屏与焦点行为未在本轮设备上验收。

#### 6. 新增设置／Benchmark

- find.verifyModel、find.hitThreshold、encourageEdits、commit.enabled、todo.midRunNudges、Bash path/env 规则与 TTSR repeatMode 需要进入既有设置／配置编辑表面；新键当前未入 Studio 已支持白名单。不要为每个小开关新建独立页面。
- grep.contextBefore／After 是既有键默认改成零；Spotlight 的现有原生读值可继承 med，但说明／演示不要留 low 或错误费用预期。
- Benchmark 指定账户不仅是 UI 选框：上游 --account 是 provider 内的一基 OAuth 账户位置，使用结构化 apiKey。Studio BenchmarkSpec、评测转换和裁剪 registry 都未接，需要同步契约、Runtime 注入、账户选择及既有付费确认。priority 拒绝的结果可沿现有失败投影继承。

落点：[BenchmarkSpec](packages/studio-protocol/src/contracts/benchmarks.ts)、[benchmark-service](omp-patch/overlay/packages/coding-agent/src/studio/services/benchmark-service.ts:157)、[evaluation-workspace-service](omp-patch/overlay/packages/coding-agent/src/studio/services/evaluation-workspace-service.ts:54)、[原生 bench](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/cli/bench-cli.ts)。

### P2：可在底座完成后补全

| 表面 | 现状 | 建议边界 |
| --- | --- | --- |
| 富文本粘贴 | 原生 TUI 转 Markdown 并保留图片位置；ChipComposer 优先文件，否则只 text/plain，测试原先明确剥 markup | 安全转换、文本／图片有序落位，保留代码纯文本和现有附件流程；不是普通粘贴坏掉 |
| prompt-history 单项删除 | 原生 HistoryStorage 有 delete；Studio 没有对应输入历史 read model | 可补输入历史列表／单项删除，不等于历史页删整个会话；不复制 Ctrl+R 按键宏 |
| generic 扩展 select | Remote UI 仅传 title/options，丢 initialIndex、selectionMarker、checkedIndices、markableCount | 补真实选择状态与交互 DTO；这是选择器兼容债，不是 HTML Ask 主链不可用 |
| 提交／设置的高级操作面 | 现有 generic Eval 结果可以显示，但无完整归属选择和提交单元编辑 | 按需要补原生 read model 的操作面，不从日志、ANSI 或 transcript 重造执行状态 |

所有新增读表面必须同时有真实／preview 数据；preview 独立 fixture、marks 控制演示标记，不能用空真值偷偷回退 mock，也不能让演示按钮操作 Host。

## 六、可以沿原生继承，不需要重做 GUI 的部分

前提始终是接缝正确刷新并完成新版 Runtime 验收。

- **HTML Form／Ask：** 已有 parseHtmlForm DTO、Other／附注／上下文块、单一 FormSession 当前值超时与迟到 fencing。此次主要是无 formDialog 的宿主回退修复，不需要第二次换协议。
- **Steps／委派、Plan 批准、Actions 步骤：** 都已在 18.19 适配；继续一次原生 spawn、真实批准 metadata、真实步骤／时间／日志，不新建任务执行器。
- **Context／Agent 用量：** Studio 已分开累计账单 tokens 与 native contextUsage。上游 usageContextTokens 修复可继承；没有发现需要把现有字段重命名或重新估算上下文的证据。
- **清上下文／Eval 生命周期：** resetSessionContext 已走原生边界，session_clear、transcriptEpoch、stale kernel release 不需要新按钮或把内部 epoch 塞进全局 reducer。
- **Browser：** 新开继承 CLI、不传 app，真实 target／代次观察保持；等待、取消、密码、ABKit 0.1.1 沿原生实现。不要再做“新版 Browser”壳、重新打开同 URL 冒充同页。
- **Changes／GC：** 已消费真正成功的 perFileResults／hunks；格式化后结果修复、共享 collectGc 清理可继承，不重做 Diff／维护页。Host 自执行 session.delete 则另见前节。
- **MCP／Skills／扩展发现：** SDK-wrapped 内容去重、短 Skill 简介、身份发现修复沿原生处理；不要把配置目录库存当已加载真值。
- **Provider 请求／配额／预算：** Gemini 分段、Vertex／Bedrock／reasoning／配额窗口修复在原生 transport、ranking、refresher。Studio 已保留 USD 与未知值，不复制请求编码或自动兑券政策。
- **通用工具展示：** ToolKind／toolName 是 string，ToolBody 有 fallback；新工具能经真实协议展示。不因“没有专属卡”误判不可执行，也不因“能显示文本”误判完整操作面已接好。
- **TUI 专属：** Ctrl+O、终端 theme、iTerm2／tmux 修复、Tern Surface 及按键本身不必搬成 GUI／按键宏。

## 七、建议下一轮讨论的实施范围

**建议先完成升级底座与现有入口的正确性，再补高价值新功能，不同时重做所有页面。**

- 第一层：处理 vendor 错位／保留现有工作；固定正式 18.20.2；刷新四组接缝；修 Seance／Advisor 等接口；对齐模型缓存、授权目录、Provider/API 分类；同源 native 与签名 Runtime 跑通。
- 第二层：修 `/commit` 结果消费、语音 provider／固定配置、恢复 cwd、native 删除索引、登录超时与 Computer 状态；这些不是仅加文案或 fixture 能完成的。
- 第三层：补选择性提交操作面、辅助政策／暂停恢复、托管 ACP 就绪、Judge／Benchmark 账户、流式 fork；富文本和 prompt-history 等交互可按需求后续补。

实现时继续 CLI-first：Runtime 控制执行／政策／持久化；新增 query/command 只扩类型、facade 与实现，输入校验在真正执行层一处；不新增结果／事件校验器，不通过 slash 文本、ANSI、PTY 或按键宏控制。新的正文／提交预览／媒体保持瞬时，避免把大正文塞回命令账本或全局 reducer。

### 实现后的验收重点（本轮未执行）

- 模型缓存：旧／新策略共存、freshness authority、不同 OpenRouter key／endpoint、无当前凭据时目录真值。
- `/commit`：真实菜单调用确实启动原生工作流；preview 对应入口；主／子代理归属、他人修改、二进制／mode、HEAD 改变时的原生拒绝。
- 身份／恢复：缺失 cwd、跨工作区 resume、流式 abort→fork、清上下文／切会话释放 Eval、后台 delivery 不开启不可见轮次。
- Provider／语音：缺 nc、仅安装／仅登录、取消／超时、offline 同 provider、本地／云 fixed configuration、无 usage 时诚实未知。
- 删除：既有 native DB 行与子代理索引、Studio 自有残留都处理；不在分析或验收时动用户真实会话。
- Computer：Secure Input、effective Escape、Windows 锁定／安全桌面、输入确认／焦点归还。fixture 证明显示，真实设备证明 OS 行为，两者不混算。
- 局部 GUI 使用既有 harness／真实组件，按改变的当前表面针对性检查；不把全部页面、演示 fixture 或性能基准加进默认门禁。

检查仍走项目既有入口、按范围切片。Runtime 专项只在升级相关时跑；例如：

```bash
npm run runtime:verify-source
```

```bash
npm run omp:verify:patches
```

```bash
npm run check -- --only studio-host
```

```bash
npm run check -- --only host-client-api
```

```bash
npm run check -- --only renderer
```

完成适配后再做生产构建、同源 Windows x64 制品／认证 Bridge／worker smoke；macOS、其他 Runtime 制品、真实 OAuth／ACP／账户额度单列实际证据。发布不重复跑一套额外源码门禁，提交／推送／发布仍需另外授权。

## 八、不能按日志安排的“假新增／假迁移”

| 容易照日志误判的内容 | 最终源码核对 |
| --- | --- |
| Rust secret regex、四词占位符、provenance 存储、旧会话必须重开 | 发布前被 [53dd4c6a31](https://github.com/can1357/oh-my-pi/commit/53dd4c6a3192d2934a195a4158c444ce2a6b1935) 撤回；最终 compileSecretRegex 仍 new RegExp、buildPlaceholder 仍 `$$…$$`。不要限制用户现有 JS regex 或安排该格式迁移 |
| WebKit 默认／自动安装／可视窗口、原生 Tern DOM、Liquid Judge | 18.19 已有；本次是后续修复和 ABKit 0.1.1 管理，不从零重做这些表面 |
| task.file/taskFile、blocked todo 删除；Steps／autoParallel | 基线已有，不计为此次 Added／Removed |
| Ask HTML／timeout、Actions 步骤、Windows session-save 优化、Nix AppleFM、read 描述按需加载、edit selector | 基线已有；不能用当前日志重复排一期迁移 |
| 整个 commit 包、Collab、autoresearch／goal／autoqa 全新 | 基线已有；新增是 selective `/commit`。Collab 有修复，没发现此次新增一套自主质量循环 |
| wait 直接 5 分钟 | 最终实现是 **240 秒／4 分钟** |
| ACP 删除空白后继修复属于 18.20.0 | 实际提交在 18.20.0→18.20.1 区间，按 18.20.1 归类 |
| `{prompt:string}` 是新的 Slash 返回协议 | 该契约基线已存在；新 `/commit` 暴露现有 Studio 消费缺口 |

核对函数：[最终 regex](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/secrets/regex.ts#L7-L20)、[最终 placeholder](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/secrets/placeholder.ts#L379-L385)、[wait](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/tools/wait.ts)。

## 九、本轮完成与未完成

**已完成：**

- 保留并读取两层工作区状态；核对 Gitlink／pin／series／overlay／活动 vendor 版本与默认 profile 激活记录。
- fetch 上游 refs／tags；独立干净检出正式 18.20.2 和 18.19 基线；再次确认 latest 仍为 18.20.2。
- 核对相关 package 日志与重大净源码变化，识别日志撤回／基线重复／误归版，并补录 wait、ABKit、native DB purge、Wire 等日志遗漏。
- 四组接缝普通／三方预检、overlay 路径与相对 import 检查；只在独立分析目录操作。
- 比对 Studio／Host／overlay／Renderer／contracts／已有测试，区分直接继承、必须修正、新 GUI 与 TUI-only。
- 检查当前分析 shell 的 nc／ncat PATH 状态。

**没有完成，也没有宣称通过：**

- 没有切换活动 vendor、修改 upstream／series／catalog、回收或重生成 patch、修改产品源码。
- 没有执行 Bun 类型／lint／Runtime 测试／项目 check、构建 native／二进制、签名／激活／安装新版。
- 没有运行 GUI 验收、真实 ACP、Google 登录、付费模型、真实额度或平台硬件测试。
- 没有确认当前应用进程的运行版本，没有修改用户配置／凭据／会话／安装目录，没有提交、推送或发布。

因此现在可以讨论实施范围，但**还不能说 Runtime 已升到 18.20.2，或 Studio 已完成全部新功能适配**。

## 附录 A：普通 apply 需要刷新的 24 个文件

这些是文本预检拒绝位置，不是 24 个已证实运行 bug；三方预检均通过。

**0001（1）**

- packages/coding-agent/src/main.ts

**0002（4）**

- packages/coding-agent/src/session/agent-session-types.ts
- packages/coding-agent/src/session/agent-session.ts
- packages/coding-agent/src/session/session-manager.ts
- packages/coding-agent/src/task/executor.ts

**0003（0）**：无普通 apply 拒绝。

**0004（19）**

- packages/coding-agent/src/cli/bench-cli.ts
- packages/coding-agent/src/eval/executor-base.ts
- packages/coding-agent/src/eval/js/context-manager.ts
- packages/coding-agent/src/eval/js/executor.ts
- packages/coding-agent/src/eval/js/tool-bridge.ts
- packages/coding-agent/src/eval/preludes.ts
- packages/coding-agent/src/eval/py/tool-bridge.ts
- packages/coding-agent/src/live/controller.ts
- packages/coding-agent/src/sdk.ts
- packages/coding-agent/src/session/session-tools.ts
- packages/coding-agent/src/stt/stt-controller.ts
- packages/coding-agent/src/tools/browser.ts
- packages/coding-agent/src/tools/browser/tab-worker.ts
- packages/coding-agent/src/tools/browser/tern/wire.ts
- packages/coding-agent/src/tools/browser/webkit/host.ts
- packages/coding-agent/src/tools/computer.ts
- packages/coding-agent/src/tools/computer/worker.ts
- packages/coding-agent/test/system-prompt-template.test.ts
- packages/tui/src/html-form/data.ts

## 附录 B：主要上游证据

- [coding-agent 版本日志](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/CHANGELOG.md)、[AI](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/CHANGELOG.md)、[catalog](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/catalog/CHANGELOG.md)、[natives](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/natives/CHANGELOG.md)、[TUI](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/tui/CHANGELOG.md)。日志不是未经核对的适配真值。
- [辅助请求政策真实定义](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/config/auxiliary-model-policy.ts)、[Google Antigravity 暂停政策](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/catalog/src/compat/rules/auth/google-antigravity.kdl)。
- [selective commit 引入](https://github.com/can1357/oh-my-pi/commit/e8bcbd6a3a)、[Bash／辅助调用政策](https://github.com/can1357/oh-my-pi/commit/8b9b1ad22f)。
- [ABKit 0.1.1](https://github.com/can1357/oh-my-pi/commit/2b562c5b7e)、[240s wait](https://github.com/can1357/oh-my-pi/commit/545b727cdd)、[native DB purge](https://github.com/can1357/oh-my-pi/commit/5040aec096)、[ACP lazy successor](https://github.com/can1357/oh-my-pi/commit/8b87fec7d9)、[Wire 附件 blob](https://github.com/can1357/oh-my-pi/commit/f834b06135)。
- Studio 上一次已完成的范围和验收限制见 [18.19 迁移报告](docs/migrations/omp-18.19.0.md)。该记录的既有 canary／GUI 验收不等于此次新版验收。
