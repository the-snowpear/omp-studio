# OMP Studio 性能优化实施计划：流式处理、资源占用与释放

## 一、目标、已确认取舍与实施边界

本计划基于 OMP Studio 当前实现及本地 zcode `872ad96` 的源码审查。目标是减少流式过程中的重复计算、降低后台处理频率、明确资源的占用与释放，并将适合移出的计算放入有界 Worker。

本计划没有预先宣称性能提升幅度。先保存同机基线，再以正确性测试、确定性的资源计数和前后性能对照决定是否启用优化。

### 已确认的产品取舍

| 项目 | 决定 |
|---|---|
| 优化范围 | 分阶段全面优化，保留现有协议体系和 Markdown 技术栈 |
| 优先级 | 优先保证输入、点击、滚动响应，同时让缓存、队列和 Worker 占用有界 |
| 后台更新 | 允许降低中间更新频率，完整结果必须保留；审批、错误和终态不人为延迟 |
| 代码块 | 识别到代码围栏后立即显示代码框、背景、语言标签和等宽正文 |
| 语法高亮 | 允许代码框内的语法颜色异步补齐，保留现有语言、配色和正常范围内的高亮能力 |
| 诊断交付 | 第一版交付本地日志和测试报告，不扩建诊断面板 |
| 性能验收 | 本机 Windows、同构建模式、同数据集，比较优化前后结果 |
| 执行方式 | 拆成边界明确的 worker 工单；跨包集成及最终启用由集成负责人完成 |

### 保留的既有设计

以下能力已经存在，本轮不得顺带重写：

- `frozen / pending / tail` 增量 Markdown 扫描。
- 虚拟列表可见行使用普通文档流、挂载行上限 120。
- 单一贴底写入者、用户手势脱离跟底。
- Store 的 2,000 items / 24MiB 窗口及各类 live 数据上限。
- token 热流与低频元数据的双通道订阅。
- Runtime 自有的空闲休眠、回收及恢复机制。
- 真实数据与预览 fixture 的边界。

### 明确不在本轮实施的改动

- 不迁移到 Streamdown、Shiki 或 `@pierre/diffs`。
- 不迁移到 MessagePort，不新增二进制业务协议或批量事件 wire 格式。
- 不取消 IPC、Bridge 等信任边界的校验。
- 不删除 Renderer transport 的 `deepClone`。
- 不强制 GC，不定期杀 Runtime，不调用系统工作集压缩作为产品优化。
- 不调整默认前台刷新频率和 Runtime 的 16ms 合流参数。
- 不增加后台会话的长期 keep-warm Store。
- 不实现一套没有实际调用方的通用 Worker 平台。

zcode 的借鉴点限定为：语义合并、不变量测试、按消费需求降频、渲染前预算、资源计数、计算隔离及显式清理。实现适配 OMP 现有代码，不整段移植 zcode 源文件。

---

## 二、架构决策与统一验收规则

### 2.1 三层流式处理职责

| 层次 | 本轮职责 | 不承担的职责 |
|---|---|---|
| Runtime overlay | 保持现有源头合流；补充自身内存和资源计数 | 不根据 UI 可见性改变模型运行，不接受高频诊断轮询 |
| Host | 优化工具回放存储；复用已验证对象；对后台 conversation 增量做有界合并 | 不改写持久 transcript，不吞控制事件 |
| Renderer | 保持前台 RAF 合帧；后台降低投影发布；代码高亮 Worker；Mermaid 预算与清理 | 不伪造终态，不跳过水位断档检查 |

**后台合并放在 Host 分配 conversation `streamSeq` 之前。** Runtime 原始 `eventSeq` 仍先由 Bridge 按现有规则验证；Host 实际输出的事件再分配连续 `streamSeq`，Facade 最后分配客户端全局 cursor。

不得在已经分配 cursor 的 IPC 出口丢弃、合并事件，否则会制造客户端断档。

第一版后台优化降低的是 Host 回放处理、Facade/IPC 和 Renderer 工作量，**不承诺降低 Runtime→Host 命名管道的原始流量**。

### 2.2 新接口只允许三类

1. **进程内诊断接口**  
   例如 `getDiagnostics()`、`registerCounters()`、`dispose()`。只返回计数，不返回正文、路径、对象集合或内部 Map。

2. **两个固定的 desktop chrome 方法**  
   - `reportPerformanceSample(sample)`：Renderer 上报有界的数值诊断样本。
   - `setConversationViewState(state)`：报告当前窗口真正展示的 conversation session IDs。

   两者均通过固定 IPC 常量实现，不能暴露通用 `invoke`。旧 preload 缺少方法时，Renderer 正常工作：不上报诊断、保持现有投递策略。

3. **Renderer 内部 Worker 消息接口**  
   请求与响应使用显式版本、任务 ID 和有限字段，不进入 Studio Bridge。

不新增 `client-contract` query/command，不增加 Host capability，不变更 Runtime wire 协议。

