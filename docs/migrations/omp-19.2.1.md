# OMP 19.2.1 迁移报告

目标上游固定为正式标签 `v19.2.1`，提交 `b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac`，不包含上游未发布提交。初次交付的 Runtime 为 `19.2.1-studio.1`；合并审查修复及格式化按标准回收流程递增为 `19.2.1-studio.3`，未复用已构建产物的身份。Studio workspace 版本仍为 `0.2.11`，本次不发布安装包或推送 Tag。

## Runtime 与工作台

- 迁移 TUI 拆分后的模块路径、四组接缝与 Studio overlay；使用 Bun `1.4.4`、Rust `nightly-2026-11-08`。上游 prepare 生成转录查看器与 Browser Relay 扩展资源。
- 设置接入 `tools.commands*`、`computer.takeover`、Magic 编辑及模型配置、Prewalk `escalate` / `@initial`、Eval 定义工具、跨实例任务、MCP 共享和空闲停止、后台进程清理、PTY 输入提醒。旧 `tools.xdev*` / `computer.backgroundFallback` 配置沿原生迁移处理。
- Binary Ninja 与 IDA/Ghidra 共用反汇编器入口，提供安装目录、Python 配置、状态和数据库编辑链路。外部 Todo 后端读取扩展注册清单，支持切换、同步状态、重试及查看所属扩展源码；原生 API 没有统一配置 schema，扩展自行定义配置方式。
- MCP 展示共享进程、会话绑定、空闲策略及 OAuth scope 补充授权。语言切换立即重读本地化状态，旧请求不能覆盖新语言，搜索与筛选保持。
- Chrome 扩展管理展示 Profile、Native Host 清单、安装健康和企业策略拒绝原因，支持安装、同步、修复与卸载；打开扩展目录通过本机系统文件服务，远程 Runtime 不调用本机 Shell 打开远端路径。桌面托管浏览器对齐新版 Relay。
- 后台遗留进程支持接管和终止；运行中子代理可切换模型与思考档位；工作树面板展示 post-checkout 进度、加载项与警告。
- 作业详情支持管道/重定向输出流。无头 Studio 的 PTY 使用原生 `PtySession` 后台作业，输入经 `jobs.input` 及原生线程回调传送，不依赖扩展 `custom()`。JobInspector 支持发送文本、回车与 Ctrl+C；失败保留草稿，发送中切换语言不锁死输入。等待状态随作业元数据跨 Worker 投影，`pty.notify` 开启且桌面失焦时通知；重复 snapshot 不重复通知。
- 侧栏读取持久审批等待态，父工具结果可解除嵌套审批；投递中的队列保留身份和图片直到进入转录。对话流区分 AgentLoopError，并关联嵌套调用的 `parentToolCallId`。
- 历史页提供全文搜索和可调整详细程度、字符预算、回合范围的转录。归档调用、正则搜索、统计支持时间范围与子代理，评测页复用同一分析面。正文走瞬时 query，不进入全局 reducer 或命令账本。
- Composer 图片批注支持画笔、矩形、箭头、文字、颜色、撤销和重置；确认后只替换附件字节，保留图片 ID、`[图N]` 标记与正文。修复恢复草稿时重复添加图片后空格的问题。
- 账号入口接入 Anthropic 长期 OAuth、Otari 原生区域/端点交互；OpenRouter 与 `pi-native` Auth Gateway 目录发现采用实际 API 和 provider 范围。离线目录为 6,236 个模型，版本 `a5d57cc5ef22468f`。Fast 页面展示当前原生资格结果及降级/恢复状态，不推断未知凭据的资格。

## 已确认暂不迁移：扩展自定义 UI 与 Composer 钩子

**2026-11-27，项目负责人确认：本轮暂不迁移这一项，明确标记保留。** 此决定调整原升级计划 §3.4「扩展远程 UI 适配」中有关新 Composer 钩子与 custom 选项的功能接入范围；恢复升级工作时不要自动将其重新纳入本轮交付。

暂缓范围：

- `ctx.ui.composer`：`addKeyHandler`、`addDecorator`、`setSubmitTransform`、`setShape` 的 Studio 功能桥接。
- `ctx.ui.custom()`：扩展自定义终端 UI 到 React 的渲染、输入与生命周期桥接，包括 `fullscreen`、`onHandle({ closed, close })` 以及关闭、完成、取消语义。

原因：上游 custom 工厂返回终端 UI 组件，`fullscreen` 指终端整屏；这些不是可直接传给 React 的界面。Composer 钩子中部分行为可独立桥接，但涉及跨进程按键、草稿装饰和发送前转换，另行评估后再实施。

这项暂缓不包含 Studio 自有 Composer、图片附件批注，以及已经支持的标准选择、输入、Ask、表单和审批交互；也不代表禁用所有 OMP 扩展。

### 当前代码

