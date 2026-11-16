# OMP 18.20.2：前端复核修复与收尾验收

日期：2026-11-16。工作树：`D:\Project\omp-studio\.claude\worktrees\omp-18.20.2-backend`；分支：`feat/omp-18.20.2-backend`。本报告承接用户批准的“修复全部问题”，不代表发布或安装升级。

## 隔离验收阶段结论

- 原复核的 **15 项问题均已实施修复**，包括两项 P1；修复结论已回填审查结果。
- Runtime 源码为 **`18.20.2-studio.5`**；上游固定 `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`，Studio 产品版本仍为 `0.2.0`。
- 全量 Renderer **294 个文件、2,081 项全部通过，0 失败、0 跳过**，门禁总耗时 567.4 秒；生产门禁、定向 Renderer 回归、原生设置回归及同源签名 canary 验证也通过。
- **界面复验未完成**：Browser 工具仍从原工作区解析 `.claude/launch.json`，无法找到工作树的 `omp-18202-review`。没有启动原工作区的服务冒充当前修复结果，也没有修改原工作区配置。
- 该次隔离验收结束时，既有未提交内容保留，尚未提交、推送、合并、发布或替换用户安装版。本报告的测试数量是该阶段快照；后续按用户指示进行的本地提交与合并以 Git 记录为准。本次收尾没有新增子代理。

## 修复范围

| 项 | 已实施的改动 | 主要回归 |
| --- | --- | --- |
| 1 | Bash 编辑只保存所选配置层的 `editableValues`；保留路径分组和未知属性，旧 Runtime 缺少分层数据时只读。 | `Runtime18202Settings.test.tsx`；原生 `studio-feature-policy.test.ts` 的跨项目审批隔离；编译 canary 的真实 Bridge 保存。 |
| 2 | 冻结补丁使用独立读取代次；修改选择、重新冻结或重置时使旧响应失效，避免显示与执行的预览不一致。 | `SelectiveCommitPane.test.tsx` 的预览 A 迟到、当前执行 B 场景。 |
| 3 | Host 在准备恢复后返回不透明 `threadId`；Renderer 先等待 `session.resume` 成功，再读执行工作区历史。 | `sessionActions.test.ts`；`SessionPickers.test.tsx`；Desktop `session-commands.test.ts`。 |
| 4 | 草稿范围标为 Agent 范围；单值（含 `self`、`*`）按标量发送，多 Agent 才用数组；文件过滤仍由 `only` 承担。 | 面板参数回归；真实 Bridge 的标量 `self` 草稿准备。 |
| 5 | HTML 表格只枚举当前表格的 `rows` 与 `cells`；嵌套表格在单元格内递归一次。 | `richPaste.test.ts` 的嵌套叶节点和 thead/tbody/tfoot 场景。 |
| 6 | 聊天角色入口与“更多模型”都排除非 chat 模型，不把 Judge 角色作为聊天目标。 | `ComposerModelPicker.test.tsx`。 |
| 7 | `shellPath`、`find.verifyModel` 可提交空字符串恢复原生默认；不再因空输入禁止应用。 | `Runtime18202Settings.test.tsx`；真实 Bridge 保存非空后清空。 |
| 8 | 已保存会话的 Fork 默认只阻塞压缩，不阻塞流式；后台目标使用其 resident 压缩状态。 | `AppSidebar.threadRowMenu.test.tsx` 的流式／压缩组合。 |
| 9 | 输入历史复用当前 Surface 的 document/window，统一 portal、定位、监听、计时器和焦点归属。 | `PromptHistory.test.tsx` 的分离文档场景；不等同于原生独立窗口实测。 |
| 10 | 输入历史按完整引用与缓存代次读取；重复点击当前范围不清缓存，范围、搜索或预览语言变化触发适当重读。 | `PromptHistory.test.tsx` 的重复范围、缓存、迟到正文和语言切换场景。 |
| 11 | 恢复列表读取不再因语言变化清空 placement；选择中的执行工作区保持不变。 | `SessionPickers.test.tsx` 的同页语言切换和失败保留弹窗。 |
| 12 | 富文本 data URI 复用既有 `isImageMimeType`，内嵌 base64 SVG 转成图片附件。 | `richPaste.test.ts` 的 SVG 附件及 BMP/TIFF slot 场景。 |
| 13 | 被淘汰的 prepare 结果由原发起 source 释放，避免未 adopt 的草稿占满原生租约预算。 | `SelectiveCommitPane.test.tsx` 的卸载／新启动意图淘汰场景。 |
| 14 | 常驻删除警告保存 title/details，Studio 前缀在渲染时按当前语言翻译，原始 Host 原因保留。 | `sessionActions.test.ts` 的中英文警告格式化。 |
| 15 | 移除提交标题的额外 `maxLength=200`；保留完整输入，由 Runtime 唯一校验。 | 面板的长标题回归；编译 Runtime 成功提交 201 字符标题。 |

同时对齐了已有行为的过时断言：`RuntimeSettings.test.tsx` 不再寻找已迁走的重置券下拉框；`dock/railPresentation.test.tsx` 使用当前四组原生 Context 分类。没有修改对应产品实现来迎合断言。

## 验证结果与证据

所有命令通过隔离 wrapper 执行：独立 HOME/USERPROFILE、APPDATA、agent、config/data/cache/state/TEMP，移除继承的 Provider 密钥、端点与路由；Runtime 状态放在仓库外的同盘临时目录。测试中的 Git 提交只发生在临时 fixture 仓库。