### 2.3 初始预算

这些值是本轮实现默认值，不是对机器性能的预测。worker 不得自行放宽。

| 对象 | 初始预算 |
|---|---|
| 常规进程诊断采样 | 60 秒一次；不允许重叠采样 |
| 本地诊断日志 | 首次、显著变化、计数变化或 5 分钟心跳时写入 |
| 内存变化门槛 | heap 5%；RSS/external 10%；同时避免零基数导致日志风暴 |
| 后台 conversation 合并窗口 | 250ms |
| Host 后台缓冲 | 每 controller 总计最多 500 项、1MiB；达到上限立即排空，不静默丢弃 |
| 后台 Renderer 发布 | 最多每 250ms 一次；控制与终态更新立即发布 |
| Mermaid 自动渲染 | 最多 20,000 UTF-16 code units、600 行、复杂度分数 1,500 |
| Mermaid 缓存 | 最多 32 项；源码与 SVG 合计按 UTF-8 计最多 4MiB |
| Mermaid 队列 | 同时执行 1 项，最多等待 8 项 |
| 高亮 Worker | 懒启动，最多 2 个；CPU 核心不足时 1 个 |
| 高亮缓存 | 最多 128 项，源码及序列化 token 数据合计最多 8MiB |
| 高亮等待队列 | 最多 32 项、2MiB 源码 |
| 高亮输入范围 | 保持现有 `96 * 1024` 的字符串长度限制；这是 UTF-16 code units，不是字节 |
| Worker 空闲释放 | 队列为空且无任务执行后 30 秒终止 |
| 高亮异常执行上限 | 每任务从实际执行开始计 5 秒，超时终止该 Worker |
| 开发态 Performance timeline 清理 | 10 秒一次；性能录制时禁用 |

缓存字节预算是可重复计算的逻辑预算，不得在日志中称其为“真实 V8 堆占用”。

### 2.4 正确性优先于性能

所有优化必须满足：

- 同一输入事件序列，优化前后最终公开状态一致。
- 最终正文、工具输出、截断标记及错误信息一致。
- 保留当前的头部截断、尾部截断等具体语义，不能互换。
- 不因切换、隐藏、恢复或重连重复消息、丢失文本、错误触发 resync。
- 旧 epoch 的任务、事件和异步结果不得写入新会话。
- 资源释放后，仍持有已 dispose 对象也不能通过它保留整份正文。
- 取消组件订阅不等于取消模型任务。
- 未找到数据时显示缺失，不用 `0` 代替未知。

---

## 三、可直接派发给 worker 的工单

工程根目录：`D:\Project\omp-studio`。

工单中的文件所有权同时限制修改范围。需要改动范围外文件时，worker 应返回具体原因和建议补丁位置，由集成负责人调整工单；不得自行扩展任务。

### W00：建立可重复的性能基线

**所有权**

- [现有 Chromium 门禁](D:/Project/omp-studio/scripts/streaming-perf-gate.mjs)
- [Renderer 性能 harness](D:/Project/omp-studio/apps/renderer/src/perf-harness-entry.tsx)
- 新增测试专用 benchmark 脚本和 fixture，不修改产品行为。

**实施步骤**

1. 保留现有门禁的场景和默认阈值。
2. 给报告增加基线身份：Git commit、dirty 状态摘要、Node/Electron/Chromium 版本、构建模式、屏幕刷新率、CPU 核心数、各优化开关。
3. 增加 Node 基准，分别测量：
   - `ConversationEventFanout.forward()`。
   - 文本 replay 的追加与 snapshot。
   - 工具 replay 的 append、replace、snapshot。
   - `parseConversationRuntimeEvent()` 的首次及重复处理。
4. 增加浏览器场景：
   - 短/长历史的持续文本输出。
   - 256KiB 以内工具日志的小增量持续追加。
   - 多个代码块完成及虚拟行反复卸载、重挂。
   - 代码围栏尚未闭合时的实时显示。
   - 连续打开、关闭主会话和子代理视图。
   - 多个 Mermaid 图进入视口。
5. 每场景先预热，正式运行 5 次，使用中位数比较；同时记录最差值。
6. 现有 Vite dev harness 继续使用；新增隔离的 production harness 构建，输出到 `outputs/`，不把测试入口打包进产品。
7. 性能采样只在 harness 或显式 trace 模式下启用逐事件计时，生产环境不得每个 token 写日志。

**交付物**

- `outputs/perf/<run-id>/baseline.json`。
- 场景定义、执行命令、版本信息。
- 明确列出未能运行的场景及原因。

**验收**

同一版本重复运行能产生同形报告；测试 fixture 不读取 `backup/`、用户真实对话或 zcode 运行数据。没有基线报告，后续工单可以写代码，但不得宣布性能收益。

---

### W01：共享诊断计数与日志门控

**所有权**