- 入口：`omp-patch/overlay/packages/coding-agent/src/studio/remote-extension-ui.ts`；执行工作区中的对应文件位于 `omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/remote-extension-ui.ts`。
- 已调整到新版接口签名，并移除 `composer` 空实现对象，扩展可按上游可选属性语义检测不可用并选择降级。
- `custom()` 保持明确的中英文不支持提示；预先取消的请求保留取消原因，不创建界面或伪造 `onHandle`。这只是兼容性清理，不是自定义 UI 迁移完成。

## 验证记录

以下为初次交付 `19.2.1-studio.1` 的证据；合并前审查修复与最终验证另记于[合并审查](../reviews/omp-19.2.1-merge-review.md)。此前被暂停的重放以及修复前失败记录不作为通过证据。

- `npm run models:catalog:check` 已通过，可从固定上游提交复现目录。
- `npm run omp:verify:patches -- --source outputs/upgrade-19.2.1-handoff/replay` 在独立干净检出上重放 324 个 overlay 文件和四组接缝，通过 Bun `check:ts`、145 份测试报告（1,143 项通过、6 项跳过、0 失败）及 CLI 源码冒烟；验证后该检出恢复干净。
- 交付时已核对 overlay 与 vendor 文件逐字节一致并保存恢复快照，再反向移除已回收接缝及 overlay；vendor 子模块最终保持上述固定提交且工作区干净。后续本地源码开发或构建前先运行 `npm run omp:overlay:apply`。
- `npm run check -- --production` 已通过（210.6 秒），包括架构、选择器、动效、全包编译、核心测试、生产 Renderer、沙箱 preload、远端 Host 和独立 Web Host。
- `npm run test:tooling`：152 项通过、1 项跳过、0 失败；打包能力清单的顺序和哈希与 Runtime 对齐。
- 编译产物曾因 Host 旧快照白名单拒绝新字段而无法完成握手；已移除该重复输出深校验，保留信封与 Runtime 身份/epoch 校验，并补真实 Socket 快照→命令清单回归。嵌套事件也保留新增父调用身份与错误来源。
- 定向行为测试覆盖 Relay 跨 Bun/Node 往返、临时 Chrome Profile 安装修复卸载、Todo 同步失败恢复、MCP scope 升级、配置与模型探测、审批恢复、队列投递、后台输出流、图片合成与语言切换。

## Windows x64 Canary

初次交付 `19.2.1-studio.1` Runtime 位于 `outputs/canary/omp-19.2.1-studio.1-win32-x64/`。通过 `build-omp-host.mjs` 执行原生编译、二进制构建、`--smoke-test`、认证 Bridge Hello、快照与命令清单校验，以及优雅退出。已完成生产检查，因此构建使用 `--skip-build` 复用已验证的 Studio 产物；合并审查后的新版 Canary 见上述审查记录。

使用隔离的开发密钥生成 Canary，未安装进用户 Runtime，也未发布。独立调用 Runtime Installer 的签名与全文件校验确认 Ed25519 签名和 SHA-256 全部有效；二进制摘要为 `22b647ee2b6a30b8de035503e38922130c4aaeab74977d1a32d1fbdde9945d29`。

对该二进制额外进行了真实 Bridge 读取：新设置、Todo 后端、MCP 状态、反汇编器状态、工作树钩子、遗留进程、归档全文搜索和调用统计，八项全部完成，再次确认命令清单与优雅退出。探测使用临时用户配置和工作区，不使用真实账号或用户会话。

## GUI 与平台边界

开发入口为 `apps/renderer/upgrade1921-harness.html`。在 Windows Chrome 上使用真实组件，分别走 Preview fixture 和受控 typed client；覆盖 `marks=off`、中英热切、状态保持与窄面板布局。受控客户端用于确定操作参数和迟到请求行为，不等于真实外部服务验收。

截图与详细矩阵保存在本地 `output/playwright/upgrade1921-gui-acceptance.json` 及同目录，日志保存在 `outputs/upgrade-19.2.1-handoff/`，均不提交。包含 Chrome 扩展、Composer 批注、归档、MCP、Binary Ninja、Prewalk、Todo、Agent、输出流、工作树与遗留进程的验收证据。PTY 输入另验证了延迟成功/失败回执期间的语言切换、草稿保持和 Ctrl+C 字节；最终浏览器控制台无错误或警告。

Windows ConPTY 已实际验证启动、输出、输入与退出，并覆盖真实 BashTool `pty:true` / `async:true` 路由及 Worker 输入回调。上游 Windows `awaitsInput()` 返回未知，界面保留手动输入并明确显示无法自动检测，不伪造等待通知；macOS 检测也受原生能力限制。

未执行真实 Binary Ninja 许可证分析、第三方 OAuth 登录、生产 MCP 服务、真实 SSH 文件端到端或系统通知的人工可见性验收；未在 macOS、Linux、Windows ARM64 真机安装。Fast 展示原生已提供的当前资格/恢复信息，不能视为所有 API key 或临时 broker 拒绝原因的完整诊断。跨平台能力须由对应环境继续验证。
