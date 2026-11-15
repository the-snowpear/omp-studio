# tmux 控制模式合并审查

审查分支为 `codex/tmux-control-mode`，原实现提交 `4115d50`。先整合 `0.2.0` 的 `3148169`，再修复以下问题。用户主工作区的其他改动不属于本次提交。

## 已修复的问题

| 优先级 | 可复现行为 | 修复 |
| --- | --- | --- |
| P1 | tmux 的 `after-split-window` 等 hook 发出独立应答块，消耗 Studio 下一个命令的 FIFO 项，导致拓扑或抓屏拿到错误结果 | 启动之后仅接受带控制命令标记的块；真实 SSH 验证 hook 的块为 flags=0 |
| P1 | 抓屏正文包含形如 `%end 1 999 1` 的行，被当作当前应答的结束，破坏后续通信 | 同时匹配 time、number、flags；其他标记样式的行仍属于正文 |
| P1 | 同一工作区的多个对话挂载相同的 tmux xterm，屏幕会被另一个面板移走；跨工作区复用连接后找不到分组 | 按发起附加的终端面板记录归属，复用连接时转移分组并保留同一个 xterm |
| P2 | 隐藏窗口后，其他客户端新增的窗格恢复了输出 | Main 记录窗口隐藏状态，新增窗格继承；恢复整窗时遵守显示数量上限 |
| P2 | 移除连接后，异步 detach 的最后一份拓扑把已移除的分组加回列表 | 移除期间忽略该连接的退出拓扑，随后释放临时记录 |
| P2 | 新增执行层错误只有英文；旧分支与终端国际化更新冲突 | 使用现有 Desktop 语言助手，整合中英文终端提示；同页切换语言保留会话选择器草稿 |

切回窗口时重新发布视口尺寸，避免共享控制客户端仍使用另一个标签的旧尺寸。普通 Shell 标签在 tmux 被选中时也不再同时显示为已选中。

这些修复沿用现有的 IPC 输入检查、终端 ACK、xterm 和 Desktop 语言服务，没有增加输出校验器或多层输入校验。

## 验证

- Windows 上通过相关 Renderer 测试：`terminalSessions`、`TerminalPane`、`TmuxWindowView`、`i18n.test`。覆盖两个对话之间的连接复用、迟到的退出事件、关闭 / 隐藏 / 恢复，以及真实和预览路径同页 `zh → en → zh` 后草稿保留。
- `TMUX_TEST_SSH=<alias> npm run check -- --only desktop --suite tmux --suite terminal-ipc` 通过，实际远端为 Linux / tmux 3.4。独立随机 socket 覆盖 hook、协议样式正文、隐藏窗口远端新建窗格、中文输入、拆分、分离和重新附加；测试 server 已清理。
- 同一次 Desktop 检查回放了已提交的 tmux 3.2a、3.4、3.7c 原始字节，覆盖分块和 UTF-8 输出。3.2a / 3.7c 本轮没有重新搭建远端环境。
- Windows Chromium 使用临时验收页、真实 xterm 和 `TmuxControlManager`，经 SSH 连接 tmux 3.4：中文输入、左右拆分、拖动分隔线、同一分组转移到另一对话均通过。转移前后保留同两个 xterm 实例和中文输出。
- 真实与预览选择器在同一已挂载页面执行 `zh → en → zh`，输入的会话名称草稿保持不变。真实分屏和预览分屏均检查中英文；`marks=off` 不显示演示标记，预览没有创建终端实例。
- `npm run check -- --production` 通过（212.7 秒）：架构、选择器、动效、类型、核心测试及 Renderer / preload / 远端 Host 构建。截图与完整检查日志保存在本地恢复备份中。

本轮不宣称已验证 macOS / Linux 桌面壳、密码 SSH、物理断网或完整平台安装包。初次实施的验证范围见[计划中的实施记录](../../doc/tmux-control-mode-plan.md)。