在 `packages/studio-protocol/src/` 新增纯数值诊断辅助模块及测试，并通过现有包入口导出。它是共享工具，不新增 wire 字段。

**接口**

```ts
type PerformanceCounters = Readonly<Record<string, number>>;

interface CounterRegistry {
  register(
    name: string,
    read: () => PerformanceCounters,
  ): () => void;
  collect(): PerformanceCounters;
}

interface MemorySample {
  role: "main-host" | "renderer" | "runtime";
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  externalBytes?: number;
  arrayBuffersBytes?: number;
  counters: PerformanceCounters;
}
```

**实施步骤**

1. `register()` 返回幂等注销函数；禁止静默覆盖同名 provider。
2. provider 抛错只跳过该 provider，不能影响业务。
3. 数值必须有限且非负；动态正文、路径、会话标题不得作为 key。
4. 使用固定白名单选取每个进程的计数，单条日志控制在现有 HostLog 长度上限内。
5. 实现首次/变化/心跳门控，时钟和阈值可注入测试。
6. `collect()` 读取已有标量，不得为了统计调用 `snapshot()`、投影完整历史或序列化正文。
7. registry 自身不能保留已注销 provider 的闭包。

**测试**

重复注销、provider 异常、非法数字、静态样本不重复写、native 内存单独增长、计数下降、采样后停止。

---

### W02：接入 Main/Host、Renderer 与 Runtime 本地诊断

**依赖：W01**

**所有权**

- Desktop chrome 诊断 IPC、应用启动/退出接线。
- Renderer 诊断采样模块。
- Runtime overlay 的独立采样模块及其生命周期接线。
- 不修改诊断页面。

**实施步骤**

1. Main/Host 使用 `process.memoryUsage()`，明确这两种逻辑职责当前处于同一 Electron Main 进程，不能重复累计。
2. Renderer 使用可用的 Chromium heap 数据；API 不存在时省略 heap 字段，仍可上报资源计数。
3. 新增固定 chrome 上报接口；Main 校验可信 sender、字段、数值范围、字段数量及载荷大小。
4. Main 对 Renderer 上报限频，防止异常页面形成日志风暴；正常间隔 60 秒。
5. Runtime 在进程内部自行采样，使用专门的数值诊断日志出口进入既有 stderr 日志链路。Host 不从日志推导业务状态。
6. Runtime 采样器不得调用 Bridge query、`ensureWorkerLive()`、session 恢复或 transcript 读取。
7. 采样定时器绑定 Runtime 服务生命周期；可用时 `unref()`；dispose 后清除。
8. Main 的运行实例用无敏感信息的内部序号区分；日志不得暴露 PID、令牌、路径和对话内容。

**最低计数集合**

- Renderer：活跃 Engine/Store、发布快照行数、rowCache 项数、待打开事件数/字节数、Mermaid/高亮缓存及队列。
- Host：resident Runtime 数、conversation listener 数、replay 会话数/事件数/字节数、后台缓冲项数/字节数。
- Runtime：worker residency、generation、live projector message/tool/pending 数量及已有可直接读取的字节计数。

计数读取接口由各模块暴露，不允许采样器访问私有字段或使用反射。

**测试**

多次启动/停止没有重复定时器；采样异常不影响业务；Runtime dormant 状态下采样不导致 revival；旧 preload 无新方法时 Renderer 正常运行。

**解释要求**

RSS、heap、external、ArrayBuffer 分开报告，不直接相加成“总内存”；ArrayBuffer 可能包含于 external。

---

### W03：主会话与子代理 Engine 的完整释放

**依赖：W01**

**所有权**

- [主会话 Engine](D:/Project/omp-studio/apps/renderer/src/conversation/conversationEngine.ts)
- [子代理 Engine](D:/Project/omp-studio/apps/renderer/src/conversation/subagentConversationEngine.ts)
- 对应 Engine/Hook 生命周期测试。

**实施步骤**

1. 保留 Store 现有的 dispose 清场。
2. 在 Engine dispose 中同时替换自身发布的 `snapshot`、`metadataSnapshot`，使用空数据，保留必要 identity/generation。
3. 清空打开期间的事件缓冲、loading 状态及诊断登记。
4. 不向已卸载消费者继续广播“清空”事件。
5. 使 `getSnapshot()` 在 dispose 后仍可安全调用，但不能返回旧 rows、正文和工具输出。
6. 检查 `useConversation` 的过渡快照：只在现有同会话重挂或切换动画需要的期间保留；动画结束、目标改变或组件卸载后释放。
7. 所有迟到 query、缩略图读取和 loadOlder 结果继续受 generation/disposed 约束。

**测试**

显式保留已 dispose 的 Engine 引用，断言其 getters 返回空正文；重复 dispose 安全；延迟 Promise resolve 不复活数据；现有会话切换动画测试继续通过。

---

### W04：工具输出 replay 改为增量存储与惰性物化

**依赖：W00、W01**

