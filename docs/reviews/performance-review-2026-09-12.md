**OMP Studio 流式渲染与持续运行性能审查报告**

日期：2026-09-12。起始 HEAD：`fd51332a215448f4bb22c04ab8f78962be6e21c4`。范围：Renderer 对话、Store/Engine、Markdown、虚拟列表、滚动、图片、终端，以及 Desktop/Host/Runtime 的流式传输与资源生命周期。

**结论：常规流式路径已有有效优化，现有短时门禁通过；长时间运行的资源上限和异常恢复仍有关键缺口。优先处理 Bridge 恢复互锁、无限常驻 Runtime、连续 assistant run 绕过虚拟化，以及退出终端的历史资源保留，再优化解析、布局和装饰动画。**

本次未修改产品源码、配置或依赖，也未修改用户会话。新增本报告和审查验证产物；没有覆盖既有文件，因此无需源码备份。工作区原有 Runtime/submodule 改动已保留；审查过程中还观察到其他工作产生的补丁再生成变化。以下按实际读取的源码和对应验证记录出结论，并非对一个始终冻结的干净工作树做发布认证。

**一、验证结果与结论边界**

| 验证 | 结果 | 能说明什么 |
|---|---|---|
| Store、useConversation、子代理 Engine、流式布局与提交成本测试 | 5 文件、37 测试通过 | 现有被测行为正常，不能覆盖下文全部边界 |
| 现有 `streaming-perf-gate.mjs` 场景与预算 | 15 项检查全部通过 | 常规短时浏览器场景未出现门禁回归 |
| Store 结果归并预算探针 | 配置 1024 B，items 从 305 B 增至 2239 B | `closeTurn` 绕过字节裁剪，已复现 |
| Engine dispose 探针 | dispose 前后外层快照均保留 1 行 | Store 清理没有同步清除 Engine 快照，已复现 |
| Bridge named-pipe 故障探针 | gap 后迟到 completed receipt 未结算，snapshot 被 pending 拒绝 | gap 与在途命令恢复互锁，已复现 |

浏览器实测使用 Windows x64、Node 24.13.0、系统 Edge 152.0.4191.66 headless、临时安装的 Playwright 1.63.0；机器为 i9-13900HX / RTX 4080 Laptop GPU，并有虚拟显示适配器。门禁的临时副本只替换模块解析、项目根路径和浏览器路径，未改场景与阈值。

| 场景 | Layout ms/帧 | Script ms/帧 | rAF 间隔 p95 |
|---|---:|---:|---:|
| 3 turns / 40 行工具输出 | 0.96 | 5.22 | 15.4 ms |
| 24 turns / 每轮 3 工具 / 1200 行输出 | 1.57 | 12.86 | 23.1 ms |
| 长历史并展开/收起卡片 | 1.01 | 9.38 | 23.2 ms |

长/短布局成本比 1.63；强制 GC 后第二、第三批 JS 堆为 13.13 / 13.39 MiB，比值 1.02，listener 均为 255；工具输出翻倍时 CDP DOM node 数 658 → 698。会话切换可见跳位为 0，卡片展开底边最大偏移 0.5 px。

这些是单次、短时、开发服务器、headless 浏览器结果。headless rAF 调度不能直接换算成用户屏幕帧率，也不能直接与 CI 的固定 Chromium 或 release Electron 比较。长历史的 Script 成本仍明显高于短历史，需要进一步拆分历史量与输出量的影响。

**没有实测真实 Electron 的 GPU 使用率、专用/共享显存、全部进程内存曲线，也没有做 1–8 小时 soak。不能据此声称“没有内存泄漏”“GPU 已稳定”或把某段 CSS 认定为高 GPU 的唯一原因。** 未运行完整 `npm run check`；这次是定向审查，并未实施修复。

原始数据、复现脚本与运行说明：[验证记录](../../output/playwright/review-20260912/README.md)、[浏览器结果](../../output/playwright/review-20260912/streaming-perf.json)、[Store 探针结果](../../output/playwright/review-20260912/store-probes.json)。

