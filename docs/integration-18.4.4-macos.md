# OMP 18.4.4 与 macOS 整合

当前代码 Runtime：18.4.4-studio.38。应用版本仍为 0.1.7。

## 修复与适配

- 修复图片消息取回后 Host 转存失败导致无法恢复：Runtime 以消息 ID 保留恢复记录和附件描述符，失败时重复取回复用同一份内容；Composer 完成恢复才发送 `session.queue.ack`。确认失败的重试不会再次插入草稿。取消恢复可以显式丢弃记录；恢复记录限当前 Runtime 生命周期，不自动重发。
- 合并 main `0af57f9` 上的 18.4.4 GUI 工作与 `feat/macos-platform` (`35ab6d0`)。包含 Mac 窗口/原生菜单/快捷键、权限、私有 IPC、Runtime 生命周期、更新交换/回滚、arm64 打包与签名工件验证。
- 新队列、服务档位、设置、技能身份、预测、Stats/Frustration、Ask 图片、子代理 BTW、资源和 IDA 共用同一套协议与 GUI。Mac 无扩展名二进制文件增加 IDA 菜单入口。
- Electron 验收脚本改为按平台定位 Electron、Runtime 和本地公钥目录，Mac 使用独立 HOME、原生配置与应用配置，固定测试语言。CI 从实际 Mac 安装包运行新增 GUI 验收。
- Windows/Mac 共用门禁矩阵，保留每次只构建/测试一次、按范围触发原生/元数据验证，以及工件门禁不重复源码测试。Mac 原生检查和手动构建验收均不允许静默失败。
- 将 Mac watchdog 的旧 Settings 替身迁移到 18.4.4 原生注册表；修复上游 lint 错误，按上游格式器规范化涉及的 Runtime 源码。补丁由 vendor 经 regen 生成。

- 修复 Mac 首次输入预测：原生 flock 需要锁文件的父目录，预测服务现在先创建私有目录再加锁；不创建草稿数据库、不导入外部历史。回归测试从不存在的嵌套目录开始。
- 修复 Mac 上游扩展测试使用 `fs.watch` 等待文件名事件的同步竞态，改为有界检查同一个启动标记，取消与消息重写断言保持不变。
- Mac 实包验收在隔离配置中预置正常的“暂不移动到应用程序”偏好，并在窗口就绪后接入文件选择器；读请求、关闭与 CI 步骤均有超时，失败不会记为通过。
- 手动 CI 支持仅运行 Mac 打包验收，与全量 CI 使用独立的取消分组；原生依赖缓存共用，普通 push/PR 门禁不变。

- 紧凑窗口下 Ask 卡按实际对话空间限高，保留头部/底部操作与翻页按钮可见，避免面板遮挡；尺寸观察器随卡片生命周期清理。

## 已完成的本地验证

- 全仓生产构建通过；测试通过：Renderer 113 文件 / 717 用例，Desktop 489 用例，其余 workspace 全部通过。Desktop 新增回归验证转存失败后仍可按原 ID 恢复。
- 元数据与跨平台工件测试 81 / 81 通过；新增恢复确认接口的工件清单修正后，又通过 19 项相关测试。移除 150 多行重复抄写的清单，改为与公共命令契约比较。
- 上游完整 `check:ts` 通过，包括 lint、格式和所有原生包的类型检查。
- 原生队列、Host watchdog、音频与统计专项通过；Windows 跳过仅 Unix 的真实父进程测试。Renderer 验证确认重试不重复插入草稿。
- 临时 Git index 回放四组接缝，确认 vendor 与生成源码一致；139 个 overlay 文件一致。未清理 dirty vendor 或无关的未跟踪文件。

- Windows `.38` 签名 Runtime 构建与认证探测通过；真实 Electron 18 项通过，报告位于 `outputs/full-gui-e2e/report.json`。预测修复的本地测试、原生类型检查、lint/format 及工件检查通过。

## 远程验证与合并状态

- [Windows 源码完整门禁](https://github.com/the-snowpear/omp-studio/actions/runs/36727807334/job/109929536342)：通过。
- [macOS arm64 源码完整门禁](https://github.com/the-snowpear/omp-studio/actions/runs/36727807334/job/109929536681)：通过。包含修正后的扩展取消测试。
- [Mac `.38` 实包 GUI 验收](https://github.com/the-snowpear/omp-studio/actions/runs/36739408991)：19 项通过，包含原生 PTY 创建/释放；报告位于 `outputs/macos-ci-final/report.json`。Windows 真实 Electron 18 项通过。两平台均以 1024×684、侧栏与底部面板开启验收，截图已检查。
- 两个分支整合后快进合入 main；未发布。

## 验证边界

Mac 交付目标是 Apple Silicon arm64，沿用 ad hoc 签名，未配置 Developer ID 公证。真实 Gatekeeper/TCC 弹窗、物理中文输入法、商业 IDA、付费模型/Judge/兑券不属于自动验收结论。未创建发布标签或执行 Release 工作流，Windows 本地安装包在整合后重新构建，不替换当前安装。
