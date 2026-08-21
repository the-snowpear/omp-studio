# 历史会话离线 Token / Context 遥测实施计划

## 1. 目标与锁定决策

在用户查看未启动常驻 Runtime 的历史会话时，右上角仍能显示 Token 用量和 Context 构成。

已锁定：

- 查询优先级：`Live Runtime → 历史真实快照 → 一次性 OMP 只读探针`。
- 有历史快照时优先显示快照，保持“上次真实状态”语义。
- 无快照时允许启动一次性 OMP 子进程，计算后立即退出；不创建常驻 Session Worker。
- 探针禁止执行扩展、Hooks 和 MCP；如果 Context 依赖动态扩展，只返回真实 Token，Context 明确不可用。
- 不估算、不回退 Mock，不返回 Prompt、消息正文、工具参数、路径、凭据或 Provider payload。
- 现有补丁序列已到 `0023`，新 OMP 补丁固定为：
  `omp-patch/patches/0024-studio-archived-session-telemetry.patch`。
- 不修改或重写 `0019` 及其他历史补丁。

数据来源语义：

```ts
type SessionTelemetrySource =
  | "live"
  | "persisted"
  | "archive-recomputed";

type SessionTelemetrySemantics =
  | "current-live"
  | "last-observed"
  | "current-environment-recomputed";
```

## 2. 协议和数据接口

新增只读 Client 查询：

```ts
"session.telemetry.read"
```

输入：

```ts
interface SessionTelemetryReadInput {
  readonly sessionId: SessionId;
}
```

结果：

```ts
interface SessionTelemetryReadResult {
  readonly sessionId: SessionId;
  readonly source: SessionTelemetrySource;
  readonly semantics: SessionTelemetrySemantics;
  readonly telemetry: SessionTelemetrySnapshot;
}
```

规则：

- 查询只接收 `sessionId`，Renderer 不得传路径、Workspace 路径或 Runtime 参数。
- 无法获得任何可靠 Token 数据时，查询返回现有 `ClientError`，错误码使用 `UNAVAILABLE`。
- Token 可用但 Context 无法安全重建时，查询仍成功，`telemetry.context` 为 `null`。
- 扩展 `SessionTelemetrySnapshot.unavailableReason`：

```ts
type SessionTelemetryUnavailableReason =
  | "runtime_not_ready"
  | "model_context_unknown"
  | "probe_dynamic_context_disabled";
```

- `probe_dynamic_context_disabled` 表示当前环境启用了必须执行代码或连接外部服务才能恢复的扩展、Hook、动态工具或 MCP。
- 继续只允许五个 Context 分类：`systemPromptTokens`、`systemContextTokens`、`systemToolsTokens`、`skillsTokens`、`messagesTokens`。
- Client Contract、Desktop Transport 入站/出站验证都必须采用 exact-key 校验，拒绝额外字段、负数、NaN、Infinity 和错误 sessionId。

## 3. 实施步骤

### 3.1 任务准备和备份

实施前执行：

1. 检查根工作区和 vendor 状态，保留所有无关用户改动。
2. 在 `backup/YYYY-MM-DD/archived-session-telemetry-HHmmss/` 中备份所有准备修改的现有文件，保持项目相对路径。
3. 创建 `README.md`，记录原因、文件清单、恢复方法和当前提交。
4. 不备份 `node_modules`、构建产物、日志或临时探针文件。
5. 不执行 `git reset`、`checkout --` 或清理用户文件。

### 3.2 提取 OMP 共享遥测构建器

在应用 0001–0023 后的临时 OMP 副本中新增共享模块：

```text
packages/coding-agent/src/studio/session-telemetry.ts
```

导出统一函数：

```ts
buildStudioSessionTelemetry(input: {
  sessionId: string;
  session: TelemetrySessionPort;
  capturedAt: string;
}): StudioSessionTelemetry
```

要求：

- 将 `state-projector.ts` 中现有的 `getSessionStats()`、`getContextBreakdown()` 和最近完成 assistant usage 映射迁入共享函数。
- Live `StudioStateProjector` 改为调用共享函数，行为、250ms 节流和事件顺序不变。
- 离线探针也调用同一函数，禁止复制第二套 Token/Context 算法。
- 对所有数值执行 finite、非负处理；Context token 字段必须为安全整数。
- 无有效 Context Window 时返回 `context: null` 和 `model_context_unknown`。
- aborted/error assistant 不得成为 `lastCompletedTurn`。

