# incremental-updates 分支审查（2026-09-18）

结论：存在 4 项 P1 和 3 项 P2，建议修复后再合并、发布。现有门禁全部通过，但没有覆盖下面的事务中断、组件组合和连续发送场景。本次是审查，没有修改产品代码、提交、发布或安装应用。

## 审查范围

- 分支 `codex/incremental-updates`，HEAD 与本地 `main` 均为 `a1b6513`；没有相对 main 的新增提交，审查对象是全部工作区修改和新增文件。
- 包含签名清单、Runtime ZIP、发现和差分下载、更新事务、IPC、Host 启停及会话恢复、Renderer 更新入口、NSIS/C# 迁移、发布 workflow/脚本/依赖与文档。
- 包含 `App.tsx`、`composer/dispatch.ts`、对应测试和 CHANGELOG 中的新会话/排队归属修复。
- vendor 用独立临时 Git index 重建接缝结果进行只读比较：受 Git 跟踪文件没有超出已管理接缝的改动，79 个 overlay 文件与源目录一致（忽略 CRLF/LF）。没有修改 vendor 工作树或真实 index，也没有执行会反向修改它的 patch gate。
- 既有 `docs/reviews/performance-review-2026-09-12.md` 是此前的未跟踪审查资料，不作为本轮新增产品代码。

## 问题

### R1 · P1 · Runtime 激活后的崩溃重启会丢失回滚目标

位置：`apps/desktop/src/update-coordinator.ts:125–130`。

`initialize()` 先保存 `runtimeTrial`，然后激活新 Runtime，最后才保存清除 pending/authorized 的 journal。如果进程在激活成功后、最后一次保存前退出，下次启动会再次进入同一激活路径。此时 `installer.current()` 已是候选版本，代码会用没有 `previousVersion` 的新 trial 覆盖原 trial。随后真实会话启动失败，`completeStartup(false, true)` 返回“没有可回退的 Runtime”，即使 `current.json.previousRuntimeVersion` 和旧版本文件仍然完整。

已用真实签名 fixture、RuntimeInstaller 与 Coordinator 复现：`18.0.0-studio.1 → studio.2`；模拟该磁盘检查点后重启，trial 丢失 previousVersion，回滚返回 false，current 仍为 studio.2。

建议：恢复已有 trial 时保持其原始回滚目标；对“候选已经激活”的状态做幂等续跑，不重新推导/覆盖旧版本。补激活前、激活后、最终 journal 保存前后的故障注入测试。

### R2 · P1 · 最终应用阶段允许不兼容的 pending 桌面与 Runtime 组合

位置：`apps/desktop/src/update-coordinator.ts:252–262`。

兼容性只在准备 Runtime 时检查，而 `apply()` 仅在没有 pending Runtime 时校验当前 Runtime。准备好的 Runtime 可以跨检查、跨启动保留；之后准备另一个协议版本的桌面包，就能形成协议不相交的 pending 组合。`prepare("all")` 也会先保存桌面包，若随后 Runtime 兼容性检查失败，之前的 pending Runtime 没有被清除。Renderer 只要有任一 ready 组件就允许点击重启。

已复现：先在协议 1 的桌面准备协议 1 Runtime，再准备协议 2 桌面；`apply()` 返回 `{ok:true}` 并调用安装器。新 Main 启动时才会拒绝旧协议 Runtime；现有有效 Runtime 又会让 seed 路径直接返回 already-installed，不能依靠内置工件自动兜底。

建议：最终 apply 前，针对最终桌面版本/协议与最终 Runtime（pending 或 current）重新验证协议交集和 minAppVersion。失败应保持应用运行，不启动安装器。补跨次准备、部分准备失败和更换待更新组件的集成测试。

### R3 · P1 · 桌面复用旧 Runtime 会遮蔽较新的独立 Runtime 发布

位置：`scripts/build-update-assets-v2.mjs:50–60`，消费端 `apps/desktop/src/update-discovery.ts:44–48`。

每次桌面发布都会给所携带的 Runtime 分配新的最大 sequence，即使该 Runtime 是复用的旧版本。发现逻辑只选最大 sequence。因此，先独立发布 R2，再从仍携带 R1 的桌面分支发布新桌面时，新清单中的 R1 会遮蔽 R2；已装 R1 的客户端比较版本后得到“没有 Runtime 更新”。现有的同版本字节校验不能阻止此情况。

已复现消费行为：R2=`18.0.0-studio.2/sequence=2`，后发桌面携带 R1=`studio.1/sequence=3`，发现结果选中 R1。

建议：将桌面内置 seed 与独立 Runtime 更新候选分开；或者在发布时拒绝将旧版本提升为该通道的新更新序号，并保留最新 Runtime 候选。补“独立 Runtime 更新后发布仅桌面改动”的序列测试。

### R4 · P1 · 全机迁移没有等待 NSIS 实际卸载完成

位置：`packaging/installer-host/InstallerHost.cs:70–76`。

