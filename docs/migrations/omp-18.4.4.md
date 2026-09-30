# OMP 18.4.4 Runtime 升级与 Studio 适配

后续已按批准方案实施 GUI 适配，当前 Runtime 为 **18.4.4-studio.31**。下文保留最初升级评估；最新实现与验收以 [GUI 实施记录](omp-18.4.4-gui.md) 和 [使用说明](../gui-18.4.4.md) 为准。

## 固定范围

- 原基线：OMP `18.3.0-studio.12`，上游 `62bc57be1b03ef0802a33cf7f5f530e534527531`。
- 目标：2026-09-30 查询到的最新发布版 `v18.4.4`（2026-09-29），`8ac1309bd8adaddc891eeb389c545345073875be`。
- 任务：升级 Runtime、恢复既有 Studio Bridge 兼容性、整理新增 GUI 能力的适配清单。新增页面及交互需要另行确定范围。
- 原始工作区无未提交改动；子模块未初始化。任务前备份：`backup/2026-09-30/omp-18.4.4-130941/`。
- 维持单 AgentSession、类型化 Bridge 和现有预览模式边界。
- 上游提交区间包含 1,275 条提交（含合并提交）；以下按 10 个发布版本归纳，不把提交数当作功能数。

## 逐版本变化

来源：[完整对比](https://github.com/can1357/oh-my-pi/compare/v18.3.0...v18.4.4)、[固定版本 Changelog](https://github.com/can1357/oh-my-pi/blob/v18.4.4/packages/coding-agent/CHANGELOG.md)。本表总结用户可见变化；完整修复条目以上游 Changelog 为准。

| 版本 | 主要更新 |
|---|---|
| 18.3.1 | IDA Pro 与项目级数据库管理；`local://`、`omp://`、`attachment://`、`conflict://`；`cfg://` 分层配置与会话批准；Slow 服务档位、OpenAI 实时纠偏开关；大文件分页读取；子代理独立压缩阈值；更完整的吞吐/并发/prefill benchmark；多浏览器并存；RPC prompt_result、settled、open_session、事件过滤；MCP 可禁用单服务器 instructions。 |
| 18.3.2 | 扩展获得主/子代理身份与父子关系；Claude 配额耗尽后的收尾额度状态；Windows 临时目录、hashline/Go 编辑、完整日志产物、压缩重试修复。 |
| 18.3.3 | 统一输入预测引擎（N-gram、SmolLM2、macOS 原生）与预测 daemon；技能 JSON 列表；下载进度；全局/项目记忆范围；子代理 BTW；MCP structuredContent 保留；任务自动思考深度依据。 |
| 18.3.4 | **破坏性变化**：task 的 `complexity` 改为 `solutionSpace`；自动思考按问题开放程度决定；修复 reasoning 耗尽输出预算后的循环。 |
| 18.3.5 | Prompt cache warming：`providers.cacheWarming=off/streaming/idle`，默认 idle，按成本收益与缓存命中判断是否刷新；扩展可覆盖决策。 |
| 18.4.0 | OTLP 导出开关；Python 缺失诊断；Stats 后台同步与 Frustration 分析（使用 judge、展示预计费用）；任务/额度/压缩/Windows 路径修复；Goal 全部受阻时等待用户。 |
| 18.4.1 | 更快启动与模型加载；composer 缓存迁入 SQLite；find 内存优化；跨工作区系统提示缓存复用；禁用 provider 全链路生效；Windows session append 回滚、插件 junction、配置链接保存修复；文本流中断后继续恢复；SDK agentDir、子代理证据和 compaction 修复。 |
| 18.4.2 | Shell cp 支持 macOS `-c`；锁与文件身份验证、用量存储、模型角色链缓存优化。 |
| 18.4.3 | task 流式推测启动（有审批及扩展条件）；可选快速 git worktree 克隆；大量 Tern/TSP 原生界面；**默认搜索改为 free-only 引擎链与会话提供商 hosted search**，付费引擎需显式配置；图像优先会话提供商，默认升级 gpt-image-2 / Gemini GA；无终端 CLI 行为与参数校验收紧；流式 CPU 优化。 |
| 18.4.4 | Bedrock Messages API 兼容选项；assistant_message 改写 hook、tool_result additionalContext；Ask 自定义回答/备注附图；Ultrafast 档位；真实 queuedMessages、queue_update 与单条 remove_queued_message；同名技能 namespace 保留；Tern 浏览器与会话恢复；可选裸命令输入；记忆召回、xAI endpoint 和队列附件一致性修复。 |

## 新能力与 GUI 候选范围

| 优先级 | 能力 | Studio 所需工作 |
|---|---|---|
| 高 | Runtime 真实待发队列、单条取消、实时纠偏 | 新增类型化 snapshot/event/command；稳定消息 ID、附件一并取消；区分 Renderer 本地队列与已提交 Runtime 队列；重连恢复。上游 RPC 自动支持不代表 Studio Bridge 已接入。 |
| 高 | 服务档位 slow / priority / ultrafast | 统一模型能力驱动的选择器，读取可用 tiers；主模型、子代理、advisor 设置及配额收尾状态；不可仅模拟 `/fast` 或 `/slow`。 |
| 高 | 新设置与默认行为 | 展示 cache warming 的成本/关闭选项、推测 task 启动、OpenAI live steering、OTLP 导出、advisor 旧结果淘汰、子代理压缩阈值；经严格白名单接入。 |
| 高 | 同名技能 namespace | Runtime 的手动 `/skill:namespace/name` 扩展已适配；GUI 仍需以 Runtime 解析后身份统一 Skills 列表、搜索、提及及插入，显示冲突来源。 |
| 中 | Ask 图片答案 | Interaction payload 和 Remote UI 增加图片能力，复用受控文件通道及 Composer 图片体验；保留文本客户端兼容。 |
| 中 | cfg:// 配置与审批 | 展示生效层、覆盖来源、修改/取消及“本会话始终允许”；保持原生配置批准语义，避免仅展示一次性布尔确认。 |
| 中 | Codex / Claude 额度收尾与重置 | 共用原生 reset consent 已保留；补充 Codex 重置策略、Claude wrapping-up / slow 状态展示。不得将额度查询变为自动兑券。 |
| 中 | 费用展示语义 | 检查订阅用量是否应标为 API 等价值估计；没有参考价格时显示未知/N/A，避免把未知显示成免费。 |
| 中 | Benchmark 新阶段 | 接入上游单用户吞吐、并发扩展和自适应 prefill 的参数与结构化进度；维持费用审核和取消行为。 |
| 中 | 子代理 BTW | 给 BTW 增加父会话/子代理 target、独立历史与生命周期；不能拿主代理 transcript 冒充子代理上下文。 |
| 中 | 新工具/资源 | IDA 状态、数据库操作、分页 read、attachment/conflict 资源的查看入口；检验 Changes 不将配置、数据库等写入误判为普通文件编辑。 |
| 可选 | 输入预测 | Composer 接入原生预测服务，取消/过期结果处理、按需模型下载（SmolLM2 约 145 MB）和隐私控制。 |
| 可选 | Stats / Frustration | 新的统计分析页、同步进度和 judge 费用确认；属于产品扩展。 |
| 无需照搬 | Tern/TSP、裸 exit/slash、终端缓存与状态栏 | 主要针对终端宿主；Electron 保持现有窗口、Composer 与类型化控制。 |

Cache warming 可能在空闲时发出计费请求；free-only 搜索链仍可能使用会话提供商的订阅额度或按提供商规则计费。升级验证不主动调用这些外部服务。

## 实施与验证

已完成的兼容修改：

- 迁移 4 组接缝，处理 15 个冲突文件；配置默认值的接缝从已删除的 `config/settings-schema.ts` 移到 `task/settings.ts`，保留 Studio 的 300,000 ms 空闲 TTL。
- Studio 设置服务、权限、模型、Plan、媒体、目录、遥测读取改用原生配置句柄，继续使用严格白名单；测试使用实际 Settings 对象。休眠 Worker 重建后重新绑定 Plan 配置监听。
- 保留新版 RPC options、非 TTY 启动处理、服务所有者语义、暂停屏的原生渲染、重试取消、防止批准失败后遗留 preflight 等行为。
- 向新版 task API 提供必需的 `solutionSpace`。现有 GUI 未提供独立说明字段，暂以 assignment 作为自动思考分类输入，延续旧版行为；没有假设用户已给出额外的任务复杂度判断。
- `prompt` / `steer` / `followUp` 的注入上下文与用户消息一起入队，保留原生隐藏附件的取消语义。**没有新增 Studio 的队列取消命令或真实队列 GUI**；可见技能前置信息的复合队列展示仍需在该功能中统一设计。
- 保留新版 Benchmark 实现的原生阶段、结构化观察和取消信号。现有 Studio measurement 的 `phase` 仍只表示 cold/warm，未把 single/parallel/prefill 混进旧字段。
- 同步原生搜索/图像候选及旧配置迁移；明确配置的 Perplexity/Kagi 等付费引擎保留，Gemini 的 CLI/Antigravity/API 路由保留。
- 现有子代理服务档位覆盖的协议、校验、设置选项接受 `ultrafast`；完整主模型档位产品交互仍未新增。
- 手动命名空间技能 token 可正确匹配原生技能身份；Skillshare provenance 改为读取真实 Runtime VERSION。

已完成检查：

- 全仓 `npm run check` 通过，包含 687 Renderer / 388 Desktop 测试。日志：`%TEMP%/omp-1844-root-check3.log`。
- 工件元数据检查 47/47 通过。日志：`%TEMP%/omp-1844-final-metadata.log`。
- Runtime 全包源码检查通过。回归覆盖新增配置注册表、原生真实队列/RPC 取消、Benchmark profiles/cache，以及全部 Studio overlay 测试。
- 审批测试改为等待原生异步预检完成后出现的卡片；RPC 错误测试改为先 await/catch，再断言相同的 command 字段。未放宽超时或业务断言。直接 JSONL 帧及独立 RpcClient 探针均确认原生错误回包正确；原 Promise matcher 写法在本机 Bun 1.3.14 和 1.4.2 均可复现等待超时。
- 使用独立 Bun 1.4.2 与上游固定 Rust 工具链构建本机 Windows x64 原生模块及 Runtime。`omp.exe --version`、`--smoke-test`、认证 Bridge 身份探针通过。探针版本为 **18.4.4-studio.18**，目标提交为 `8ac1309bd8adaddc891eeb389c545345073875be`。日志：`%TEMP%/omp-1844-host-build.log`。
- 本地签名工件：`packages/runtime-installer/dist/artifacts/win32-x64/18.4.4-studio.18/`。未使用发布签名流程。
- 隔离安装、自检、回滚、重新激活通过：`18.3.0-studio.11 → 18.4.4-studio.18 → 18.3.0-studio.11 → 18.4.4-studio.18`。原始源码基线是 studio.12；本机可用回滚工件是 studio.11。日志：`%TEMP%/omp-1844-install-e2e.log`。

最终 `npm run omp:verify:patches -- --skip-workspace-check` 通过：114 个 overlay 文件、4 组接缝、72 套独立测试进程，共 710 项 Runtime 测试通过，包含上游 smoke。全仓门禁已单独运行，因此回放阶段不重复运行全仓测试。验证后 vendor 恢复干净，再重新应用完全相同的补丁；`runtime:verify-source` 与 `assertForkApplied()` 通过。日志：`%TEMP%/omp-1844-final-replay.log`。

此次未发布、未替换全局 OMP 或已安装的 Studio；未进行付费模型/媒体请求、真实额度兑券或 Skillshare 远程写入。新增 GUI 功能、ARM64 构建和完整安装包发布均不属于此次完成范围。
