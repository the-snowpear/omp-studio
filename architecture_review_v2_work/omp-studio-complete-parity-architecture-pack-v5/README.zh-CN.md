# OMP Studio Complete Parity Architecture Pack v5

本包是 OMP Studio 的可执行架构基线。目标不是只描述方向，而是让工程团队可以据此创建模块、定义协议、拆分 PR、编写测试并判定发布。

## 最终产品决策

- 默认 Runtime：Studio 管理的 `omp --mode studio-host`。
- Full Parity Runtime：`Managed Runtime` 或通过完整能力门禁的 `Compatible System OMP`。
- 普通用户安装、尚未实现 Studio Protocol 的 OMP：`Limited System OMP`。
- GUI 与 TUI 使用同一个 OMP process/AgentSession；禁止 RPC/TUI 双进程接管同一 session。
- OMP 内置能力使用 Native GUI；标准扩展使用 Generic Remote UI；任意自定义 TUI 使用同一 Runtime 的内嵌终端人工操作。
- GUI 自动控制只走 typed Studio Bridge，不使用 Slash 文本、ANSI 解析或按键宏。

## 阅读顺序

1. `OMP_STUDIO_V5_FINAL_ARCHITECTURE.zh-CN.md`：完整架构与最终边界。
2. `00_EXECUTION_BASELINE.md`：工程开始前不可更改的决策。
3. `01_RUNTIME_RESOLUTION_AND_DISTRIBUTION.md`：Managed/Compatible/Limited 的解析与安装。
4. `02_STUDIO_HOST_RUNTIME.md`：OMP patch、进程和模块结构。
5. `03_STUDIO_BRIDGE_PROTOCOL.md`：握手、帧、receipt、事件和错误。
6. `04_COMMAND_REMOTE_UI_AND_TUI.md`：所有命令和交互如何进入 GUI。
7. `05_AGENT_HUB_AND_JOBS.md`：Agent Hub、Lifecycle、Task 和 Job API。
8. `06_STATE_SECURITY_AND_RECOVERY.md`：状态、权限、fencing 和 crash recovery。
9. `07_UPGRADE_AND_COMPATIBILITY_CI.md`：上游升级、自动验证和发布。
10. `08_IMPLEMENTATION_WORK_PACKAGES.md`：按依赖排序的可执行工作包。
11. `09_ACCEPTANCE_MATRIX.md`：完成定义与发布门禁。
12. `10_OMP_SOURCE_CHANGE_MAP.md`：当前 OMP 源码修改位置和抽取策略。
13. `contracts/`：规范 TypeScript 契约。
14. `adr/`：最终架构决策记录。

## 执行规则

- 契约先行：每个实现 PR 必须引用一个 Work Package 和一个 contract/test 条目。
- 新增 OMP built-in command 没有 manifest route 时，Full Parity Runtime 构建失败。
- Runtime、Host、Renderer 三层禁止共享 OMP private object。
- Managed Runtime 发布必须通过 Windows/macOS/Linux 全矩阵。
- 不确定 outcome 使用 `outcome_unknown`，不得猜测成功或自动重放副作用。

