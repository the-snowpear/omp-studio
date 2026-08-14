# 06. State, Security and Recovery

## 1. 标识和序号

```text
EnvironmentId  Studio 环境
WorkspaceId    工作区绑定
ThreadId       产品 Thread
RuntimeId      一个 OMP process 实例
runtimeEpoch   Thread 每次新 Runtime 递增
stateVersion   Runtime 可观察状态每次提交递增
eventSeq       Runtime Bridge event 单调序号
commitSeq      Studio Host durable projection 提交序号
generation     Agent/Job/Lease 的 CAS 世代
```

不同序号不可互换。Renderer 只使用 Host publication cursor；Host 才处理 Runtime eventSeq。

## 2. Command Ledger

Host durable record：

```ts
interface CommandLedgerEntry {
  commandId: string;
  requestId: string;
  threadId: string;
  runtimeId: string;
  runtimeEpoch: number;
  operationKind: string;
  requestedAt: string;
  status: "requested" | "accepted" | "interaction_required" | "completed" | "failed" | "rejected" | "outcome_unknown";
  terminalAt?: string;
  stateVersionBefore?: number;
  stateVersionAfter?: number;
  errorCode?: string;
}
```

Ledger 不保存 secret、raw prompt content、audio、PTY bytes 或内部 session path。

## 3. Authority

Studio Host 是 Desktop 唯一 authority：

- Renderer session 只能发 domain command；
- Host 验证用户、workspace、thread、runtime binding；
- Host 将 domain command 转为 Studio operation；
- Runtime 再验证 runtime-specific precondition；
- Host 不绕过 Runtime 直接 mutate OMP files。

## 4. Bridge 认证

- Host 创建 endpoint 和一次性 token file；
- token file 仅当前用户可读；
- Runtime 读取后删除/清空；
- 双方使用 challenge-response 绑定 runtimeInstanceId；
- 后续 frame 绑定连接，不把 token 放每帧；
- reconnect 需要 Host 发新 nonce，并验证同一 process identity；
- system/custom Runtime 仍受相同认证。

## 5. Renderer 安全

禁止 Renderer 获得：

- raw Bridge socket；
- Runtime token；
- process PID/handle；
- OMP session path；
- arbitrary filesystem path mutation；
- AgentSession/Registry reference；
- Runtime update signing key；
- microphone device handle。

Renderer 展示的 Markdown、tool output、terminal output 均视为 untrusted。

## 6. Destructive confirmation

以下至少要求 Host confirmation policy：

- session drop；
- agent kill/release；
- job cancel（按设置）；
- OMFG overwrite/global save；
- config/rule deletion；
- workspace destructive shell/git；
- Runtime uninstall while referenced。

Runtime interaction 不能替代 Host security confirmation；两者可以合并成一个有 scope 的 approval token，但必须由 Host 签发并一次性消费。

## 7. Crash 分类

| 情况 | 恢复结果 |
|---|---|
| request 未发送 | Host 可安全重新发送 |
| Runtime 未 accepted | 重新连接后依据 receipt registry/ledger 判断 |
| accepted，无副作用且有 idempotency | 可按 operation policy retry |
| accepted，可能有外部副作用 | `outcome_unknown`，人工 reconcile |
| completed receipt 已持久化 | 使用 terminal outcome |
| Bridge 断开但 Runtime 活着 | reconnect + snapshot |
| Runtime crash | process exit + session recovery + snapshot from new epoch |

## 8. Rebind

当前版本不做 live backend migration。Runtime crash/restart 是新 epoch：

```text
old runtime exits
  -> Host marks active commands interrupted/outcome_unknown
  -> verify process really closed
  -> launch same runtimeVersion if available
  -> resume session through OMP supported path
  -> new runtimeEpoch
  -> snapshot/reconcile
  -> enable mutation
```

不允许旧 Runtime 尚未退出时启动新 owner。

## 9. PTY 安全

- 使用一次性 attach ticket；
- PTY resize/write/signal/terminate 分开授权；
- output byte-bounded；
- terminal renderer 正确处理 ANSI，但复制到日志时 sanitize；
- 禁止 OSC 导航直接触发 Host privileged action；
- 不把 PTY 内容送入 semantic parser；
- PTY input 来源必须是当前获得 TUI control lease 的用户 surface。

## 10. 安全测试

- stale runtimeEpoch replay；
- stale agent/job generation；
- stolen/replayed PTY ticket；
- Renderer XSS 调 Bridge/Host API；
- oversized frame；
- malformed manifest/schema；
- OSC/hyperlink伪造 success；
- token file ACL；
- custom executable trust warning；
- Runtime binary replaced after probe；
- destructive approval replay。

