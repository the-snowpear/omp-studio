# 更新系统与消息排队审查修复

日期：2026-09-18；分支：`codex/incremental-updates`。

对应 `incremental-updates-review-2026-09-18.md` 的 7 项问题均已修复。此前工作区中的更新重构和消息归属改动完整保留；本轮没有提交、发布或安装应用。

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| R1：中断恢复丢失 Runtime 回滚点 | 重进同一 trial 时保留原回滚目标；已激活候选的恢复失败仍保留 trial 给 Host 回退 | 激活前、激活后、最终 journal 保存后三个中断检查点均能恢复旧 Runtime |
| R2：待更新组合不兼容仍可安装 | 在最终 apply 退出前重新验签并检查最终桌面/Runtime 协议交集与 minAppVersion | 分次 prepare(app)、prepare(all) 部分失败、外部桌面版本变化均阻止退出/安装 |
| R3：旧 Runtime 获得新序号遮蔽新版 | 发布时拒绝同通道/架构早于任何已发行 Runtime 的版本，要求桌面分支升级 Runtime pin 与工件 | 独立 Runtime 发布后携带旧 seed 的桌面构建被拒绝；最新版本复用、不同通道仍正常 |
| R4：迁移未等待真实卸载完成 | 将旧卸载器复制到临时目录，传入 NSIS `_?=` 与 allusers 参数并等待实际进程；核对旧程序/卸载器已移除 | 直接编译生产维护类，验证参数、失败退出码、未完成移除、UAC 取消及成功；完整安装宿主编译通过 |
| R5：创建期间连续发送覆盖状态 | sending 状态不再被 sessionCreating 绕过；dispatch 同步互斥阻止 React 重渲染前的重复进入；第二份草稿留在编辑器 | 连续 Enter/同帧门控、首次失败后的解锁重试测试通过 |
| R6：桌面回滚没有用户入口 | 设置 → 高级提供目标版本、准备、重启恢复两步操作；无可信旧版本时禁用；持久化回滚意图防止后台准备覆盖 | Coordinator 跨启动测试与 Renderer 的成功、失败、忙碌、禁用、预览测试通过 |
| R7：Runtime 跳过按钮无效 | Runtime 独立更新不显示跳过；状态方法也拒绝把 Runtime 版本保存为 skippedAppVersion | 弹窗组件与状态桥接测试通过，桌面更新保留跳过操作 |

回归结果：`npm run check` 全部通过（Renderer 573、Desktop 362）；`npm run omp:test:metadata` 45 项通过；Windows 安装宿主重新编译通过；`git diff --check` 通过。

主要日志：`outputs/review-fixes-check-20260918.log`、`outputs/review-fixes-metadata-20260918.log`、`outputs/review-fixes-installer-host.log`。

修改前快照：`backup/2026-09-18/review-fixes-070728`；根 package.json 的追加备份位于 `backup/2026-09-18/review-fixes-package-1789715794841`。原审查报告和复现记录保留，便于对照。

剩余发布验收边界：真实 Windows 旧全机迁移/UAC、两版静默更新及安装中断恢复、ARM64 实机、新 GitHub Actions 完整实跑。本轮没有把编译/隔离测试标记为上述验收完成，也没有重建完整 Setup。
