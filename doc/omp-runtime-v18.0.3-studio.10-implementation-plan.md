# OMP Runtime v18.0.3 / Studio.10 最终实施计划与验收结果

> 状态：最终验收版；本轮实现、App 接线和最终门禁均已完成。
> 目标：把上游 OMP v17.4.1 到 v18.0.3 的行为变化，映射到 Studio Bridge、Host、Desktop、Renderer 和制品链路，并给后续 agent 一套可以直接执行的验证与回滚路径。
> 约束：本文件只记录本轮范围，不改变旧的 v17.4.1 计划，不把预览 fixture 当作 Runtime 真值，也不把并行 agent 的无关工作树改动算入本轮结果。

## 1. 事实来源与固定身份

本轮上游变更以 vendor 中的上游 changelog 为准：
omp-patch/vendor/oh-my-pi/packages/coding-agent/CHANGELOG.md（对应上游 packages/coding-agent/CHANGELOG.md）。

Studio 的 pin、patchset 和制品身份以以下文件为真值：

- omp-patch/upstream.json
- omp-patch/patches/series.json
- omp-patch/vendor/oh-my-pi/packages/coding-agent/package.json
- omp-patch/overlay/packages/coding-agent/src/studio/bridge-server.ts 中的 PATCHSET_VERSION
- scripts/omp-seam.mjs、scripts/runtime-artifact.mjs、scripts/verify-omp-patches.mjs

| 身份字段 | 本轮固定值 | 说明 |
| --- | --- | --- |
| 上游仓库 | https://github.com/can1357/oh-my-pi.git | 受管 OMP fork |
| 上游版本 | v18.0.3 | vendor coding-agent package.json 同步为 18.0.3 |
| 上游 commit | 160ed439ac0df594347e7d7018b813a7ffdb5e81 | upstream.json 与 series.json 必须一致 |
| 初始审计基线 | 45e12e5bb758198a920c6070e7e64cb33b21beac | omp-patch/README.md 记录的迁移前审计基线，不是本轮发布 pin |
| 旧 v17.4.1 计划目标 | 9350b7990d26ebf69a604edc82d8558ef04adf30 | 只属于旧计划 doc/omp-runtime-v17.4.1-upgrade-plan.md，本文件不修改它 |
| Studio patchset | studio.10 | 记录在 series.json，不按 patch 文件数量推导 |
| patchset digest | sha256:2ab946b985a6ba9103b6051c191508e1bf984b0ae6e183144641278afd1ae4b3 | 覆盖 overlay 与 seam patch 内容和路径 |
| seam patch 顺序 | 0001-studio-cli-entry.patch → 0002-studio-session-runtime.patch → 0003-studio-modes-and-pause.patch → 0004-studio-extensibility.patch | 只能由 regen 脚本生成，不手改 patch |
| Runtime 制品版本 | 18.0.3-studio.10 | 上游版本与 patchset 的联合身份 |
| Windows entrypoint | omp.exe | 以 omp --mode studio-host 启动；omp-studio.exe 仍预留给未来桌面壳 |
| 首个平台 | win32-x64 | upstream.json 的 firstPlatform |
| Studio Protocol | omp-studio / v1 | 根 packages/studio-protocol 是 canonical contract |

vendor 工作树在开发态可能带有 overlay 和已应用 seam 的 dirty 标记；这不等于制品身份变化。发布前必须由 apply/verify 流程确认：overlay 与 canonical 副本一致、四组 patch 可应用和反向检查、vendor 的上游基线没有未声明修改。

## 2. v17.4.1 → v18.0.3 的上游变化摘要

### v17.4.1：本轮设置和兼容面的起点

- 新增 providers.openai-codex.codeMode（off/on/auto），对 code_mode_only 模型把非必要工具收进 eval bridge。
- compaction.asyncEnabled 默认开启，用后台 speculative compaction 减少达到阈值时的停顿。
- 用有序的 compaction.methodOrder 取代 compaction.strategy 和 compaction.remoteEnabled。
- 新增 extendedContext，用于在高级长上下文与标准计费窗口之间作选择。
- token 估算按模型 tokenizer 动态作用域化。

这些字段成为 Studio Runtime settings 镜像的主要兼容来源。Studio 只暴露已验证的白名单，不能把上游 settings 菜单自动变成任意写配置接口。

### v17.4.2–v17.4.4：图片与终端呈现边界

- v17.4.2 新增可选 image URL broker（images.urls.enabled）、图片/大文本 composer attachment chips，并把粘贴图片的标记收敛为单一逻辑 marker。
- v17.4.3 修复 edit payload 中粘连分隔符的解释。
- v17.4.4 修复 composer 图片 chip 边框/缩略图布局，并改进 resize scrollback。