**所有权**

- [Host conversation replay](D:/Project/omp-studio/packages/studio-host/src/conversation-events.ts)
- 新增私有文本缓冲辅助模块。
- `conversation-events-replay.test.ts` 及对应基准。

**实施步骤**

1. 只先替换 `conversation.tool.updated` 的累计输出存储；文本 delta 已有分段策略，本工单不重写它。
2. replay 内部保存：
   - 最新事件元数据。
   - 输出字符串分片。
   - 输出 UTF-8 字节数。
   - JSON 字符串编码长度计数。
   - revision 与上次物化结果。
3. `append` 只处理新增内容；`replace` 清空旧分片并建立新基线。
4. 保持目前 `TEXT_BLOCK_MAX_BYTES` 的头部截断语义及 `truncated` 传播。
5. 只有 `snapshot()`/`replay()` 真正需要输出时才 join；同一 revision 复用物化结果。
6. `#store()` 预算通过元数据和增量计数更新，不再每个 append 序列化完整累计 output。
7. 分片数也必须有界：最多 1,024 片，超过后压成约 8Ki UTF-16 code units 的页；不能每个小增量都压实。
8. 跨分片代理对必须正确计数；覆盖中文、emoji、引号、反斜线、控制字符及分开的 UTF-16 高低代理。
9. message/tool 终态、turn 切换、全局淘汰和 dispose 时清理分片及物化缓存。
10. 维持现有 snapshot/replay 外部数据结构和克隆隔离。

**正确性判据**

测试中保留一个简单的旧语义参考实现。对固定随机种子的 append/replace/complete/abort 序列，比较 replay 内容、事件顺序、截断标记、watermark 和 overflow 状态。

**性能判据**

- 追加路径不再随累计 output 长度重复扫描整份 output。
- 基准的小块追加场景，中位处理时间目标降低至少 20%。
- 高频 snapshot 场景相对基线不恶化超过 10%。
- 单纯 replace 大字符串不承诺同等收益，单独报告。

不达标时保留测试和报告，不通过提高容量或减少校验让结果“变绿”。

---

### W05：复用已验证的会话事件，避免重复完整解析

**依赖：W00**

**所有权**

- [会话事件解析器](D:/Project/omp-studio/packages/studio-protocol/src/conversation-validation.ts)
- 协议测试。
- Facade 与出站校验的集成测试；默认不删除其校验调用。

**固定方案**

采用“解析器自己产生的不可变对象可复用”，不引入公开的信任标志。

**实施步骤**

1. 将现有完整解析逻辑保留为内部函数。
2. 完整解析成功后，对解析器新建的返回对象递归冻结，并登记到模块私有 `WeakSet`。
3. 后续 `parseConversationRuntimeEvent()` 收到同一个已登记对象时直接返回。
4. 原始输入对象不进入缓存，不冻结调用者传入的对象。
5. 外部传入的 `Object.freeze()` 对象不自动可信，仍完整解析。
6. structured clone、IPC 或重新构造的对象失去本地身份，仍完整解析。
7. 不缓存失败结果，不使用正文内容作为全局缓存 key。
8. 不删除 envelope、sessionId 一致性、epoch、cursor 或 sender 校验。
9. 不用 TypeScript `as` 替代运行时验证。

**测试**

首次完整校验；同一返回对象复用；伪造/冻结对象仍被检查；未知字段和超限载荷仍拒绝；嵌套数据不可修改；原始输入仍可独立修改；跨 clone 后重新解析。

**性能判据**

在已确认的 Fanout→Facade→IPC 出站链路中，同一个已解析 update 只执行一次完整会话解析。Bridge 更早的边界检查单独计数，不把它从报告中遗漏。

---

### W06：后台语义合并核心

**依赖：W04、W05**

**所有权**

- Host 新增后台 conversation 合并器。
- `ConversationEventFanout`、`StudioRuntimeSessionController` 的内部接线和测试。
- 不改 Renderer，不新增 wire 字段。

**输入与输出**

输入为已验证的 Runtime conversation 事件；输出仍为既有 `ConversationRuntimeEvent`。合并发生在分配 Host `streamSeq` 之前。

**合并规则固定为**

1. 相邻且 session/turn/message/block/blockType 全部一致的文本 delta 可以拼接。
2. 拼接结果不得超过 `DELTA_MAX_BYTES`；超过则分段输出。
3. 相邻同一 tool 的 append 可以拼接；replace 建立新的输出基线。
4. 截断标记不得因合并丢失。
5. 不跨越 message/tool start、complete、abort、compaction、notice 等结构事件合并。
6. 第一版不实现 zcode 式“终态吞掉所有旧 delta”，避免扩大中间态语义变化。
7. 输出元数据采用合并组最后一个事件；Runtime 原始序列已经由 Bridge 验证，不能修改 Bridge 的序列检查。

**调度**

