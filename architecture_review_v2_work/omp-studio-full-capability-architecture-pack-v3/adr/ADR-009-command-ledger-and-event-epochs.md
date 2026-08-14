# ADR-009: Command Ledger and Epoch-Scoped Event Replay

Status: Accepted for v3 baseline

## Decision

Every mutation is represented by a Studio `commandId` and idempotency key. The Host records command state before dispatch and exposes outcome lookup. OMP acknowledgement and turn completion are distinct; uncertain crash outcomes become `ambiguous` and are never automatically replayed.

Events use Host-global sequence numbers scoped by `hostEpoch`; each OMP process has a separate `runtimeEpoch`. Snapshots carry the exact `snapshotSeq` and runtime epochs. Epoch mismatch or journal gaps force a full resync.

## Consequences

- The design does not claim exactly-once execution across crashes.
- Late events, local-only slash commands and non-terminal `agent_end` frames can be represented correctly.
- Snapshot plus incremental replay has a defined atomic barrier.

Normative details: `contracts/command-lifecycle.ts` and `contracts/event-stream.ts`.
