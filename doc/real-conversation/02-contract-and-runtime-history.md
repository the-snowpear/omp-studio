# 执行计划 02：Conversation Contract 与 Runtime 历史读取

> 可并行：可与计划 01 同时开始；必须先产出 contract-only commit 供计划 03/04/05 使用。
> 目标：定义唯一的结构化对话合同，并让 OMP Runtime 从当前 active branch 返回可分页的真实 transcript。
> 文件 owner：`packages/studio-protocol/**`、vendor 的 bridge protocol/validation/dispatcher 与新 transcript service。不要修改 Desktop、Host Facade、Client reducer 或 Renderer。

## 1. 必须先完成的 contract-only 变更

### 1.1 新建协议模块

建议新建：

- `packages/studio-protocol/src/contracts/conversation.ts`
- 从 `packages/studio-protocol/src/index.ts` 导出
- vendor `studio/bridge-protocol.ts` 添加严格镜像

不得先在 Renderer 定义另一套“临时真数据”类型。

### 1.2 建议的持久类型

最终命名可遵循现有风格微调，但语义不得丢失：

```ts
type ConversationRole = "user" | "assistant" | "system";

type ConversationContentBlock =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "thinking"; text: string; truncated?: boolean }
  | {
      type: "toolCall";
      toolCallId: string;
      toolName: string;
      arguments?: JsonValue;
      truncated?: boolean;
    }
  | {
      type: "toolResult";
      toolCallId: string;
      toolName?: string;
      output?: string;
      data?: JsonValue;
      isError: boolean;
      truncated?: boolean;
    };

type ConversationItem =
  | {
      kind: "message";
      itemId: string;       // persistent SessionEntry id
      parentId: string | null;
      createdAt: string;
      role: ConversationRole;
      content: readonly ConversationContentBlock[];
    }
  | {
      kind: "compaction";
      itemId: string;
      parentId: string | null;
      createdAt: string;
      summary: string;
      shortSummary?: string;
      warning?: string;
    }
  | {
      kind: "resetBoundary";
      itemId: string;
      parentId: string | null;
      createdAt: string;
    };
```

不要把任意 vendor message 对象整体暴露。`JsonValue` 必须是严格 JSON 类型，不允许 class、function、symbol、循环引用或 prototype object。

以下内容首版不进入公共合同：provider request/response、providerPayload、usage 原始对象、模型认证、内部 extension state、绝对 session 文件路径、未经筛选的 custom entry。

### 1.3 Transcript page

```ts
interface ConversationTranscriptPage {
  runtimeEpoch: RuntimeEpoch;
  sessionId: SessionId;
  branchLeafId: string | null;
  items: readonly ConversationItem[];
  olderCursor?: OpaqueCursor;
  headCursor: OpaqueCursor;
  hasMoreBefore: boolean;
}
```

约束：

- `items` 按 UI 阅读顺序（旧→新）返回。
- 无 cursor：读取最新一页。
- `olderCursor`：只用于读取更老一页。
- page 不混入当前 branch 之外的 sibling entries。
- 默认 limit 50，允许 1..100；0、负数、浮点、>100 拒绝。
- 即使 branch 为空也返回有效 `headCursor`，便于 gap/reload 语义统一。

### 1.4 Operation 与 capability

增加 read-concurrent operation：

```ts
{ kind: "session.transcript.read"; cursor?: OpaqueCursor; limit?: number }
```

需要同步修改：

- root `StudioOperation`
- root strict validation allow-list
- `CommandConcurrency` 分类，必须是 `read-concurrent`
- vendor operation union、validator、dispatcher allow-list
- vendor implemented capability/command manifest
- protocol fixtures/tests

Capability 使用现有 `session.history`，不要无理由新增近义 capability；只有 Runtime reader 真正实现后才声明支持。

### 1.5 Snapshot cursor 语义

启用已有 `StudioSnapshotResponse.messagesCursor`：

- 含义是“生成该 snapshot 时，当前 active branch 已持久化 transcript 的 head cursor”。
- 它不是页 cursor，不承载消息正文。
- branch 切换、session resume、reset 后必须生成与新 branch/session 绑定的新 cursor。
- Host 只可用它判断是否需要补读，不能从字符串内容推断位置。

### 1.6 Live event 精确结构