### 3.3 增加 OMP 隐藏只读探针

在 OMP CLI 入口增加隐藏参数：

```text
--studio-session-telemetry-probe
```

该参数必须在普通 command/launch 分发前处理，不能落入 Prompt，也不出现在公开帮助中。

探针从 stdin 读取一次性 JSON：

```ts
interface StudioTelemetryProbeInput {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionFile: string;
  readonly expectedSessionId: string;
  readonly allowedCwd: string;
}
```

其中 `sessionFile` 必须是 Host 创建的临时会话副本，不是原始 JSONL。

输出只允许：

```ts
type StudioTelemetryProbeOutput =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly telemetry: StudioSessionTelemetry;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly code:
        | "INVALID_INPUT"
        | "SESSION_NOT_FOUND"
        | "SESSION_MISMATCH"
        | "WORKSPACE_MISMATCH"
        | "SESSION_CORRUPT"
        | "PROBE_UNAVAILABLE";
      readonly message: string;
    };
```

探针流程固定为：

1. exact-key 校验 stdin，限制输入大小。
2. `SessionManager.open(sessionFile)` 打开临时副本。
3. 验证 sessionId 与 `expectedSessionId` 一致。
4. 验证会话头 cwd 与 `allowedCwd` 属于同一 Workspace。
5. 使用当前本地模型配置、系统规则、静态 Skills 和内置工具构造只读统计会话。
6. 明确关闭 MCP、LSP、后台任务、模型发现刷新、记忆同步、Agent 注册和所有模型请求。
7. 不加载扩展或 Hooks，不执行任何扩展初始化代码。
8. 如果检测到启用的扩展、Hooks、动态工具、扩展模型或 MCP 会影响 Context，则仍计算 Token，但将 Context 设为 `null`，原因设为 `probe_dynamic_context_disabled`。
9. 调用共享遥测构建器，输出单行 JSON，然后 dispose 并退出。
10. stdout 不得打印日志；诊断只写受限 stderr，且不得包含路径或内容。

### 3.4 生成 `0024` 补丁

vendor 当前是干净上游基线，因此不得直接把 0001–0023 永久应用到 vendor。

固定流程：

1. 在系统临时目录创建 vendor 的临时 clone。
2. 按 `series.json` 顺序应用 0001–0023。
3. 保存应用完 0023 后的基线。
4. 在临时 clone 中实现共享构建器、隐藏探针和 OMP 测试。
5. 仅对基线到新实现生成 `0024-studio-archived-session-telemetry.patch`。
6. 将 `0024` 追加到 `omp-patch/patches/series.json`。
7. 补丁只包含 OMP 相关源码和测试，不包含构建产物。
8. 在另一个干净临时 clone 中完整应用 0001–0024，确认 series 可重复应用。

### 3.5 扩展历史会话读取器

在 Studio Host 的历史会话读取层增加两个内部能力：

```ts
readRevision(sessionId): Promise<{
  sessionId: string;
  transcriptRevision: string;
}>;

createProbeCopy(sessionId, destinationDirectory): Promise<{
  sessionId: string;
  transcriptRevision: string;
  temporarySessionFile: string;
}>;
```

要求：

- 复用现有 Session Archive Reader 的 session 定位、重复 ID、Workspace、符号链接、大小限制和 JSONL 完整前缀校验。
- `createProbeCopy` 只复制已经验证的完整 JSONL 前缀，忽略崩溃产生的不完整尾行。
- 临时副本只能创建在 Host profile 下的任务临时目录。
- 原始会话文件只读打开，探针永远不能获得原始路径。
- `temporarySessionFile` 只在 Desktop/Host 内部传递，不能进入 Client Contract、事件、Renderer 或日志。
- 探针结束、超时、异常或 Host 关闭时都必须清理临时目录。

### 3.6 增加持久化遥测快照

新增 Host 内部快照存储，位置固定为：

```text
<profileDirectory>/session-telemetry/v1/<sha256(sessionId)>.json
```

内部记录：

```ts
interface PersistedSessionTelemetryRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly transcriptRevision: string;
  readonly recordedAt: string;
  readonly telemetry: SessionTelemetrySnapshot;
}
```

写入策略：

