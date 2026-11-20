# OMP 19.0.1 迁移报告

Studio Runtime 的上游固定为 `can1357/oh-my-pi` 的正式标签 `v19.0.1`，提交 `f40f335845f0b136453d12fec8d6057011082766`。该提交生成的离线目录纳入 6,303 个模型，并收录 Kiro、Modal 和 Bifrost 的供应商定义。这些供应商的账号模型由 Runtime 连接后发现。工作台的功能入口集中在[功能索引](../../doc/feature-index.md)。

## 运行时与协议

- 反汇编器使用 `disassembler.*` 与上游 `dsm`。支持 IDA Pro、Ghidra、自动选择和仅头部元数据模式。数据库编辑通过预览令牌、版本绑定和原生备份执行。Dock 读取旧布局时迁移 `ida` 面板位置。
- Seance 已移除。工具长输出使用 `local://N.log`，旧 `artifact://N` 链接按会话读取。工作台可先创建会话本地目录，再复制路径或交给文件管理器。
- 会话生命周期按上游的 `agent_pause` 和最终 `agent_end` 投影。Handoff 调用原生后台压缩，完成后在当前会话呈现交接摘要。队列条提供取消操作。
- 服务面板采用统一 Daemon 的单元及启动代次。Kiro 使用原生多账号认证与额度，Claude 显示原生订阅等级。Live 支持自定义端点、密钥来源和音色，TTS 使用 Phonon 模型目录。

## 工作台适配

- Plan 卡片支持 Markdown 原位编辑、划选引用批注和独立保存，并按目标模型上下文判断保留条件。Ask 表单改成单流折叠布局，选项附注支持图片，主输入框可随部分答案结算当前表单并继续发送。
- 主输入框的 `?` 进入 BTW 模式。回答可从时间线便签或 BTW 面板操作，两处使用同一话题状态。
- 模型菜单支持供应商筛选、`provider/model` 搜索与思考档位。用量面板分列会话辅助调用和原生评判模型。设置页接入搜索、MCP、反汇编、子代理、缓存预热、记忆与压缩形态。
- 代理面板展示等待关系和跨实例发现。工作树视图显示 ovnfs 来源。对话流承接后台匹配输出与仅界面可见的扩展消息。桌面动作显示原生键盘交还状态。

## 验证

- `npm run omp:verify:patches` 在干净的 upstream 检出上重放 312 个 overlay 文件和四组接缝。Bun `check:ts` 通过，测试记录为 1,116 项通过、5 项跳过、0 失败，CLI 源码冒烟通过。
- `npm run check -- --production` 通过，覆盖架构、选择器、动效、类型、核心测试、生产 Renderer、沙箱 preload 和远端 Host 产物。
- `npm run test:tooling` 记录为 152 项通过、1 项跳过、0 失败。打包能力列表的顺序及哈希均与 Runtime 一致，离线模型目录可从固定提交复现。
- Chrome 使用隔离工作台和演示数据验证了反汇编、Plan、Ask、Kiro／Claude 账号、Live 配置和 Token 用量的同页中英热切。Form 和 Plan 草稿在切换时保留，`marks=off` 隐藏演示标记。BTW 已验证从主输入框提交、在时间线追问并打开 Dock。
- 在 1280×720 的完整工作台中，用鼠标点击「跳过并发送」验证了问题结算与新用户消息入队。关闭演示且 Runtime 断开时，账号页显示真实空态。
- 实机范围包括 Windows x64。Kiro 登录和付费请求、IDA／Ghidra 真库、外部 Live 服务、ovnfs 实际挂载、macOS 原生窗口及 Linux／macOS 桌面流程需要各自的环境验证。

## Windows x64 Canary

`npm run omp:build:host` 使用 Bun 1.4.4 和 Rust `nightly-2026-11-08` 生成了 `19.0.1-studio.1`。编译后的 `omp.exe` 通过冒烟、认证 Bridge 身份与命令清单探测，以及正常退出检查。

产物位于 `outputs/canary/omp-19.0.1-studio.1-win32-x64/`。使用独立开发公钥复核了 Ed25519 签名，也复核了二进制和清单的 SHA-256。二进制摘要为 `0cd00733f68da8bd199b79c5e907c4fbeb8f1102a5a6600caf40c5acf239f829`。