**二、优先级总览**

P1 = 建议优先修复，影响持续运行可靠性或资源上限；P2 = 随工作量放大的性能/资源缺口；P3 = 清理完善与低成本加固。优先级不是实测事故频率。

| 编号 | 级别 | 问题 | 证据 |
|---|---|---|---|
| R1 | P1 | Bridge gap 恢复与在途命令互相等待 | 源码 + named-pipe 复现 |
| R2 | P1 | 生产主会话 Runtime 驻留数量默认无上限 | 生产组装链 + 既有测试 |
| R3 | P1 | 连续 assistant run 合为一个虚拟行，内部工作量不受 120 行限制 | 源码 |
| R4 | P1 | 自然退出终端的历史、图片和部分观察器持续保留 | 源码 |
| R5 | P2 | 终端没有应用级背压，消费慢时积压并可能丢输出 | 源码 + xterm 实现 |
| R6 | P2 | 滚动工具输出的 replace 绕过 16 ms 合流 | 源码 |
| R7 | P2 | Store 结果归并绕过预算，Runtime 缺每消息聚合预算 | Store 复现 + 源码 |
| R8 | P2 | 关闭流式显示反而走整篇解析；特殊 Markdown 尾部仍昂贵 | 源码 |
| R9 | P2 | 主对话与工具卡存在重复跟底写入 | 源码 + 现有测试行为 |
| R10 | P2 | 完成工具链整体折叠后，已展开正文仍可能挂载 | 源码 |
| R11 | P2 | 图片压缩字节预算不能限制解码内存，历史缩略图全量读取 | 源码 |

**三、具体发现与修复建议**

**R1：Bridge 在拥塞丢帧后可能无法自行恢复。**