- foreground：保持现有立即投递。
- background：250ms 排空。
- 结构事件：先排空对应会话，再立即投递。
- Controller 将权限、错误、终态收据及断连等作为控制屏障，在向外发布之前排空相关 pending conversation；不能延迟控制事件等待计时器。
- `conversation.open` 获取 replay/watermark 前先同步排空目标。
- background→foreground：先同步排空，再切换策略。
- 达到项数或字节上限：立即排空，禁止静默丢弃。
- epoch 失效或 controller dispose：取消计时器并释放旧 pending，不向新 epoch 投递旧数据。

**测试**

使用假时钟验证 249/250ms 边界；验证每种屏障；连续输出 `streamSeq` 无断档；缓冲溢出无丢字；切前台立即追平；两会话交错不串数据；dispose 后零 pending。

合并开关开/关两条路径应用到同一参考状态机，最终状态必须一致。

---

### W07：窗口可见性、目标兴趣与 Renderer 后台发布

**依赖：W03、W06**

**所有权**

- 固定 chrome 可见性接口及 Main 生命周期接线。
- Renderer 新增 conversation 可见目标登记模块。
- ConversationPane、SubagentConversationPane 的轻量接线。
- Store 的调度策略。

**可见性协议**

```ts
interface ConversationViewState {
  runtimeEpoch: number;
  visibleSessionIds: readonly string[];
}
```

最多 8 个 session IDs；ID 复用既有长度限制。它只影响展示投递频率，不能创建、取消、暂停或恢复会话。

**实施步骤**

1. Renderer 由实际挂载并展示的 conversation pane 取得本地登记租约；关闭或切换时幂等 release。
2. 子代理使用 `conversation.open` 返回的 child conversationSessionId，不使用 parentSessionId 代替。
3. Renderer 聚合所有租约，一次上报集合；StrictMode 双挂载不能重复计数。
4. Main 结合真实 BrowserWindow 的 hidden/minimized 状态判定有效可见性。失焦但仍可见的窗口不降级。
5. 多窗口使用有效可见目标的并集；一个窗口隐藏不能降级其他窗口正在看的会话。
6. 未收到合法新接口状态时，活动连接沿用旧的 foreground 行为，保证兼容。
7. 对于完全没有前台消费者的 resident controller，启用后台策略。
8. 导航、窗口销毁、Runtime epoch 改变时清理旧登记。
9. 预览 fixture 不上报为 Host 的真实目标，不影响真实写操作。
10. Renderer 在 document hidden 时改用 250ms 的受控定时发布；不要不断等待可能暂停的 RAF。
11. 事件仍即时进入本地有界状态，发布快照可合并；结构事件与终态不得等后台定时器。
12. 恢复可见时取消后台计时器、立即发布最新快照，再恢复已有 30/60/90/120Hz 设置。

**验收**

纯流式后台场景中，conversation 投递与 Renderer 发布显著降频；控制事件无人工等待。切换前后台 50 次、快速开关子代理、最小化后恢复均无断档、重复或旧会话回写。

---

### W08：Mermaid 预算、队列、缓存与取消

**依赖：W01**

**所有权**

- 从 [Markdown 组件](D:/Project/omp-studio/apps/renderer/src/conversation/markdown.tsx) 提取 Mermaid 专用模块。
- 新增 budget、queue、cache 的纯逻辑及组件测试。

**实施步骤**

1. 保留 IntersectionObserver 懒加载和当前 `securityLevel: "strict"`。
2. 在入队前及实际执行前各做一次可见性、存活状态和预算检查。
3. 大小超限保留源码，显示简短说明，不自动执行昂贵渲染。
4. 复杂度分数定义为“行数＋边特征数＋节点特征数”；明确它是启发式预算，不是精确图复杂度。
5. 页面隐藏期间不启动新渲染，恢复可见后仅重新调度仍挂载、仍需要的任务。
6. 相同源码及实际渲染配置的任务去重；多订阅者共享结果。
7. 缓存按项数和总字节双重 LRU 淘汰；命中刷新访问顺序。
8. 缓存 key 包含全部实际 Mermaid 渲染配置。保持当前主题表现，本工单不顺带改主题。
9. 等待队列满时暂不入队，不建立无界备用队列；挂载组件在有槽位时重新尝试。
10. 卸载时取消等待任务；执行中的 Mermaid 若不能中断，只禁止结果回写，并释放订阅者引用。
11. 执行中的任务没有完成时，不以 Promise 超时为由继续启动下一项，避免假串行造成并发积压。
12. 单项结果超过缓存预算时仍可供当前组件显示，但不得缓存。

**测试**

隐藏、滚出视口、卸载、换源码、异常、队列满、重复源码、多主题 key、缓存淘汰及大 SVG。断言取消的等待任务未调用 `mermaid.render()`。

---

### W09：有界高亮 Worker 与缓存核心

**依赖：W00、W01**

**所有权**

