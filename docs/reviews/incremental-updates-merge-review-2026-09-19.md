# incremental-updates 合并前复审（2026-09-19）

结论：复审新发现 1 项 P0 与 2 项 P1，均已当场修复并补回归测试；此前审查（`incremental-updates-review-2026-09-18.md`）的 R1–R7 修复经逐条复核确认在位。门禁全绿后合并入 main。

## 复审方式

- 审查对象与上轮相同：HEAD 与 main 均为 `a1b6513`，全部改动为未提交工作区内容（135 个修改文件 + 43 个新增文件）。
- 按五个切面并行独立审查：桌面更新核心、安装器/发布脚本/NSIS/CI、渲染层 UI、协议契约与 Host、overlay 与上游 18.2.5 升级。
- R1–R7 修复逐条在代码中复核确认，重点链路（事务断点恢复、apply 前兼容性重检、发布遮蔽拒绝、NSIS `_?=` 等待、发送互斥、桌面回滚入口、Runtime 跳过隐藏）均有真实测试断言。

## 本轮新发现与修复

| 问题 | 级别 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| `btw.changed` 出站校验白名单未同步契约新增的 `sessionId`/`topicId`/`question`：overlay 无条件携带三字段，桌面 `assertBtwSnapshot` 抛错且被事件总线隔离吞掉，BTW 提问成功但回答永不渲染 | P0 | `packages/transport-desktop/src/validate-outbound.ts` 白名单补三字段并做可选校验 | `runtime-mirror-validation.test.ts` 新增 btw.changed 用例（含旧五键兼容、错误类型与未知键拒绝） |
| `update-discovery.ts` 的 GitHub releases 列表请求硬编码直连，未走 `applyMirror`（资产下载走了），镜像用户检查更新完全失败 | P1 | 列表请求同样经 `applyMirror` | `update-v2.test.ts` 新增「目录与清单全部走镜像」用例 |
| `^` 模型提及每次击键都经 `session.models.mentions` 回打 Host；旧 Runtime 上每次击键产生一条必然失败的命令 | P1 | `mentions.ts` 按 client 做 60s TTL 缓存（含失败），击键只本地过滤，与 `@` 文件索引同一原则 | `mentions.test.ts` 新增缓存与失败缓存用例 |

## 复核确认无需处理的问题

- `getUpdateSnapshot` 在未打包/非 win32 下 reject：渲染层三个调用点均有 `.catch(() => null)` 兜底，不产生未处理 rejection。
- facade 校验/分发展开顺序不一致：入站拒 `kind` 注入 + Runtime 侧 `parseStudioRequest` 重新校验，fail-closed。
- Host arbiter 对 btw.ask/abort 放宽为 queue-compatible：该 arbiter 无生产调用方，权威仲裁在 Runtime 侧，属对齐。
- overlay `upgrade-service` 幂等表死代码、`runtime-upgrade-protocol` 结果类型描述的是 Host 重写后的公开形状等：留档为后续清理项，不影响正确性。

## 验证

- `npm run check` 全绿（typecheck + 全部 workspace 测试；Renderer 619、Desktop 366、其余 workspace 991 项 node:test）。
- `git diff --check` 通过。
- 修改前快照：`backup/2026-09-19/merge-review-fixes-205556/`。

## 遗留边界（不阻断合并，发布前必须验收）

- 新 release.yml 发布链路未在 Actions 端到端实跑；全机→当前用户迁移的真实 UAC/静默更新/ARM64 实机验收仍未做（`docs/updates-verification.md` 已如实标注）。
- P2 跟进项：InstallerHost 卸载等待无超时；R3 防护只覆盖 Runtime 组件不覆盖 app 组件回退；统一更新 releaseNotes 增量标记硬编码中文；BTW hook 内新增文案未走 i18n；`update-coordinator` 死分支与 `attempts` 死字段；桌面 exe 校验/执行间的 TOCTOU 窗口（每用户安装，风险低）。