contract-only commit还要定义实时联合，避免计划03/04/05各自发明字段。建议基线如下；可按上游稳定id实际情况微调，但每项身份和completed权威收敛语义必须保留：

```ts
type ConversationRuntimeEvent =
  | {
      kind: "conversation.message.started";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      role: ConversationRole;
      createdAt: string;
    }
  | {
      kind: "conversation.message.delta";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      blockId: string;
      blockType: "text" | "thinking";
      delta: string;
    }
  | {
      kind: "conversation.message.completed";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      item: Extract<ConversationItem, { kind: "message" }>;
    }
  | {
      kind: "conversation.tool.started";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      toolCallId: string;
      toolName: string;
      arguments?: JsonValue;
      startedAt: string;
    }
  | {
      kind: "conversation.tool.updated";
      sessionId: SessionId;
      turnId: string;
      toolCallId: string;
      updateMode: "append" | "replace";
      output?: string;
      truncated?: boolean;
    }
  | {
      kind: "conversation.tool.completed";
      sessionId: SessionId;
      turnId: string;
      toolCallId: string;
      result: Extract<ConversationContentBlock, { type: "toolResult" }>;
      completedAt: string;
    }
  | {
      kind: "conversation.turn.completed" | "conversation.turn.aborted";
      sessionId: SessionId;
      turnId: string;
      occurredAt: string;
    }
  | {
      kind: "conversation.compaction.started";
      sessionId: SessionId;
      action: string;
      occurredAt: string;
    }
  | {
      kind: "conversation.compaction.completed";
      sessionId: SessionId;
      item?: Extract<ConversationItem, { kind: "compaction" }>;
      aborted: boolean;
      occurredAt: string;
    }
  | {
      kind: "conversation.notice";
      sessionId: SessionId;
      level: "info" | "warning" | "error";
      message: string;
      source?: string;
      occurredAt: string;
    };
```

`runtimeEpoch/eventSeq/stateVersion/occurredAt`若已有统一 `StudioEventEnvelope` 提供，就不要在每个内层事件重复；上例的内层 `occurredAt`可删除并以 envelope为准。contract Agent必须选择一种并在注释/测试固定，不能出现两个时间源互相矛盾。

`message.completed.item.itemId`若与 live `messageId`不同，必须增加显式 `replacesLiveId` 或书面规定 `messageId`就是最终稳定id。下游不得靠文本内容猜测两者关联。

## 2. Cursor 设计

优先复用 vendor Agent transcript 已有的签名 opaque cursor/generation 实现模式，但主 session cursor 需独立 namespace。

Cursor payload 至少绑定：

- schema version
- session identity
- runtime/session generation 或等价 epoch
- active branch leaf id
- page boundary entry id/index
- direction (`older`)

要求：

- 对用户和 Renderer 完全 opaque。
- 有完整性校验，篡改返回 `INVALID_ARGUMENT`。
- 用旧 session、旧 branch 或旧 generation cursor 返回明确 stale error；若现有错误码没有 `CURSOR_STALE`，contract Agent需决定复用 `STATE_VERSION_CONFLICT` 还是新增错误码并补全所有 strict validators。
- 不把文件路径、token、原始 branch 数据明文编码后直接下发。
- 相同 active branch/相同边界读取应确定性返回相同数据，不得随机跳页。

## 3. Runtime transcript service

建议新建 vendor service，例如：

`omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/services/session-transcript-service.ts`

### 3.1 权威数据源

必须使用 `session.sessionManager.getBranch()`。原因：SessionManager 是 append-only tree，`getEntries()` 包含 sibling branch；`session.tree.get` 只有元数据，没有正文。

读取流程：

1. 取得一次 active branch 稳定快照。
2. 获取 leaf id/generation。
3. 过滤/投影允许公开的 entry 类型。
4. 根据 cursor 找到边界并切页。
5. 映射后再执行大小限制，保证单页不会突破 Bridge frame 限制。
6. 返回 page 和新 cursor。

### 3.2 Entry 映射

