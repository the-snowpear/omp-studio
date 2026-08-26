# OMP Runtime 升级至 v17.4.1 的执行计划

## 1. 目标与已确认现状

将 Runtime 从 `v17.3.7 / 8500092296621a6826b7136e840f8a59ea338958` 升级到上游最新稳定版 [`v17.4.1 / 9350b7990d26ebf69a604edc82d8558ef04adf30`](https://github.com/can1357/oh-my-pi/releases/tag/v17.4.1)，严格固定该提交，不跟随之后可能继续移动的 `main`。上游完整差异见 [GitHub Compare](https://github.com/can1357/oh-my-pi/compare/8500092296621a6826b7136e840f8a59ea338958...9350b7990d26ebf69a604edc82d8558ef04adf30)。

已完成的只读审计结论：

- 两版本相隔 496 个提交；全库 1054 个文件变化，其中 `packages/coding-agent` 433 个。
- 25 个 seam 文件中有 18 个被上游修改；overlay 路径与新上游零冲突。
- 普通 `git apply --check`：`0001`、`0002`、`0003` 拒绝，`0004` 可直接应用。
- 三方应用后真正需要人工合并的只有：
  - `packages/coding-agent/src/cli.ts`
  - `packages/coding-agent/src/session/agent-session.ts`
- 当前 vendor 的 overlay 内容和四个 seam patch 与仓库 canonical 副本逐字节一致，四个 patch 均可反向应用，可安全拆除后切换 pin。
- 根目录现有未跟踪文件 `release-notes-0.1.1.md` 属于用户改动，本任务不得修改、备份覆盖或纳入提交。

成功标准：新 Runtime 保留全部 Studio 能力和协议 v1，构建并探测为 `17.4.1-studio.6`，四组补丁能从干净的 `v17.4.1` 原子应用、验证后恢复干净，Windows Runtime 制品可签名、安装、连接和正常关闭。

## 2. 安全迁移与 pin 更新

1. 使用 `D:\Program Files\Git\bin\bash.exe`；所有源码编辑使用 `apply_patch`，禁止 `git reset --hard`、`git submodule update`、手改 `.patch` 或 `git add -A`。

2. 编辑前创建唯一备份目录：

   `backup/2026-08-22/omp-runtime-v17.4.1-HHmmss/`

   保持项目相对路径，备份：

   - `omp-patch/README.md`
   - `omp-patch/upstream.json`
   - `omp-patch/patches/**`
   - `omp-patch/overlay/**`
   - `scripts/omp-seam.mjs`
   - `scripts/runtime-artifact.test.mjs`

   备份 README 记录创建时间、根仓库提交、旧/新 pin、当前 submodule 状态、文件清单，以及“恢复 canonical 文件、将干净 vendor checkout 到旧 SHA、重新执行 overlay apply”的恢复步骤。后续若发现还需编辑其他既有文件，必须先把其原版追加到同一备份并更新说明。不得备份 `node_modules`、`dist`、密钥或构建制品。

3. 在拆除当前 fork 前重新确认：

   - vendor `HEAD` 为旧 SHA。
   - 四个 patch 按 `0004 → 0001` 均通过 `git apply -R --check`。
   - 每个 vendor overlay 文件和 canonical overlay 内容一致。
   - 每组 vendor diff 与对应 patch 内容一致。

4. 干净拆除旧 fork：

   - 按 series 逆序反向应用四个 patch。
   - 调用 `scripts/omp-overlay.mjs` 已有的 `removeOverlay()`，只删除清单内 overlay 文件。
   - 确认 vendor `git status --porcelain` 为空；不使用硬重置或递归删除。

5. 获取并切换固定上游：

   - fetch `v17.4.1`，校验 tag 指向完整 SHA `9350b7990d26ebf69a604edc82d8558ef04adf30`。
   - detached checkout 到该 SHA。
   - 校验 `packages/coding-agent/package.json` 版本为 `17.4.1`，根仓库 gitlink 也指向该 SHA。

6. 更新身份和测试真值：

   - `omp-patch/upstream.json.commit`
   - `omp-patch/patches/series.json.upstreamCommit`
   - `bridge-server.ts` 的 `UPSTREAM_COMMIT`
   - `command-manifest-service.ts` 的 `UPSTREAM_COMMIT`
   - `studio-bridge-server.test.ts` 的预期上游版本
   - `scripts/runtime-artifact.test.mjs` 的真实 pin、上游版本及派生版本断言
   - `omp-patch/README.md` 的 managed pin 说明

   此时保留 `series.json` 原来的 `studio.5`、digest 和 patch 列表，交给 regen 统一重算。不要全局替换测试中作为普通 fixture 使用的 `"studio.5"`，也不要修改旧发布说明。

## 3. Seam 合并与 Runtime 兼容适配

1. 执行 `npm run omp:overlay:apply`。第一次预期在 `0001` 停止；overlay 已复制成功。按以下方式逐组处理，每完成一组可重跑该命令，让脚本识别已应用组并继续：

   - `0001` 使用 `git apply --3way`。在 `cli.ts` 同时保留上游 `--license` 分支和隐藏的 `--studio-session-telemetry-probe`；推荐顺序为 smoke test、license、Studio probe、普通命令分发。两个分支均须提前 `return`，probe 不得进入 help 或把 stdin JSON 当 prompt。
   - `0002` 使用三方应用。在 `agent-session.ts` 做语义合并：
     - 保留上游新的 `dispatched` 布尔结果、`#promptDropped` 回送和 `#promptWithMessage(): Promise<boolean>`。
     - 保留所有上游 `return false/true`、异步 compaction、prompt 恢复、Code Mode 和模型 preflight 行为。
     - 保留 Studio `prependMessages`，将其与 todo/task prelude、magic-keyword notice、图片描述按现有顺序合并且只注入一次。
     - 保留 Studio `#runBeforeNextUserTurn()`，仅在真正的 user message 开始前运行，不能改回旧的 `Promise<void>` 实现。
   - `0003` 使用三方应用；已审计为无文本冲突。保留上游 composer/状态栏/cleanse/新模式生命周期，同时保留 Studio pause、loop、RPC/TUI 共用控制。
   - `0004` 应可普通应用。保留上游新增的 extension project trust、usage provider、custom composer/runtime registration 类型，不得用旧类型覆盖新字段。

2. 三方应用会暂存干净合并的文件：解决冲突后仅 `git add` 冲突文件以完成索引，然后立即用 `git restore --staged -- .` 取消 vendor 内全部暂存。regen 前必须满足：

   - 无未合并索引项。
   - `git diff --cached --quiet` 成功。
   - 无 `.rej`、冲突标记或临时文件。
   - 所有上游已修改文件仍属于 `scripts/omp-seam.mjs` 现有四组。

3. 运行 `npm run omp:install-deps`，然后以 `bun run check:ts` 为快速反馈修复 overlay 对新 API 的兼容：

   - AgentSession/session entries/events：适配异步 compaction、原生 handoff、prompt restore、token/summary 元数据；Studio handoff/fork/telemetry/transcript 不得覆盖上游新语义。
   - `interactive-mode`/RPC/pause：确保新 composer 和 cleanse 生命周期不绕过 Studio pause/loop。
   - extensions/SDK/remote UI：适配 custom composer、project trust、usage provider 和新 SDK 参数；远程 UI 仍只暴露 Studio 明确支持的交互。
   - model registry/settings/TAN/telemetry probe：跟随构造器和设置签名变化，不复制第二套 registry。
   - task/job/Agent Hub：适配上游 auto-backgrounding、structured subagent 和 job manager 变化，保持 ownership/generation fencing。
   - conversation projector/sanitizer：新事件和字段只能经过明确投影与脱敏，不允许把未知 Runtime 对象直接透传到 Bridge。

   默认只修改 overlay 和现有 seam 文件；不要改变根 `studio-protocol`、`client-contract`、transport 或 capability 列表。如果保持现有 wire 行为必须新增协议字段、能力或修改现有 seam 分组之外的上游文件，暂停并报告，不自行扩大范围。

4. 增加或强化一个真实 AgentSession 回归测试，覆盖本次关键冲突：

   - Studio prelude 与上游 eager/keyword prelude 顺序正确且各出现一次。
   - 正常 prompt 返回 `true`。
   - abort/preflight race 未派发时保持上游 `false + promptDropped` 行为。
   - `setBeforeNextUserTurn` 钩子只在 user turn 执行一次。

5. 运行 `npm run omp:patches:regen`：

   - 由脚本捕获 overlay、重写四个 patch 和 `series.json`，禁止手改生成后的 patch。
   - 预期 patchset 从 `studio.5` 升为 `studio.6`，digest 改变，并自动同步 `bridge-server.ts` 的 `PATCHSET_VERSION`。
   - 确认仍为四组 patch，未把 `packages/coding-agent/CHANGELOG.md` 纳入，未产生未分组 upstream 文件。
   - 确认两个 `UPSTREAM_COMMIT` 常量、`upstream.json`、`series.json` 和 submodule gitlink 全部为同一目标 SHA。

## 4. 验证、制品与验收

1. 在 patched vendor 上先跑聚焦测试：

   - CLI：license、argv routing、unknown flag、host classification、Studio telemetry probe。
   - AgentSession：handoff、compaction、retry recovery、Studio session control、prewalk、mode control。
   - TUI/extension：interactive loop、pause screen、extensions runner、remote extension UI、command manifest。
   - Agent Hub/job：spawn/send/revive/release、job list/cancel、conversation reconstruction。
   - transcript/telemetry：live projector、archive telemetry、conversation sanitizer。

2. canonical 验证前拆除刚生成的 fork：

   - 新 patch 按逆序反向应用。
   - 用 `removeOverlay()` 删除清单内 overlay。
   - vendor 必须完全干净且仍位于新 SHA。

3. 执行正式门禁：

   - `npm run omp:verify:patches`
   - 验证命令结束后 vendor 仍完全干净。
   - `npm run omp:overlay:apply`，确认四组现在均能普通应用，无需 `--3way`。
   - `npm run check`
   - `npm run runtime:verify-source`
   - `npm run omp:test:metadata`

4. Windows Runtime 构建和身份验证：

   - 使用已有本地开发签名密钥；若不存在，运行 `npm run omp:keys` 生成本地密钥，禁止备份或提交私钥。
   - 执行 `npm run omp:build:host`。
   - 构建必须通过 `omp.exe --version`、`--smoke-test`、Studio Hello、command manifest、graceful shutdown 和签名制品生成。
   - 运行 `npm run omp:e2e:install`，验证签名、checksum、安装、激活与回滚路径。

5. 最终身份断言：

   - `upstreamVersion = 17.4.1`
   - `upstreamCommit = 9350b7990d26ebf69a604edc82d8558ef04adf30`
   - `patchsetVersion = studio.6`
   - `runtimeVersion = 17.4.1-studio.6`
   - Studio Protocol 仍为 v1，capability IDs/grades/limitations 不变。
   - command manifest hash 允许因上游 builtin 目录变化而重算，但 `unclassifiedBuiltins` 必须为空。

6. 最终工作区检查：

   - vendor 留在“新 pin + overlay + seam 已应用”的开发态，和当前项目习惯一致。
   - vendor overlay 与 canonical overlay 逐字节一致；每组 vendor diff 与生成 patch 一致；每个 patch 均可反向检查。
   - 根 diff 只包含新 backup、submodule gitlink、pin/身份/测试、overlay 兼容修改和重新生成的 patch。
   - `release-notes-0.1.1.md` 保持原样。
   - 不提交 `node_modules`、`dist`、artifact、日志、截图、密钥、`.rej` 或散落 `.bak`。

## 5. 固定假设与停止条件

- 目标固定为当前最新稳定 tag `v17.4.1`，即使执行期间 `main` 又更新也不改目标。
- 本次只做兼容升级，不引入新 Studio 功能、不开放上游新能力为新的 Bridge API。
- 因上游提交常量和 patch 上下文必然变化，patchset 版本确定升至 `studio.6`。
- 如果冲突扩展到审计外文件、overlay 路径被上游占用、必须改变 wire contract，或现有用户工作区状态与上述基线不一致，停止实施并报告差异，不能用重置、覆盖或扩大 seam 来强行完成。