- 监听现有 `session.telemetry.changed`。
- 每个 session 使用 2 秒 trailing debounce，latest-wins；流式 delta 持续到达时不重复写盘。
- debounce 到期后读取当前 `transcriptRevision`，再原子写入临时文件并 rename。
- Runtime detach 或 Host 正常关闭时，尝试 flush 最后一份待写数据。
- 单条记录限制为 64 KiB。
- 文件名使用 sessionId 的 SHA-256，不直接使用用户输入。
- 损坏、超大、schema 不匹配或 sessionId 不匹配的记录视为 cache miss。
- 不保存消息、Prompt、路径、Provider 数据或凭据。

读取策略：

- 先读取当前历史会话的 `transcriptRevision`。
- 只有 record 的 revision 与当前 archive revision 完全一致时才返回 `persisted`。
- revision 不一致时忽略旧快照并进入探针流程。
- 探针重算结果只做短期内存缓存，不写入“历史真实快照”存储。
- 探针内存缓存键使用 `sessionId + transcriptRevision + Runtime executable identity`，TTL 固定 30 秒。

### 3.7 增加 Host 探针执行端口

新增 Desktop/Host 内部 Probe Port，使用当前 Runtime Resolver 选出的兼容 OMP executable。

固定限制：

- `shell: false`。
- Windows 后台启动，不显示窗口。
- stdin/stdout/stderr 使用 pipe。
- 只传隐藏探针参数；sessionId、路径和 cwd 通过 stdin JSON 传递。
- 超时固定 8 秒。
- stdout 最大 64 KiB，stderr 最大 16 KiB。
- 超限、超时、退出码异常和 malformed JSON 都映射为安全的 `UNAVAILABLE`。
- 同一个 cache key 的并发请求共享一个 in-flight Promise。
- 不把原始 stderr 返回到 Client。
- 无兼容 Runtime executable 且没有有效持久化快照时，返回 `UNAVAILABLE`。
- 探针进程不注册为 Session Worker，不修改 Session Broker、当前选择或 Runtime epoch。

### 3.8 Facade 查询优先级

`session.telemetry.read` 固定执行：

```text
请求 sessionId
  ├─ 当前 Runtime snapshot.sessionId 匹配且存在 telemetry
  │    └─ source=live, semantics=current-live
  └─ 否
       ├─ Archive 校验 session/workspace/revision
       ├─ 有匹配 revision 的持久化快照
       │    └─ source=persisted, semantics=last-observed
       └─ 无有效快照
            ├─ 创建临时会话副本
            ├─ 运行一次性 OMP 探针
            └─ source=archive-recomputed
               semantics=current-environment-recomputed
```

Facade 必须再次验证：

- Result sessionId 与请求一致。
- `parseSessionTelemetrySnapshot` 通过。
- 响应不包含未知字段。
- Live 查询不能返回其他 session 的 telemetry。
- 探针迟到结果不能覆盖已经切换的会话。

### 3.9 Renderer 数据选择

新增 `useViewedSessionTelemetry` 一类的 Renderer hook，保持离线查询状态独立于 Client 的 Live reducer。

行为：

- Preview 开启：只使用 Preview fixture，不发真实查询。
- 查看会话等于 Live snapshot session：直接使用 `entities.telemetry`。
- 查看其他历史会话：调用 `session.telemetry.read`。
- sessionId 改变时增加 generation；旧请求即使完成也必须丢弃。
- 同一页面生命周期内按 sessionId 缓存已完成结果。
- Runtime 后续恢复为该 session 时，Live 数据立即覆盖离线结果。
- 查询失败时显示诚实不可用状态，不回退当前会话数据或 Mock。

来源标签固定为：

- `live`：`实时`
- `persisted`：`最后记录`
- `archive-recomputed`：`当前环境重算`

Context 为 `null` 时：

- `model_context_unknown`：显示“当前模型没有可用的 Context Window”。
- `probe_dynamic_context_disabled`：显示“该会话依赖扩展或 MCP；安全模式下无法离线重建 Context”。
- Token 面板仍正常展示已获得的真实 Token 数据。

## 4. 测试计划

### OMP 单元测试

