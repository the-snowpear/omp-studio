# OMP 18.20.2：迁移与分阶段验收

最初交付按“新开工作树、只完成后端”的要求实施，该阶段没有修改 Renderer 页面、前端设计或网站。随后已接入前端并按用户批准修复复核发现的 15 项问题；当前 `18.20.2-studio.5` 的门禁、签名 canary 与未验证边界见[前端复核收尾报告](../reviews/omp-18.20.2-frontend-fixes-2026-11-16.md)。调用约定见[前端交接](omp-18.20.2-frontend-handoff.md)。Studio 产品版本保持 `0.2.0`。

## 身份与范围

> 阶段说明：下文的 `18.20.2-studio.3`、1,109 项原生回归和签名 canary 记录属于最初后端交付。2026-11-16 的前端复核修复将源码推进到 `18.20.2-studio.5`，并修改了 Renderer；不要把下面“前端未修改”或旧制品哈希当成当前工作树状态。当前分层设置与恢复句柄约定见[适配交接](omp-18.20.2-frontend-handoff.md)。

- 工作树：`D:\Project\omp-studio\.claude\worktrees\omp-18.20.2-backend`。
- 分支：`feat/omp-18.20.2-backend`；创建基线 `c4049fd48afb88fc46f2ab80560eda9c8b69402d`，对应已保存的 `18.19.0-studio.12`。
- 上游固定到正式 `v18.20.2`：`7c49c11aa5bbaf3f418406583096168ad5b8c6dc`，未混入后续 main。
- 最初后端交付的源码修订为 **`18.20.2-studio.3`**；当时 314 个 overlay 文件和四组接缝均通过 `npm run omp:patches:regen` 回收/生成，未手工编辑 `.patch`。当前源码身份以 [`series.json`](../../omp-patch/patches/series.json) 为准。
- 原工作区和其脏 vendor 未被 reset、覆盖或切换；未触碰原有网站、前端等 WIP。临时测试仓库中的提交只用于验收，**本项目没有提交、推送、合并或发布**。

## 后端完成内容

| 范围 | 实现与责任边界 |
| --- | --- |
| Runtime 基座 | 重放四组接缝，解决新原生 SDK、Advisor、Seance、session、browser/worker 与 HTML Form 拆分接口；对齐 gitlink、pin、series、Bridge/命令身份和模型 catalog provenance。 |
| Antigravity CLI | AI transport 接受 coding-agent 注入的同源命令；标准 ACP `mcpServers` 指向隐藏 Runtime stdio relay，转发到原生 loopback MCP bridge。覆盖新建、load/fork 使用当前 transport 的绑定；不依赖 nc，不修改系统 PATH，不建立第二个 AgentSession。新增只读就绪查询与分发自检。 |
| 模型真值 | 当前有效/授权模型只取 Runtime registry；保留公开 API/kind/thinking/能力/限额/价格/discovery。Host 不再查询旧 model_cache SQL。分页绑定 session/registry/凭据/设置代次，短租约、有界容量和释放；`models.get` 只共享同目标的进行中读取，不缓存 30 秒真值。 |
| 目录与认证 | 在线目录刷新和静态推荐刷新分开；刷新重取 command credentials 并等待 scoped models。动态 OAuth、最长 600 秒等待、取消与暂停/显式 unpause 接原生流程；Antigravity ACP 不是普通 HTTP provider，Google Decisions 使用原生 API-key 规则。 |
| 选择性提交 | 复用原生 ChangeJournal、Draft、DraftStore 与 commitSelection；提供结构化 scope/agent/own/other/review/path/hunk/unit，原生 own 预选。预览冻结 patch/tree/revision/HEAD，执行绑定 previewId；原生 expectedTree/expectedHead 防止 hook 混入未确认内容，CLI 非确认模式保留原有重基。 |
| 命令输入 | GUI 的 builtin.commit 只返回需要确认的 draft；其他原生命令生成的 prompt 在 Runtime 内消费。异步技能/自定义命令和 core.prompt/steer/followUp 的输入准备绑定旧 session，不在 fork 后误送。 |
| 会话生命周期 | recordedCwd 与 executionCwd 分离，明确选择已存在工作区后恢复；失败保留原健康 Worker/活动项目，包括死亡 resident 的冷恢复。fork/branch 统一 abort→settle→重绑，旧队列不跨会话；publication 更新重连目标。 |
| 删除 | Host 归属/resident 检查后、unlink 前调用同源私有原生 purge worker，分别报告 history/stats 状态；等待期间再次成为 resident 会拒绝删除。保留 telemetry/binding/lease/pin 等 Studio 清理，partial 不伪装跨库原子成功。 |
| 既有设置与执行面 | 增加 noJudge/noSpotlight/offline、find、encourageEdits、commit、todo、Bash、TTSR 原生 setting handles；语音固定/动态配置与 active-provider 政策一致；Computer 传 secureInput、有效 Escape、独立 lockKnown/sleepKnown、unconfirmed/focusReturn；Benchmark/Evaluation 账户选择绑定稳定 credential ID。 |
| 新的瞬时读表面 | 输入历史 list/read/delete 使用原生 HistoryStorage/FTS 和行 revision，重新提交后不误删旧预览；generic select 保留初始索引与标记元数据。正文、diff 和媒体不进入全局 reducer/命令账本。 |
| Host/客户端集成 | 补齐新 query 的 Facade 分发、同步期敏感命令登记与契约测试 fixture。Bridge 保留原生 cursor 错误的 retryable 标记，让 Host 的有限重新分页在真实通道上生效。 |

