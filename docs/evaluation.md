# 评测工作区

评测页覆盖项目固定的 OMP 18.13.2 评测能力：性能基准、指令遵循、模型评判和 Ratchet。每个模块支持真实 Runtime 与演示预览两种数据来源。

## 开始评测

选择工作区后，点击「新建评测」。未填写的可选参数沿用原生默认值。性能基准的确认页显示原生解析后的模型和实际请求数，Detailed 的并发阶段会向上取整到完整的并发波次。指令遵循显示最多轮次请求数；原生重试可能产生额外请求。评判的实际请求数受问题分组、Judge 角色链及重试影响。

确认后才启动付费执行。Ratchet 的代理辅助准备可能产生费用；创建已有评测配置本身不调用模型。开始优化仍须完成输入、评分器、计划三个原生审批，并主动启动。

## 运行与结果

评测使用独立的常驻 Runtime，上下文绑定启动时的工作区，不随前台聊天切换。可离开评测页，后台会继续保存结果与进度。需要回应的审批在对应评测中呈现。

正常退出应用会请求停止本机评测并保存已有结果。Runtime 意外退出后保留结果、标记中断，不自动重发模型请求。远程评测的状态由所属 Host 决定，客户端断连不等于任务已停止。

结果自动保存于 Host 状态目录的 `evaluations/v1/`。记录包括冻结配置、Runtime 版本、分页结果和原生报告；凭据不写入报告。保存失败会显示原因，后台在 Runtime 仍在线时重试。

- 性能基准按工作负载显示延迟、吞吐、并发扩展和缓存证据。缓存加速不自动等同于供应商确认命中。
- 指令遵循记录每轮的预期、响应与失败原因。
- 模型评判显示样本结果、概率与置信度，可仅重试失败项。单个样本用于单项试评。
- Ratchet 展示训练／留出集均值、区间、最佳版本、原生判定和恢复信息。

## 历史、复跑与导出

历史记录默认按工作区和模块筛选，支持搜索与分页。复跑会打开原配置并创建新记录；旧报告缺少输入时只能查看和导出。旧版产物库中的基准和评判报告可导入历史视图。

选择两份同类报告可比较配置与指标。配置或 Runtime 不同会明确提示，不能直接把数值差异解释为模型改善。

在评测页导出 JSON、CSV 或 HTML 报告，文件由产物库和桌面导出通道处理。原生 JSON 保留原有结果结构。Ratchet 可查看、导出已验证最佳版本的补丁；补丁相对于隔离副本创建时的项目状态，只包含获批可修改路径，不自动应用到原项目。没有可验证补丁的旧记录不会伪造最佳版本。

## 原生能力映射

| 原生能力 | Studio 入口 | 执行依据 |
|---|---|---|
| `omp bench` 全部 profile、Detailed、Cache | 性能基准 | 原生 `resolveBenchPlan` / `runBenchCommand` |
| 模型选择、thinking、service-tier、前缀文件 | 性能基准高级配置 | 原生选择器、服务档位及文件读取 |
| `omp if-bench` 全部参数 | 指令遵循 | 原生 `runIfBench`，附加取消信号 |
| `judge` / `judge_batch` | 模型评判 | 原生批次、Judge 角色链、图片与问题解析 |
| 批次 attach、结果观察、取消、失败复跑 | 模型评判 | 非消费式分页读取，不移动原生 drain 游标 |
| `ratchet.init/split/plan/approve/check/train/gate/status` | Ratchet 向导、审批、原生代理执行 | 原生 prelude、审批摘要、冻结划分及统计判定 |
| Ratchet 结果交付 | 最佳版本差异与补丁 | 在原生 gate 时捕获，保留内容摘要 |
| 账户状态与模型配置 | 模型与凭据入口 | 既有模型配置页；评测不复制认证管理 |

## 实现与维护

页面入口为 `apps/renderer/src/evaluation/EvaluationWorkspace.tsx`。Host 协调器为 `packages/studio-host/src/evaluation-coordinator.ts`，独立 Worker 接入在 `apps/desktop/src/evaluation-workspace.ts`。Runtime 接入位于 overlay 的 `services/evaluation-workspace-service.ts` 和 `services/evaluation-ratchet-runner.ts`。

所有控制走类型化 Bridge。Runtime 接缝修改通过 `omp:patches:regen` 回收；不要手工修改 patch。预览数据位于 `preview/evaluationPreview.ts`，演示执行不调用 Host。视觉验收入口为 `evaluation-harness.html?preview=1&marks=off`，该入口只使用演示 fixture。
