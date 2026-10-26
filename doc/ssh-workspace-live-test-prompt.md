# deskserver / ucloud 实机稳定性验收交接提示词

将分隔线后的正文直接交给执行测试的 agent。本文件不包含密码、私钥或连接令牌。

---

请亲自对 OMP Studio 当前未提交工作树进行 **deskserver（Windows）和 ucloud（Ubuntu）的 SSH 实机稳定性验收**。重点是连接抖动、偶发断线、自动恢复、取消及恢复后的界面行为，不是只跑单元测试。不要使用子代理。

这是测试任务：可以编写独立测试脚本、夹具和报告，但不要自行修改产品实现、修改断言来迎合实现、提交或推送。发现问题先保留证据并报告，不擅自扩大修复范围。

## 1. 工作目录和先读材料

工作目录：`D:\Project\omp-studio\.claude\worktrees\trusting-khorana-a24ebe`

预期分支：`claude/trusting-khorana-a24ebe`。先核对实际分支、HEAD 和 `git status`，不要切换分支。全部命令在此工作树执行，不进入原仓库根目录。

先读：
- `AGENTS.md`、`doc/feature-index.md` 的 SSH / Host 章节。
- `docs/ssh-workspaces.md`、`doc/ssh-workspace-progress.md`。
- `doc/ssh-workspace-test-report.md`：2026-10-25 的历史验收报告，**不要覆盖**。
- `doc/ssh-workspace-test-prompt.md`：完整功能与认证安全边界。

本轮主报告写到 **`doc/ssh-workspace-recovery-test-report.md`**；若已存在，先阅读并保留历史，使用带本轮日期/运行标识的新文件，不覆盖别人的结果。

功能包含大量未跟踪文件，不能只看 `git diff`。实现者在 2026-10-26 跑通过核心 314 Node + 129 Renderer、SSH 专项 47 项、Renderer 专项 37 项，但这是历史证据，不能直接当作你的验收结果；部分用例重复，不能相加为独立总数。

## 2. 授权和禁止事项

已授权使用本机系统 SSH 配置中的 `deskserver` 和 `ucloud` 做测试。**macOS 实测暂缓。** 不要在聊天中索取私钥或密码。

允许：只读探测；在本轮新建的私有测试目录部署 Host、创建临时 Git 仓库和测试文件；运行有限时、无付费模型调用的测试任务；关闭本轮专属 SSH 子进程和测试 Host；安全地注入仅影响本轮连接的故障。

禁止：
- 不读取私钥、不搜集真实密码，不把密码放 argv、环境变量、脚本、日志、截图、报告或 Git；不导出含凭据的堆转储。
- 不输出 `RemoteConnectionManager.get()` 整个对象、SSH 环境或 endpoint 文件：可能包含 attachment key、askpass ticket 或认证令牌。只记录白名单诊断字段。
- 不关闭 `StrictHostKeyChecking`，不自动接受指纹，不改用户 `known_hosts` 或 SSH config。
- 不改 `sshd`、防火墙、网络适配器、路由、DefaultShell、注册表、服务、账户或密码策略；不重启真实主机，不全局断网或暂停所有 SSH。
- 不按进程名批量杀 `ssh` / `node` / Runtime / ConPTY。只操作通过本轮 spawn 捕获并核实归属的进程句柄/PID，防止误杀用户连接。
- 不向真实项目写入，不清旧测试目录，不停止先前会话留下的 Host。旧报告中的目录/PID是历史数据，不是清理授权。
- 保留所有现有未提交改动。不 `git reset --hard`、不使用共享 stash、不批量删除、不提交依赖/制品/日志/截图。
- 工具权限拒绝后不要换工具绕过；请求正常授权或记录阻塞。
- 没有费用授权，不调用模型、不触发真实 LLM 工具任务。不能绕过 Runtime 签名或使用不可信测试签名冒充正式工件。

两台主机上次均为 `PasswordAuthentication no`。可重新只读确认，但不要为验收启用密码认证，不做真实错误密码尝试。条件没变化就将真实账密登录明确列为阻塞，继续完成密钥模式稳定性测试。

## 3. 先建立可复核的测试环境

按主机顺序测试，先 deskserver，再 ucloud，避免同时大量建立 SSH 连接。