[bridge-client.ts:658](../../packages/studio-host/src/bridge-client.ts#L658) 遇到 eventSeq gap 就进入 `snapshot-required` 并解绑 data listener；同文件 [201 行](../../packages/studio-host/src/bridge-client.ts#L201) 在有 pending command 时拒绝 snapshot。默认请求没有超时，[runtime-session-controller.ts:95](../../packages/studio-host/src/runtime-session-controller.ts#L95) 则每 250 ms 重试恢复。

若 completed receipt 在 gap 之后的另一个 data chunk 到达，已没有 listener 消费它，pending 无法清除，snapshot 也无法执行。不是只有非法协议输入才会产生 gap：[bridge-server.ts:202](../../omp-patch/overlay/packages/coding-agent/src/studio/bridge-server.ts#L202) 在 socket 待发送量超过 8 MiB 时主动丢事件。

复现使用现有构建的 Host client，关键分支与源码逐点对应；人为注入 gap 后发送独立 chunk 的终态回执，得到 `snapshot-required / settledAfterReceipt=false`，随后 snapshot 明确报 pending 错误。没有制造 8 MiB 真实拥塞，也未声称全部 dist 都与源码一致。

影响：流式 UI 停止推进，命令 Promise 和关联资源保留，恢复定时器持续运行。建议保持统一 decoder 接收回执，gap 时只暂停普通事件投影；支持 snapshot 与在途命令终态对账。超时可作兜底，但不能代替恢复协议修复。验收应覆盖“慢消费者 + pending + gap + 独立 chunk 迟到回执”，并检查事件恢复和 pending 清零。

**R2：多个实际活动过的主会话会留下多个 Runtime 进程，默认没有驻留预算。**

[host-factory.ts:626](../../apps/desktop/src/host-factory.ts#L626) 生产组装只传 `{ log: hostLog }`；[runtime-session.ts:198](../../apps/desktop/src/runtime-session.ts#L198) 的 `maxResidentSessions` 默认 `Infinity`，紧接着明确停用桌面 idle TTL；[447 行](../../apps/desktop/src/runtime-session.ts#L447) 的容量检查默认直接放行。即便配置有限上限，也只拒绝新建，不回收旧 resident。

新建或恢复非驻留会话会启动独立 Runtime，旧 resident 保留 Bridge/controller、publication 订阅、lease 和 heartbeat。切回同一个 resident 会复用。**纯查看冷历史、只点击项目，不会必然启动进程；增长条件是实际新建会话或恢复冷会话执行动作/继续聊天。** 内部 `AgentLifecycleManager` 停驻子代理，不会停止 Host 为各主会话创建的独立进程。

这是有意驻留策略造成的资源增长，不必称为 GC 泄漏；但 Renderer 的 24 MiB 窗口无法约束这部分内存。既有 [runtime-multi-session.test.ts:580](../../apps/desktop/test/runtime-multi-session.test.ts#L580) 还明确固定默认无 cap、idle 不退出的行为。

建议先暴露生产 resident count / 总 RSS 预算与容量提示，再设计可靠的主会话 parked 状态：后台、无流式/工具/job、无待交互、状态已持久化时才停止进程并释放 lease；恢复时重新绑定 sessionId。不要直接恢复旧 TTL、误杀后台任务。预算具体数值与停驻体验需要产品决定，本次不擅自设置。

验收：实际依次运行 20–50 个会话，完成并切走；resident 数与总内存应在预算附近形成平台，同时验证审批保护、后台任务、恢复与最终退出。

**R3：虚拟化限制的是 assistant run 数量，不是 run 内部消息与 DOM 数量。**

[ConvoTranscript.tsx:38](../../apps/renderer/src/conversation/ConvoTranscript.tsx#L38) 将所有连续 assistant 行合成一个 `assistantRun`；更新时重建整段依赖和 entries。[ConversationItemView.tsx:344](../../apps/renderer/src/conversation/ConversationItemView.tsx#L344) 再对全部 segments 做 `flatMap` 和渲染遍历。[ConversationVirtualList.tsx:5](../../apps/renderer/src/conversation/ConversationVirtualList.tsx#L5) 的 120 行上限只能约束外层 run。

长代理任务连续进行数百轮工具调用、中间没有新的 user 行时，一个虚拟行就能包含很长的时间线。已有 memo 可以减少正文重解析，但不能取消整段数组创建、segment 遍历和已挂载卡片。这也解释了为什么“历史列表已经虚拟化”仍不能保证持续任务成本平稳。

建议保留视觉分组，将虚拟化单位下沉到消息/segment，或把 run 切成固定容量分片；同时约束单虚拟行的正文与节点量。增加“1 个 user + 500 个连续 assistant/tool 轮”的测试，分别测静态 DOM、token 增量成本和结束后的回收；现有交替 user/assistant fixture 不覆盖这个形状。

**R4：终端自然退出不会移除其全部 Renderer 资源。**

[TerminalPane.tsx:99](../../apps/renderer/src/TerminalPane.tsx#L99) 持续追加 session；[148 行](../../apps/renderer/src/TerminalPane.tsx#L148) 自然退出会 dispose xterm、清 pending/decoder，但保留 ended session、graphics 和 graphicsErrors。每 session 最多 4 张图不能限制历史 session 总数。ended session 仍挂 `XtermScreen`，其 [318 行](../../apps/renderer/src/TerminalPane.tsx#L318) 的 MutationObserver 闭包仍引用 term，直到该 screen 卸载。

Main 已删除退出的 live registry，所以 8 个活动终端上限也不会阻止反复 create → exit 的历史增长。不能据此断言已 dispose 的完整 xterm 缓冲仍存活，但 session、图片和观察器的保留路径确定存在。

建议退出后立刻切换为轻量历史组件并卸载 XtermScreen；历史图片采用统一字节预算/LRU，配合关闭/清除历史。验收至少 100 次创建、输出图片、退出，确认 observer、history、graphics 字节达到平台。

**R5：终端输出缺少端到端背压。**

[terminal-pty.ts:278](../../apps/desktop/src/terminal-pty.ts#L278) → [terminal-ipc.ts:44](../../apps/desktop/src/terminal-ipc.ts#L44) → [TerminalPane.tsx:128](../../apps/renderer/src/TerminalPane.tsx#L128) 每 chunk 立即 IPC、图像解析和 `term.write`，没有消费完成 ACK 或信用窗口。

1000 行 scrollback 只限制已解析屏幕；64 KiB pending 只保护尚未挂载屏幕；两者不约束正常运行中的 IPC/解析积压。安装的 xterm 内部有 `DISCARD_WATERMARK=50_000_000`，因此不能称其完全无界，但可积压到数十 MB/终端，超阈值会抛错并丢弃数据。

建议使用 `term.write(data, callback)` 回传消费进度，建立按字节的高低水位并对 PTY/pipe pause/resume；合批降低 IPC 频率。不能背压时明确裁尾与丢弃提示。验收同时跑高速终端输出和流式对话，并模拟隐藏/恢复、慢 Renderer，测 pending bytes、输入响应和丢数据情况。

**R6：工具输出一旦成为滚动尾窗，合流可能失效。**

[conversation-live-projector.ts:545](../../omp-patch/overlay/packages/coding-agent/src/studio/services/conversation-live-projector.ts#L545) 对非前缀更新把 `unsent` 算成全文长度，超过 4 KiB 即同步 flush，之后发送完整 `replace`。原生 Bash 输出尾窗约 50 KiB，窗头裁掉旧日志后自然不再是上次输出的前缀。普通非 PTY Bash 上游已有约 50 ms 节流；PTY 路径和自定义工具不能依赖这个保护。

此外 sanitizer 在每个原始 update 上先编码全文再裁剪，保留字节上限不等于瞬时分配或 CPU 上限。建议 replace 采用 latest-wins 时间窗，终结/控制事件强制 flush；字符阈值只衡量 append 的真实新增量。UTF-8 裁剪使用有限编码窗口，避免每次编码大型原文。验收用已满尾窗的连续日志，而非只增长不裁头的短输出。

**R7：字节预算没有覆盖所有层级和写入路径。**

Renderer：[conversationStore.ts:279](../../apps/renderer/src/conversation/conversationStore.ts#L279) 的 `closeTurn` 把工具结果折入 `items`，之后只 `trimAncillary()`，没有再经过 `pageItems()`。缩小预算探针确认 1024 B 配置下，305 B 的历史归并为 2239 B，直到后续触发受限写入路径才有机会重新裁剪。[59 行](../../apps/renderer/src/conversation/conversationStore.ts#L59) 还特意保留至少一个 item，所以单条超大 item 本来就可以超过 maxBytes。这是窗口策略，不应对外表述成无条件硬上限。

Runtime：[conversation-live-projector.ts:681](../../omp-patch/overlay/packages/coding-agent/src/studio/services/conversation-live-projector.ts#L681) 的 `open.blocks` 只有每 block 256 KiB 限制，缺每消息块数/总字节预算；`open.toolCalls` 也缺每消息容量上限。多块聚合可能超过 Bridge 单帧约 1 MiB 限制，编码抛错后被 [bridge-server.ts:138](../../omp-patch/overlay/packages/coding-agent/src/studio/bridge-server.ts#L138) catch 掉，造成完成事件缺失风险。Runtime 大响应这一部分为静态推导，未发真实 provider 请求验证。

建议统一所有 items 变更后的裁剪入口，明确单 item、message、live 总量、tool 结果与图片的独立预算；超大完整内容走持久 transcript 分页/引用，UI 使用显式 truncated 状态。验收同时覆盖“完成/中止归并后超限”和“多个合法 block 总和超限”。不能简单丢 block 却仍声称消息完整。

**R8：流式显示设置与数据生命周期耦合，另有昂贵的 Markdown 尾部。**

[ConversationItemView.tsx:243](../../apps/renderer/src/conversation/ConversationItemView.tsx#L243) 只有 `showStreaming && segment.streaming` 才把 streaming 传给 Markdown。开关关闭后 Store 仍发布增量；[markdown.tsx:133](../../apps/renderer/src/conversation/markdown.tsx#L133) 则切到整篇 ReactMarkdown，并对适用大小启用高亮。因此仅隐藏流式光标的设置会撤掉增量解析优化。

即使开启流式，[markdownBlocks.ts:124](../../apps/renderer/src/conversation/markdownBlocks.ts#L124) 为引用定义保留整体解析域；长单段、大表格等没有安全切点的内容也会保留较大 tail。Store 单 block 256 KiB 限制能约束空间，却不保证每帧解析时间恒定。

建议分离 `isStreaming` 与 `showCursor`，任何显示偏好都不改变解析优化所需的真实生命周期。对超大 pending tail 使用字节/时间预算，必要时临时纯文本或低频解析，完成再正式解析；不要破坏引用链接、列表和围栏语义。增加开关两态、长单段、引用定义、大表格和代码围栏闭合测试。

**R9：主对话与工具卡对同一次内容增长重复跟底。**

[useConversationScroll.ts:248](../../apps/renderer/src/conversation/useConversationScroll.ts#L248) 在 contentKey 变化时同步 `stickToTail()`，同文件 ResizeObserver 又跟底一次；`resizeFollow` 没有用于跳过 fallback。声明的滚动几何缓存也没有用于实际 onScroll 读取。[useToolCardFollowScroll.ts:42](../../apps/renderer/src/conversation/useToolCardFollowScroll.tsx#L42) 同步 stick 后还 schedule 下一帧写入。

重复写入确定存在；DOM 读取是否每次都强制布局，需要 trace 判断，不能只凭读操作就断言 layout thrashing。[streamingLayoutBudget.test.tsx:94](../../apps/renderer/src/conversation/streamingLayoutBudget.test.tsx#L94) 当前还期望提交和 resize 各写一次，测试并未防止重复。

建议按同一内容增长合并 commit/RO/RAF 调度，集中读后再写，目标已正确时不写。要保留首次挂载、展开卡片、会话切换贴底和用户上滚脱离测试；不能直接删同步路径而引入新跳位。

**R10：完成的整条工具链收起后，不保证卸载其正文。**

[BatchChain.tsx:334](../../apps/renderer/src/conversation/BatchChain.tsx#L334) 的单卡 open 由 overrides/activeKey 决定，独立于链 open；[421 行](../../apps/renderer/src/conversation/BatchChain.tsx#L421) 只有运行中的链被收起才卸载 cards。先展开多个完成工具卡，再收起整链时，正文可能仍挂在 CSS 折叠区域。

单卡的 lazy-unmount 已有，但没有覆盖整链关闭。建议完成链在退出动画结束后也卸载内部 cards，把轻量展开状态保存在外层。`content-visibility:auto` 是绘制/布局优化，不能当成 DOM 或图片内存释放。验收展开大型日志/图像卡再收起整链，观察 DOM 和保留对象回落。

**R11：图片需要解码像素预算，并避免先全量加载再裁剪。**

[terminalGraphics.ts:81](../../apps/renderer/src/terminalGraphics.ts#L81) 的 Kitty PNG 分支只检查压缩数据/签名，没有使用 raw/Sixel 同样的尺寸限制；[TerminalGraphicView.tsx:4](../../apps/renderer/src/TerminalGraphicView.tsx#L4) 直接交给 img，CSS 展示尺寸不能限制解码位图。用户图片 [thumbnailImage.ts:61](../../apps/renderer/src/conversation/thumbnailImage.ts#L61) 对小于 64 KiB base64 的图直接透传，也没有先验证像素数。

例如 8192×8192 RGBA 解码约 256 MiB，即使压缩文件很小；这是容量示例，不是本次测得的实际显存。并行缩略图转换也会同时持有多张原始 bitmap。

[userMessageThumbs.ts:241](../../apps/renderer/src/conversation/userMessageThumbs.ts#L241) 按 session `getAll()` 读入全部历史缩略图，然后 Store 才筛可见 item 和 8 MiB 预算。持续积累图片的长会话在打开时仍有瞬时内存峰值，磁盘缓存也没有总容量/TTL；删除会话已有 dropSession 清理，不应误报完全不能删除。

建议解码前验证 width/height/总像素，限制并发解码数，为解码内存而非仅 base64 设置预算；读取缩略图时按当前 page 的 itemId 查询，并为本地缓存设置明确容量和清理策略。验收小文件大尺寸 PNG、多图片同时发送、千条图片历史的打开/删除。

**四、GPU 与后台运行的专项判断**

目前只能确认持续绘制来源，不能给实际 GPU 百分比。主要排查点为 [workbench.css:3801](../../apps/renderer/src/styles/workbench.css#L3801) 的逐字符 hue-rotate、[3858 行](../../apps/renderer/src/styles/workbench.css#L3858) 的 Full Access 无限 text-shadow、活动行渐变动画，以及大图像解码、工具卡高度过渡和上述重复布局。已发送关键词也保留动画，任务结束不等于装饰动画结束。

[base.css:278](../../apps/renderer/src/styles/base.css#L278) 已有全局 reduced-motion 降级。[main.ts:564](../../apps/desktop/src/main.ts#L564) 关闭到托盘只 hide；没有发现应用级 visibility 调度策略，但 Electron 默认后台节流并未被禁用。后台继续任务是预期行为，hide 不卸载本身不是泄漏。

建议按“空闲 / 流式 / 禁装饰动画 / 托盘 / 恢复”五种状态采 trace：先确定 Paint、Raster、Composite、JS/Layout 各占多少，再修改。已发送文字和长期权限标记可改静态样式；隐藏时停止装饰、非必要测量，将可恢复的展示更新合并/降频，恢复时按 watermark 补齐。不能只暂停消费而让队列不断累积，也不建议默认禁用硬件加速——这可能把工作移到 CPU 并恶化滚动。

[ProcessMemoryPanel.tsx:46](../../apps/renderer/src/ProcessMemoryPanel.tsx#L46) 已有 5 秒采样和防并发，但只展示 Electron app metrics 的工作集/峰值，不含独立 Runtime。**其中 GPU 行是 GPU 进程的系统内存工作集，不是 GPU 使用率，也不是专用显存。** 各进程工作集简单相加也不等于唯一物理内存占用。

**五、较小的清理与防护缺口**

- P3：主/子代理 Engine dispose 只清内部 Store，外层 `snapshot` / `metadataSnapshot` 仍引用旧 rows。[conversationEngine.ts:140](../../apps/renderer/src/conversation/conversationEngine.ts#L140)、[subagentConversationEngine.ts:96](../../apps/renderer/src/conversation/subagentConversationEngine.ts#L96)。探针已确认；只有 Engine 仍被调用方或在途任务引用时才继续保留，不等于每次切换永久泄漏。建议 dispose 同步替换外层空快照，异步打开支持取消/失效保护。
- P3：Host [conversation-events.ts:63](../../packages/studio-host/src/conversation-events.ts#L63) 的 streamSeq/evictedTurns 不随 replay LRU 一同删除；长期出现大量新 child session ID 会积累小对象。应接入会话释放语义，保留 epoch/去重正确性，不能直接删 watermark。
- P3：Client [studio-client.ts:221](../../packages/client/src/studio-client.ts#L221) 的 bootstrap 事件缓冲缺总字节/事件上限。慢 bootstrap/resync 可积压；建议预算、超时和明确的重新同步处理。
- P3：Store 的 pending user 仅限 100 条，图片预算主要应用于已落地的 userDisplays/userThumbs。建议将待发送/失败记录也纳入图片预算；不能只从条数上限推断其内存很小。
- P3：Mermaid SVG 缓存限 32 项但不按字节；卸载阻止 setState，不能取消已开始的渲染。建议源/节点/SVG 字节预算和相同在途请求合并。
- P3：终端和通用 IPC 的导航/销毁配对 listener 没有完整互相解绑；反复 reload 会留下小量 once listener。首页 usage 30 秒轮询缺 single-flight。建议沿用内存面板的防重入并完善清理。

没有证据支持“所有订阅都泄漏”或“所有缓存都无界”。多数组件的 timer/RAF/ResizeObserver 已有 cleanup；问题集中在上述遗漏的层级、状态转换和压力路径。

**六、已有优化应保留**

- 对话 token 热流与壳 metadata 分离，RAF/可配置 cadence 合并，历史行与视图对象复用。
- Store 历史数量/字节窗口、live block/tool output 限制；rowCache 在结构路径剪枝；Store 自身 dispose 清空快照。
- 虚拟列表与未测量 fallback 有限额；行高缓存 8192 条；工具输出裁尾并用 content-visibility 分块；单卡 lazy mount/unmount。
- 流式 Markdown frozen/pending 分离、未闭合代码围栏安全降级、Mermaid 延迟加载和缓存。
- Runtime 终态清正文/工具输出，tombstone 有界；Host replay 全局 16 MiB / 32 session；ledger/receipt 终态容量有限。
- 主进程终端 live registry、应用退出、Host shutdown 和 projector 解绑已有清理流程。
- 已有独立 [.github/workflows/perf.yml](../../.github/workflows/perf.yml) 浏览器门禁，不是完全没有性能测试。

需要修正功能索引中“单一跟底写入”“同步投递不丢事件”“24 MiB 无条件硬上限”等过强描述：当前实际代码存在重复写入、拥塞丢事件与归并超预算路径。修复后应让文档与测试共同约束真实行为。

**七、建议实施顺序与验收方式**

| 批次 | 工作 | 完成标准 |
|---|---|---|
| 第一批：可靠性与资源上限 | R1 恢复互锁；R2 驻留预算/停驻设计；R3 run 内虚拟化；R4 退出终端清理 | 故障能恢复；进程/DOM/历史资源有可解释上限 |
| 第二批：流量与计算成本 | R5 背压；R6 replace 合流；R7 总预算；R8 解析语义；R9 跟底去重 | 流量增加不造成队列无限等待；单帧成本不随已完成历史线性增长 |
| 第三批：回收和显示功耗 | R10 折叠卸载；R11 图片；Engine/元数据清理；装饰动画/隐藏调度 | 收起、退出、切换后引用与观察器回落；空闲 Paint 有限 |
| 持续：可观测性和门禁 | 补 release Electron soak、异常/单 run 场景、Runtime/GPU指标 | 同一版本可稳定复现和比较，不靠肉眼与瞬时工作集判断 |

性能采样建议使用有界时间环，避免诊断本身泄漏：Electron 各进程 CPU、private bytes/working set；各 Runtime RSS、heapUsed、external/ArrayBuffer；Renderer post-GC heap、DOM/listener、long tasks、p95/p99 帧时；Bridge/IPC pending bytes、事件年龄；系统 GPU 引擎占用、dedicated/shared memory。不要将不同指标混为一个“内存”数字。

建议补齐以下固定场景：

1. 1 个 user + 500 个 assistant/tool 轮，以及 200 次会话切换；检查每帧工作量、DOM 和旧快照释放。
2. 20–50 个实际运行过的主会话；验证驻留预算、忙碌保护和恢复一致性。
3. 100 次终端创建/图片/退出；高速 stdout 与对话并发，含慢消费与恢复。
4. 长单段、引用定义、大表格、代码块收尾；流式显示开关两态分别测。
5. 大像素小 PNG、批量图片、长历史图片载入；观察 native/GPU 内存峰值。
6. 前台 30 分钟 → 托盘 30 分钟 → 恢复；完成后闲置观察，并再做 8 小时 release soak。
7. gap 与 pending receipt、断连重连、abort/timeout；验证终态、回执和缓冲能清空。

先预热并填满有界缓存，再比较多段时间窗口的保留量/增长斜率。JS 对象释放不代表工作集立即还给系统，GPU/解码缓存也可能延迟回收；判断泄漏需结合 retained references、private bytes、进程数量和平台趋势。验收不宜要求 RSS 每次立即回到启动值，也不应把默认 90 帧、三批 token 的近似稳定当成长期稳定性证明。

**本次建议保留现有架构，先补齐端到端预算、异常恢复和释放边界；没有证据表明需要整体重写流式渲染器。**