Renderer 新增 `highlight/` 模块；本工单暂不改 Markdown 组件。

**技术选择**

继续使用 `rehype-highlight` 当前底层的 `lowlight`/highlight.js。将当前已安装的 `lowlight 3.3.0` 显式列为 Renderer 直接依赖，使用 `common` 语言集合、`detect:false` 和现有 `hljs-*` class，避免换主题或语言行为。

依赖声明与 lockfile 由集成负责人统一修改。

**Worker 协议**

```ts
type HighlightRequest = {
  version: 1;
  jobId: number;
  language: string;
  code: string;
};

type HighlightResponse =
  | { version: 1; jobId: number; ok: true; tokens: HighlightToken[] }
  | { version: 1; jobId: number; ok: false; reason: string };
```

token 仅允许文本和带白名单 class 的 span 树；不能返回可执行 HTML、任意标签或任意属性。

**调度与资源规则**

1. 请求前不启动 Worker；池大小为 `max(1, min(2, floor(cores / 2)))`，未知核心数取 1。
2. `new Worker(new URL(..., import.meta.url), { type:"module" })`，不使用 blob 或远程脚本。
3. 相同语言和完整源码共享一个在途任务。
4. 缓存使用完整内容身份校验；禁止只用首尾文本和长度作为 key。
5. 先调度可见请求，再调度 overscan；不可见且无人订阅的请求取消。
6. 队列满时不保存额外源码副本；组件等到可见或有槽位时再请求。
7. 结果回写必须匹配 jobId、组件 generation、源码及语言。
8. 任务超时终止该 Worker，拒绝该任务并计数；当前代码框保留原文，不允许转回主线程执行同一重计算。
9. Worker 崩溃最多为同一任务重试一次；持续失败停止该页自动重启，避免重启循环。
10. 所有 Worker 空闲 30 秒后终止；缓存保留受预算限制的条目。
11. 页面关闭、模块 HMR dispose、测试 teardown 时终止 Worker、清队列和计时器。
12. token 树节点数、深度和序列化大小设置独立上限，异常结果拒绝，不能让 Worker 输出反向制造巨大 DOM。

**测试**

假 Worker 覆盖乱序、重复、超时、崩溃、取消、缓存命中、LRU 淘汰、单个超大结果、空闲终止及启动次数。真实 Worker 的加载验证交给 W10/W12。

---

### W10：Markdown 接入 Worker，同时保持代码框即时显示

**依赖：W08、W09**

**所有权**

- `markdown.tsx` 及必要的局部拆分。
- Markdown、流式围栏和性能测试。
- Worker 打包/CSP 的必要接线。

**实施步骤**

1. 不修改 `scanStreamingMarkdown` 的切点、检查点和引用定义语义。
2. 未闭合代码围栏继续立即使用现有 `CodeFrame`＋安全 `<pre><code>`，逐次追加正文。
3. 已闭合块和非流式块先同步产生同样的 CodeFrame DOM，然后请求语法 token。
4. Worker 返回时只替换 `<code>` 内部的着色节点，不更换外层 key，不重挂代码框，不改变复制文本。
5. 保留当前正常高亮资格：现有 Markdown block 长度规则、语言识别范围、无语言不猜测、Mermaid 单独处理。
6. 当前冻结块可以提前高亮的行为继续保留，不等待整条 assistant 消息结束。
7. 使用与旧 `rehype-highlight` 等价的 token class；fixture 比较最终文本与 class 结构。
8. 正常资格内的代码不得仅因队列暂满永久失去高亮；仍挂载且可见时应继续尝试。
9. 原本超限、未知语言及异常任务保留可读代码框。
10. 将重型语法计算从主线程 rehype 路径移除；不要同时保留两次高亮。
11. 使用 React 安全渲染 token，不通过 `dangerouslySetInnerHTML` 注入 Worker 输出。
12. 检查 production/file:// Worker 加载。需要调整 CSP 时，只允许自有 Worker 源，并同步 Vite meta CSP 与 Electron header；不得加入 `unsafe-eval`、`*` 或远程源。

**必须通过的体验测试**

- 仅输出开围栏及少量代码时，代码框已经存在。
- 完成前不会把代码当普通正文等待。
- 高亮补齐前后 CodeFrame 元素身份相同。
- 复制内容逐字一致。
- 上滚阅读时高亮完成不会把用户拉回底部。
- 虚拟行重挂时缓存命中，不重复启动同样的计算。
- 代码颜色补齐不会造成明显高度跳变。

---

### W11：开发态 Performance timeline 清理

**所有权**

Renderer 开发态初始化模块及独立测试。

**实施步骤**

1. 仅 `import.meta.env.DEV` 启用。
2. 每 10 秒清理 marks/measures，限制开发会话长期保留的诊断记录。
3. 提供 `VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE=1` 禁用清理。
4. 性能 harness 固定禁用清理，避免破坏测量。
5. 初始化幂等，HMR dispose 清除计时器。
6. 生产构建不得启动清理器。

