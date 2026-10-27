# 一次性发布待办：回复 the-snowpear/omp-studio#6

> 给下一位发布 agent。**目前尚未回复、未发布本次修复。** 仅在修复进入正式工件且发布成功后执行；评论成功并回读核对后删除本文件。未执行、失败或内容仍待确认时保留。

- 目标：<https://github.com/the-snowpear/omp-studio/issues/6>
- 创建日期：2026-10-27
- 用户要求：修复并验证，拟好一次性回复交接，发布时回复，用完删除。
- 本文件不授权现在发布，也不授权自动关闭 issue。正式评论前，按项目约定展示目标和最终文本并获得发布负责人确认；若负责人已明确授权向此目标发布最终文本，则按授权执行。

## 发布前后待办

- [ ] 确认下列修复均包含在待发布提交，不夹带未审核的本机改动。
  - Runtime：`createSessionManager()` 的隐式 `autoResume` 不再作用于 `studio-host`；显式 `--resume` / `--continue` 和普通 CLI 自动恢复不变。
  - 更新：按 Runtime 的最低桌面版本和协议提前投影 `blockedReason`，检查 API 返回 `plan: blocked`；诊断页和 Runtime-only 更新对话框说明原因并禁用对应更新按钮。兼容桌面准备后可成对更新。