迁移直接运行旧安装目录中的卸载器，并等待该进程；参数没有 NSIS 的 `_?=`。NSIS 默认把卸载器复制到临时目录，再启动真正的卸载进程，原进程随即退出。因此这里得到的退出码只能表明卸载子进程启动成功，不能证明旧安装已卸载或得到它的失败结果。新安装器可能继续完成并启动新应用，而旧卸载器仍执行旧版按进程名全局结束 Studio/omp 的逻辑，存在刚启动的新应用被结束的竞态。

代码证据：当前依赖 `node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh:224–230` 使用临时卸载器加 `_?=$installationDir` 等待实际操作；NSIS exehead Main.c 的自复制分支在 CreateProcess 后 CloseHandle 并退出。此项是静态代码/NSIS 实现审查结果，没有在用户机器执行卸载实验。

建议：按 NSIS/electron-builder 支持的方式启动并等待实际卸载进程，确认旧卸载项/文件结果后再允许重新拉起应用；覆盖卸载成功、失败、取消和慢卸载时序。

### R5 · P2 · 新建会话期间第二次发送会绕过本地排队与发送互斥

位置：`apps/renderer/src/App.tsx:4199–4206`、`4445–4451`；`composer/dispatch.ts:120–121`。

这次修改正确隔离了旧 snapshot 的 streaming 状态，但也把当前新草稿自己的 `optimisticPrompt` 运行状态一起过滤掉。创建期间发送第一条后，`running=true` 来自该 optimistic prompt；因新会话尚无 owner，`composerRunning` 仍为 false。再次输入并按 Enter 时，即使 `sending=true` 让 promptChannelReady=false，`composerPromptEnabled()` 仍因 sessionCreating=true 放行。

结果是两条消息分别进入并发的 `dispatchPrompt()`、等待同一个创建 Promise，绕过可编辑的本地排队；单槽 `optimisticPrompt` 和 `promptUnsub` 会相互覆盖，不能独立追踪两次发送。新增测试仅验证第一条发送，没有覆盖这条连续操作路径。

已复现上述实际 helper 的门控结果：firstPromptIsPending=true 时，composerRunning=false、canSubmitAgain=true；本项没有宣称完成真实 Electron/模型的端到端复现。

建议：区分旧 snapshot 的忙碌状态和当前草稿自己的发送中状态；在创建期间串行发送，或为待创建会话提供临时归属并在创建成功后绑定队列。补延迟 session.create、连续 Enter、分别失败回执的 App 级测试。

### R6 · P2 · 桌面回滚只接通 IPC，没有用户可达入口

位置：`apps/desktop/src/unified-updates-ipc.ts:27`、`update-coordinator.ts:281–294`；文档 `docs/updates.md` 的“设置中的回滚入口”。

新的 `rollbackDesktop()` 能准备上一桌面安装包，preload 也暴露了 `rollbackUpdate()`，但 Renderer 没有调用它的组件或按钮。诊断页面现有回滚入口只调用 `rollbackRuntimeUpdate()`。因此文档承诺的桌面回滚无法从应用界面执行，用户只能手动找历史 Setup。

建议：接入桌面回滚入口，并展示目标版本/准备状态，再复用重启应用流程；同步预览 fixture 和 UI 测试，或明确收缩文档承诺。

### R7 · P2 · Runtime 独立更新的“跳过此版本”不生效

位置：`apps/renderer/src/settings/appUpdate.ts:81–89`、`185–187`。

统一弹窗在只有 Runtime 更新时把 Runtime 版本放进 updateInfo.version，但“跳过”仍只写 skippedAppVersion。Coordinator 仅对 kind=app 应用该字段，下一次检查/后台下载照常发现、准备刚跳过的 Runtime；界面关闭弹窗造成已成功跳过的假象。

建议：按组件/通道保存并使用跳过版本，或者在 Runtime 独立更新时不显示该操作。补 Runtime-only 场景的跳过后再次检查测试。

## 验证和边界

- 本轮重新执行 `npm run check` 成功；Renderer 565 项、Desktop 355 项，其他 workspace 测试通过。日志 `outputs/review-check-20260918.log`。
- `npm run omp:test:metadata`：43 项通过。日志 `outputs/review-metadata-20260918.log`。
- `git diff --check` 通过。
- 隔离复现脚本 `outputs/review-update-probes-20260918.mjs` 和同名 `.log`：实际执行 Coordinator/Installer/Discovery/Composer helper；所有运行、签名和工件都使用临时测试数据，安装回调是测试替身。
- vendor 比对脚本/日志：`outputs/review-vendor-drift-20260918.*`；未发现额外 Runtime 源码漂移。
- 未重新执行真实 GUI 安装、UAC、两版静默更新、ARM64 实机或 GitHub Actions 发布。此前的本地差分节省比例也没有在本轮重新测量，不作为这些边界已经通过的证据。

建议先处理 R1–R4，再处理消息连续发送 R5，并补齐 R6/R7 的界面行为。针对这些失败场景补测试之后，再进入真实 Windows 迁移和静默更新验收。