1. 记录本机 OS / Node / npm / OpenSSH；远端 OS / 架构 / Node / Git / SSH 版本、Windows 登录 shell（只读，不修改）。主机地址、账号只在必要时脱敏描述，不复制完整个人 SSH 配置。
2. 两台主机分别做少量、有限超时的系统 SSH 基线探测。ucloud 历史有 TCP 超时；若失败，至多补做两次有间隔的对照，不循环刷连接。区分系统 SSH 也失败与仅应用失败。
3. 每台主机创建唯一运行标识，例如 `omp-studio-recovery-<timestamp>-<random>`，先确保目标目录不存在，再创建。优先使用远端实际临时目录：Windows 从远端 Node 的 `os.tmpdir()` 得到；Ubuntu 可用该账户私有缓存目录。记录本轮拥有的精确路径。
4. **新建独立 Host root/state 与测试项目**，不能使用默认生产 `omp-studio/remote/state`。测试工作区包含中文和空格，例如 `稳定性 test project`；创建本机另一个同名文件作为不应被修改的哨兵。
5. 新增脚本放当前工作树 `tmp/ssh-recovery-<run-id>/` 等独立测试目录，不和下载/解压内容混放。下载/解压各用新的空目录，不从其中运行解释器；读取不可信文件的 Python 用 `-I`。
6. 可以注入 manager 的 `services.probeRemote`：实际调用产品 `probeRemote`，仅将返回的 `environment.root` 改为本轮私有 root；`deployRemote` / `attachRemote` / OpenSSH / 远端 Host 都使用真实实现。完整记录这项隔离，不改生产源码或全局环境来改变默认根。
7. 测试 UI 时也必须隔离本机 userData/profile 与远端数据根。先核对项目真实支持的启动/注入方式，不能凭猜测传参数。若正常 Electron 无可用隔离入口，可以写独立 Electron 测试入口，复用真实 preload/IPC/manager，并只注入测试目录；报告要标注这是测试入口，不冒充正常安装包。无法隔离就将该项标阻塞，不冒险接管用户默认 Host。

## 4. 构建与本地回归

先运行一次完整检查，确保后续导入的是当前源码构建的 dist：

```bash
npm run check
```

```bash
node --test apps/desktop/dist/test/remote-*.test.js
```

```bash
npm run test -w @omp-studio/renderer -- src/workspaces/ExecutionTargets.test.tsx src/workspaces/remoteTransport.test.ts src/workspaces/SshPasswordDialog.test.tsx src/conversation/useConversation.test.ts src/conversation/conversation.test.tsx src/terminalSessions.test.tsx src/sidebar/useProjectHistories.test.ts
```

保留退出码与通过/失败/跳过计数。若临时目录被策略阻止，可为本次测试设置工作树内的新 TEMP/TMP/TMPDIR；不要修改全局设置。构建删除被拒不能擅自移动/删除目标来绕过权限。长命令后台执行，结束后读取结果。

## 5. 必须经过真实 manager 的自动恢复验收

主要入口：
- `apps/desktop/src/remote/{manager,transport,wire,deploy,server,main,ipc,errors}.ts`
- `apps/desktop/test/remote-{recovery,transport,ipc,host}.test.ts`
- Renderer：`workspaces/{ExecutionTargets,remoteTransport,RemoteScopeNotice,ExecutionTargetPicker}` 与对话 hook。

**不能仅调用 `attachRemote` 两次就声称自动恢复通过。** 必须创建真实 `RemoteConnectionManager`，通过 `save/connect/onChanged/onEvent/get/disconnect/close` 观察真实 OpenSSH + 远端 Host，并保留状态时间线。

记录每个阶段：连接 id（可脱敏）、state、generation、attempt/maxAttempts/retryAt、耗时、错误类别；同时记录 probe/deploy/attach 调用次数和 Host `hello.instanceId`、authority ID/epoch。可以包装真实服务计数，不能用假服务返回成功。不要记录连接密钥、令牌或完整 manager 对象。

每台主机完成以下矩阵：

