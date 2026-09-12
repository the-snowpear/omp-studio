# OMP v18.1.18 Runtime / Studio 迁移记录

## 基线与范围

- 功能基线：`18.1.10-studio.2`，上游 `f241301c83726afe75a847e919b89977a54dafbe`。
- 固定目标：`v18.1.18`，上游 `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。
- 最终 Runtime：`18.1.18-studio.5`，Windows x64；已按 v18.1.18 frozen lock 对齐依赖并重新完成源码、工件和 GUI 验收。
- Studio 应用版本保持 0.1.4；本地迁移工件不发布、不自动安装、不创建 Git 提交。
- 两个上游提交之间有 805 个提交（含 merge）、651 个文件变化；其中包含生成的模型目录与测试，不能等同于 651 处公共 API 破坏。
- 启动时已有 vendor gitlink、upstream.json、series.json 的目标 pin 修改；保留这些修改和无关的 docs/reviews/。
- 编辑前快照：`backup/2026-09-12/omp-18.1.18-183726/`。新增接缝、Desktop 与 transport 各有独立补充快照及 README。

[正式版发布说明](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.18) · [精确比较](https://github.com/can1357/oh-my-pi/compare/f241301c83726afe75a847e919b89977a54dafbe...00085d4e7dfdcfbf302c122fa2682b410a0f43d1)

## 更新与适配矩阵

| 能力 | 上游变化 | Studio 处理 / 验证 |
|---|---|---|
| 压缩 / 缓存 | Claude 服务端压缩、Anthropic 历史缓存断点与 OAuth 1h 缓存、重复压缩和 token 估算修复 | 沿用原生 remote 链路；原生回放 payload 留在会话记录，不进入公开 transcript；覆盖 notes/compaction 私有数据不泄漏 |
| 重试 / 恢复 | 配额重置等待、EOF/代理断流恢复、已执行工具安全续跑、Copilot 认证修复 | 增加配置开关；状态快照保留尝试次数、绝对重试时间和有限原因枚举；不把供应商错误正文作为状态输出 |
| Plan | 批准计划内联执行上下文、自动保存 | 共享 Runtime 审批路径调用上游 autosave，失败警告而不回滚已提交审批；保全 execute/compact/keep/refine/dismiss/saveAndQuit |
| Prewalk / 命名 | Prewalk restart、tiny 模型生成会话名 | 新增 `session.prewalk.restart`；自动命名复用 `operator.invoke / builtin.rename`，不解析 ANSI 或文本输出 |
| Loop | while/until Shell 条件、插话与 Vibe/reset 修复 | `loop.enable.condition = {command, until}`；共享调度器处理代次、取消、退出码、超时和迟到结果；TUI 原生条件测试继续保留 |
| 笔记式上下文 | 分支笔记、原始历史搜索、模型请求轮换 | 实验开关默认关，写配置不热替换工具；快照区分 configured/effective/restartRequired；不额外实现笔记编辑器 |
| Agent Hub | 隔离任务不可恢复、多份嵌套仓库补丁、WorkPool yield 修复 | 从原生注册表 / session_init 传递 isolated 和 nestedPatchPaths；send 与 revive 均在 Runtime 拒绝隔离复活 |
| 模型 / 价格 | Muse Code、Command Code、DeepSeek V4.1 / Muse reasoning、分时和生效日价格、图片发送策略 | 配置/登录入口复用原生流程；价格 metadata 只读，固定覆盖不混用；UTC 时段及长上下文阈值覆盖测试 |
| 工具 / 扩展 | 浏览器冻结和超时回收、审批、插件发现、MCP reload 状态等修复 | 保留新版实现；不把 Host 的 MCP 配置探测冒充 Runtime 连接库存；复合 Shell 授权仍默认关闭 |
| TUI | Vim 编辑、鼠标子任务焦点、草稿恢复、当前会话标记 | 保留上游，不复制到 Electron 编辑器 |

正式版之后 main 上的 MCP 重连工具释放、DeepSeek Flash V4.1 wire contract、heap snapshot 修复不包含在此 pin 中，不做隐式 cherry-pick。

## 接口与安全边界

- 保留协议版本 1，增量增加操作、可选快照字段和严格校验；Host / Renderer / Runtime 一起构建，不承诺任意混配旧 Runtime。
- `runtime.settings` 增加 `plan.autosave`、`plan.autosaveDir`、`retry.waitForUsageReset`、`compaction.experimentalContextManagement`。
- 实验设置必须持久化；当前 Runtime 保持已有工具配置，用户明确重启后生效。保存操作不重启进程、不操作真实用户会话。
- Loop 首轮不执行条件，后续仅按退出码判断：0/1 是条件结果，其他退出码、启动失败和超时是错误。默认超时沿用上游 30 秒。
- Loop 的 token limit 保持原有 unavailable/limited 说明，不虚构计费口径；现有 Live 等尚未具备的能力也不提高等级。
- 模型价格仅用于当前预估；历史用量使用原始 usage/cost，不按新价表回算。用户显式固定覆盖优先。
- 认证、runtime epoch、事件序号、幂等收据、操作代次、远端交互与权限边界不降级。
- 所有新增 GUI 控件有真实与预览两套路径；预览展示有标记，演示按钮不调用 Host。

## 验证记录

| 门禁 | 结果 |
|---|---|
| `npm run check` | 通过；所有 workspace 构建、类型检查和测试，含新 GUI / IPC / 协议 / 模型价格用例 |
| `npm run runtime:verify-source` | 通过；HEAD 为锁定的 v18.1.18 提交 |
| `npm run omp:install-deps` | 通过；同步 39 个包，随后构建 preflight 再次检查 frozen lock；抽查 connectrpc 2.2.0、huggingface/hub 2.16.3、inquirer/prompts 8.7.2、oxlint 1.82.0 与锁一致 |
| `npm run omp:verify:patches` | 完整运行通过；最终取消修复又从干净 vendor 运行 OMP 检查、全部受管 overlay 测试和新增上游定向测试（使用 `--skip-workspace-check`，Root 门禁已独立通过） |
| `npm run omp:build:host` | 通过；实际 exe smoke、hello、command manifest 与签名工件身份一致，版本为 18.1.18-studio.5 |
| `npm run omp:test:metadata` | 通过；pin、能力清单、签名与安装包元数据检查 |
| `npm run omp:e2e:install` | 实物 Runtime 安装/激活通过；18.1.10-studio.2 → 18.1.18-studio.5 → 18.1.10-studio.2 → 18.1.18-studio.5，均在临时目录验证 |
| `npm run pack:win -- --skip-host --skip-build` | 通过；复用刚构建并验收的 Runtime / workspace，不跳过签名和打包审计 |
| `npm run pack:win:audit` | 通过；x64、CSP、Renderer、preload、Runtime 和仅公钥打包检查；Setup 约 168.6 MiB |
| `OMP_E2E_ALLOW_MODEL=1 npm run conversation:e2e:manual` | 通过；实际 Electron + managed Runtime + 已配置 DeepSeek-V4-Flash-0731（high），随机文件内容验证、真实显示、取消后循环保持暂停、重载保留 epoch / transcript / 工作区、历史可发现 |
| `npm run perf:streaming` | 真 Chrome 全部门禁通过；布局放大 2.19 ≤ 2.50，堆保留比 1.02 ≤ 1.25，DOM 放大 1.02 ≤ 1.35，繁忙 p95 26.90 ms ≤ 120 ms；未放宽阈值 |
| `git diff --check` | 通过 |

取消复核新增了可复现回归：原先 `core.abort` 已暂停 Loop 后，较早 `core.prompt` 的迟到完成仍可能重新捕获正文。最终使用带代次的 prompt hold：准备/运行手工提交时取消条件与自动调度，暂停、禁用或换会话后不接受旧提交的 capture。先验证失败，再以 dispatcher 和共享服务用例验证修复，最终真实 GUI 也覆盖该场景。

最终日志与截图位于本机 `%TEMP%/omp-studio-migration-18.1.18-20260912/`：`workspace-check-final.log`、`dependency-install.log`、`patch-verify-locked.log`、`runtime-build-locked.log`、`metadata-locked.log`、`install-rollback-locked.log`、`pack-win-locked.log`、`installer-audit-locked.log`、`gui-locked/report.json` 和 `streaming-perf.json`。GUI 测试前后 config.yml / models.yml 摘要一致，未改写原账号配置。依赖对齐后重跑了完整 OMP 检查/测试、签名构建、安装回滚、打包审计和真实 GUI；Renderer 源码未再改变，性能门禁阈值保持不变。

### 验证边界

- Muse Code、Command Code 的配置和原生 RPC 登录入口已接入；没有替用户登录或复制凭据，供应商账号级联调未运行。要求手工输入的认证流程保留现有的明确 CLI 提示。
- Claude 服务端压缩通过上游原生 compaction 用例与 Studio 数据隔离测试验证；没有为触发 55k 阈值刻意制造付费长上下文。
- 实际安装/回滚验证针对签名 Runtime 安装器。Setup 已生成和审计，但未运行系统级安装向导，不覆盖当前安装或注册表；未替换现有全局 OMP。
- 未发布 release、未提交 Git、未追随 main；本地 Windows Setup 未使用 Authenticode 签名，Runtime 工件仍通过 Ed25519 验证。
- 新版 oxlint 对既有 overlay 监听器快照等代码提出非阻断建议；没有为了消除建议而改动无关的监听器迭代语义。

## 重建、工件与回滚

日常源码流程保持：

```bash
npm run omp:install-deps    # 升级 pin 后先按上游 frozen lock 同步依赖
npm run omp:overlay:apply
# 在 vendor 修改源码
npm run omp:patches:regen
```

接缝仅由 regen 生成。验证器从 overlay 自动发现所有受管测试，避免新增测试漏入手写列表，并保留原生 compaction/context-notes/loop/prewalk 测试。

Runtime 构建现在会先核验 source pin 并调用 frozen-lock 依赖安装，防止 vendor 已切版本但 node_modules 仍来自旧 pin 的混合构建。全局 Bun / Node 版本不自动升级。

`series.json` 的 digest 与 patchsetVersion、两处 Runtime 上游身份、二进制 hello/manifest 探针和安装工件已经对齐：

- patchset digest：`sha256:b3c017a35eeee5cdc6d4059e1085db847d94ba5f206ca32a39827e0ebd59709f`。
- capability hash：`sha256:6778f2e9823d3506135274c43ced05c4d1428b7e4c176cf62ff0175ed43f1781`。
- command manifest hash：`sha256:2511ae5006d0bd5489527d9c590802631df92e17c06a38a4353b04c12ebfcd24`。

最终工件：

- Runtime 四件套：`packages/runtime-installer/dist/artifacts/win32-x64/18.1.18-studio.5/`。
- Windows Setup：`outputs/installer-18.1.18-studio.5-migration/OMP-Studio-Setup-0.1.4-win-x64.exe`。
- Setup SHA-256：`79032f87385f2d5d99253371d49e7c7caf2b2a2fbf9872527a5ad33024a81b67`。

Windows 打包设置 `OMP_PACK_OUTPUT_DIR` 到独立目录；`pack:win` 与 `pack:win:audit` 使用相同目录，不覆盖已有 `outputs/installer/`。不启用随机系统证书签名；Runtime 仍使用项目 Ed25519 工件验签机制。

回滚仅在临时安装目录和隔离 userData 中验证，保留旧的 18.1.10-studio.2 工件。升级后的新数据不删除；不承诺旧 Runtime 能续跑新实验笔记会话。迁移前的会话副本用于恢复验收，真实账号配置不改写、不记录到报告。

旧工件使用 `omp-studio-release-2026b`，新本地工件使用 `omp-studio-local`。回滚验收显式加入仓库已有的发布公钥，不改签旧工件、不覆盖任何密钥：

```bash
npm run omp:e2e:install -- --artifact packages/runtime-installer/dist/artifacts/win32-x64/18.1.18-studio.5 --rollback-artifact packages/runtime-installer/dist/artifacts/win32-x64/18.1.10-studio.2 --rollback-public-key packaging/keys/omp-studio-release-2026b.pem
```

真实 GUI / 性能脚本可通过 `PLAYWRIGHT_MODULE` 使用外部已安装的 Playwright，不要求改项目依赖锁；性能脚本另支持 `PERF_BROWSER_EXECUTABLE`。真实模型脚本须显式设置 `OMP_E2E_ALLOW_MODEL=1`，每次最多发送两条前台提示词。测试只桩化文件夹选择对话框，Host、IPC、签名 Runtime、模型响应和会话恢复均走真实实现。
