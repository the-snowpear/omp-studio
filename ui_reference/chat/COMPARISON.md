# OMP Studio Chat UI - 核对报告

## 已实现的功能 ✅

根据 OMP 源码核对，我们的聊天界面已经覆盖了以下核心功能：

### 1. 基础消息展示 ✅
- 用户消息（User Message）
- AI 回复（Assistant Message）
- 系统通知（System Message）
- Markdown 渲染和代码高亮

### 2. 工具调用展示 ✅
- 工具名称和图标
- 状态指示（success/running/error）
- 输入参数展示
- 输出结果展示（可折叠）
- 对应 OMP 的工具执行过程

### 3. 思考链展示 ✅
- 可折叠的推理过程
- 等宽字体显示
- 对应 OMP 内部的思考过程

### 4. TodoList 进度追踪 ✅
- 任务列表展示
- 三种状态（pending/in-progress/completed）
- 进度统计

### 5. 子 Agent 调用 ✅
- Agent 名称和状态
- 任务描述
- 运行状态指示器
- 对应 OMP 的 `StudioAgentSnapshot`

### 6. 会话管理 ✅
- 会话列表（Sessions List）
- 会话切换
- 活跃状态显示

---

## 缺失的核心功能 ⚠️

根据 OMP 源码分析，以下是我们**需要补充**的重要功能：

### 1. 运行时状态展示 🔴 **CRITICAL**

**OMP 源码位置**: `packages/client-contract/src/read-models.ts`

```typescript
interface RuntimeConnection {
  status: "unavailable" | "connecting" | "connected" | "disconnected";
  classification: "unavailable" | "managed" | "compatible-system" | "limited-system" | "rejected";
  runtimeId?: RuntimeId;
  runtimeEpoch?: RuntimeEpoch;
  backend?: "studio-host" | "rpc-ui" | "acp";
  runtimeVersion?: string;
}
```

**缺失内容**:
- ❌ Runtime 连接状态指示器
- ❌ Runtime 版本信息
- ❌ Runtime 后端类型显示
- ❌ 连接/断开状态的视觉反馈

### 2. 模式切换指示 🔴 **CRITICAL**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/state.ts`

```typescript
interface OperatorStateSnapshot {
  activeMode: "normal" | "plan" | "goal" | "vibe";
  plan?: PlanState;
  goal?: GoalState;
  vibe?: VibeState;
  loop?: LoopState;
  pause?: PauseState;
  live?: LiveState;
}
```

**缺失内容**:
- ❌ 当前模式显示（Normal/Plan/Goal/Vibe）
- ❌ Plan 模式状态（active/paused/review）
- ❌ Goal 模式进度（objective、tokenBudget、tokensUsed）
- ❌ Loop 模式状态（iterations、prompt）
- ❌ Pause 状态指示器

### 3. 交互请求处理 🟡 **HIGH**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/interactions.ts`

```typescript
type RemoteInteractionRequest =
  | { kind: "confirm"; message: string; destructive?: boolean }
  | { kind: "select"; options: Array<{...}>; multiple?: boolean }
  | { kind: "input"; placeholder?: string; secret?: boolean }
  | { kind: "editor"; content?: string; language?: string }
  | { kind: "approval"; approvalType: string; details: unknown };
```

**缺失内容**:
- ❌ Confirm 对话框（确认/取消）
- ❌ Select 选择器（单选/多选）
- ❌ Input 输入框（普通/密码）
- ❌ Editor 编辑器（代码编辑）
- ❌ Approval 审批卡片

### 4. Agent 详细状态 🟡 **HIGH**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/agents-jobs.ts`

```typescript
interface StudioAgentSnapshot {
  agentId: AgentId;
  generation: Generation;
  parentAgentId?: AgentId;
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
  activeJobIds: JobId[];
}
```

**当前实现**:
- ✅ 基础 Agent 名称和状态
- ❌ Agent 层级关系（parentAgentId）
- ❌ Agent 详细状态（8 种状态）
- ❌ 未读消息数量（unreadCount）
- ❌ 关联的 Job IDs
- ❌ 转录历史链接

### 5. Job 任务管理 🟡 **HIGH**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/agents-jobs.ts`

```typescript
interface StudioJobSnapshot {
  jobId: JobId;
  generation: Generation;
  ownerAgentId: AgentId;
  agentId?: AgentId;
  type: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  summary?: string;
}
```

**缺失内容**:
- ❌ Job 列表展示
- ❌ Job 状态追踪（5 种状态）
- ❌ Job 所属 Agent 关联
- ❌ Job 执行时间线

### 6. 命令执行历史 🟢 **MEDIUM**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/state.ts`

```typescript
interface CommandLedgerEntry {
  commandId: CommandId;
  requestId: string;
  operationKind: string;
  requestedAt: string;
  status: "requested" | "accepted" | "interaction_required" | "completed" | "failed" | "rejected" | "outcome_unknown";
  terminalAt?: string;
  stateVersionBefore?: StateVersion;
  stateVersionAfter?: StateVersion;
  errorCode?: string;
}
```