| 场景 | 操作与通过标准 |
|---|---|
| 首次连接 | 实际 probe/deploy/attach、bootstrap、文件树、Git 成功；OS 正确；不是只连通 22 端口。 |
| 成功后保持连接 | 连上至少跨越两次实际健康检查，不能出现 connect 返回成功马上又断开。 |
| 瞬断自动恢复 | 捕获并只终止本轮控制通道的本机 SSH 子进程，不调用 manager.disconnect 或 transport.close 代替意外断线。应用自行 recovering→synchronizing→connected；没有调用者手动 connect；Host instanceId/authority 保持、generation 增加；probe/deploy 次数不增加、不 start、不重启任务。 |
| 短暂迟滞 | 在本轮私有通道上暂缓字节转发，第一次 ping 超时进入 degraded，及时恢复后同步成功；不必重新部署，不杀远端 Host。 |
| 连续失联 | 仅使本轮连接无法响应，连续两次 ping 超时触发恢复；每次 ping 默认最多 15 秒，检测调度间隔默认 15 秒。单个业务超时不能被误当作任务失败。 |
| 连续抖动 | 每次恢复后很快再次断开；重试预算不能因为短暂 connected 无限重置。默认最多 5 次 / 120 秒，退避约 1/2/4/8/15 秒 ±20%。至少有一轮按生产默认时间跑，缩短时间参数的结果只能单列为加速测试。 |
| 稳定后重置 | 保持成功连接至少 60 秒，再断开；新故障允许新的恢复预算。 |
| 取消恢复 | 退避中、attach 握手中、快照同步中分别取消；之后不再创建 SSH 子进程，不出现迟到 connected。再由用户操作/测试显式 connect 时可以正常连接。 |
| 恢复预算用尽 | 只针对本轮新 attach 持续制造失联直到上限；最终 failed、有明确提示，不无限重试；后续手动 connect 正常。 |
| Host 停止 | 在本轮 Host 无任务/审批时用受控 shutdown 停止，再观察恢复；不能自动 start/deploy。明确 Host unavailable；手动重新连接才允许准备新 Host。 |
| 同一 Host 的旧 attach | 让旧控制通道仍占着连接，再建立同一 manager 的更新通道；只能替换自己的旧 attach。旧序号迟到不能把新连接踢掉。不要将 attachment key 写报告。 |
| 其他桌面占用 | 用第二个独立 manager、独立连接身份连接同一本轮测试 Host，必须拒绝而不抢占第一方。不能拿用户真实会话当第二方。 |
| Host 实例改变 | 只在本轮 Host 空闲时停启，恢复/手动重连后能识别 instanceId 改变并重新同步；不得谎称原任务仍在运行。 |
| 目标隔离 | deskserver/ucloud 保持不同私有根、不同哨兵内容；事件、读结果、写入不串机器，不回落本机，同名本机文件不变。 |

### 故障注入必须诚实分层

优先使用可持有实际进程句柄的 `spawnProcess` 测试包装捕获系统 SSH 子进程；不要把 `peer.close(new Error(...))` 的内存模拟写成真实网络断线。

允许使用**仅本轮专属、仅绑定 loopback 的可控转发器**暂缓/断开测试流量，结束后关闭它。复用原 SSH host/key 验证，不修改用户 config；若要使用进程级临时 SSH 参数，必须保留原目标身份和严格主机密钥检查。不得抓取/打印认证内容，不开放任意远端代理。

如果仅在本机 SSH 的 stdin/stdout 与 RemotePeer 之间延迟转发，它验证的是“真实 SSH 后的应用控制通道迟滞”，不是 TCP 丢包；报告必须这样写。因环境限制只能做内存注入的项目单列为隔离测试，不能标实机网络故障通过。

无法安全制造某种故障就写阻塞原因，不改系统网络来凑通过率。

## 6. 未知结果与任务存活：避免重复执行

在每台机器的本轮测试仓库中选择一个有限副作用操作，例如写入唯一内容的文件或创建唯一 Git 分支。使用产品真实 typed query/command，先读契约，不猜命令名。

- 先确保操作确实已到达远端，然后阻断返回确认的通道。客户端应标记 outcome_unknown，而不是断言远端失败或自动发第二次。
- 恢复后用真实远端只读检查核对结果；记录请求 id、服务调用计数或本轮文件/分支证据。相同请求/副作用不得自动重放。
- 仅在发出命令前断开连接，不能证明“执行后丢确认”语义。应说明注入点、确认已到达远端的证据和为什么可以得出未重放结论。
- 不能重新发送命令后把最终成功当成恢复原命令成功。
- 若要验证 Runtime 会话存活，只能使用本轮可合法获得、签名受信任且架构匹配的 Runtime；可创建空会话而不调用模型。无可用 Runtime 则标阻塞，别动默认 Runtime 根或复用用户正在运行的会话。
- 外部自建 Node 定时任务继续运行只能证明该进程存活，不等于 OMP Runtime 任务存活；审批/流式模型任务未测要明确列出。

## 7. Electron UI 实际闭环

浏览器 `ssh-recovery-harness.html` 和单元替身只能作为对照，不替代以下真实链路：Renderer → preload → Main IPC → manager → 系统 SSH → 两台远端 Host。

