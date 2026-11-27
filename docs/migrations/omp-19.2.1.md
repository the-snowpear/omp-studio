# OMP 19.2.1 迁移报告

Studio Runtime 的上游从 `can1357/oh-my-pi` 的 `v19.0.1`（提交 `f40f335845f0b136453d12fec8d6057011082766`）升级到正式标签 `v19.2.1`，提交 `b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac`。补丁集版本递增至 `studio.3`，overlay 收录 313 个文件，四组接缝补丁按上游子系统重生成。

## 接缝与契约适配

- 选择性提交按 19.2.1 的提交契约重建：变更日志先记录、再不带取消地读取 `commitDetails`；提交标题取 hooks 落库后的首行；HEAD 竞争按有界次数重试。共享索引和解改用临时索引副本应用补丁后原子换回的协议，并在原生 `lock_index` 固定等待窗口内完成；该协议不使用上游的 `commitReconciled`，接缝保持自有的 `expectedTree` 校验。
- 选择性提交新增子模块指针（gitlink）为整项原因，渲染端补中英文标签，指针在构建提交时按子仓库 HEAD 复核。
- 会话队列跟进 19.2.1 新增的投递窗口：已出队、未落盘的 Steering 与 Follow-up 继续列入快照与 `queue_update`，与原生 `peekDeliveringMessages` 的契约一致；Studio 队列快照将其标为投递中。
- 组合预测控制器在 19.2.1 改为响应式信号；接缝新增 `onChange` 通知，Studio 端在建议出现与撤销时重新发布，终端侧仍走原生信号。
- 会话压缩服务透出原生探针失败（`probeFailure`）。macOS 27 上 `ditto --hfsCompression` 存文件不压缩（上游 #16244），此时 Studio 如实显示压缩被跳过，而非报告零候选。
- 原生模块按 `nightly-2026-11-08` 工具链重建，纳入 `diffBlobs`、`operationKind`、`commitReconciled`、`readTreeKeepingSparse` 等新接口；操作类型守卫（merge、cherry-pick、revert、rebase、am、未和解索引）沿用上游语义。
- 接缝分组新增三项：Agent Hub 运行时（`served` 字段）、选择性提交流程测试、`pi-utils` 目录助手（provider 在途根目录）。

## 验证

- `npm run omp:verify:patches` 在干净的 19.2.1 检出上重放 overlay 与四组接缝：Bun `check:ts` 通过，验证名单内测试全部通过，CLI 源码冒烟通过，源树复原干净。
- Studio 全量测试 117 个文件：687 项通过、3 项跳过、0 失败。选择性提交流程、Studio 选择性提交、会话队列与 `queue_update` 契约逐组通过。
- 若干行为与 pristine 19.2.1 基线逐项对照：Rust 侧两个环境敏感测试（依赖主机名与超长工作目录）在基线上同样失败，确认非迁移引入。
- 部分会话目录测试要求临时目录不是符号链接根；此类失败与 Studio 改动无关，属上游目录命名行为。

## 已知限制

- macOS 27 上 `omp gc compress` 的 APFS 压缩不可用，探针已阻断误报；Studio 面板显示错误说明。
- 空会话不进入历史列表、草稿仅存渲染进程内存、首次启动较慢等 Studio 限制不变。
