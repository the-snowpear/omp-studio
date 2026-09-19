# OMP v18.2.5 Runtime / Studio 迁移

## 基线与目标

- 原功能基线：`18.1.18-studio.5`，`00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。
- 固定目标：`v18.2.5`，`37273117021129e96bd05d8277b140ec3fd61990`；不追随之后的 main。
- 上游范围：10 个正式版本，1,892 个提交（含 merge），2,628 个变化文件。文件数由完整 Git diff 得到，不使用 GitHub compare 的 300 文件截断结果。
- 实施开始时 pin、vendor 已由其他工作切到目标；vendor 干净、series 为 studio.0。保留现有更新器、安装器、模型 YAML 编辑器等未提交改动。
- 编辑前备份：`backup/2026-09-19/omp-18.2.5-2026-09-19T06-52-16-882Z/`，附恢复说明；新增上游文件有补充备份。
- 最终 Runtime：`18.2.5-studio.6`，Windows x64；Studio 应用版本保持 `0.1.5`。本地工件不发布、不自动安装到系统、不创建提交。

[完整上游比较](https://github.com/can1357/oh-my-pi/compare/v18.1.18...v18.2.5)

## 十个版本更新摘要

以下按用户可观察的变化归纳；同一能力在后续版本继续修复时合并说明。发布说明中的历史条目以最终 pin 的源码为准，不能把每一条“Added”都当成最终仍存在的新接口。

| 版本 | 主要新增与变化 |
|---|---|
| [18.1.19](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.19) | BTW 持久话题和多轮追问；默认关闭的推测本地读取；fallback 每模型思考等级、每代理 service tier；Charm Hyper 与预付费余额。修复 MCP 重连内存增长、直播工具结果恢复、Windows Z.AI OAuth、部分 Codex／Muse 登录及配额判定。 |
| [18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20) | Collab 自动托管、本机会话发现与代次绑定的访问链接；MCP 名称兼容和工具发现修复；DeepSeek V4.1 Flash 图片能力与协议继续完善。 |
| [18.1.21](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.21) | 浏览器工具的 Chromium profile 目录集中管理，以及运行稳定性修复。 |
| [18.1.22](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.22) | Hub 消息／任务等待改为自适应窗口，移除旧 timeout 参数与轮询配置；Ollama assistant prefill；Git TUI 丢弃修改操作；BTW 复制反馈和导航改善。 |
| [18.2.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.0) | 模型目录／供应商策略移入 KDL 规则；扩充 DeepInfra、LiteLLM、Qwen Portal、SiliconFlow 等供应商与 Gemini 模型；实际服务模型识别；Ollama 搜索；技能原子标签；预编译字节码与大量启动优化。部分 catalog、MCP、浏览器工具导出发生破坏性变化。 |
| [18.2.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.1) | Claude／Codex 会话导入、`omp cleanse`、Exa 登录、Parallel 无密钥搜索、CUT／PASTE 编辑；工具参数可被 hook 改写；任务 effort 开关／上限、自动思考上限、Advisor 独立费用。长流式响应、压缩、模型切换、凭据轮换与 Windows Shell／PTY 大量修复。`/drop` 改为 `/delete`，Read 结果不再重复保存 truncation 正文。 |
| [18.2.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.2) | Bedrock 自定义端点；更完整的 reasoning metadata；扩展密钥脱敏；停止 hook 行为修复；数据库损坏备份／恢复；刷新模型时重新解析命令凭据；已消费后台任务及时回收。 |
| [18.2.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.3) | `^模型` 标签与持久化 m1/m2 委派定义；请求头与 Shell 凭据异步解析；登录 secret 输入语义；移除旧同步 model-config-values 等接口；会话 SQL 重命名要求事务支持。 |
| [18.2.4](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.4) | TypeSafe／LLM 统一 judgment 系统、eval `judge()`；用于自动思考、异常停止检测等判断；可配置生成速率显示。 |
| [18.2.5](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.5) | 终端主题、暂停屏、工具渲染、状态栏等迁入独立 pi-tui 包；`omp stream`／Stencil 认证、观众聊天和脱敏；Parallel 默认无密钥回退优先级；Anthropic 缓存断点、子代理中断／yield、browser relay、hashline 已读行约束和插件根目录容错等修复。 |

### 最终源码中的关键兼容变化

- **TUI 拆包**：旧 coding-agent 子路径不再存在。Studio 使用新的 pi-tui 导出，暂停控制通过中立接口注入，不建立反向依赖。
- **视觉能力**：最终源码已移除 `inspect_image` 和 `/vision`。图片问答使用 `read <image>?q=<question>`；超时为 `images.questionTimeoutMs`，旧配置由上游迁移。中间版本的三态开关不再接入。
- **配置与凭据**：遵循异步凭据解析；新调度设置保留上游默认值和模型限制。未接管配置字段继续保留。
- **会话与工具**：使用新工具结果字段，继续恢复旧记录；保留重试中止、暂停代次、审批、Loop 防止迟到重启、隔离代理不可复活等 Studio 语义。
- **Windows 导入**：修复 Claude 编码项目目录与注册项目路径的 Windows 匹配；上游导入测试的路径编码同时修正，避免在文件名中留下盘符冒号。

## Studio / GUI 接入矩阵

| 能力 | 本次状态与入口 |
|---|---|
| BTW 历史／追问 | 已接入浮窗与停靠面板的话题列表、新话题、历史读取、追问。取消保留输出，保存失败阻止相关会话操作；复用原生 store 的锁和 revision 检查。单轮符合条件时可分支，多轮明确保留在历史。 |
| 模型委派 | Composer 输入 `^` 选择模型；规范 selector 经原生 registry 登记。选择标签不启动代理。活跃与归档 transcript 将登记标签恢复为可编辑 selector，Agent Hub 单列可委派定义。 |
| 调度配置 | fallback 每模型 effort；任务 effort 开关／上限、自动思考上限、精确代理名 service tier。使用原生允许值，未覆盖代理继续继承。 |
| 视觉 | 模型角色中的 vision 选择、当前模型图片能力显示、纯文本模型图片描述及图片问答超时。 |
| TypeSafe | 凭据录入／移除／配置状态；判断后端 auto/typesafe/llm。仅当会话有原生 auto-thinking usage 记录时显示最近实际判断 provider/model，不以配置偏好替代实际结果。 |
| 运行信息 | 主会话生成速率、最近完整响应速率、Advisor 独立费用、请求／实际服务模型差异；子代理速率与结构化任务输出详情。无数据时不造数。 |
| 会话导入 | 历史页的来源选择、摘要预览、目标工作区选择、导入结果和打开按钮；复用原生转换、创建新身份，保持来源文件和当前活动会话。Host 登记导入工作区但不自动激活。 |
| 搜索 | Parallel 无密钥状态与描述更新；Ollama Cloud 搜索配置；Exa 获取密钥及录入入口。认证状态读模型不包含密钥。 |
| 推测读取 | 文件与终端设置中的实验开关，默认关闭；沿用原生授权、取消和动态配置，保留默认并发。 |
| Collab／Stencil／cleanse | 按用户选择，本次不做 GUI 流程；保留上游 CLI 能力。 |
| 纯 TUI 改善 | 主题、终端编辑、终端直播绘制、终端专属向导等不机械复制到 Electron。 |

所有新增界面同时实现真实数据、预览 fixture、空态和能力不可用状态。演示交互不调用 Host。生成速率采用原生 TokenRateMeter；流式速率投影限频，避免每个 token 重算全部上下文。历史费用保持原始记录，不按新版目录价格回算。

## 接口、存储与授权

- Bridge 协议保持 v1；新增操作加入严格输入／结果校验、capability 和 IPC 白名单。
- 新增 `btw.history.list/read`、`btw.followUp`、`session.models.mentions`、`session.import.list/preview/execute`、受限供应商集合的 `runtime.auth.get/set/remove`。
- BTW 历史按需读取，不塞进全局 snapshot；事件增加 session/topic 身份。分支 token 仍只在私有问答回执中返回。
- 新设置扩展原有 `runtime.settings`，对布尔、枚举、超时和代理名映射逐项校验。
- 导入源文件路径不由 Renderer 提供；来源 ID 必须在 Runtime 枚举中唯一匹配。GUI 使用工作区 ID，Host 私下解析实际目录。导入结果仅公开 sessionId/workspaceId。
- 新的凭据操作不输出密钥，不把密钥写入配置预览、历史、telemetry 或日志；移除本地凭据不删除环境变量。
- 升级保持单个 AgentSession 和类型化控制，不引入 slash/ANSI/按键自动化。

## 验证记录

| 检查 | 最终结果 |
|---|---|
| `npm run check` | 通过；所有 workspace 构建、类型检查与测试，Renderer 80 个文件 / 598 项测试，Desktop 362 项测试 |
| `runtime:verify-source` | 通过；目标精确提交一致 |
| `omp:verify:patches -- --skip-workspace-check` | 最终 studio.6 在 Bun 1.4.2 下通过；82 个 overlay 文件与 4 组接缝从干净 vendor 重放，原生类型检查、受管测试、相关原生测试和 smoke 通过，vendor 恢复干净。Root 门禁已独立完成 |
| 新功能定向回归 | BTW 持久化、启动前取消、跨进程冲突、保存失败恢复、标签回退／分支、IPC 校验、导入与视觉／judgment 用例通过 |
| 实际 exe / 身份探测 | Bun 1.4.2 编译，最终 exe smoke、hello、capability、命令 manifest 与签名身份一致 |
| `omp:test:metadata` | 45 项通过 |
| 隔离安装／回滚 | 通过：18.1.18-studio.5 → 18.2.5-studio.6 → 18.1.18-studio.5 → 18.2.5-studio.6 |
| 真实模型 GUI | 两条前台提示词通过：不可预测文件读取证明、流式回答、取消后 Loop 不复活、重载保留 epoch 与 transcript、历史可发现；使用已配置 DeepSeek V4.1 Flash（high） |
| 最终版本无模型请求 GUI | studio.6 通过：Runtime 模型候选、实验设置即时覆盖与恢复、无密钥泄漏的认证状态、BTW 当前会话历史、Claude 导入预览／缺目录回退／幂等重放／来源文件保全／Host 历史登记 |
| Chromium 预览与布局 | 检查导入、模型凭据、调度与视觉设置、推测开关、模型标签、BTW 历史；修复工作台运行中将 /btw 误排队的整合问题 |
| `perf:streaming` | 通过；原有布局、堆、DOM、帧间隔、会话切换及展开跟随阈值均未放宽 |
| `pack:win` / `pack:win:audit` | 通过；x64、CSP、preload、真实 Runtime 与仅公钥打包检查通过 |
| `git diff --check` | 通过 |

### 验证边界与工具链

- 两条真实模型请求在 studio.5 完成。之后的 studio.6 只增加模型标签在树导航／分支回填中的恢复及回归用例；最终二进制重新编译、身份探测、安装回滚、完整补丁验证、无模型请求 GUI 均重验。未为最后这项改动超出两条前台提示词预算。
- TypeSafe／Exa／Ollama 的真实账号登录未运行；配置、状态、协议与上游回退行为由可控测试覆盖，不把“已配置”当作“账号验证成功”。
- 真实 GUI 使用隔离 userData、工作区和 OMP agent 目录。配置文件按副本使用，SQLite 凭据库以一致性快照复制；原配置摘要一致。验收完成后已删除临时配置与凭据数据库副本。
- Bun 1.3.14 在此次 Windows 字节码编译中触发内部断言 `total_insertions != output_files.items.len`。使用临时独立的 [Bun 1.4.2 官方 Windows x64 包](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) 成功构建；全局 Bun 未替换。下载 ZIP 的 SHA-256：`ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405`。
- Rust 使用上游固定的 nightly-2026-08-12；官方组件下载超时后使用镜像完成同版本组件安装。最终构建复用已验证的 Windows 原生模块，只重新编译变动后的 TypeScript bundle。
- 同目录的模型 YAML 编辑工作被保留。整合时修正漏改变量引用、严格可选类型测试和脱敏预览／真实凭据的 parity 测试边界；未还原其新增字段映射。
- BTW 列表当前返回最近 100 个话题，导入列表返回最近 200 个来源会话；BTW 追问设有 32 轮和正文预算，超限拒绝继续追问，原始历史不删除。
- 安装包只做生成和审计，未执行系统级安装向导。Setup 未做 Authenticode 签名；内置 Runtime 仍用项目 Ed25519 签名验证。未发布 release、未创建提交、未替换全局 OMP。

### 工件与证据

- Runtime 四件套：`packages/runtime-installer/dist/artifacts/win32-x64/18.2.5-studio.6/`。
- Windows Setup：`outputs/installer-18.2.5-studio.6-migration/OMP-Studio-Setup-0.1.5-windows-x64.exe`。
- Setup：199,884,557 bytes（约 190.6 MiB）。
- Setup SHA-256：`6a4d49e4a95bcf8e30ab2c97eeabe137a24c462158bff8880f2c5b567ed3d486`。
- Patchset digest：`sha256:5f48fabf81c900532e3825643606bd95b2c9467573ed1e61d56348e724e30e91`。
- Capability hash：`sha256:88ed539a48190e709312ee6277b89741ab95481cbb2f30df57fb715d3f981a46`。
- Command manifest hash：`sha256:7cbd2c26d79adf8e83b9ab8567aa5f42924551162634c7f4f1690e085ebac3e4`。
- 本机证据：`%TEMP%/omp-1825-gui/` 下的实际 GUI 报告、截图、`real-features.json` 和 `streaming-perf.json`；Git Bash 的 `/tmp/omp-1825-*.log` 保存根目录、补丁、工件与安装包门禁日志。

## 重建与恢复

使用项目既有 overlay → vendor → regen 流程。新接缝文件加入 `scripts/omp-seam.mjs`，不手改 patch。验证从干净 vendor 开始，结束必须恢复干净，再应用补丁构建实际 Runtime。

恢复前查看备份 README 与当前 diff，只恢复本任务相关文件；不要覆盖用户后续的更新器／安装器／模型编辑器工作。保留旧 Runtime 工件，新格式会话不强行交给旧 Runtime；回滚验证使用隔离目录与会话副本。

Windows 本地重建需将 `BUN_EXE` 指向独立的 Bun 1.4.2，然后使用既有构建命令。打包本机测试工件时还需显式设置 `OMP_RUNTIME_TRUSTED_PUBLIC_KEY` 与 `OMP_RUNTIME_SIGNING_KEY_ID=omp-studio-local`，让安装包携带与工件匹配的本机公钥；不改写仓库发布公钥，不携带私钥。