**验收**

dev/production 两种分支测试、重复初始化、HMR 清理和性能录制开关测试通过。不将此项收益写成生产内存收益。

---

### W12：集成、真实浏览器验证和长时间释放检查

**依赖：W00—W11 中所有启用项**

**所有权**

性能脚本、测试 harness、集成测试；不得在本工单夹带产品重构。

**测试矩阵**

| 场景 | 必须验证 |
|---|---|
| 10,000 次小文本 delta | 完整文本、事件顺序、连续水位 |
| 工具 append/replace 混合 | 与参考实现结果一致 |
| 前台＋后台多目标 | 可见目标实时；后台降频；不串会话 |
| 审批/错误/结束到达 | pending 先落地，控制事件不等待 250ms |
| 隐藏后持续输出，再恢复 | 立即追平，不触发伪断档 |
| 主/子会话切换 50 次 | Engine/Store/监听器回到预期数量 |
| 代码框流式生成 | 围栏出现时立即成框，随后着色 |
| 重挂 100 个不同代码块 | 缓存有界、Worker 有界、主线程响应改善 |
| Mermaid 大图/多图/取消 | 预算生效、等待队列有界、取消不继续启动 |
| Runtime 空闲回收 | 日志采样不唤醒 Runtime，原有恢复功能正常 |
| production file:// | Worker 和 CSP 正常；无开发服务依赖 |
| 旧 preload | 新方法缺失时保持旧行为 |

**性能判定**

1. 原有 `perf:streaming` 门禁全部保留并通过。
2. 同场景 5 次运行的中位数比较：
   - 既有流式 Script/Layout p95 不恶化超过 10%；极小基数允许最多 1ms 差异。
   - 高亮压力场景主线程 ScriptDuration 目标降低至少 20%。
   - 工具 replay 使用 W04 的专项门槛。
3. 新增输入响应探针：压力场景下测实际事件到下一次绘制延迟，不只看 RAF 间隔。
4. 资源释放用确定性计数判定：
   - dispose 后 pending 数为零。
   - 关闭视图后 Engine/Store/provider/listener 数恢复基线。
   - 30 秒空闲后高亮 Worker 数为零。
   - 所有缓存均不突破预算。
5. GC 仅用于测试里的 retained-heap 对照，生产不调用。
6. 暖机后执行三批等量操作，比较后两批 retained heap；沿用现有 1.25 比值门槛，同时记录 DOM 与 listener。
7. RSS 不立即下降不单独判失败。若持续上涨且计数稳定，提交独立诊断结果，不能自动增加 kill/GC 策略。

**失败处理**

正确性失败必须修复。性能收益未达标则对应优化保持关闭，保留基线和测试结果；不得擅自放宽阈值。需要更改预算或范围时，由集成负责人回到计划决策，不交给小模型现场选择。

---

### W13：文档、回滚与默认启用

**依赖：W12**

**所有权**

文档、功能索引、性能默认配置和最终验收报告。

**实施步骤**

1. 更新 [功能索引](D:/Project/omp-studio/doc/feature-index.md) 中对应入口，不把实现细节复制进 AGENTS.md。
2. 增加性能维护文档，说明：
   - 数据路径与三层合流职责。
   - 缓存、队列、Worker 的所有者及释放条件。
   - 诊断日志字段、缺失值、内存口径。
   - 如何运行基线、对照和 production/file:// smoke。
   - 什么条件下应暂停优化并升级给负责人。
3. 每项行为优化设置独立内部开关，测试必须覆盖开/关两条路径。
4. 开关不进入用户设置页；用于测试、开发和回滚，不能形成第二套产品模式。
5. W12 通过后，按 replay、解析复用、Mermaid、Worker、后台降频的顺序逐项启用并重跑相应门禁。
6. 保留禁用 Worker 时的旧高亮路径，仅作为显式回滚模式；正常 Worker 执行超时不能自动调用它。
7. 输出最终报告：每项开关状态、修改摘要、正确性结果、性能前后数据、残余限制。

---

## 四、派发顺序、文件冲突与 worker 执行规范

### 4.1 依赖顺序

```text
W00 基线 ───────────────────────────────────┐
W01 诊断基础 ─┬─ W02 采样接线              │
              ├─ W03 Engine 释放           │
              ├─ W04 replay ─┐             │
              ├─ W08 Mermaid │             │
              └─ W09 Worker  │             │
W05 解析复用 ────────────────┴─ W06 合并 ─ W07 可见性
W08 + W09 ──────────────────── W10 Markdown 接线
W11 开发态清理 ──────────────────────────────┤
                                            W12 集成验收
                                                 ↓
                                            W13 文档与启用
```

### 4.2 共享文件必须串行