**缺失内容**:
- ❌ 命令执行历史记录
- ❌ 命令状态追踪（7 种状态）
- ❌ 状态版本对比
- ❌ 错误代码展示

### 7. 流式响应指示 🟢 **MEDIUM**

**OMP 源码位置**: `packages/studio-protocol/src/contracts/state.ts`

```typescript
interface OperatorStateSnapshot {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessages: number;
}
```

**缺失内容**:
- ❌ 流式输出指示器（isStreaming）
- ❌ 上下文压缩指示（isCompacting）
- ❌ 待处理消息数量（pendingMessages）

### 8. 环境和诊断信息 🟢 **MEDIUM**

**OMP 源码位置**: `packages/client-contract/src/read-models.ts`

```typescript
interface EnvironmentReadModel {
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  authority: PublicAuthorityIdentity;
  runtime: RuntimeConnection;
  installer: RuntimeInstallState;
}

interface DiagnosticReadModel {
  entries: ReadonlyArray<DiagnosticEntry>;
}
```

**缺失内容**:
- ❌ 平台信息展示
- ❌ Runtime 安装状态
- ❌ 诊断日志查看器
- ❌ 环境问题诊断面板

### 9. 会话历史和恢复 🟢 **MEDIUM**

**OMP 源码位置**: `packages/client-contract/src/read-models.ts`

```typescript
interface SessionHistoryEntry {
  historyId: HistoryEntryId;
  threadId: ThreadId;
  title: string;
  summary?: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  status: "active" | "archived" | "closed";
}
```

**缺失内容**:
- ❌ 会话历史列表
- ❌ 会话恢复功能
- ❌ 会话归档状态
- ❌ 消息计数显示

---

## 优先级修复建议

### 🔴 P0 - 立即实现（核心功能）

1. **Runtime 状态指示器**
   - 在顶部添加 Runtime 连接状态
   - 显示版本信息和后端类型
   - 连接/断开的视觉反馈

2. **模式切换显示**
   - 在 active-agents-bar 旁边添加模式指示
   - Plan/Goal/Vibe/Loop 模式的视觉标识
   - Pause 状态的明显指示

3. **交互请求组件**
   - Confirm 对话框
   - Select 选择器
   - Input 输入框
   - Approval 审批卡片

### 🟡 P1 - 尽快补充（重要功能）

4. **Agent 详细状态**
   - 完整的 8 种状态展示
   - Agent 层级关系可视化
   - 未读消息徽章
   - 关联 Jobs 列表

5. **Job 任务管理**
   - Job 列表面板
   - 状态追踪时间线
   - 取消操作支持

### 🟢 P2 - 后续优化（增强功能）

6. **流式响应指示**
   - 流式输出动画
   - 压缩状态提示
   - 待处理消息数量

7. **环境和诊断**
   - 环境信息面板
   - 诊断日志查看器
   - 问题排查工具

8. **会话历史管理**
   - 完整历史列表
   - 会话恢复和归档
   - 搜索和过滤

---

## 建议的 UI 结构调整

### 1. 顶部状态栏增强

```
┌─────────────────────────────────────────────────────────┐
│ Runtime: Connected ● claude-3.5-sonnet | Mode: Normal  │
│ [Main Agent] [Subagent #1] [Subagent #2]              │
└─────────────────────────────────────────────────────────┘
```

### 2. 右侧面板新增 Tab

```
Context | Agents | Jobs | History | Diagnostics | Settings
```

### 3. 交互请求悬浮层

当有 `pendingInteraction` 时，在对话区域上方显示交互卡片：

```
┌─────────────────────────────────────────────┐
│ ⚠️ Confirmation Required                    │
│ Are you sure you want to delete this file? │
│ [Cancel] [Confirm]                          │
└─────────────────────────────────────────────┘
```

---

## 下一步行动

1. **立即补充 Runtime 状态组件**（1-2 小时）
2. **实现模式切换指示器**（1 小时）
3. **创建交互请求组件库**（3-4 小时）
4. **增强 Agent 状态展示**（2-3 小时）
5. **添加 Job 管理面板**（2-3 小时）

总计：**约 10-15 小时**可完成核心缺失功能的补充。

---

## 总结

当前实现已经覆盖了 **基础对话交互** 的 70% 功能，但缺少 OMP 特有的：

- ✅ 消息展示、Markdown 渲染
- ✅ 基础工具调用、思考链
- ✅ TodoList、基础 Subagent
- ❌ Runtime 状态管理
- ❌ 模式切换（Plan/Goal/Vibe/Loop）
- ❌ 交互请求处理
- ❌ 完整的 Agent/Job 管理
- ❌ 会话历史和诊断

建议按优先级逐步补充，先实现 P0 核心功能，确保界面能够正确反映 OMP Runtime 的完整状态。

---

**生成时间**: 2026-08-12  
**源码版本**: OMP Studio packages/client-contract + packages/studio-protocol  
**核对人**: Kiro (Claude Code)
