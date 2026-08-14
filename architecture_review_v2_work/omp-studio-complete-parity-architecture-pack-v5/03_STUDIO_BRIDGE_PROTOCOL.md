# 03. Studio Bridge Protocol

## 1. Transport

| 平台 | Transport | 要求 |
|---|---|---|
| Windows | Named Pipe | 当前用户 ACL；随机 opaque name |
| macOS/Linux | Unix Domain Socket | `0600`；路径位于 Runtime 私有临时目录 |

禁止 TCP 默认监听。Frame 使用 length-prefixed JSON 或已有 wire codec；不得使用换行分隔且无大小上限的裸 JSON。

## 2. Frame header

```ts
interface FrameHeader {
  protocol: "omp-studio";
  version: 1;
  frameId: string;
  runtimeEpoch: number;
  bodyLength: number;
}
```

限制：

- control frame 默认最大 1 MiB；
- snapshot 可单独配置上限；
- transcript/content 大数据使用分页或 resource handle；
- audio 和 PTY 不使用此 frame；
- decoder 在分配前验证长度。

## 3. Connection lifecycle

```text
CONNECTING
  -> AUTHENTICATING
  -> NEGOTIATING
  -> SNAPSHOTTING
  -> READY
  -> DRAINING
  -> CLOSED
```

认证失败、协议不兼容或 runtimeEpoch 不匹配立即关闭。

## 4. Correlation

每个 request 必须有唯一 `requestId`；mutation 可以带 `idempotencyKey`。Runtime 保存有界最近 receipt registry：

- 相同 idempotencyKey + 相同 canonical operation：返回旧 receipt；
- 相同 key + 不同 operation：返回 conflict；
- registry 只用于网络重试，不保证跨 Runtime crash exactly-once；
- 有外部副作用且 crash 时仍可能 `outcome_unknown`。

## 5. 命令生命周期

```text
received
  -> rejected
  OR accepted
       -> interaction_required <-> running
       -> completed
       -> failed
       -> cancelled
       -> outcome_unknown
```

`accepted` 只表示 Runtime 接管，不表示完成。Host 只有收到 terminal receipt 才能提交最终成功投影。

## 6. Error codes

最低稳定错误集：

```ts
type StudioErrorCode =
  | "UNAUTHENTICATED"
  | "PROTOCOL_UNSUPPORTED"
  | "RUNTIME_EPOCH_STALE"
  | "STATE_VERSION_CONFLICT"
  | "CAPABILITY_UNAVAILABLE"
  | "COMMAND_UNKNOWN"
  | "COMMAND_BLOCKED"
  | "INVALID_ARGUMENT"
  | "INTERACTION_REQUIRED"
  | "INTERACTION_STALE"
  | "AGENT_GENERATION_CONFLICT"
  | "JOB_GENERATION_CONFLICT"
  | "NOT_OWNER"
  | "BUSY_STREAMING"
  | "BUSY_COMPACTING"
  | "MODE_CONFLICT"
  | "OUTCOME_UNKNOWN"
  | "INTERNAL_ERROR";
```

Host UI 根据 code 决定提示和按钮状态；不得解析英文 message。

## 7. Snapshot 与恢复

Host 在以下情况请求 snapshot：

- 首次连接；
- eventSeq gap；
- Renderer/Host projection 丢失；
- Bridge reconnect；
- Runtime 明确发出 resync_required。

Snapshot 返回：

- runtime/session identity；
- operator state；
- current messages page cursor；
- agents revision + snapshot；
- jobs revision + snapshot；
- pending interaction；
- command terminal receipt tail；
- command/capability manifest hashes。

## 8. Backpressure

分为：

- durable/control queue：不得静默丢；客户端过慢则断开并要求 snapshot；
- ephemeral delta queue：byte-bounded，可合并 text delta，并发出 gap marker；
- PTY queue：独立 byte-bounded retained tail；
- audio：独立 realtime policy。

Host 不得让慢 Renderer 阻塞 Runtime。Host 自己消费 Runtime stream，并向多个 Renderer client 发布 projection。

## 9. 版本策略

- Protocol major 不兼容时拒绝；
- minor capability 通过 manifest 扩展；
- operation kind 不认识时返回 `COMMAND_UNKNOWN`；
- Runtime 不得忽略未知 mutation 字段后继续执行；
- deprecated operation 至少保留一个 Studio release cycle；
- contract fixtures 存储 canonical JSON，跨 Host/Runtime 双向测试。

## 10. 最小 E2E

1. hello/auth/negotiation；
2. snapshot；
3. invoke `runtime.pause`；
4. accepted receipt；
5. state event paused；
6. completed receipt；
7. invoke `runtime.resume` with pauseEpoch；
8. reconnect and verify snapshot；
9. send stale runtimeEpoch and verify rejection；
10. kill Runtime after accepted, before completed, verify `outcome_unknown`。