- `markdown.tsx`：W08 完成后，W10 才能修改。
- `conversation-events.ts`：W04 完成后，W06 才能修改。
- `conversationEngine.ts`：W03 完成后，W07 才能修改。
- `main.ts`、chrome API、Renderer 类型声明：W02 与 W07 串行。
- 根/包 `package.json`、`package-lock.json`：仅集成负责人修改。
- Runtime vendor/overlay 的 apply、regen、verify：仅一个指定 Runtime worker 操作，禁止同时运行。
- 性能 harness：W00 建立接口后冻结；后续 worker 提交场景需求，由 W12 统一接入。

可以并行执行的是文件完全不重叠的工单，不把一个大工单再交给 worker 自行拆架构。

### 4.3 每张派发单必须包含

```text
任务 ID：
目标：
前置工单及其提交：
允许修改的文件：
禁止修改的文件：
必须保持的不变量：
具体步骤：
必须新增/运行的测试：
验收命令：
交付格式：
```

派发时附上本工单原文及“二、架构决策与统一验收规则”，不要让小模型自行回读整段研究对话。

### 4.4 worker 的强制规则

1. 先读项目 AGENTS.md、功能索引对应节及相关测试。
2. 修改既有文件前，按项目规则创建：
   `backup/YYYY-MM-DD/<工单ID>-HHmmss/`。
3. 备份保留相对路径，附 README：时间、原因、来源提交、文件列表、恢复方式。
4. 不覆盖已有备份，不编辑历史备份。
5. 明确告知 worker：“你不是唯一修改仓库的人；保留他人改动，不恢复或覆盖无关文件。”
6. Windows 命令优先使用真实 Git Bash：
   `D:\Program Files\Git\bin\bash.exe`。
7. 不升级无关依赖、不格式化全仓、不使用 `git reset --hard`。
8. 不为通过性能测试而减少 fixture 内容、放宽阈值或跳过真实 Chromium。
9. 遇到未规定的协议变化、资源所有权冲突、快照语义变化，停止该项修改，提交具体问题；不得自行选择新架构。
10. 每个工单必须提交独立可审查 diff，禁止混合多个优化主题。

### 4.5 worker 返回格式

```text
完成的任务：
修改文件：
行为变化：
测试命令及真实结果：
性能报告路径：
资源释放证据：
仍未解决的问题：
是否修改了工单范围外文件：
备份目录：
```

“构建成功”不能替代性能验收；“测试应该通过”不能写成已通过。

---

## 五、验证命令、Runtime 工作流与完成标准

### 局部验证

首次建立依赖构建基线：

```bash
npm run build
```

Renderer 局部测试使用已有 Vitest：

```bash
npm run test -w @omp-studio/renderer -- <测试文件路径>
npm run typecheck -w @omp-studio/renderer
```

Node 包使用已有测试入口：

```bash
npm run test -w @omp-studio/studio-protocol
npm run test -w @omp-studio/studio-host
npm run test -w @omp-studio/host-client-api
npm run test -w @omp-studio/transport-desktop
npm run test -w @omp-studio/desktop
```

每个 worker 先运行受影响的测试；全部集成后由负责人运行：

```bash
npm run check
npm run perf:streaming
```

新的 Host 基准和 production Worker smoke 由 W00/W12 增加独立命令，结果统一写入 `outputs/perf/`。脚本不得自动修改 package.json 或 lockfile 来安装浏览器。

### Runtime 修改工作流

Runtime 采样代码遵守现有 overlay 流程：

```bash
npm run omp:overlay:apply
# 在 vendor 工作区修改 Studio 自有文件及测试
npm run omp:patches:regen
npm run runtime:verify-source
```

- apply 前记录 vendor 状态并备份相关文件，不能覆盖未知未提交改动。
- 新代码优先位于 Studio overlay 自有路径。
- 不手写 `.patch`。
- Runtime 测试在 vendor 环境用已有 Bun 工具运行对应 `studio-*` 测试。
- `omp:verify:patches` 会施加和清理工作区内容，只由集成负责人在已确认可恢复的验证环境执行，不能与其他 worker 并发。
- 如验证必须使用编译后的 Runtime，使用项目现有构建流程，不替换用户当前安装的 Runtime。

### 最终完成标准

只有以下全部成立，计划才算完成：

- 所有已启用优化均通过正确性测试和对应性能门禁。
- 代码框立即显示，高亮补齐不重挂外框、不丢正文。
- 后台更新降频，控制事件即时，恢复可见无损追平。
- 已 dispose 的 Engine 不再通过发布快照保留对话。
- replay、缓存、队列、Worker、诊断 provider 的数量与字节均有可验证上限。
- Runtime 采样不会阻止休眠或触发恢复。
- production/file:// 环境验证通过，不能仅在 Vite dev 下成立。
- 性能报告明确区分实测结果、预期收益及尚未覆盖的场景。
- 文档、功能索引、备份说明和回滚开关齐全。
- 最终仓库差异仅包含本计划相关文件，用户原有改动完整保留。