| 验证 | 结果 | 本地证据（忽略产物） |
| --- | --- | --- |
| 生产门禁 `scripts/check.mjs --production` | **通过，230.4 秒**。架构、选择器、动效、全部类型、核心包与 Renderer 回归，以及 Renderer/preload/remote-host 生产包通过。 | [`production.log`](../../tmp/frontend-fix-SkEtrg/production.log) |
| 最终定向 Renderer 切片 | **通过，49.3 秒**。覆盖 15 项修复相关 suite，并包括首轮失败日志中可识别的 `AgentAccountRules`。 | [`focused-final.log`](../../tmp/frontend-fix-SkEtrg/focused-final.log) |
| 全量 Renderer 首轮 | **2,079 通过、2 失败，294 个文件**。门禁只保留错误末尾，未把此次退出 1 描述为通过；未根据超时日志改无关产品代码。 | [`renderer-all.log`](../../tmp/frontend-fix-SkEtrg/renderer-all.log) |
| 全量 Renderer 最终复跑 | **294 个文件、2,081 通过、0 失败、0 跳过，门禁总耗时 567.4 秒**。保持单一 `scripts/check.mjs --only renderer --all` 入口与原 worker 配置，仅加 reporter 保留完整日志和逐测试 JSON。首轮两项失败在本轮全量复跑中未复现；原失败输出仍保留。 | [`renderer-final.log`](../../tmp/frontend-fix-SkEtrg/renderer-final.log)；[`renderer-results.json`](../../tmp/frontend-fix-SkEtrg/full-final/renderer-results.json)；[`renderer-raw.log`](../../tmp/frontend-fix-SkEtrg/full-final/renderer-raw.log) |
| 最终上游 pin | **通过**，仍为 `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`。 | [`source-final.log`](../../tmp/frontend-fix-SkEtrg/source-final.log) |
| 当前 Runtime 元数据／签名专项 | **20 通过、0 失败、0 跳过**。版本常量、能力镜像、patch/overlay 摘要及 Installer 验签通过。 | [`runtime-metadata-final.log`](../../tmp/frontend-fix-SkEtrg/runtime-metadata-final.log) |
| overlay／vendor 与交付边界 | **314 个 overlay 文件逐字节一致**；无差异或意外纳入的依赖、build/temp/.bak 产物。`git diff --check` 通过，项目 HEAD 未改变。 | 当前文件与 Git 状态的本地检查；非重跑最初的完整原生重放。 |
| 原生设置政策／配置层 | **4 通过、0 失败**；包含真实跨项目审批隔离、路径分组 env、会话覆盖及清除。 | [`native-policy-final.log`](../../tmp/frontend-fix-SkEtrg/native-policy-final.log) |
| `studio.5` 同源 Runtime 构建 | **通过**：native addon、编译二进制 smoke、认证身份、manifest/checksums/Ed25519 canary 签名。存在既有 Rust dead-code 与 Windows linker warnings，未称为零警告。 | [`runtime-build.log`](../../tmp/frontend-fix-SkEtrg/runtime-build.log) |
| canary 签名与隔离激活 | **通过**。真实 Installer 验签、校验文件并激活，只写隔离安装目录。 | [`canary-install.log`](../../tmp/frontend-fix-SkEtrg/canary-install.log) |
| 编译 canary 的真实 Bridge | **12 项检查通过，模型／付费请求均为 0**。包括分层 Bash 写入与清覆盖、可选设置清空、模型分页释放、只读就绪、历史、账户、标量 Agent scope、冻结确认、201 字符提交及 foreign staged 保留、正常退出。 | [`bridge-final-canary.json`](../../tmp/frontend-fix-SkEtrg/bridge-final-canary.json) |

### 当前制品身份

- 制品目录：`tmp/verification/build-6quBgr/artifacts/`。
- `omp.exe` SHA-256：`009af5dd3474d06f3f13475c1c7912996cc5bb7040de1735df43638cc2d653a9`。
- patchset digest：`sha256:6025630281b487bf4469207313a02f1a737d65a8ca73fc25dbfcd4a402cc883d`。
- 版本与输入以 [`series.json`](../../omp-patch/patches/series.json) 和 canary manifest 为准。接缝只经 `omp:patches:regen` 生成，没有手工编辑 `.patch`。
- 这是临时 Ed25519 key 签名的本地 canary，不属于正式发布信任链；没有发布或提供它作为用户升级包。临时 key、依赖、日志、截图和 build 输出不进入版本控制。

## 仍未验证的边界

- 当前修复的真实 Browser/GUI 交互、布局与截图尚未复验；无法启动工作树预览服务的限制已记录。Renderer fixture/分离文档测试不能替代 GUI 验收。
- 未进行真实 OAuth/ACP 登录、模型推理、付费 Benchmark/Judge、账户额度验证或音频上传。
- 未验证 macOS/Linux 制品、macOS Secure Event Input/焦点归还、实机锁屏／休眠组合，以及原生独立窗口中的历史弹层。
- 最初后端交付的 `studio.3` 完整重放、1,109 项原生回归、官方 ACP 与 canary 证据仍是阶段记录，不冒充本次 `studio.5` 的全量平台验收。

调用约定见[前端交接](../migrations/omp-18.20.2-frontend-handoff.md)，最初后端迁移记录见[分阶段迁移报告](../migrations/omp-18.20.2.md)。