Studio 本轮采用 transport 层的 canonical inline Base64 图片协议；URL broker 的公网后端明确延期。Runtime 的 TUI/编辑器修复随上游保留，但不通过 Studio Bridge 暴露一个任意 URL 获取面。

### v18.0.0：会话回放、上下文和 inline image

- 新增 omp render，用于回放会话线程和基准测试 transcript pipeline。
- history rewind 改为原地截断 transcript tail，减少清空和重放终端 scrollback。
- 修复 live code block 高亮、provider 部分 thinking replay、Windows transcript layout、粘贴图片缩略图和 compaction token delta。
- provider 请求侧继续完善 inline Base64 image 支持。

Studio 复用 Runtime 的 transcript/session 真值和 CLI 兼容性；omp render 的 Studio 产品 UI、read model 和桌面命令不在本轮虚构，明确延期。

### v18.0.1：pin、Plan、后台 Bash 和历史启动

- Plan review 可以保存到选择的路径并启动新 session。
- 新增 /pin，在 --resume picker 中 pin/unpin session。
- Bash 超过阈值时默认自动转后台。
- recent session 标题进入 history.db 索引，启动扫描使用 mtime 与逐文件 fallback。
- transcript retirement/reflow/resize 使用有序批次和容量驱动的提交。
- 修复异步 V2 remote compaction 在 speculative snapshot 之后丢失 user/tool 消息。
- 启动阶段并行化缓存、auth/config、provider discovery 等独立工作。

Studio 将 /pin 与旧 OAuth /session pin 明确分开：本轮只读取 OMP 的 session pin 真值并在 Host/History 展示，写入继续依赖已验证的上游 /pin command manifest；不新增任意 pin write protocol。

### v18.0.2：更新通道与 Unexpected Stops

- omp update --canary 安装 npm canary dist-tag，omp update --stable 切回稳定通道；选择会持久化并影响启动检查。
- Unexpected Stops 增加 None、Mechanical（默认）和 Smart；Smart 使用小模型做文本停止分类。
- 修复 Windows 自更新在包管理器重装遇到运行中文件时出现 omp 缺失或停留旧版本的问题。
- 修复远程浏览器 relay 广播 client-local CDP URL 等问题。

Studio Desktop 保持 stable/canary 的安装状态、版本比较、激活和回滚语义；Runtime settings 只镜像已列入白名单的 Unexpected Stops 字段，旧 Runtime 没有 snapshot 时诚实禁用。

### v18.0.3：autoRepair 和稳定性修复

- 新增 opt-in edit.autoRepair.enabled：AST parse 失败后由 smol model 修复破损区域，再 parse 验证，失败则拒绝/回滚，并在 tool result 中提供 diff。
- 修复拼写范围越界造成的 cursor drift/text duplication、压缩 transcript tool row 的呈现、超时 fan-out 对 Python/Ruby/Julia kernel 的误杀，以及多选项的 Recommended checked-state。

Studio 本轮把 autoRepair 纳入 Runtime settings 七项白名单，实际 AST 修复行为仍由上游 Runtime 所有；其余 TUI 内部修复由上游实现，不扩大 Bridge surface。

## 3. 上游变化 → Studio 影响 → 已适配映射

