# 05. Agent Hub and Async Jobs

## 1. 领域边界

```text
AgentRef       = 可持续/可恢复的 agent 身份与会话引用
AgentRuntime   = 当前 generation 的 live AgentSession
AgentMessage   = 通过 IRC/Lifecycle 路由的 operator message
AsyncJob       = 一次有 owner 的异步工作
Transcript     = agent session 的增量消息视图
```

Agent 和 Job 不合并。一个 agent 可以执行多个 job；job terminal 不自动 release agent。

## 2. Agent snapshot

对 Renderer 返回 opaque 数据：

```ts
interface StudioAgentSnapshot {
  agentId: string;
  generation: number;
  parentAgentId?: string;
  kind: string;
  displayName: string;
  status: "starting" | "running" | "idle" | "parked" | "reviving" | "aborted" | "failed" | "released";
  assignment?: string;
  summary?: string;
  startedAt?: string;
  updatedAt: string;
  hasLiveSession: boolean;
  hasTranscript: boolean;
  unreadCount: number;
  activeJobIds: string[];
}
```

不得返回 `sessionFile` 或 raw AgentSession。

## 3. Control operations

### `agent.send`

```text
validate owner/descendant scope
  -> compare expectedGeneration
  -> reject advisor/read-only target
  -> AgentLifecycleManager.ensureLive if parked and allowed
  -> route prompt/steer/followUp through target session/IRC semantics
  -> return injected|queued|woken|revived
```

### `agent.spawn`

必须调用 TaskTool 使用的同一 service：

- definition resolution；
- policy/preflight；
- context/isolation；
- effort/model；
- parent ownership；
- session creation；
- AgentRegistry registration；
- AsyncJob registration（async）；
- keep-alive/adoption；
- cleanup/delivery。

Studio 只传结构化 assignment，不自行调用 SDK 拼装 subagent。

### `agent.kill`

```text
compare generation
  -> abort live session
  -> settle lifecycle
  -> release(tombstone=true)
  -> terminal event with killed generation
```

### `agent.revive`

```text
compare generation/status
  -> ensureLive
  -> new generation or authoritative generation transition
  -> return live snapshot
```

### `agent.release`

调用 Lifecycle `release` 的非 tombstone 语义；用于移除可释放的 parked/terminal agent，不冒充 kill。

## 4. Generation CAS

Host 对每个可变按钮发送当前 `generation`。Runtime 在 mutation 点比较：

- 相等：继续；
- agent 已 transition：返回 `AGENT_GENERATION_CONFLICT` + 最新 snapshot；
- agent 不存在且有 tombstone：返回 terminal snapshot；
- 不允许按同名 agent 重新匹配。

## 5. Transcript

```ts
interface AgentTranscriptPage {
  agentId: string;
  generation: number;
  cursor: string;
  nextCursor?: string;
  messages: StudioMessage[];
  eof: boolean;
}
```

Cursor 是 Runtime 生成的 opaque token，不是 byte path/offset 的裸暴露。Runtime 内部可以复用现有增量 transcript reader。

## 6. Job snapshot

```ts
interface StudioJobSnapshot {
  jobId: string;
  generation: number;
  ownerAgentId: string;
  agentId?: string;
  type: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  summary?: string;
}
```

## 7. Job cancel

```text
validate owner scope
  -> compare generation
  -> if terminal: already_terminal
  -> AsyncJobManager cancel
  -> if job owns live agent: follow existing Hub fallback semantics
  -> emit job lifecycle
  -> return cancelled or cancellation_requested
```

## 8. Subscription

Host 建立一次 Runtime subscription，Renderer 不直连：

- agent roster revision；
- lifecycle；
- progress；
- full event（按用户/带宽设置）；
- transcript page on demand；
- job lifecycle/progress；
- unread/message count。

断流后以 `agentsRevision/jobsRevision` snapshot 重建。

## 9. 权限

最低规则：

- main agent 可控制自己拥有的 descendant；
- child 不可任意控制 sibling/parent，除非 OMP policy 明确允许；
- advisor 默认只读；
- guest/collab 继承 OMP host token/write scope；
- destructive kill/release 要求 Host confirmation；
- Renderer 输入不可信，Runtime 再次检查。

## 10. Agent Hub UI 完成定义

- roster/tree 与 Runtime snapshot 一致；
- running/idle/parked/reviving/terminal 有不同视觉状态；
- Send/Steer/Follow-up 使用明确模式；
- Spawn 表单来自 definitions/capabilities；
- Kill/Release 有危险确认；
- Revive 显示 generation transition；
- transcript 增量加载和 gap recovery；
- job 关联和 cancel；
- stale button 不会作用于新 generation；
- Limited Runtime 精确禁用缺失控制。

