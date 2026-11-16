# OMP 18.20.2：前端接续交接

## 最初交给前端 Agent 的文本（阶段记录）

> 请在 `D:\Project\omp-studio\.claude\worktrees\omp-18.20.2-backend` 接续 OMP 18.20.2 的前端适配与设计。该工作树位于 `feat/omp-18.20.2-backend`，后端改动尚未提交；只切到同名分支或另开工作树不会自动得到这些未提交内容。Runtime 已固定到 `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`，本轮只改 Runtime、Host、Desktop 主进程与共享契约，没有改 `apps/renderer` 或 `website`。请先读本文、`doc/feature-index.md` 和迁移报告，再接入模型真值/刷新与 Antigravity 状态、原生选择性提交、辅助请求政策/高级设置、OAuth 暂停、语音政策、恢复目录选择、删除部分清理警告、Computer 安全状态、Benchmark 账户、流式 fork、输入历史和 generic select。富文本粘贴仍是前端待办。所有新增读表面必须成对实现真实数据与 preview，中英文齐全，沿用现有 Dock、选择器、motion/tokens 和媒体链路；不得复制 Runtime 政策、解析 slash/ANSI、把正文或密钥放进 reducer，也不得自动登录、付费调用、提交/推送或替换安装版。后端最终验证范围以迁移报告为准，不能把后端通过当作 GUI 已验收。

## 交付与调用约定

> 2026-11-16 接续：前端已接入，复核的 15 项问题均已实施修复，源码修订为 `18.20.2-studio.5`。Bash 编辑读取原始配置层；恢复准备使用 Host 返回的 `threadId` 执行恢复。原始交接文本保留为阶段记录，新增调用约定见第 3、4 节；全量 Renderer 的 2,081 项回归与生产门禁已通过；同源签名 canary 和未完成的 GUI／平台复验见[收尾报告](../reviews/omp-18.20.2-frontend-fixes-2026-11-16.md)。`studio.3` 证据只属于先前后端阶段，`studio.5` 本地 canary 也不代表正式发布。

- 原始工作区 `D:\Project\omp-studio` 的既有前端、网站及其他 WIP 未被带入或覆盖。该后端工作树基于创建时的 `0.2.0` 提交；不要用原工作区整树覆盖它。
- 当前源码修订为 `18.20.2-studio.5`（以后以 [`series.json`](../../omp-patch/patches/series.json) 为准），Studio 产品版本仍为 `0.2.0`。vendor 已施加 fork，不要对它运行 `git submodule update` 或 reset。后端验收见 [迁移报告](omp-18.20.2.md)。
- 公共输入/返回值以 [`client-contract/operations.ts`](../../packages/client-contract/src/operations.ts)、[`read-models.ts`](../../packages/client-contract/src/read-models.ts) 为准，领域类型在 [`studio-protocol/contracts`](../../packages/studio-protocol/src/contracts/)。
- 下文的 **query** 走既有 `ClientQueryRequest`；**command** 走既有命令回执，等待终态，不把 accepted 当成功。
- Workbench command 的业务结果位于 `{ snapshot, result }` 的 `result`；ModelServices command 有自己的直接返回类型。不要统一猜测每个命令的结果嵌套。
- 新功能先走现有能力探测。旧 Runtime 缺能力时显示明确禁用原因，不回退到向模型发送 slash、解析终端或偷偷启动另一个 Runtime。

## 1. 模型、刷新、OAuth 与 Antigravity

主要契约：[`model-services.ts`](../../packages/studio-protocol/src/contracts/model-services.ts)。

### 模型配置页优先继续使用 `models.get`

- `availableModels` 来自当前 Runtime 的原生 registry，不再读取 Host 的 `model_cache` SQL。
- `availability.status` 为 `verified | unverified`，`source` 为 `runtime | none`；可附带 `sessionId/version/total/truncated/reason`。
- 没有 Runtime 仍能编辑配置、查看静态推荐目录；这不意味着模型已授权或可调用。真实页不得拿推荐列表填充 `availableModels`。
- 模型条目保留原生 `kind/api/thinkingConfig`、输入模态、工具/Computer 能力、上下文/输出上限、价格及 discovery 元数据。Judge 模型不要放入普通聊天选择器；无价格或未知值不要显示为免费。
- 已保存但失效的角色仍应展示并让用户修正，不能自动替换分配。

### 刷新与手动分页