| 上游变化 | Studio 影响 | 本轮适配/验证映射 | 状态 |
| --- | --- | --- | --- |
| v18.0.1 /pin session | History 需要知道 OMP 全局 pin；不能与 OAuth pin 混名 | studio-host session-catalog 受限读取 OMP session-pins.json，Host read model 增加 pinned；pin-first 且 pin 内保持原最近活动顺序，分页之后不再打散；History 与项目侧栏展示；缺失、损坏、过大、条目超限、长 id、stale id 安全空集/忽略 | 通过；Host、Renderer 与 App 刷新链路均已验收 |
| v18.0.1 Plan save + new session | Plan action 需要一个独立结果和安全相对路径 | Studio Protocol 增加 mode.plan.review.saveAndQuit/result；transport 双向校验；Runtime mode-control service 与 Desktop session command 接线；PlanCard/QueuedDeck 通过可选 onSaveAndQuit(path) 与 window.prompt 获取 workspace-relative 路径，默认 PLAN.md；取消或空值不调用 | 通过；协议、Host/Runtime seam、Desktop、组件和真实 App 接线均已验收 |
| v18.0.1 Bash 自动后台 | 前景转后台不能误报 terminal outcome，也不能让旧 owner 更新新 job | 复用 Runtime job manager、owner/generation fence、状态 projector 和非终止事件语义；Desktop/Host 只接收生命周期真值，不解析 ANSI/Slash 文本 | Runtime/协议映射和端到端门禁通过 |
| v17.4.1 async compaction/methodOrder/extendedContext | 设置需要可读、可写、可解释，旧 Runtime 不能被假装支持 | runtime-settings-service、Studio Protocol runtime settings contract、client-contract read model/reducer、Host facade/services、transport whitelist/value validation、Renderer SettingsPage/tabs；compactionSpeculation 只读显示 idle/running/armed | 通过；App persist 决策与全门禁已验收 |
| v17.4.1 Code Mode | code_mode_only 模型设置必须和 Runtime 原字段保持同一 identity | providers.openai-codex.codeMode 纳入同一 settings snapshot/set 白名单，不扩充 PlanActionId，不在 Renderer 生成假能力 | 已适配；旧 Runtime 无 snapshot 时禁用 |
| v18.0.2 Unexpected Stops | None/Mechanical/Smart 和 Smart model 需要受控配置 | features.unexpectedStopDetection 与 providers.unexpectedStopModel 进入七项白名单；值和错误由 transport/Host 统一处理，真实无 snapshot 诚实禁用 | 通过；旧 Runtime 无 snapshot 时仍禁用 |
| v18.0.3 edit autoRepair | 新上游能力可在 Settings 显示，但不能由 Studio 复制 AST 修复逻辑 | edit.autoRepair.enabled 只做 Runtime-owned settings mirror；Runtime 继续负责 parse/reparse/reject/diff | 通过；旧 Runtime 无 snapshot 时仍禁用 |
| v17.4.2/v18.0.0 图片 | 需要跨 transport 的单张/总量上限，避免内存和 URL 泄漏 | canonical Base64、允许 MIME 为 png/jpeg/gif/webp，最多 16 张；单张解码上限 16 MiB，总解码上限 64 MiB；严格 alphabet/padding/trailing bits；transport inbound/outbound 和 focused tests | 通过；transport 边界/focused tests 通过，Renderer 内存压力仍属残余风险 |
| v18.0.2 stable/canary update | 版本比较、channel 状态和 Windows 激活要可回滚 | Desktop runtime-install、host composition/factory、runtime artifact/installer manifest；semver comparator 明确 prerelease 边界；stable/canary 选择持久化，激活保留 previous | 通过；安装 e2e 与最终门禁已验收 |
| v18.0.1 history.db/index/startup parallelism | Host 历史列表不能每次 content-scan，也不能把绝对路径/进程信息泄漏 Renderer | session catalog/history workspace read model 复用 agent/session 根；stale/不可读项目条目跳过；Renderer 只收 opaque id、相对展示字段和 pinned | 通过；跨层/边界测试通过，大量 session/真实 IO 压力仍属残余风险 |
| v18.0.0 omp render | 可能诱使 Studio 新造 replay UI 和协议 | 保持 Runtime CLI/manifest 兼容；不新增 render Bridge command、桌面 read model 或产品 UI | 明确延期 |
| v18.0.1 transcript retirement/reflow 与 v18.0.3 呈现修复 | Renderer 必须使用投影的 transcript，不依赖 PTY 文本解析 | Studio conversation/transcript projector 继续以 Runtime event/state 为真值；压缩、退休和 resize 由 Runtime 处理 | 通过；专项回归已完成 |
| pin/overlay provenance | 发布制品必须能回答“哪一个上游 + 哪一组 Studio seam” | upstream.json、series.json、PATCHSET_VERSION、artifact manifest 与 runtime probe 共同断言 18.0.3 / SHA / studio.10 | 通过；签名制品门禁已通过 |

## 4. 架构决策与状态边界

1. **一个 Runtime、一个 AgentSession、一个状态源。** Studio Host 与 TUI 共享上游 AgentSession/SessionManager；不增加第二套 AgentSession、第二套 RPC、TUI 热切换，也不解析 PTY/ANSI 来猜测状态。

