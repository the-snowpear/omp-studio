# v4 Target Architecture

## System diagram

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Shared Product Client                                                │
│ Desktop Renderer | Local WebUI | Future Remote/Mobile                │
│ Studio opaque IDs | Read Models | hot/cold windows | virtualization  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ Studio Host Protocol
┌───────────────────────────▼──────────────────────────────────────────┐
│ Client Boundary                                                      │
│ Desktop IPC | Local HTTP+WS | Remote TLS transport                   │
│ Auth | Origin | CSRF | Grants | Control Lease | Backpressure         │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│ HostAuthority (one active authority per Environment)                 │
│ discovery | lock/fencing | epoch | process reaper | diagnostics      │
├──────────────────────────────────────────────────────────────────────┤
│ Application                                                          │
│ Command API -> CommandOrchestrator -> CommandLedger                  │
│ Query API -> ReadModel Queries                                       │
│ RuntimeIngestion | ReceiptRegistry | RecoveryCoordinator             │
├──────────────────────────────────────────────────────────────────────┤
│ Studio Domain                                                        │
│ Environment | Project | Workspace | Thread | Run | Message           │
│ AgentProjection | Tool | Approval | Change | Preview | RuntimeBinding│
├──────────────────────────────────────────────────────────────────────┤
│ State and Publication                                                │
│ Durable Journal | Projectors | Ordered Durable Push                  │
│ Ephemeral Stream Mux | Per-client bounded queues | Snapshot/Replay   │
├──────────────────────────────────────────────────────────────────────┤
│ Gateways                                                             │
│ OmpRuntime | Workspace | Git | Terminal | Preview | Browser          │
├──────────────────────────────────────────────────────────────────────┤
│ OmpRuntimeGateway                                                    │
│ SessionBinding | RuntimeActor | LaunchPlan | CapabilityRouter        │
│ RPC primary | Slash compatibility | CLI/Config administration       │
│ Companion introspection | Collab experimental | SDK separate backend│
├──────────────────────────────────────────────────────────────────────┤
│ User-installed OMP Harness                                           │
└──────────────────────────────────────────────────────────────────────┘

Cross-cutting: Security Policy | Execution Policy | Capability Debt
               Compatibility CI | Metrics/Tracing | Protocol Versioning
```

## Layer responsibilities

### Shared Product Client

- Presents stable Studio concepts only.
- Sends commands and queries through generated protocol clients.
- Keeps a bounded hot window of transcript and stream state.
- Never parses OMP config files or RPC frames.
- Never decides which fallback channel to use.

### Client Boundary

- Authenticates transport and maps it to a scoped `ClientGrant`.
- Validates command schema, origin, CSRF, authority epoch, control lease, and
  resource scope before dispatch.
- Enforces per-client egress budgets and reconnect protocol.
- Keeps transport adapters free of business rules.

### HostAuthority

- Establishes exclusive authority for one Environment.
- Owns process supervision and orphan fencing.
- Publishes authority identity and protocol compatibility through owner-only
  discovery.
- Does not use possession of a port number as authorization.

### Application

- `CommandOrchestrator` validates intent, authorization, idempotency, expected
  revisions, and completion policy.
- `RuntimeIngestion` fences stale generations and normalizes authoritative
  runtime facts into projections.
- `ReceiptRegistry` coordinates known async milestones without sleeps or global
  implicit dependencies.
- `RecoveryCoordinator` reconciles bindings, processes, snapshots, projections,
  and `outcome_unknown` commands after failure.

### Studio Domain

Contains Studio-owned entities and OMP projections. It may express that OMP is
`running`, `idle`, `interrupted`, or `unknown` based on source facts, but it may
not invent Harness transitions or mutate OMP state independently.

### State and Publication

- Durable domain commits use one Host-authority `commitSeq`.
- Read Models are derived and rebuildable.
- Streaming content uses bounded ephemeral channels and per-stream ordering.
- Snapshot creation subscribes/buffers live durable changes before reading the
  snapshot, closing the query-subscribe race.

### Gateways

Gateways expose domain/application interfaces. Only `OmpRuntimeGateway` knows
OMP channels. `TerminalGateway` and `PreviewGateway` are Studio-owned and use
their own authorization and process policies.

## Command flow

```text
Client Command
  -> transport/auth/schema
  -> CommandOrchestrator
  -> ledger.received
  -> policy + lease + revision validation
  -> Gateway invocation
  -> ledger.dispatched/acknowledged/running
  -> authoritative runtime/domain result
  -> durable outcome commit
  -> read-model projection
  -> ordered durable push
```

If the channel disconnects after dispatch, the command becomes
`outcome_unknown`; it is not replayed automatically unless its descriptor and
target protocol prove idempotency.

## Runtime event flow

```text
OMP frame
  -> OmpRuntimeActor
  -> runtimeEpoch fence
  -> RuntimeFact envelope
  -> RuntimeIngestion
  -> durable semantic commit OR ephemeral stream update
  -> projector / stream accumulator
  -> publication
```

## Why this differs from a provider framework

The Gateway boundary exists for version and channel compatibility inside OMP,
not to normalize unrelated Agent products. A future backend must implement the
same Studio application contract explicitly and receives a separate runtime
binding. No lowest-common-denominator provider abstraction is required for v4.
