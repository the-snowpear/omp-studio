# RPC UI Adapter

## Purpose

The RPC UI adapter is the primary transport for active OMP sessions.

## Framing

- NDJSON over stdin/stdout.
- Negotiate protocol v2 immediately after ready.
- Implement chunk reassembly exactly: ordering, count, declared byte length, UTF-8 validity, maximum reassembled size, timeout/cleanup.
- Reject malformed frames without corrupting later frame parsing.

## Correlation

Every Studio mutation first receives a Host `commandId` and ledger entry. When
OMP supports request IDs, record the OMP request ID as transport correlation.

Maintain:

```ts
Map<RequestId, PendingCommand>
```

Separate command acknowledgement from turn completion. A prompt may be accepted and emit lifecycle events before/after its response. Local-only slash commands may complete without `agent_end`.

The ledger state machine and completion policy are normative in
`contracts/command-lifecycle.ts`. When a route has no reliable request ID it is
single-flight for that runtime/channel, otherwise it is unavailable for
concurrent use. A `runtimeEpoch` change moves unresolved commands to
`interrupted` or `ambiguous`; they are never replayed automatically. Late or
duplicate terminal frames are retained for diagnostics but cannot create a
second terminal outcome.

## Event normalization

Raw OMP frames must never enter React directly.

```text
RPC frame
 -> decoder
 -> OMP normalizer
 -> domain event
 -> projection
 -> WebSocket event
 -> UI store
```

## Important native RPC surfaces

### Runtime

- prompt / steer / follow_up,
- abort / abort_and_prompt,
- get_state,
- model/thinking/fast,
- queue/interrupt modes,
- compact/auto compact,
- retry/abort retry,
- bash/abort bash.

### Session

- new/switch session,
- branch,
- handoff,
- stats,
- messages and paged history,
- export.

### Extensibility

- available commands,
- extension UI requests,
- host tools,
- host URI schemes.

### Subagents

- `set_subagent_subscription`,
- `get_subagents`,
- `get_subagent_messages`,
- lifecycle/progress/event frames.

## RPC is source of truth for live state

Do not derive "agent is running" from a spinning UI timer or filesystem changes. Project runtime state must come from OMP events/state whenever OMP exposes it.

## Capability negotiation

`ready.supportedProtocolVersions` only describes framing/protocol version. Studio must separately probe command/event/capability behavior and should not infer every feature from RPC protocol version 2.