| 操作 | 方式 | 输入 / 结果 |
| --- | --- | --- |
| `models.discovery.refresh` | command，兼容旧入口 | `{}`；有 Runtime 时转发原生刷新，完成回执的 `runtimeEffect` 为 `immediate`，然后重读 `models.get` |
| `models.available.refresh` | command | `{ sessionId }` → `{ sessionId, refreshed: true }`；不在回执中带全目录 |
| `models.available.read` | query | 首页 `{ sessionId, providers?, limit? }`；后续 `{ sessionId, cursor }` |
| `models.available.release` | query | `{ sessionId, snapshotId }` → `{ released }` |

分页结果为 `{ sessionId, snapshotId, version, expiresAt, cursor, nextCursor?, total, truncated, models }`。cursor 不透明，绑定同一原生 session/registry/凭据/设置代次。不要拼接不同 snapshot 或 version；关闭、换目标、取消时释放租约。分页失效时丢弃旧页并从首页有限重取，不能无限重试。`models.get` 已在 Host 完成有界分页、失效重取与释放，普通模型页不必再复制一次。

当前 Runtime 刷新失败或缺能力时不降级到 CLI。完全没有 Runtime 时，旧刷新入口仍可更新给未来会话使用的 CLI 缓存，但页面可用性继续是 `unverified`。

### 登录与暂停

继续用 `models.auth.providers.read` 的动态名单，以及 `models.auth.login/cancel/key.set/key.remove/unpause`。新增 `paused/pauseReason` 与凭据状态分开显示。只有明确的操作者恢复动作调用 `models.auth.unpause`；读取、普通登录或项目设置不能替用户接受暂停警告。登录等待与原生最长 600 秒对齐，关闭/取消必须取消后台登录，不能只关闭卡片。

### Antigravity CLI

`models.antigravity.readiness` 是无副作用 query：`{ sessionId }` →

```ts
{
  providerId: "antigravity-cli",
  installed: boolean,
  authenticated: boolean,
  bridgeReady: boolean,
  status: "not-installed" | "not-authenticated" | "bridge-unavailable" | "ready" | "error",
  version?: string,
  source?: "managed" | "override",
  error?: string
}
```

此读取不安装、不登录、不刷新 OAuth、不接受风险提示。`ready` 表示本机安装/凭据来源/桥接条件具备，不等于付费推理或账户额度已实测。API 为 `antigravity-acp`，不是可保存普通 base URL 的 HTTP provider；不要借用旧 Antigravity usage 数据。Runtime 私有同源 relay 已接入，UI 不应要求安装 `nc`、修改 PATH 或传入可执行文件路径。

## 2. 选择性提交：先预览，后确认

主要契约：[`selective-commit.ts`](../../packages/studio-protocol/src/contracts/selective-commit.ts)。建议复用 Git/Changes/Diff 与 Agent 入口，打开一个会话级面板，普通手动 Git 提交保持原样。

| 操作 | 方式 | 输入 |
| --- | --- | --- |
| `commit.draft.prepare` | query | `{ sessionId, scope?: string | string[] }` |
| `commit.draft.read` | query | `{ sessionId, draftId, revision, body? }` |
| `commit.draft.select` | command | `{ sessionId, draftId, revision, selection }` |
| `commit.draft.preview` | query | `{ sessionId, draftId, revision }` |
| `commit.draft.execute` | command | `{ sessionId, draftId, revision, previewId, message, options? }` |
| `commit.draft.release` | query | `{ sessionId, draftId }` |

- draft 返回 `{ sessionId, runtimeEpoch, expiresAt, view }`。`view` 有原生 `id/revision/head/branch/caller/scope/agents/state/paths/staged/skipped`。
- `paths/hunks/units` 包含原生 ID、`own/other/review` 归属、`none/partial/all` 选中状态和原因。完全沿用原生预选；不要从会话 Diff 猜归属，也不要自动选上 `other/review`。
- `selection` 是 `{ action: "take" | "drop", path, units? }` 或 `{ action: "only", paths }`。`only` 按原生 glob/路径匹配缩小已有选择，不会把未选项自动选上；显式选入一个文件使用 `take`。每次选择后使用返回的新 revision，并使旧确认失效。
- 文件正文使用 `body: { kind: "file", path, offset? }`；冻结预览正文使用 `{ kind: "preview", previewId, offset? }`。返回 `text/offset/totalChars/nextOffset?`，按 `nextOffset` 继续读，不自行按字节推算。正文只留面板临时内存。
- `binary/non-utf8/large/symlink/mode` 是原生整项选择；`text: null` 不是空文件，不伪造文本 hunk。
- `preview` 返回 `{ draftId, revision, previewId, head, tree, bytes, paths, expiresAt }`。用户确认必须绑定这份预览；HEAD、选中内容、session/agent/Runtime 或 revision 变化后重新准备/预览。
- `message` 为 `{ subject, body?: string | string[], fixes?: (string | number)[] }`；`options` 为 `{ amend?, noVerify? }`。这两个危险选项仅在用户明确选择时启用，不默认跳过 hooks，也不自动付费生成提交信息。
- 成功返回 `{ sha, subject, paths, parent, indexNotes }`。显示 index 提示；不要从 toast 或 accepted 推断提交成功。关闭/切会话时 release draft。

