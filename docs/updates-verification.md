# 更新系统验证记录

分支：`codex/incremental-updates`。记录日期：2026-09-18。

## 审查修复复验（2026-09-18）

审查报告的 R1–R7 已完成代码修复，详见 `docs/reviews/incremental-updates-fixes-2026-09-18.md`。

- 重新运行 `npm run check` 通过：Renderer 573 项、Desktop 362 项，其他 workspace 全部通过。日志 `outputs/review-fixes-check-20260918.log`。
- `npm run omp:test:metadata` 45 项通过，包含旧 Runtime 遮蔽独立发布的拒绝测试和直接编译生产 C# 维护类的迁移结果测试。日志 `outputs/review-fixes-metadata-20260918.log`。
- Runtime 事务回归覆盖激活前、激活后、最终 journal 保存后三个中断检查点，以及分次准备、部分准备失败、外部桌面版本变化后的最终兼容性校验。
- 桌面回滚覆盖准备与应用分离、跨启动保留、后台准备不可覆盖；Renderer 覆盖真实两步操作、失败/忙碌重试、无旧版本禁用及不调用桌面 API 的预览。
- Composer 覆盖创建期间连续发送互斥、同帧重复进入及失败后重试；Runtime-only 弹窗隐藏不支持的跳过按钮。
- `node scripts/build-installer-host.mjs` 编译并暂存新版 Windows 安装宿主成功；`git diff --check` 通过。

本轮没有重新生成完整 Setup、执行真实安装/卸载或发布。以下旧打包与差分测试记录保留为此前验证结果，不代表此次源码已完成实机安装验收。

## 已完成

- `npm run check`：全部 workspace 编译、类型检查和测试通过；Renderer 560 项、Desktop 355 项，其他包测试也全部通过。
- `npm run omp:test:metadata`：43 项通过，包括 v2 发布文件集合、独立 Runtime 发版和旧索引迁移兼容。
- Runtime installer：54 项通过，包括签名身份、工件损坏、确定性 ZIP、目录越界和归档格式拒绝。
- 更新专项测试覆盖差分失败后单次全量回退、取消不回退、独立组件发现、防回退序号、跨启动保留待更新、忙碌会话阻止应用、执行前再次校验、Runtime 启动失败恢复和旧安装迁移验签。
- 居民会话重启测试保存并恢复两个工作区的原会话 ID，重启关闭阶段拒绝新会话操作。
- Windows x64 NSIS 构建及安装包审计通过。打包 EXE 的 `--omp-print-abi` 启动检查通过：Electron 43.4.0、modules 148、node-pty 1.1.0。
- v2 清单和正式签名 Runtime 工件验证通过；P5 的 Runtime/安全测试、私密材料扫描、v2 签名与附件检查均通过。
- 五个历史 GitHub Release 标题与正文已经整理，远程复核确认附件 ID、名称、大小、摘要、URL 与备份一致。

## 实际差分传输

使用固定版本 electron-updater 的 GenericDifferentialDownloader 和本地 HTTP Range 服务实际下载，重建后校验 SHA-256：

| 样本 | 完整字节 | 实际传输字节 | 节省 |
|---|---:|---:|---:|
| 本地 Runtime 两版 EXE | 178,487,296 | 55,600,100 | 68.85% |
| 正式签名 Runtime 旧版 ZIP → 本次 v2 ZIP | 178,794,933 | 56,261,853 | 68.53% |
| 旧桌面安装包 → 本次早期 x64 构建 | 177,543,954 | 4,556,036 | 97.43% |

这些是指定构建样本，不是未来所有版本的体积保证。Runtime ZIP 测试使用正式发行签名的旧/新 Runtime 内容，重建字节与 v2 发布候选 ZIP 完全一致。相同文件顺序和固定时间戳保持内部二进制的块复用。正式发布前仍应对届时实际发布的 ZIP 和 Setup 记录差分结果。

脚本：`scripts/verify-differential-download.mjs OLD NEW OUTPUT_DIR`。输出在 `outputs/update-diff-runtime`、`outputs/update-diff-runtime-zip`、`outputs/update-diff-desktop`。本地 Node HTTP 测试出现依赖的 Socket timeout listener 警告，但摘要和传输量验证通过；未据此声称 Electron 网络层已完成实网端到端验收。

## 发现并修复

- 旧 v1 客户端拒绝未知清单字段；迁移入口改用已有 URL 字段中的锚点标识，并用旧解析器测试。
- 本地旧 Runtime 缓存使用开发密钥，与安装包的发行公钥不匹配。增加安装资源准备阶段的实际验签；最终验证使用从 v0.1.5 下载并重新验证的正式 Runtime。
- 合并 CI 作业后，Runtime 构建留下已应用的接缝，旧 patch gate 要求干净 vendor。新增仅 CI 可运行的精确反向应用步骤；不使用 reset/clean，不触碰本地已有 vendor 改动。
- 单架构桌面发行保留另一架构的旧客户端迁移索引，避免 Latest 更换导致旧更新入口消失。

## 尚未完成的发布验收

- Windows GUI 全机旧版 → 当前用户安装迁移，真实 UAC 同意/拒绝、快捷方式与卸载项结果。
- 真正安装两个新格式版本，验证静默更新完成后重新拉起桌面；安装中断/文件占用恢复。
- ARM64 原生 runner 构建与 ARM64 实机运行。
- GitHub Actions 新工作流的完整实跑；本次只做 YAML/脚本检查，没有创建新 tag 或触发发布。
- 本地 `omp:verify:patches` 未执行，因为 vendor 有任务开始前就存在的未提交改动，该检查会反向应用接缝。更新没有修改 Runtime overlay 或接缝。

P5 的 `productionWindowsCleanRun` 保持 `manual-required`。本次未安装或卸载用户现有应用，未发布新的二进制，也未更改发行版本号。

任务前源文件备份：`backup/2026-09-17/incremental-updates-2026-09-17T08-05-39-462Z`。远程 Release 文本备份：`backup/2026-09-17/release-descriptions-2026-09-17T09-36-58-387Z`。后续并行出现的 Composer / App / CHANGELOG 改动保持原样，不归入本更新重构。