- [ ] 按 `omp-patch/patches/series.json` 的**发布时最新值**确定 Runtime 身份；不要把本文件创建时的身份硬编码进发布。交接时来源是 OMP `18.12.6` / commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`，最新派生身份曾为 `18.12.6-studio.6`，期间有其他并行修改和 regen。
- [ ] Runtime 修复必须进入新编译的签名工件，或复用**完整来源摘要完全相同且已包含此修复**的工件；不能用已发布 `18.12.6-studio.1` 或旧来源 Runtime 代替。
- [ ] 确认待发布桌面、Runtime、签名更新清单的版本/最低桌面版本/协议一致；所有选定平台的发布检查和附件上传成功。不要因本机源码测试通过就称发布完成。
- [ ] 用真实版本替换回复草稿中的 `{{APP_VERSION}}`、`{{RUNTIME_VERSION}}`、`{{RELEASE_URL}}`，链接使用此次真实 release；不要预先猜下一版本。
- [ ] 重新阅读 issue 和最近讨论，确认是否已经有人回复此次修复；已回复则核对内容，避免重复。
- [ ] 向发布负责人展示下方替换后的最终文本与目标，取得所需确认后，在原 issue 发一条回复。
- [ ] 回读 GitHub 评论，确认成功、文本和链接正确；记录评论 URL 到发布交接/发布记录（若已有该记录），**删除 `doc/issue-6-release-reply.todo.md`**。不要自动关闭 issue，留待报告者复测。

## 可核验的实现位置

- 新建会话修复：vendor `packages/coding-agent/src/main.ts`；由 `omp:patches:regen` 生成到 `omp-patch/patches/0001-studio-cli-entry.patch`。
- Runtime 启动回归：`omp-patch/overlay/packages/coding-agent/test/studio-host-args.test.ts`。
- 更新兼容性真值：`apps/desktop/src/update-coordinator.ts`；检查投影 `apps/desktop/src/unified-updates-ipc.ts`；私有快照字段 `packages/runtime-installer/src/update-manifest.ts`。
- UI：`apps/renderer/src/DiagnosticsPage.tsx`、`AppUpdateDialog.tsx`、`settings/appUpdate.ts`；现有预览 fixture 同步增加阻塞演示场景。
- 对应回归：`apps/desktop/test/update-v2.test.ts`、Renderer `DiagnosticsPage.test.tsx` / `AppUpdateDialog.test.tsx` / `settings/appUpdate.test.ts`。
- 版本记录：`CHANGELOG.md` 的 Unreleased 两条 issue 6 修复。

## 本轮验证证据与限制

### 已通过

- 新增 Runtime 行为测试先在旧代码失败（Studio 新建返回旧 ID），修复后通过。
- 新增更新检查回归先在旧代码失败（期望 blocked，实际 available），修复后通过；覆盖最低桌面版本、协议不兼容以及准备兼容桌面后的恢复。
- Runtime 解析/Studio origin 专项：28 项通过、1 项跳过；另单跑新启动回归 5 项通过。
- 项目 packages、Renderer 生产包、Desktop 均构建成功；核心回归 329 项 Node + 130 项 Renderer 通过。首次 `npm run check` 和继续构建曾被本轮新增测试的两处类型错误拦住，已修正后完成同一构建/核心链路；不要写成首次命令一次成功。
- 构建后安装/更新/文件租约专项 66 项通过；Renderer 更新/诊断专项 68 项通过，最后改动的 Renderer 类型检查和 53 项相关回归再次通过。
- `runtime:verify-source`、生成补丁摘要/报告身份一致性、Runtime 工件元数据专项 19 项通过；`git diff --check` 通过。
- 浏览器隔离验收使用真实产品组件 + 静态 QA read model：阻塞原因和禁用按钮正确；禁用按钮点击后写操作计数仍为 0；桌面兼容后更新按钮重新启用；无 console error、无失败网络请求。QA 不下载或启动 Runtime，临时页面不进入产品构建。

### 不要扩大表述

- **未在报告者机器上确认其 `autoResume` 配置、实际桌面版本或具体更新失败日志。** 已复现和修复的是代码中能产生同样租约错误的路径及更新兼容性提示不一致，不代表所有 Runtime 安装失败原因均已解决。
- 截图 `A newer trusted Runtime artifact is available locally` 是发现新版的提示，不是安装失败证据；`signature: unknown` 也不等于签名损坏。
- 本轮没有编译/签名/发布新的 Runtime 二进制，没有执行真实 NSIS/macOS 安装升级，也没有付费模型测试。这些由发布阶段按既有流程处理。
- 核心测试仍有非本次修改的 `InteractionDeck` 嵌套 `<p>` 警告，测试通过；不把此警告称为本 issue 修复或新增失败。
- 工作区有很多用户/其他任务的未提交改动；regen 会把已有 vendor 修改一起捕获，不能把整个补丁 diff 都归给 issue 6。

## 发布后回复草稿

仅将本节替换占位符后的正文发到 issue；不要把 agent 的待办清单、内部验证记录贴到 GitHub。

---

感谢补充截图。我们已定位并修复了两处相关问题，修复已随 **OMP Studio {{APP_VERSION}} / Runtime {{RUNTIME_VERSION}}** 发布：

1. **新建会话的租约报错**：当 OMP 的 `autoResume` 开启时，Studio 启动的新会话 Worker 可能自动恢复已有会话，随后重复申请同一会话的写入租约，出现 `Session lease is already held by this Broker`。现在 Studio 新建会话会创建独立会话，不再受 CLI 隐式自动恢复影响；历史会话的显式恢复保持不变。
2. **Runtime 更新提示**：此前检查可能显示“可更新”，点击后才发现桌面版本或协议不兼容。现在检查阶段就会说明需先升级桌面的原因，并禁用不可执行的更新入口；兼容桌面准备好后仍可一起更新 Runtime。

请先从[此次发布页面]({{RELEASE_URL}})下载与你的 Windows 架构匹配的完整 Setup，退出旧应用后安装并重新打开，再测试新建会话和诊断页。

另外，截图中的 `A newer trusted Runtime artifact is available locally` 表示发现新版制品，并不是安装失败日志。我们尚未在你的机器上确认具体配置和更新失败原因；如果升级后仍有问题，请补充：

- 「关于」中的桌面版本，以及诊断页的托管/运行中 Runtime 版本；
- 点击更新后出现的完整错误；
- 当天 `%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`（上传前请检查并遮盖敏感信息）；
- OMP `autoResume` 是否开启。

请勿删除会话文件或租约锁来绕过报错。此 issue 先保留，等你复测后继续跟进。

---
