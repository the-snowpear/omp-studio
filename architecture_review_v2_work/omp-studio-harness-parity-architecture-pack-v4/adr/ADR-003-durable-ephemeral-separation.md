# ADR-003: Durable semantic commits and ephemeral streams are separate

Status: accepted for v4

## Decision

Durable Studio state uses an authority-scoped commit sequence and replayable
journal. Text/thinking deltas, terminal bytes, preview logs, and progress ticks
use bounded stream channels, accumulators, ring buffers, or spool storage.

## Consequences

- Reconnect is snapshot plus durable replay plus current partial-stream state.
- Clients do not replay every token.
- Dropped/coalesced stream frames do not create durable sequence gaps.

