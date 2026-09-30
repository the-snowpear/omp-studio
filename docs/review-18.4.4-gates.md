# 18.4.4 GUI 改动审查与门禁精简

更新：后续整合已修复下述 P1：Runtime 保留取回记录，Composer 恢复后通过 `session.queue.ack` 确认清除；失败可按消息 ID 重试，仅重试确认时不会重复插入草稿。macOS 分支也已整合到同一开发线。以下为修复前审查记录；最新状态见 [整合记录](integration-18.4.4-macos.md)。

日期：2026-09-30。基线：main `0af57f9` 的 detached HEAD，以及本轮全部未提交 GUI / Runtime 改动。保留既有改动，未提交、未发布、未合并 macOS 分支。

## 审查结论

### P1：图片消息取回后的 Host 转存失败缺少恢复通道（已在后续整合中修复）

位置：`apps/desktop/src/session-commands.ts` 的 `session.queue.takeback` 分支，以及 Runtime `services/session-gui-service.ts` 的同名操作。

Runtime 导出图片后删除队列项，返回 `removed: true`。Host 随后执行 `mediaFiles.promote`；如果附件读取、摘要检查或磁盘写入失败，整个命令变成失败回执，Renderer 收不到原文和附件。再次以该消息 ID 取回时，Runtime 返回 `removed: false`。消息已经不在队列，也没有进入 Composer。即使底层文件仍存在，界面没有恢复入口。

已使用真实编译后的 Host `createDesktopSemanticCommands`、模拟 Runtime 回执和失败的附件转存复现：第一次因模拟磁盘满失败，第二次返回 `removed: false`。未操作真实会话或文件。

建议：为已取回提交保留按会话及消息 ID 索引的恢复记录，直到 Host 完成附件接收并确认，支持仅重试恢复；不能自动重发消息。仅在删除前检查磁盘或提前检查通道，不能解决删除后的失败窗口。原审查将其列为发布前待修项；后续整合已实现恢复确认协议并通过回归验证，详见整合记录。

### P2：资源与 IDA 面板跨会话后永久 busy（已修复）

请求期间切换会话会推进 epoch。旧响应正确被丢弃，但原来的 finally 也因 epoch 不同而不清除 busy；新会话的读取入口持续禁用。现在保留在途操作锁到 promise 结束，并无条件释放属于该锁的 busy，结果和错误仍按 epoch 隔离。

新增两条参数化回归：分别覆盖 Resources 和 IDA，在请求期间切换会话、完成旧响应，验证旧内容不显示且新会话可以读取。4 条面板测试全部通过。

## 精简内容

- 根 `check` / `test`：构建所有 workspace 一次，再运行各包 `test:built` 一次。原流程约 27 次 TypeScript 调用降至 14 次；生产 Renderer 构建继续保留。包内单独运行 `test` 仍保留原有构建前置。
- 根 `typecheck`：复用已经检查全部 TypeScript 的 build，不额外重复 Renderer 和 Desktop 编译。
- `omp:verify:patches`：默认只检查补丁和原生 Runtime；不再隐式重跑根 `check`。`--with-workspace-check` 可显式串联；旧 `--skip-workspace-check` 调用保持兼容。
- 删除 34 条重复维护的原生 Studio 测试路径，统一由 overlay 自动发现。逐一验证被删除的路径均在自动发现范围，实际测试集合未减少；保留 Bun 单文件进程隔离。
- CI：普通 GUI 改动不再安装上游依赖、跑完整原生补丁门禁；Runtime、公共契约和构建脚本变动触发相应检查。发布/安装相关改动触发元数据检查。手动 CI 仍运行所有门禁；Bun 固定为 1.4.2。
- `p5:gate`：只检查候选工件签名与私密材料，不再重复运行 Host、安装器和元数据测试。删掉从单元测试通过推断“真实安装/回滚已经验证”的报告字段。发布工作流仍先运行 `check`、元数据和原生补丁验证。
- 没有删除已有行为用例，没有放宽性能阈值。配置说明见 `docs/development.md`。

## 验证

- 新的 `npm run check`：通过，14 个 workspace 各构建一次；Renderer 111 文件 / 707 用例、Desktop 390 用例及其余包全部通过。
- `npm run omp:test:metadata`：48 / 48 通过。
- CI YAML 解析与 6 类路径选择样例通过。
- 补丁测试选择等价检查通过；两个修改后的门禁脚本语法检查通过；`git diff --check` 通过。
- 本轮没有改 Runtime 源码，因此没有重编 Runtime 或再次执行原生全套门禁；dirty vendor 未被清理或重放。本轮也未重复 Electron、性能、签名安装验收，前次结果仅代表前次工件。
- 本地现有 0.1.7 / 18.4.4-studio.31 安装包没有重打，因而不包含本轮两处 Renderer 修复。
- 日志：系统临时目录中的 `omp-review-check.log`、`omp-review-metadata.log`、`omp-review-targeted.log`。
- 修改前快照：`backup/2026-09-30/review-gates-210344/`。

## macOS 能否一起发布

目前不能直接一起发布。用户确认这里指 macOS，不是 iOS。

远端核对：main 为 `0af57f9`，`feat/macos-platform` 为 `35ab6d0`。当前工作区的发布矩阵仍只有 Windows x64/arm64，没有 `pack:mac` 或 Mac 发布 job；现有 `platform-darwin` 包不足以形成可发布 Mac 应用。

Mac 分支相对 main 有 190 个文件的改动，包含窗口/菜单/权限、Runtime 平台处理、Mac 更新交换和回滚、打包/审计及发布流程。该分支的 `workflow_dispatch.include_macos` 默认关闭，启用后在 `macos-15` 构建 `darwin-arm64`。标签推送不会自动构建 Mac。它只覆盖 Apple Silicon，采用 ad hoc 签名，未做 Developer ID 签名与公证。

一起发布需要先整合两个分支的 Host/Runtime/更新/构建改动，保留本轮门禁去重；然后在 Mac runner 生成匹配的 18.4.4 Runtime、应用和更新目录，在真实 Apple Silicon Mac 验证首次启动、Gatekeeper、目录/麦克风权限、真实会话、应用更新和回滚。若以该分支现有方案交付，应明确为未公证构建；若要求普通用户顺畅安装，则需配置 Developer ID 签名与公证。Intel Mac 尚未纳入现有发布矩阵。

本轮没有合并、触发远程 CI 或发布。上述 P1 也应在正式发布前解决。
