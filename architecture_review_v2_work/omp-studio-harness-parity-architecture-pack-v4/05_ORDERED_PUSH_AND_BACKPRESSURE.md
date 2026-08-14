# Ordered Push and Backpressure

## 1. Purpose

The Host exposes typed, scoped server streams. It does not maintain a global
broadcast bus that sends every event to every client. A client subscribes to a
domain scope and receives one ordered sequence of push frames for that
subscription.

All frames for a subscription pass through one logical writer. `deliverySeq`
detects a transport gap; it is connection-local and must not be confused with
durable `commitSeq` or runtime `streamSeq`.

## 2. Subscription lifecycle

```text
client subscribe(resume cursors)
        |
        +--> replay available ------> durable/runtime batches --> barrier --> live
        |
        +--> snapshot required -----> snapshot ----------------> barrier --> live
        |
        +--> cannot recover --------> resync-required
```

A resume cursor includes the last applied durable `commitSeq` and runtime
watermarks `{runtimeEpoch, streamId, streamSeq}`. The Host may replay durable
events from its journal. It may replay ephemeral frames only while the exact
epoch and requested range remain in the bounded stream buffer. Otherwise it
sends a fresh authoritative snapshot or `resync-required`.

The Host attaches the live listener before reading replay/snapshot state and
uses the same queue for the catch-up tail and ongoing delivery. This prevents an
event published during snapshot loading from being lost.

## 3. Priority classes

### P0 — control and safety

Examples: permission request, runtime epoch change, snapshot, synchronization
barrier, resync request, terminal command outcome, authentication expiry and
protocol error.

- never coalesce;
- never drop;
- flush immediately;
- if the queue cannot accept the frame, close the subscription and require
  resynchronization rather than continue with unsafe partial state.

### P1 — semantic runtime events

Examples: complete OMP RPC event/response, message boundary, tool lifecycle
transition, subagent lifecycle transition and non-terminal command outcome.

- preserve source order;
- do not merge distinct lifecycle transitions;
- small batching is allowed only when order and individual envelopes remain
  visible;
- on overflow, prefer disconnect/resync over silent loss.

### P2 — coalescible presentation deltas

Examples: adjacent text/thinking deltas for the same message, progress value for
the same task, high-frequency telemetry, filesystem invalidation and repeated
shell-summary refresh.

- coalesce only by an explicit key including environment, binding,
  `runtimeEpoch`, stream, entity and field;
- retain the covered `fromStreamSeq..toStreamSeq` range;
- never coalesce across a P0/P1 boundary or epoch;
- flush before completion, cancellation, error, detach or snapshot replacement;
- latest-value telemetry may be dropped only when the protocol declares it
  replaceable.

## 4. Bounded queues

Every subscription has independent limits for frame count, encoded bytes and
oldest-frame age. A slow client must not stall runtime ingestion, another
client, or command processing.

Recommended initial local defaults, subject to load testing:

| Limit | Initial value |
|---|---:|
| Maximum queued frames | 2,048 |
| Maximum encoded queued bytes | 16 MiB |
| P2 coalescing window | 16 ms |
| Maximum encoded batch | 256 KiB |
| Maximum events per batch | 256 |
| Heartbeat interval | 15 s |
| Ack timeout warning | 30 s |
| Forced slow-consumer close | 60 s or a hard queue limit |

These are resource limits, not semantic timeouts. Permission and command
deadlines are owned by their respective domains.

## 5. Ack and buffer reclamation

The client periodically acknowledges the highest contiguous `deliverySeq` it
has applied and may include its durable/runtime watermarks. The Host uses the
ack only to reclaim per-subscription buffers and measure lag.

An ack does not:

- commit a Studio domain event;
- acknowledge an OMP request;
- prove a turn or tool completed;
- authorize command retry.

Clients ack after reducer application, not merely after WebSocket receipt.

## 6. Overflow behavior

The writer handles pressure in this order:

1. Merge eligible P2 frames by coalesce key.
2. Flush a bounded batch if the transport is writable.
3. Drop explicitly replaceable telemetry and emit a backpressure notice with
   the dropped range.
4. If durable or semantic frames still exceed limits, stop the subscription and
   emit/return `resync-required` with the last retained watermarks.
5. Close the transport if even the control frame cannot be delivered.

The server never evicts an arbitrary oldest semantic frame and continues as if
nothing happened.

## 7. Fairness

- Runtime ingestion writes to per-runtime actors, not directly to client
  sockets.
- Each connection has a write budget per scheduling turn.
- Large snapshots and tool payloads are chunked or transferred as authorized
  resources; they do not monopolize the push queue.
- One thread's text stream cannot block another thread's permission request.
- A client can subscribe to shell/list projections separately from a selected
  thread's detailed stream.

## 8. Payload and renderer safety

Push frames are data, never executable UI instructions. Markdown and tool output
remain untrusted. Resource links use opaque, scoped handles. PTY bytes and
preview/browser content use separate capability-gated channels and cannot be
smuggled into the privileged control stream.

Compression is negotiated and bounded. The Host rejects decompression bombs,
oversized frames, unknown protocol versions and frames outside the authenticated
subscription scope.

## 9. Required tests

- live listener attaches before snapshot and no event is lost in the race;
- duplicate delivery and reconnect replay are reducer-idempotent;
- stale `runtimeEpoch` observations cannot mutate a current projection;
- P2 coalescing preserves declared sequence coverage and flushes before
  completion;
- P0 permission/control frames preempt high-volume deltas;
- a slow client reaches a deterministic resync/close path without growing
  unbounded memory;
- durable replay gap and ephemeral replay gap choose the correct recovery path;
- multi-client load does not allow one subscription to starve another.

The normative wire shapes are in `contracts/push-protocol.ts`.