- `message`：映射真实 role 和 content。
- 文本：保留换行，不解释为 HTML。
- thinking：只有上游 message 明确标记为 thinking 时映射。
- tool call：保留稳定 call id、工具名和规范化 arguments。
- tool result：按 call id 关联，保留 `isError`；二进制/图片首版可以用诚实的 unsupported/attachment metadata，不能把巨大 base64 直接塞入 frame。
- `compaction`：映射 summary/shortSummary/warning；不透传 preserveData/details。
- `reset_boundary`：映射为 resetBoundary；UI据此可明确上下文已清除。
- `branch_summary`：由 contract 决定映射 compaction-like summary 或首版忽略；必须写测试固定语义。
- `custom`/扩展 entry：默认忽略，除非有显式 allow-list 和公共类型。

### 3.3 内容规范化

实现单一 sanitizer/projector：

- 拒绝循环引用和非 plain JSON。
- key 名命中 token/secret/password/apiKey/authorization/cookie 等敏感规则时删除或替换。
- 复用项目已有 path/text redaction；不要再写不一致的第二套正则。
- 单 block/单 item/单 page 各有上限。
- 截断必须保留 `truncated: true`，不能悄悄裁掉。
- 规范化异常只降级该 block 并产生安全 warning，不能让整页不可读。

## 4. Dispatcher 与返回值

1. 在 vendor dispatcher 增加 `session.transcript.read` 分支，调用 service。
2. 该 operation 不改变 session，不增加 pending command，不要求 session-exclusive lease。
3. receipt.result 必须通过 root parser/validator 严格验证。
4. Runtime 没有 active session 时返回明确错误，不返回假空页。
5. 读取过程中 branch 发生切换时：要么基于开头的稳定快照完成，要么返回 stale；不可混合两个 branch。

## 5. Snapshot 接线

vendor StateProjector 的 `response()` 设置 `messagesCursor`。应由 transcript service 提供 head cursor，不要让 StateProjector复制 cursor 算法。

需要覆盖：

- 空 session/空 branch。
- 新增 completed message 后 cursor 改变。
- live delta 未持久化前 cursor不提前改变。
- branch navigate/resume 后 cursor 与旧 cursor 不兼容。

## 6. 必需测试

### Contract/validation

- operation 正常/非法 cursor/limit/extra key。
- page 所有 item/block kind 的 valid fixture。
- 缺字段、错误 boolean、非 JSON data、额外 key、超限输入被拒绝。
- snapshot `messagesCursor` 正常解析。

### Runtime service

- 空 branch。
- user + assistant 多 block。
- tool call/result 成功与失败。
- compaction/reset boundary。
- 最新页和连续 older pages：无重复、无缺失、全局顺序正确。
- sibling branch 不泄漏。
- branch 改变后旧 cursor stale。
- cursor 篡改失败。
- providerPayload/secret/path 被删除或脱敏。
- 巨大工具结果被截断且 frame 可发送。
- 非法 custom content 不导致服务崩溃。

### Manifest/concurrency

- `session.transcript.read` 被声明且 hash 更新。
- capability `session.history` 只在实现存在时发布。
- streaming/compacting 时仍可 read-concurrent。

## 7. 分两次提交

### Commit A：contract-only

- conversation types
- operation union
- validators
- fixtures/tests
- vendor protocol mirror（仅类型/validator）

此提交合并后通知计划 03/04/05 的 Agent，禁止继续改 schema，除非发现 blocker。

### Commit B：Runtime history implementation

- transcript service
- dispatcher
- snapshot cursor
- capability/manifest
- Runtime tests

## 8. 验收命令

```bash
npm run typecheck -w @omp-studio/studio-protocol
npm test -w @omp-studio/studio-protocol
npm run typecheck -w @omp-studio/studio-host
npm test -w @omp-studio/studio-host
npm run omp:verify:patches
```

如 vendor 有专项测试，执行其 studio dispatcher/state-projector/transcript tests，并在报告中给出精确命令。

## 9. 完成条件

- [ ] root/vendor 使用同一对话 schema。
- [ ] active branch 最新页和历史翻页可读。
- [ ] cursor opaque、签名、branch/session-bound。
- [ ] `messagesCursor` 具有明确且经过测试的 head 语义。
- [ ] tool/thinking/compaction 不靠字符串拼装丢失结构。
- [ ] 无 providerPayload/secret/任意 HTML 泄漏。
- [ ] contract-only commit 已通知下游 Agent。
- [ ] 未修改 Host Facade、Client reducer 或 Renderer。