模型 catalog 从固定上游离线生成：6,296 个条目，catalog revision `a6df552d314c84dd`；静态推荐本身不构成授权真值。

## 验证方式

使用本地 Bun `1.4.4`、现有 Rust `nightly-2026-11-08` 和 Windows x64 工具链。没有升级全局工具。运行时/测试使用独立 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、agent、config/data/cache/state/TEMP，并移除继承的 Provider 密钥、端点与默认路由。

Runtime 签名使用本轮临时生成的 Ed25519 canary key，与正式发布信任链分开；安装/激活仅发生在隔离目录，没有替换用户安装版。原生 addon 与二进制从该目标源码构建，不使用旧版 ABI。Rust 的既有 dead-code/Windows linker warnings 不被描述为“零警告”。

## 已完成的行为验证

| 范围 | 结果与证据边界 |
| --- | --- |
| ACP 状态机与绑定 | 24 项通过，包含新建、恢复、fork、工具挂起/继续、取消、迟到 transport 与关闭。 |
| MCP relay / bridge | 4 项 relay 与 4 项 native bridge 测试通过；无 nc PATH、真实本地工具往返、大段 UTF-8、EOF/取消/断连释放。 |
| 官方 ACP 兼容 | `agy 1.5.9` 使用**编译后的 Runtime** stdio relay 完成 initialize/newSession；观察到 server/discover、initialize、notifications/initialized、tools/list，stderr 为空。没有执行登录或模型 prompt；不等同于账户推理/额度验证。 |
| 选择性提交 | 14 项真实临时 Git 回归通过：主/子树归属、交错修改、foreign staged、review、binary、mode、symlink、初始提交、HEAD/内容漂移、amend、hook/noVerify、重复提交/收据重放与代次失效。 |
| 模型 | Native model-available/auth/metadata 16 项通过；Host 模型快照/adapter/kinds/pricing 等五个 suite 144 项通过，网络通过注入 fetch 拦截。 |
| 生命周期 | fork/tree/session-control/resume/purge 五组 50 项通过，包含真实 SQLite、归档 .jsonl.gz 与私有 CLI worker；Host/Desktop 对应定向切片通过。 |
| Prompt/命令 | 输入历史 2 项、命令 manifest 9 项通过；后者包含真实原生自定义命令等待期间换会话后不再 admission。 |
| 真实 Bridge 错误 | Host foundation 与 Time Travel 定向切片通过，覆盖原生模型游标 retryable 信息不被错误映射丢失。 |
| 生产门禁 | `npm run check -- --production` **完整通过，181.3 秒**；架构、选择器、动效、所有类型、核心包/Renderer 测试、Renderer/preload/remote-host 生产包均通过。 |
| 源码/格式/完整重放 | 最终 `studio.3` 的 pin、lint/format、原生类型与干净检出重放通过：**140 个测试进程，1,109 项通过、5 项跳过、0 失败**；CLI worker smoke 通过，独立检出恢复 clean。跳过项不计为通过。 |
| 同源 Runtime 制品 | 最终 **`18.20.2-studio.3`** 的 native build、编译二进制 `--smoke-test`、真实认证身份探测、manifest/checksums/Ed25519 签名及隔离安装/激活均通过。 |
| 新 API 真实 Bridge | 最终 `18.20.2-studio.3` 签名 canary 的 8 项检查通过：认证身份、模型分页/释放、Antigravity 只读就绪、prompt history、原生设置、Benchmark 账户、冻结预览后提交且保留 foreign staged、正常退出。没有模型请求。 |
| Tooling | 全量运行记录 123 项断言通过，但 Node 24 test runner 在 installer-wizard 子进程结束时报告反序列化错误，整体 exit 1；该文件两项 NSIS 行为测试在全跑内均显示通过，另外独立运行也 2/2 通过。最终修订的 Runtime metadata/pin/签名/补丁专项独立 **20/20 通过**。此 runner 异常未冒充全量通过，也未为此修改安装器产品代码。 |