在安全隔离的 Electron 环境中，分别检查：
- 连接后选择本轮中文/空格项目目录，查看真实文件树和 Git，不能显示 fixture 后标通过。
- 留下一份未发送草稿、一个未保存表单和一条终端回滚；断控制通道后当前目标保持，不能自动切回本机。
- 恢复中/同步中不允许新的写操作；控件有状态/取消提示，预算耗尽有手动重连入口。
- 网络断开期间只在测试项目添加一个唯一文件、改变 Git 状态，恢复后相应表面自动更新；当前对话按原身份重新读取，旧事件/旧异步读不能覆盖新状态。
- 同一 Client、同 Runtime epoch 恢复也能刷新，不需要换页。页面/草稿/未保存表单不通过整页重挂而丢失。
- 仅页面同步失败时显示“重新同步”，不能强迫重新部署或再次索取密码。
- 原生部署确认未返回时整页重载：取消旧尝试，迟到确认不能开始连接；新页面 IPC 仍能连接。
- probe/deploy/attach/sync 或自动恢复期间重载 Renderer、模拟本轮 Renderer 崩溃：未完成连接停止，不能迟到 connected。
- 已稳定连接时正常整页重载应保留 Main 已建立连接，并同步新页面；不承诺整页重载保留仅存于 React 内存的草稿，不能和“网络恢复保留草稿”混为一谈。
- 退出本轮测试应用后，没有本轮 SSH/PTY/重试计时器继续运行；不关闭用户其他应用实例。

无法控制真实 Electron UI 就写明此层未验收，不能用静态代码检查、浏览器 mock 或纯 manager 脚本替代。

## 8. 真实终端与既有脚本

现有脚本可以先做基础冒烟，使用密钥模式且自建远端 root；先阅读再运行：

```bash
node scripts/test-remote-ssh.mjs deskserver
```

```bash
node scripts/test-remote-ssh.mjs ucloud
```

```bash
node scripts/test-remote-terminal.mjs deskserver
```

```bash
node scripts/test-remote-terminal.mjs ucloud
```

注意：这些脚本**没有验证新的 manager 自动恢复**，并且失败路径及远端临时目录清理不完整；由你的 harness 在 finally 精确收尾，不盲目重复脚本导致 Host 累积。

- 两台机测试真实 PTY cwd、输入输出、resize、Ctrl-C、关闭；使用 xterm 应答，不用普通 pipes 冒充 PTY。Windows DefaultShell 上次是 Git Bash，不要修改成 PowerShell 来掩盖问题。
- 只中断控制通道时独立终端可以继续存活，不要求强行关闭。只中断终端自己的 SSH 进程时，显示 ended、保留回滚，不自动重开 Shell、不重放按键。
- 新终端仍进入对应远端 cwd。控制通道恢复不能把旧终端改投另一台主机。
- `test-remote-session.mjs` 会创建会话并请求 shutdown。只能传本轮自己创建的 entry/state，且已具备合法 Runtime；绝对不能传生产目录或旧报告目录。

## 9. 收尾与报告标准

所有场景有时限和 finally。保留本轮资源清单：本机测试目录、远端 root/state/project、本轮创建的 Host/SSH/PTY PID及启动归属。先用 typed shutdown 停本轮空闲 Host，再关闭附加通道；仍有工作时不得强行停。若确需处理遗留进程，重新核实 PID、启动时间/命令、精确测试路径，不能仅凭旧 PID。

只清本轮确切创建的资源，删除前核对 marker 和路径，不能对用户提供的任意路径递归删除。无法确认归属或断网无法清理时，在报告列出脱敏后的精确残留路径/归属证据、原因，不冒险清理。

报告必须包括：
1. 结论：能否作为开发预览使用、是否达到发布要求，依据是什么。
2. 版本/环境/时间/本轮目录，源码与实际运行 bundle 对应关系。
3. **deskserver 和 ucloud 分别的用例矩阵**，每项为通过 / 失败 / 阻塞 / 未测试四选一；另列证据层级：本地隔离、实际 SSH 通道、TCP 故障、正常 Electron、独立 Electron 测试入口、安装包。
4. 命令、退出码、耗时、默认重试/时间预算实测时间线、每次 probe/deploy/attach 数量、Host instanceId/authority 是否保持。
5. 缺陷：严重度、复现步骤、预期/实际、相关文件行号、最小脱敏证据。ucloud 系统 SSH 同样超时的情况单列环境问题，但恢复预算/提示/清理错误仍可判为产品缺陷。
6. 密码登录阻塞、macOS 暂缓、未做的模型/审批/睡眠/安装包项目明确列出，不笼统写“全通过”。
7. 资源清理结果和残留；不得包含私钥、密码、token、ticket、attachment key 或完整个人 SSH config。

最后向用户交付报告文件，并用简短中文说明两台主机实际通过什么、仍阻塞什么、是否发现需要修复的问题。无需提交、推送或修改服务器配置。