`operator.invoke { commandId: "builtin.commit", arguments? }` 不会直接提交或发起模型请求；其命令结果包含 `requiresConfirmation: true` 与 `selectiveCommit: { draftId, revision, runtimeEpoch, expiresAt }`，并保留原生自由文本 `instructions`。据此打开同一个确认面板。其他原生命令返回的 prompt 已由 Runtime 消费，前端不得再次发送。

## 3. 辅助请求政策、高级设置与语音

继续使用 `preferences.features.get/set/clearOverride`。set 输入 `{ sessionId, key, value, scope: "session" | "global" }`；读取与保存结果都含原生 `value/source`，不要在 UI 模拟持久化优先级。

`studio.5` 为 `bash.patterns` 另提供 `editableValues: { global, session }`：它们是目标层的原始配置，未混入项目规则、未展开路径分组；`session: null` 表示没有本层会话覆盖。编辑器只保存所选层，路径分组原样保留，不能把生效 `value` 写回全局。旧 Runtime 缺少此字段时规则编辑只读。`shellPath`、`find.verifyModel` 可提交空字符串恢复原生默认行为。

新增键：

- `models.noJudge`、`models.noSpotlight`、`models.offline`
- `find.verifyModel`、`find.hitThreshold`
- `encourageEdits`、`commit.enabled`、`todo.midRunNudges`
- `shellPath`、`bash.allowedEnvVars`、`bash.patterns`
- `ttsr.repeatMode`

`offline` 是辅助模型的 Provider 使用政策，不是断网开关；`noJudge/noSpotlight` 也不要描述成关闭全部 Judge/所有请求。范围、默认值和限制以原生 metadata/返回结果为准，不按模型名字硬编码政策。

语音配置新增 `providerPolicy: { mode: "unrestricted" | "active-provider", activeProvider? }`，`blockedReason` 新增 `provider-restricted`。固定配置、自动选择、准备与上传均走同一原生政策。显示实际配置身份与阻止原因，不只把按钮置灰后仍上传音频。

## 4. 恢复目录、删除与流式 fork

- `worktrees.session.resume.prepare` 是既有 Workbench **command**。输入增加 `executionWorkspaceId?`（必须是 Host 已登记的工作区）；不能传私有 `executionCwd`。
- 返回 `requestedSessionId/targetSessionId/recordedCwd/cwd/executionCwd?/workspaceId?/threadId?/requiresWorkspaceSelection`。`cwd` 只是 `recordedCwd` 的旧显示别名，绝不能当执行目录；`threadId` 由 Host 在准备就绪后签发，不由前端根据 session ID 拼接。
- `requiresWorkspaceSelection: true` 时，让用户选择已有目录并通过 `executionWorkspaceId` 重新 prepare；随后使用同一 facade/context，以 Host 返回的 `threadId` 调用 `session.resume`，等待终态成功后再读取目标工作区历史。不要复用“先查历史、再打开导入会话”的回调，因为恢复前 transcript 仍记录旧目录。准备结果五分钟有效，新准备会淘汰旧别名，不自动创建缺失目录。
- 失败会保留当前健康 Runtime 和活动工作区；前端不能在终态成功之前自行切走/清空当前对话。
- `session.delete` 对外仍返回 `ConfigWriteResult`。底层 `nativeCleanup` 可为 partial，但公开 UI 当前通过回执 `message` 得到警告；完整显示该消息，不把 `applied:true` 写成“所有历史/统计已完全清理”。
- Runtime 现在允许流式 `session.fork`、`session.tree.branch`，内部完成 abort → settle → 分支/重绑；排队和异步准备的旧输入不会被转送到新会话。前端可移除这两项仅因 streaming 的禁用，但保留确认、能力与真实错误处理。`session.tree.navigate` 仍有忙时限制。
- Fork 后按返回的新 session publication 更新对话归属，不沿用旧草稿、待发送队列或旧会话的异步回调。

## 5. Computer 安全状态

契约：[`computer-workspace.ts`](../../packages/studio-protocol/src/contracts/computer-workspace.ts)。