## 验证中修正的实际问题

- 新 stdio MCP 配置一度在 transport → AgyProcess 转换时丢失，真实新建/load/fork 测试发现后补传；不是仅删掉 nc 检查。
- 新 query/command 增加后，Facade、客户端敏感操作表、契约 fixture 和打包能力镜像需要同步；签名 gate 拒绝能力 hash 漂移，未绕过校验。镜像同时补齐该基线已有但未登记的 `studio.locale`。
- Windows 深层隔离 TEMP 触发原生 Unix socket 的 `ENAMETOOLONG`；临时文件已改用仓库外的新隔离短目录。
- 把 Time Travel 测试目录放在本仓库 gitignored 的 `tmp/` 下，会让 Git 把全部测试文件视为忽略，产生与本次功能无关的假失败。仓库外隔离后原测试通过，未为此改产品代码。
- 旧 worktree 回归受 Windows CRLF 默认值影响：CLI Git 与 native checkout 对同一个 fixture 得到不同换行状态。测试仓库现显式设置 `core.autocrlf=false`，保持原删除保护不变。
- Native stats 测试使用 HOME→TEMP 的相对目录作为 profile：Windows 跨盘不能构造该相对路径。验证环境现把所有 Runtime 状态放到仓库外、同盘的独立目录，只有日志/制品留在工作树；原 stats 测试 5 项通过。
- 两个上游路径设置测试打开的 AgentStorage 未关闭，Windows 不能删除仍打开的 SQLite 文件；补齐测试 finalizer 的 close 后，设置 registry 27 项通过。
- 真实 Bridge 的选择性提交验证确认 `only` 只缩小已有选择；显式纳入未选的文件应调用 `take`，交接文本已明确这一区别。

## 最初后端交付证据（studio.3）

- 签名 Runtime：`tmp/verification/build-AesS44/artifacts/`，包含 `omp.exe`、manifest、checksums 和 Ed25519 signature；仅为 canary，不属于正式发布信任链。
- `omp.exe` SHA-256：`d1bb33181b51d9075b92d410f4dfb315bac71ddbd2d8cc18706e5a8409cc4869`。
- 最终 patchset digest：`sha256:64bf9a5b75d300299dd6b08b99e28bd1447ad5ccfbcf2eb5988d2f2a0917285a`。
- 完整重放、production、最终构建、tooling、独立 NSIS、真实 Bridge、隔离安装和官方 ACP 的八份完成日志已保存在 `tmp/verification/evidence/`。
- 五个跳过用例涉及三项原生观察链路、一项缺少短 socket 目录时的音频降级、一项 Host 被终止后的 watcher 退出；未把这些可选/平台用例计入通过数。
- 最终复核中 `apps/renderer` 与 `website` 无 diff，vendor 与回收后的 overlay/接缝一致；所有本项目改动仍为未提交状态。

## 最初后端交付时未实施或未验证

- 未实现任何新前端页面/设计；富文本粘贴、所有新增 UI 的真实/preview 配对、中英文切换、宽窄布局和交互验收交给下一位前端 Agent。
- 未进行真实 OAuth/ACP 登录、模型 prompt、付费 Benchmark/Judge 或账户额度验证；没有通过自动重试绕过授权。
- 未验 macOS/Linux 制品、真实 macOS Secure Event Input/焦点归还，或实机锁屏/休眠组合；Windows 单元/契约证明不能替代这些平台验收。
- 未发布正式签名制品、未安装升级用户桌面应用、未运行远端 CI、未提交/推送/合并当前工作树。

验收日志、临时 key、测试仓库与 canary 均为本地忽略产物；它们不进入版本控制。可提交的交付物是后端源码、契约、overlay/生成接缝、测试以及本文/前端交接。
