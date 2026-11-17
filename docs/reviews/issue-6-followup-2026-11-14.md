# Issue #6 后续分析

## 证据与已发布修复

Issue 中混合了新建会话、Runtime 更新、安装后启动和进程残留等现象。2026-10-29 两位用户补充的截图均显示 Worktree 选择弹窗中的 `runtime lost (OUTCOME_UNKNOWN); outcome unknown`。日志原件见 [第一位用户的补充](https://github.com/the-snowpear/omp-studio/issues/6#issuecomment-6486785631)和[第二位用户的补充](https://github.com/the-snowpear/omp-studio/issues/6#issuecomment-6492336995)；这里不复制用户路径和其他原始日志内容。

- 两份 10 月 29 日日志均出现 Runtime 握手成功、Bridge 立即断开后仍记录 `runtime.launch.ready`。提交 `9a371d7` 修复了启动期间断线仍报告就绪的问题，随 0.1.17 发布。这证明原先的就绪状态不可信，不能单凭日志确定 Bridge 最初为何断开。
- [0.1.17 发布记录](../releases/v0.1.17.md)说明，升级后旧 Runtime 未被新随包版本取代、Worktree 选择弹窗无法关闭等问题已修复。当前版本会验签、自检并在符合条件时激活较新的随包 Runtime；不覆盖用户选择的较新版本、Canary 或回滚。
- 第一位用户的日志还包含一次 `runtime.worker.lease-lost`，随后 Host 停止并尝试恢复会话。日志不能确定租约为何丢失，也不能证明是另一个 CLI 抢占。当前代码保留租约隔离，丢失后终止旧写入者并恢复；仍需新版现场日志确认是否复现。
- 第二位用户的更新检查出现 GitHub API HTTP 403 限流，另一次请求出现传输中断。限流是独立的更新网络问题，不能据此判断 Runtime 工件损坏。更新器会显示限流和重试时间；它仍需取得完整目录并验证签名，手动安装完整发行包是可用替代路径。
- 最后补充未确认应用、Runtime 和 Setup 中哪个进程在从托盘彻底退出后残留。0.1.14 修复了安装器进程残留，不能据此认定应用或 Runtime 进程残留已全部解决。

## 本次代码修复

- 诊断中心手动检查更新时，检查请求抛错或返回错误会显示实际原因；无法在线检查时不会仅凭本地制品状态宣布已是最新版本。自动检查失败仍静默，继续刷新本地 Runtime 信息。
- Worktree 创建并登记成功后，如果切换到该工作区失败，同一会话视图允许重试打开已创建的目录；Runtime 断开并恢复后也会重新提供该入口，不再次发送创建命令。

Worktree 的这项恢复依赖已经收到成功结果和已登记的 `workspaceId`，且只保存在当前会话视图内。若创建命令的结果本身是 `OUTCOME_UNKNOWN`、登记失败，或应用已重启，不能仅凭此改动确认是否已经创建；应先检查会话 Worktree 列表和 Git 工作树，再决定是否重试。

## 验证与待确认

- `npm run check -- --only desktop --suite runtime-session.test --suite runtime-install.test --suite update-network.test`：通过。
- `npm run check -- --only desktop --suite runtime-multi-session.test`：通过。
- `npm run check -- --only studio-host --suite session-lease-store.test`：通过。
- `npm run check -- --only renderer`：在隔离目录通过；当前工作区的上游 submodule 停在 18.18.0，而项目固定为 18.19.0，缺少本次构建所需的 HTML 表单文件。隔离目录使用项目固定 commit 的文件并应用仓库对应接缝补丁。最终改动另在隔离目录运行 `--only renderer --suite DiagnosticsPage.test --suite SessionWorktreesPane.test` 通过。
- 尚未在两位反馈者的设备上复测；新代码尚未发布。建议安装现有 [0.2.1 完整发行包](https://github.com/the-snowpear/omp-studio/releases/tag/v0.2.1)，从托盘退出旧应用后覆盖安装，确认桌面及 Runtime 版本，再测试新会话和 Worktree。若仍失败，请提供新版的完整错误及对应时间的脱敏 Host 日志；若仍有进程残留，还需区分进程名称和是否已从托盘选择退出。

Issue 保持开放，等待反馈者在新版复测后确认。不要删除会话文件或租约锁来绕过故障。