- `capabilities.globalEscape` 已是当前有效的全局 Escape 能力。新增 `secureInput/secureInputApp`，系统安全输入启用时不能仍显示全局逃生可用。
- `screen.lockKnown` 与 `screen.sleepKnown` 分开；`screen.known` 只是旧版两者的合取。Windows 能识别锁定不等于已知休眠状态；缺字段/未知不能画成安全可操作。
- 操作增加 `unconfirmed` 与 `focusReturn: { handedBack, previousPid?, frontPid? }`。如实展示未确认效果和焦点是否交还，不用“请求过”冒充“已执行”。
- 沿用原来的控制 revision/lease、私有帧、焦点和输入链路，不另建 OS 控制层。

## 6. Benchmark / Evaluation 的账户选择

- `benchmarks.accounts.read` 沿现有 Workbench **command** 路由：`{ sessionId, providerId }` → `{ providerId, accounts: [{ account, credentialId, label }] }`。
- `BenchmarkSpec.account` 与 benchmark 类型的 `PerformanceEvaluationSpec.account` 为 `{ account, credentialIds: Record<string, number> }`。`account` 是原生一基序号，同时带对应 Provider 的稳定 credential ID；名单变化会拒绝旧选择，不静默改选另一个账户。
- `BenchmarkSpec` 新增 `serviceTier?`；使用原生支持值及现有评测确认，不自行复制 flags 或 HTTP 调用。
- 创建/执行仍可能付费，必须保留显式确认。演示账户只在 preview，不向真实服务提交 fixture IDs。

## 7. 输入历史与 generic select

### Prompt history

| 操作 | 方式 | 输入 |
| --- | --- | --- |
| `history.prompts.list` | query | `{ sessionId, scope?: "profile" | "workspace" | "session", limit?, query? }` |
| `history.prompts.read` | query | `{ sessionId, scope, id, revision }` |
| `history.prompts.delete` | command | `{ sessionId, scope, id, revision }` |

默认 workspace，列表默认 50、最多 200 项；返回 `{ sessionId, scope, items, truncated }`。条目有 `id/revision/preview/createdAt/useCount/cwd?/sourceSessionId?`。只按需读取正文，`read` 的 `truncated` 必须可见，不能把截断正文当完整提示词。点击插入只编辑 Composer，不自动发送。删除使用列表那一版 `id/revision/scope`；提示词被再次提交或目标改变后刷新列表再确认。此功能只操作原生 prompt history/FTS，不是 `session.delete`，也不是 Ctrl+R 按键模拟。

### Generic select

Remote UI → Bridge → 客户端交互模型已保留 `initialIndex/selectionMarker/checkedIndices/markableCount`。按请求的 option ID 返回答案，保留取消与 `leaseGeneration`。

`selectionMarker: "checkbox"` 是原生逐次选择界面的显示状态，不自动等于 `multiple: true`；不要仅因画了复选框就把返回类型改成数组。`markableCount` 之后的 Other/Done 等动作不画选中标记。原生循环与回调仍在 Runtime，UI 不接收函数、不复制选择状态机，也不改已完成的 HTML Form 主链。

## 8. 当前前端状态与验收边界

前端已接入上述页面／面板及富文本粘贴。`text/html` 转换复用 ChipComposer/serialize/附件/缩略图，不执行 HTML、不自动抓远程图片、不把图片字节放入 reducer；复核后已补齐 SVG 附件，并使嵌套表格只转换所属行一次。

15 项复核问题的实现修复与定向回归已完成，当前门禁和同源 canary 证据见[收尾报告](../reviews/omp-18.20.2-frontend-fixes-2026-11-16.md)。当前修复的 Browser/GUI 复验仍未完成，不能将单元、契约或 canary 通过当成界面验收。所有新读表面继续遵守以下约定：

- preview 与真实模式共用组件；preview 只读 fixture、演示按钮只改本地；真实模式没有数据就诚实空态，不做 mock fallback。
- `marks=off` 隐去演示专用提示；保持原有全局预览开关，不新增 Host capability。
- 新文案提供中文和英文，并在同一挂载页验证 `zh → en → zh`，不丢草稿或选择。
- 按本次变更范围验证窄/宽容器、主题、减动效、打开/关闭/切会话/取消/过期/失败；通过实际页面交互和日志验收，而不是只跑 fixture 测试。
- 后端 canary、源码与测试证明不能替代真实 OAuth/ACP 登录、付费请求、macOS Secure Event Input/焦点、Linux/macOS 制品或新的 GUI 验收。