2. **Overlay 与 seam 按文件所有权分层。** upstream 不存在的 packages/coding-agent/src/studio/** 和 studio-* tests 进入 omp-patch/overlay，普通源码维护；只改 upstream-owned 文件时才进入四组 seam patch。scripts/omp-seam.mjs 是分组真值，禁止手改 .patch。

3. **根协议是 canonical contract。** packages/studio-protocol 定义 wire contract；vendor overlay 只镜像最小 frame/hello 结构，因为 vendor 是独立 Bun workspace，不能导入根私有包。根 fixtures 和双向验证是兼容权威。

4. **制品身份采用三元组。** upstreamVersion、upstreamCommit、patchsetVersion 必须同时匹配，并派生出 runtimeVersion 18.0.3-studio.10。series.json 记录 digest；manifest 的 patchHashes/overlayHash 与 Runtime probe 一起防止“代码已变但版本名没变”。

5. **读写权限按真值源划分。**
   - Session pin 本轮只做安全读取和刷新后可见；写操作依赖已经验证的上游 /pin manifest，不新增任意写协议。
   - Runtime settings 只开放七项白名单；set 请求带 persist，由 App 决定是否持久化，Runtime 负责值和生存期，不能由 Renderer 直接写任意 settings 文件。
   - Plan save path 由用户输入 workspace-relative 字符串，Host/Runtime 做 canonicalization、workspace 边界和文件操作校验；Renderer 不接收绝对路径。

6. **兼容失败要诚实。** 旧 Runtime 没有 runtime settings/session pin snapshot 时，Host 返回空/unknown，Renderer 显示禁用和原因；不得“空了再回退 fixture”。预览开关只控制显示层 fixture，不进入 protocol/capability。

7. **分页和生命周期顺序固定。** pinned-first 在分页之前做；pin 集合中的排序仍按原最近活动顺序。异步 job 以 owner/generation fence 保护，后台转移不是 terminal event；terminal outcome 只在真实完成、取消或拒绝时产生。

8. **数据最小化和资源上限前置。** Renderer 只拿 opaque session id、workspace-relative path 和展示字段；图片在 transport 入口做 MIME、Base64、单张/总量限制；命令和快照采用 allowlist/exact-key 验证。

## 5. 按层文件范围与所有权

### 5.1 OMP vendor、overlay 与 seam

固定身份和操作脚本：

- omp-patch/upstream.json
- omp-patch/patches/series.json
- scripts/omp-seam.mjs
- scripts/apply-omp-overlay.mjs
- scripts/regen-omp-patches.mjs
- scripts/verify-omp-patches.mjs
- scripts/runtime-artifact.mjs、scripts/runtime-artifact.test.mjs

四个 seam 的权威分组：

- 0001-studio-cli-entry.patch：packages/coding-agent/package.json、src/cli.ts、src/cli/args.ts、src/cli/flag-tables.ts、src/commands/launch-help.ts、src/main.ts、test/main-host-classification.test.ts。负责 Studio host CLI entry、flags 和进程分类。
- 0002-studio-session-runtime.patch：src/plan-mode/approved-plan.ts、src/registry/agent-registry.ts、src/session/agent-session-events.ts、agent-session-types.ts、agent-session.ts、prewalk.ts、session-entries.ts、session-manager.ts、turn-recovery.ts。负责 session origin、prewalk、model/retry/abort 等 Runtime hook。
- 0003-studio-modes-and-pause.patch：src/async/job-manager.ts、src/modes/components/pause-screen.ts、src/modes/controllers/event-controller.ts、src/modes/interactive-mode.ts、src/modes/rpc/rpc-mode.ts、src/modes/types.ts、src/slash-commands/builtin-modes.ts 及 interactive/pause tests。负责 modes、pause、job manager 和后台生命周期。
- 0004-studio-extensibility.patch：src/extensibility/extensions/types.ts、wrapper.ts、src/sdk.ts、src/tools/context.ts 及 extensions-runner test。负责 extension UI transport、SDK 和 tool context plumbing。

本轮相关 overlay：

- bridge-server.ts、bridge-protocol.ts、bridge-dispatcher.ts、studio-host-mode.ts、state-projector.ts
- services/runtime-settings-service.ts
- services/mode-control-service.ts、services/command-manifest-service.ts
- Runtime session/job/plan/telemetry/conversation 等已有 studio services 与 studio-* tests

CHANGELOG.md 在 scripts/omp-seam.mjs 中属于 SEAM_EXCLUDED：它是 fork-local prose，不应进入 patch。

### 5.2 根协议、客户端和 transport

- packages/studio-protocol/src/contracts/runtime-settings.ts，以及 commands.ts、state.ts、index.ts、validation.ts 和 protocol.test.ts。
- packages/client-contract/src/read-models.ts、index.ts、lifecycle.ts、operations.ts；session entry 增加 pinned，Runtime settings/plan result/image operation 使用可选或受限字段保持兼容。
- packages/client/src/reducer.ts、test/reducer.test.ts：处理 snapshot、refresh、job/non-terminal event 和旧字段缺失。
- packages/transport-desktop/src/validate-inbound.ts、validate-outbound.ts、package.json，以及 runtime-mirror-validation.test.ts、prompt-image-validation.test.ts。

Runtime settings 的七个 canonical key：

1. edit.autoRepair.enabled
2. features.unexpectedStopDetection
3. providers.unexpectedStopModel
4. extendedContext
5. compaction.asyncEnabled
6. compaction.methodOrder
7. providers.openai-codex.codeMode

另有只读的 compactionSpeculation 状态：idle、running、armed。它不能被 Renderer 当成写入 key。

### 5.3 Host 与 Desktop

- packages/studio-host/src/session-catalog.ts、test/session-catalog.test.ts：受限读取 session-pins.json，缺失/损坏/过大/条目过多/长 id/stale id 安全降级，稳定 pin-first 排序。
- packages/host-client-api/src/services.ts、facade.ts、events.ts、index.ts、test/runtime-mirror.test.ts：把 Runtime snapshot/command/event 映射为根 read model，避免向 Renderer 传播路径。
- apps/desktop/src/runtime-install.ts、host-composition.ts、host-factory.ts：stable/canary、semver、artifact identity、激活/previous/回滚和 Runtime resident。
- apps/desktop/src/runtime-session.ts、session-commands.ts：Plan saveAndQuit、settings bridge、history/pin refresh、session lifecycle。
- apps/desktop/test/runtime-install.test.ts、runtime-residents.test.ts、history-workspace.test.ts、session-lifecycle.test.ts：安装、版本、session identity、历史和退出语义。
- packages/runtime-installer/src/** 与 test/**：目录安全、manifest、activate/rollback/self-check 的既有真值和回归入口。

### 5.4 Renderer

本轮组件范围：

- apps/renderer/src/SettingsPage.tsx
- apps/renderer/src/settings/tabs.tsx
- apps/renderer/src/i18n/locales/zh.ts、en.ts
- apps/renderer/src/deck/PlanCard.tsx、QueuedDeck.tsx
- apps/renderer/src/HistoryPage.tsx
- apps/renderer/src/sidebar/useProjectHistories.ts
- apps/renderer/src/RuntimeSettings.test.tsx
- apps/renderer/src/deck/PlanSaveAndQuit.test.tsx
- apps/renderer/src/sidebar/useProjectHistories.test.ts

Settings props、Plan save callback、History pinned 显示都保持可选；预览模式使用 demo fixture，真实模式没有 snapshot 时显示禁用空态。App.tsx 的最终聚合、刷新触发和 persist 决策已完成，并由真实 Host 流程和 focused UI/根门禁验收。

### 5.5 明确不在本轮所有权内

- image URL broker 的公网后端、匿名/长期 URL 生命周期和外部下载代理。
- omp render 的产品 UI、桌面菜单、Replay read model 和新的 Studio command。
- Runtime overlay、Installer、transport 之外的无关重构，以及并行 agent 已有的删除/改动。
- 旧 doc/omp-runtime-v17.4.1-upgrade-plan.md；它仍是历史计划。

## 6. 完整验证矩阵

下表是最终门禁矩阵及实际结果。源码、seam、package、App、artifact 和 install 链路均已完成；延期项与残余 symlink TOCTOU 风险不影响本轮已声明的通过范围。

| 层级 | 可执行命令/检查 | 通过条件 | 本轮状态 |
| --- | --- | --- | --- |
| 来源 pin | npm run runtime:verify-source | upstream.json、vendor package version、commit、entrypoint 和 source metadata 一致 | 通过；source SHA 验证通过 |
| 身份文件 | 读取 upstream.json、series.json、PATCHSET_VERSION、package.json；比较 160ed439ac0df594347e7d7018b813a7ffdb5e81 与 studio.10 | 三元组一致，runtimeVersion 派生为 18.0.3-studio.10，digest 未漂移 | 通过 |
| prepatch 基线 | npm run omp:verify:prepatch | 在切 pin/重建前，vendor 上游基线无未声明修改 | 通过 |
| overlay/seam 应用 | npm run omp:overlay:apply | overlay 可幂等复制，四组 patch 按 series 顺序应用 | 通过 |
| seam 生成 | overlay 或 seam 内容变化时执行 npm run omp:patches:regen | patch 由脚本生成；分组完整；CHANGELOG 未进入 patch；series digest/版本同步 | 通过 |
| patch verifier | npm run omp:verify:patches | 每个 patch git apply --check 通过；overlay 不触碰 upstream-owned 文件；finally 反向应用并清理成功 | 通过 |
| OMP TypeScript | 在 omp-patch/vendor/oh-my-pi 执行 bun run check:ts | vendor fork 在 overlay+seam 状态下无类型错误 | 通过；由 omp:verify:patches 验收 |
| Runtime focused | vendor studio agent/session、bridge/manifest、job/modes、transcript、compatibility focused tests | Studio hook 与 v18 上游行为一致；后台 job/terminal 语义无回归 | 通过；459/459 |
| Biome | 在 omp-patch/vendor/oh-my-pi 执行 bun run check:ts（内含 biome check .） | 所有纳入检查的文件格式/静态规则一致 | 通过；4596 files。注意：Biome 属于 vendor 上游门禁，omp-studio 根门禁（npm run check）不含任何 lint/format 检查 |
| OMP metadata | npm run omp:test:metadata | artifact、installer、manifest、目录和 self-check 测试通过 | 通过；23/23 |
| Protocol | npm run build -w @omp-studio/studio-protocol；npm run test -w @omp-studio/studio-protocol | runtime settings、plan result、session pinned、image validation fixtures 通过，protocol 仍 v1 | 通过；纳入 root check |
| Client contract/reducer | npm run build -w @omp-studio/client-contract；npm run test -w @omp-studio/client | 旧 snapshot 缺可选字段安全；pinned、settings、job event 映射稳定 | 通过；纳入 root check |
| Transport | npm run test -w @omp-studio/transport-desktop；npm run test -w @omp-studio/transport-web | runtime mirror whitelist、plan path/result、Base64 MIME/16 张/16 MiB 单张/64 MiB 总量和严格 trailing bits 校验通过；web 侧 pairing/CSRF/origin 与 health 不泄敏 | 通过；两个 transport 均已纳入 root check |
| Host catalog | npm run test -w @omp-studio/studio-host | missing、corrupt、oversize、too-many、long-id、normal、stale、排序和分页测试通过 | 通过；纳入 root check |
| Host API | npm run test -w @omp-studio/host-client-api | snapshot、refresh、command、event 和旧 Runtime fallback 不泄漏绝对路径 | 通过；纳入 root check |
| Runtime installer | npm run test -w @omp-studio/runtime-installer | semver prerelease 边界、stable/canary、manifest、目录安全、activate/rollback/self-check 通过 | 通过；纳入 root check |
| Desktop | npm run typecheck -w @omp-studio/desktop；npm run test -w @omp-studio/desktop | runtime resident identity、history workspace、session lifecycle、Plan saveAndQuit、unexpected stop 非 terminal 事件通过 | 通过；190 |
| Renderer type/build | npm run typecheck -w @omp-studio/renderer；npm run build -w @omp-studio/renderer | exactOptionalPropertyTypes、App 接线、preview/real 分支和 i18n 无错误 | 通过；390 |
| Renderer focused | npm run test -w @omp-studio/renderer -- src/RuntimeSettings.test.tsx src/deck/PlanSaveAndQuit.test.tsx src/sidebar/useProjectHistories.test.ts | 缺省禁用、七 key onSet、preview 不调 Host、compaction 状态、PLAN.md/default/cancel、QueuedDeck 透传、History pinned 排序展示通过 | 通过；focused UI 31 |
| Root package gates | npm run check | 根 packages、Desktop、Renderer、协议、transport 和静态门禁全部通过 | 通过 |
| Host artifact | npm run omp:build:host | Windows omp.exe 成功构建并可探测 | 通过；omp:build:host 成功 |
| Binary identity | 构建出的 omp.exe --version、--smoke-test 和 authenticated identity probe | CLI --version 输出 omp/18.0.3；认证 identity probe 输出 18.0.3-studio.10；hello、manifest hash 和 patchset 一致 | 通过；两种身份已明确区分 |
| Install e2e | npm run omp:e2e:install | 签名/校验、channel 选择、安装、activate、previous 保留、rollback、hello、manifest、graceful shutdown 全链路通过 | 通过；已安装并激活 win32-x64 |
| 最终断言 | 复核 upstreamVersion=18.0.3、upstreamCommit=160ed439ac0df594347e7d7018b813a7ffdb5e81、patchsetVersion=studio.10、runtimeVersion=18.0.3-studio.10、protocol=1、unclassifiedBuiltins=[] | 无身份漂移、无未声明 capability、vendor verifier 清理完成 | 通过 |
| 工作树卫生 | git diff --check；限定路径 git status/diff；确认不纳入 node_modules、dist、artifact、日志、截图、密钥和无关删除 | 只审查本轮所有权，保留并行 agent 的用户改动 | 通过；diff-check 通过；本轮文件按文档范围审查，用户原有删除/无关改动保持未触碰；artifact/build 输出不纳入 Git |

### 6.1 制品能力镜像漂移修复与最终 provenance

本轮制品门禁曾发现 capability mirror 与 Runtime 真实 manifest 漂移。门禁在签名/发布前拒绝了该制品，随后修正镜像并重新生成/验证制品；因此这次漂移没有进入可安装发布结果。最终验收值如下：

| 项目 | 最终值 |
| --- | --- |
| capability 数量 | 74 |
| capability hash | sha256:1f83035b0213b70329564a1b1b0e966421d94850bf6fdb932a6263f02c670e9a |
| command hash | sha256:dcd545345750eb28809f0f7f080de4ae8049855adc1db239130b1df70931ef3a |
| manifest SHA256 | afdc61cc9b9e563e94ae0ba64350e90e1dc6abd86349c2d02750be5ccbb46bae |
| Runtime artifact 目录 | packages/runtime-installer/dist/artifacts/win32-x64/18.0.3-studio.10 |
| artifact 文件 | runtime-manifest.json、checksums.json、runtime-signature.json、omp.exe |
| binary CLI identity | omp/18.0.3 |
| authenticated Runtime identity | 18.0.3-studio.10 |
| unclassified builtins | 0 |

CLI 的 omp/18.0.3 是上游程序版本输出；authenticated identity probe 的 18.0.3-studio.10 才包含 Studio patchset。两者必须同时保留，不能用其中一个覆盖另一个。能力镜像漂移修复后，capability hash、command hash、manifest SHA256、series digest 和 Runtime probe 形成一致 provenance 链。

执行 omp:overlay:apply、omp:verify:patches 或 regen 前，先确认没有另一 agent 正在使用 vendor 工作树；这些命令可能复制、应用或清理共享的 vendor 状态。

## 7. 备份、回滚与恢复

### 7.1 备份规则

本次从上一版实施文档收束并改名为 studio.10 前，已先把精确源文件保存到：

    backup/2026-08-23/omp-runtime-v18.0.3-studio-doc-final-231714/doc/omp-runtime-v18.0.3-studio.9-implementation-plan.md

同一备份目录的 README.md 记录了时间、原因、相对路径和恢复步骤。源文件随后安全改名为本文件；旧源路径不再存在，目标路径已确认存在。任何后续修改既有源码、配置、脚本、协议或文档，仍必须先创建：

    backup/YYYY-MM-DD/<task>-HHmmss/

备份保持原项目相对路径，并附 README.md 记录原因、来源提交、文件清单和恢复步骤。旧 v17.4.1 计划中的迁移备份约定为 backup/2026-08-22/omp-runtime-v17.4.1-HHmmss/；它只属于旧计划，不能当作本轮新备份或被覆盖。

### 7.2 安全回滚顺序

1. 停止 Desktop、Studio Host 和正在运行的 omp.exe；保留日志、manifest、checksum、diagnostics 和 active/previous 目录现场。
2. 通过 installer 的 rollback/previous 机制切回上一份已验证制品；不要直接删除 current 或 previous，也不要用未校验的目录替换当前运行版本。
3. 在根仓库和 vendor 分别执行限定路径 git diff/status，确认要恢复的文件确实属于本轮。禁止使用 git reset --hard、git checkout --、根目录 git add -A 或在 fork 已应用时执行 git submodule update。
4. 若需回退 Runtime pin，把 vendor detached checkout 恢复到已确认的前一 pin（本轮 README 的初始审计基线为 45e12e5bb758198a920c6070e7e64cb33b21beac；旧 v17.4.1 目标 9350b7990d26ebf69a604edc82d8558ef04adf30 仅在明确选择旧版本时使用），再按对应备份恢复 upstream.json 和 series.json。
5. 用 overlay/seam 的正式脚本移除/反向应用，不手删 overlay、不手改 patch；执行 npm run omp:verify:patches 确认清理和可逆性。
6. 重新运行 runtime:verify-source、protocol/Host/Desktop/Renderer typecheck 和最小 test 集，确认 Protocol v1、capability manifest 和 Runtime identity 没有半回滚状态。
7. 只有在所有权和备份核对无误后，才让 installer 重新激活；回滚结果写入任务日志，不删除故障制品以便诊断。

### 7.3 局部回滚注意点

- 只回滚 Renderer 会使真实 settings/plan/pin 入口与 Host 能力不对齐；先关闭入口或保持 optional props，再回滚协议和 Host。
- 只回滚 Runtime settings service 会让旧 snapshot 缺字段，Renderer 必须进入 honest disabled，而不是使用 preview fixture。
- 只回滚 patch 文件而不同时回滚 series digest/PATCHSET_VERSION，会在 artifact probe/signing 阶段被拒绝。
- 安装通道回滚必须保留 channel 选择与 previous identity 的审计信息，不能把 canary 目录直接重命名成 stable。

## 8. 明确延期与不做的事

### 8.1 image URL broker 公网后端

上游 v17.4.2 的 images.urls.enabled 只说明 Runtime 可以通过有序 backend 发布 URL，不提供 Studio 可以安全公开的后端。延期原因：

- 需要认证、授权、生命周期、过期、撤销、审计和下载权限边界。
- 公开 URL 可能把本地/工作区图片变成长期可访问资源。
- Renderer 不应把任意 URL 当作 Host 真值或自动下载入口。

本轮固定使用 inline Base64 的 canonical transport contract 与资源上限；未来若实现 broker，必须另建受认证的 Host/backend contract，并重新做安全审计和兼容矩阵。

### 8.2 omp render 产品 UI

v18.0.0 的 omp render 继续作为上游 CLI 能力和 manifest 兼容项；本轮不增加 Studio render command、Replay 页面、transcript read model 或桌面菜单。需要产品 UI 时另立工作包，先定义权限、数据量、回放一致性和取消/进度语义。

### 8.3 任意 pin 写协议与任意 settings 写入

本轮 session pin 只做 OMP 真值读取和显示刷新，写入依赖 manifest 已验证的 /pin；Runtime settings 只做七项白名单，persist 由 App 决策。不得为了方便向 Renderer 开放文件路径或任意 key/value 写接口。

## 9. 残余风险

### P1/P2：父目录 symlink 的 TOCTOU

当前路径安全主要做 canonical path/parent 检查，然后在后续 write、rename、activate 或 saveAndQuit 中使用该路径。若攻击者或并发进程在检查与使用之间替换父目录 symlink，检查过的真实目录与最终写入位置可能不一致。重点影响：

- Plan saveAndQuit 的 workspace-relative 写入；
- Runtime artifact/installer 的 active、previous、staging 目录；
- session/history 文件和 pin 文件的父目录。

这是当前残余风险，不应在本轮文档中宣称已经消除。后续应考虑 Windows 可用的 no-follow directory handle、逐级拒绝 symlink、紧邻提交前再次 canonicalize/revalidate，以及在已验证父目录下原子 create/rename。Renderer 继续只提交相对路径，Host 保留最终边界检查。

### 其他残余项

- App 的最终 settings、Plan、History 刷新聚合已完成并通过真实 Host 流程；后续改动仍需重新跑 focused 与 root gates。
- vendor 在 overlay+seam 开发态重新产生 dirty 状态后，若未经 verifier 清理，不能直接作为发布制品。
- 旧 Runtime 可能没有 runtime settings 或 global pin snapshot；必须保持 disabled/empty，而不是填充 fixture。
- 大量 session、stale pin、跨项目 history 和首次启动并行读仍需真实 Windows/IO 压力验证。
- 图片虽然有 16/16 MiB/64 MiB transport 上限，但解码器、缩略图和 Renderer 渲染仍需内存压力测试；限制不能被下游重新复制成无界 buffer。
- stable/canary 的 semver 边界、包管理器运行中文件和签名失败路径本轮安装 e2e 已通过；后续改变 installer 或版本比较器时仍需重新执行 Windows activation。
- 上游 transcript/reflow、fan-out timeout 和 autoRepair 的内部语义由 OMP 所有，Studio 只能通过事件/snapshot 观察；若上游改变事件序列或字段，必须重新做 protocol compatibility audit。

## 10. 给后续 agent 的执行清单

以下命令按顺序执行；遇到共享 vendor 正被其他 agent 使用时先停在对应步骤，不能强行清理工作树。

~~~powershell
# 0. 只查看本轮范围，确认没有误纳入并行改动
git status --short
git diff --check
git diff -- omp-patch/upstream.json omp-patch/patches/series.json scripts/omp-seam.mjs

# 1. 来源和 pin
npm run runtime:verify-source
npm run omp:verify:prepatch

# 2. 应用/验证 OMP fork；只有 seam 有合法修改才 regen
npm run omp:overlay:apply
npm run omp:verify:patches
# npm run omp:patches:regen

# 3. OMP 源码和 metadata
Set-Location omp-patch/vendor/oh-my-pi
bun run check:ts
Set-Location ../../..
npm run omp:test:metadata

# 4. 根 packages
npm run build -w @omp-studio/studio-protocol
npm run test -w @omp-studio/studio-protocol
npm run test -w @omp-studio/transport-desktop
npm run test -w @omp-studio/studio-host
npm run test -w @omp-studio/host-client-api
npm run test -w @omp-studio/client

# 5. Desktop/Renderer focused and package gates
npm run typecheck -w @omp-studio/desktop
npm run test -w @omp-studio/desktop
npm run typecheck -w @omp-studio/renderer
npm run test -w @omp-studio/renderer -- src/RuntimeSettings.test.tsx src/deck/PlanSaveAndQuit.test.tsx src/sidebar/useProjectHistories.test.ts
npm run build -w @omp-studio/renderer

# 6. 全门禁（本轮已完成；后续改动需重跑）
npm run build
npm run typecheck
npm test
npm run omp:build:host
npm run omp:e2e:install

# 7. 最终身份和文档 diff
git diff --check -- doc/omp-runtime-v18.0.3-studio.10-implementation-plan.md
git status --short -- doc/omp-runtime-v18.0.3-studio.10-implementation-plan.md
~~~

最终 handoff 已报告：上游 SHA、studio.10 patchset/digest、Runtime probe 的双重 identity、vendor verifier、package/Renderer/installer tests、App 最终接线、capability/command/manifest hashes，以及未关闭的 symlink TOCTOU 风险。

## 11. 本轮交付口径

本文件是 OMP Runtime v18.0.3 / Studio.10 的最终实施与验收记录，最终签字已完成。App 接线、源码 SHA、overlay/seam verifier、根门禁、focused tests、能力镜像修复、Runtime 构建、双重 identity probe 和 win32-x64 安装激活均已记录为通过；image URL broker 公网后端、omp render 产品 UI 仍按约定延期，父目录 symlink TOCTOU 仍是后续安全工作项。共享工作树仍含其他用户/agent 的无关改动，不纳入本轮。
