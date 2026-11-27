# OMP 19.2.1 合并审查

2026-11-27，审查升级提交 `0ffdb321` 相对 `main` 基线 `8fd4d018` 的全部 263 个文件。三名子代理分别审查 Runtime/接缝、Renderer、Desktop/Host/协议，主代理核对打包脚本、离线目录、版本信息及跨层修复。原工作区 `codex/fix-approval-web-access` 的其他未提交改动保持独立。

## 已发现并修复

确认 8 项 P2，未发现 P1。修复后的具体行为如下：

| 问题 | 修复与回归依据 |
| --- | --- |
| `pi-native` 模型发现被 Ollama/LiteLLM 预设覆盖 | 统一优先请求 `/v1/pi/models`，跳过 LM Studio 专属补充请求；覆盖预设与保存配置的真实 adapter 调用。 |
| 归档转录选项在语言切换/刷新时重置 | 详细程度、字符预算、回合数由父组件持有，详情重读不丢选择；覆盖实际父子组件 `zh → en → zh` 和刷新。 |
| 退出预览后仍显示可操作的演示模型 | Runtime 不可用时清除模型读状态；覆盖预览切换到离线真实模式。 |
| 已登记的 Chrome 扩展目录丢失后无法修复 | 显式修复按原目录恢复扩展并保持扩展 ID；无法恢复或用户选择不恢复时返回具体警告，保留占位用户文件。 |
| Linux 企业策略拆分文件时误报阻止 | 按浏览器合并策略键后统一评估 Blocklist/Allowlist，并记录来源；覆盖不同文件的允许例外和同键覆盖。 |
| 子 Agent PTY 等待提示指向主对话 | 等待投影保留来源会话、所有者、作业 ID 和代次；查看命令进入对应子对话，打开终端复用 JobInspector，通过根会话的既有所有权检查发送输入。旧 Runtime 无新增字段时保留原入口。 |
| Composer 禁用期间确认批注会丢失修改 | 禁用保存并保留画布；异步合成结束时读取最新禁用状态与确认回调，只有成功替换才关闭。 |
| Worker 后台作业缺少管道/文件输出流 | 沿现有 Worker RPC 读取元数据与按需尾部，单次最多 64 KiB、主线程缓存最多 4 个选中流，原生流仍由原 Worker 持有。明确断连时默认输出可读，显式选流返回错误；覆盖真实 Worker、原生 Shell、二进制及终态读取。 |

修复前按路径备份于 `C:/Users/123/.codex/tmp/omp-19.2.1-review/`，并保留 `codex/backup-main-before-omp-19.2.1-review` 与 `codex/backup-upgrade-before-19.2.1-review` Git 恢复点。

Runtime 修改在 vendor 完成，再由 `omp:patches:regen` 回收，未手工编辑 `.patch`。格式检查发现的 7 个文件已按上游 oxfmt 规则修正并重新回收，最终版本为 `19.2.1-studio.3`。

## 验证

定向回归已覆盖上述 8 项问题。Renderer 6 个专项文件及依赖编译通过；Host 模型 adapter 专项通过；真实 Worker 服务 14 项测试、69 条断言通过；Chrome 管理 8 项、48 条断言通过；PTY/审批/模型生命周期 4 项通过。

Chrome 真实浏览器验收使用隔离 harness：批注画笔在禁用/恢复及中英切换后保留，确认后图片 ID、正文和附件数不变；子 Agent PTY 使用根会话、目标作业与正确代次发送输入；预览模式仅在本地处理输入，`marks=off` 无演示标记。最后控制台 0 错误、0 警告。截图和运行记录保存在 `output/playwright/review-*`，验证日志保存在 `outputs/upgrade-19.2.1-review/`，均不提交。

最终验证全部通过：

- `npm run check -- --production`：301.2 秒，包含源码门禁、核心回归、Renderer、沙箱 preload、远端 Host 和独立 Web 产物。
- `npm run test:tooling`：152 项通过、1 项跳过、0 失败；能力清单顺序与身份哈希对齐。
- `npm run omp:verify:patches -- --source outputs/upgrade-19.2.1-handoff/replay`：324 个 overlay 文件与四组接缝重放、完整 `check:ts`、145 份测试报告（1,147 通过、6 跳过、0 失败）及 CLI 源码冒烟；重放检出恢复干净。
- `runtime:verify-source` 和 `models:catalog:check` 通过；上游仍为正式 v19.2.1，目录仍为 6,236 个模型。
- 新版 Windows x64 `19.2.1-studio.3` Canary 已构建，通过二进制冒烟、认证 Hello、snapshot、命令清单、优雅退出与独立 Ed25519 签名/全文件 SHA-256 校验。产物为 `outputs/canary/omp-19.2.1-studio.3-win32-x64/`，二进制 SHA-256：`7cd3cfa0ab4f90f63beeed97f9b40f2a15b00dabdb10e7a49408c71e7570f456`。仅使用隔离开发密钥，未安装或发布。
- 对新编译二进制真实读取设置、Todo、MCP、反汇编器、工作树钩子、遗留进程、归档全文搜索与统计，8 项全部完成，随后正常退出。
- 最后逐字节比对 vendor 与已回收 overlay，再反向移除接缝和 overlay；开发 vendor 与验证检出均处于固定上游提交，工作区干净。

合并使用单独的 `D:/Project/.worktrees/omp-studio-main-19.2.1-review` main 工作树，保留升级分支和原工作区。合并前重新获取 `origin/main`，确认它仍为基线 `8fd4d018`；本次仅本地合并，不推送远端、不创建版本 Tag。

## 范围与限制

保留用户明确决定：扩展 `ctx.ui.composer` 钩子、`ctx.ui.custom()` / `fullscreen` / `onHandle` 暂不迁移。

本次为源码审查与合并，不是多平台发布验收。未执行真实第三方 OAuth、生产 MCP/外部 Todo、Binary Ninja 许可分析、SSH 文件端到端、人工系统通知可见性或 macOS/Linux/Windows ARM64 真机安装；受控 GUI 客户端不能替代这些外部服务验证。