- Live projector 和 probe 对同一无扩展 fixture 生成完全相同的 telemetry。
- 五个 Context 字段逐项等于 `getContextBreakdown()`。
- Session totals、reasoning、cache read/write、cost 和最近完成 turn 正确。
- aborted/error assistant 被排除。
- 无模型 Context Window 时返回 `model_context_unknown`。
- 配置含扩展、Hook、动态工具或 MCP 时不执行代码，并返回 `probe_dynamic_context_disabled`。
- stdin 额外字段、错误 schema、超大输入和 session mismatch 全部拒绝。
- probe stdout 只含一份 JSON。
- 原始会话文件的 hash、大小和 mtime 在探针前后完全不变。
- 无模型请求、工具调用、Bridge listener、Agent Registry 项或后台 Job 被创建。

### Host 和存储测试

- Live > persisted > probe 的优先级严格成立。
- revision 匹配时不启动探针。
- revision 改变时丢弃持久化记录并启动探针。
- 2 秒 debounce 只写最后一份遥测。
- 持久化写入使用原子替换。
- 损坏、超大、额外字段和 sessionId 不匹配记录均忽略。
- 临时会话副本忽略不完整尾行，但拒绝损坏的完整中间行。
- Workspace mismatch、重复 sessionId、符号链接和超大归档全部安全失败。
- 相同 session/revision/runtime 的并发查询只启动一个进程。
- timeout、非零退出、stdout 超限、malformed JSON 和错误 sessionId 都返回 `UNAVAILABLE`。
- 每种退出路径都清理临时目录。
- 错误和日志不含绝对路径、Prompt、消息或凭据。

### Contract、Transport 和 Client 测试

- 新 query input/output exact-key 验证通过。
- 未知 source、semantics、unavailableReason 和负数被拒绝。
- Desktop/Web transport 保持 queryName 和结果类型对应。
- 不允许 Renderer 提交 path/cwd/runtime executable。
- Live reducer 不被离线查询结果覆盖。
- session 切换后迟到结果被忽略。

### Renderer 测试

- 当前会话显示 `实时`。
- 已停止但有匹配快照的会话显示 `最后记录`。
- 老会话无快照时显示 `当前环境重算`。
- 动态扩展会话显示 Token，但 Context 显示明确不可用原因。
- loading、unavailable、stale result 和 Runtime 恢复路径正确。
- Preview 模式不发查询，真实模式不使用 fixture。

### 集成场景

1. 启动会话、完成一轮、等待快照落盘、停止 Runtime、查看历史会话：返回 `persisted`。
2. 准备无快照旧会话且无动态扩展：启动一次性探针并返回完整 Token/Context。
3. 准备依赖扩展或 MCP 的旧会话：返回 Token，Context 为 null。
4. 查询过程中切换会话：旧结果不进入 UI。
5. 查询结束后恢复该会话 Runtime：来源切换为 `live`。
6. 修改历史 JSONL revision 后再次查询：旧快照失效并重新探测。

## 5. 验证、交付与完成标准

执行：

```bash
npm run build
npm run typecheck
npm test
npm run check
git diff --check
git -C omp-patch/vendor/oh-my-pi diff --check
npm run omp:verify:patches
```

额外验证：

```bash
# 在干净临时 OMP clone 中应用完整 0001–0024
git apply --check <0024 patch>
git apply <0024 patch>

# 应用后运行 OMP telemetry 专项测试与类型检查
bun test packages/coding-agent/test/studio-session-telemetry.test.ts
bun test packages/coding-agent/test/studio-archived-session-telemetry.test.ts
bun run --cwd packages/coding-agent check:types
```

交付物：

- `0024-studio-archived-session-telemetry.patch`
- 更新后的 `series.json`
- 新的 Client query contract 和 transport validator
- Host telemetry store、archive copy 和 probe port
- Renderer 历史会话遥测 hook 与来源标签
- OMP、Host、Client、Transport、Renderer 测试
- 规范备份目录及 README

完成标准：

- 未启动常驻 Runtime 时可以查看历史会话 Token。
- 有历史快照时不启动任何 OMP 进程。
- 无快照时只启动一次性受限 OMP 探针。
- 安全探针可重建时显示五类真实 Context。
- 依赖扩展/MCP 时不执行扩展，Context 诚实不可用。
- UI 清楚区分实时、最后记录和当前环境重算。
- 不修改原始会话文件。
- 不泄漏消息、Prompt、路径、工具参数、凭据或 Provider payload。
- 完整补丁序列、构建、类型检查和测试全部通过。
