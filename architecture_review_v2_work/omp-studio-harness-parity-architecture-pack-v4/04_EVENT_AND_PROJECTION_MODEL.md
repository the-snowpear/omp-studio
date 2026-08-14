# Event and Projection Model

## 1. Two planes, two retention rules

Studio has two event planes and must not blur them.

| Plane | Contains | Ordering identity | Retention | Recovery |
|---|---|---|---|---|
| Durable domain plane | Studio-owned business facts | `commitSeq` | Durable | Replay journal |
| Ephemeral runtime plane | OMP/runtime observations and UI deltas | `runtimeEpoch + streamId + streamSeq` | Bounded/in-memory | OMP snapshot reconciliation |

`commitSeq`, `runtimeEpoch` and `streamSeq` are different concepts. None may be
substituted for another.

## 2. Durable domain events

A durable event records a fact owned by Studio: for example, registering an
environment, registering a workspace, creating a thread, changing Studio thread
metadata, or activating a session binding.

The Host assigns `commitSeq` only after the event and its durable projection
changes commit atomically. `commitSeq` is strictly increasing in the Host
database and does not reset when the Host process restarts. Gaps are permitted
when a transaction reserves a sequence and aborts; reordering and reuse are not.

Rules:

- clients never choose `commitSeq`;
- reducers apply durable events only in ascending `commitSeq` order;
- an `eventId` is globally unique and makes duplicate delivery harmless;
- the durable journal contains no token-by-token assistant text, tool progress,
  PTY bytes or guessed OMP lifecycle;
- command-ledger records may reference a durable event but command acceptance
  and OMP execution remain distinct facts;
- persistence and durable projection update occur in one transaction.

Durable replay rebuilds Studio-owned state only. It cannot reconstruct the
current OMP process and therefore never marks a binding `ready` without runtime
reconciliation.

## 3. Ephemeral runtime observations

Every OMP process incarnation has a fresh `runtimeEpoch`. The Host's runtime
adapter assigns a `streamId` to each ordered ingestion stream and a strictly
increasing `streamSeq` to every observation it accepts from that stream.

The local sequence provides deterministic reducer and transport behavior; it
does not claim that OMP persists or can replay that observation. The envelope
keeps the upstream OMP event type and body intact. Normalized routing fields may
be added, but Studio must not infer unreported tool completion, turn completion,
permission outcome or agent state.

Rules:

- a runtime envelope always contains `environmentId`, `runtimeEpoch`,
  `streamId` and `streamSeq`;
- `streamSeq` is contiguous only within one `streamId` and `runtimeEpoch`;
- duplicate or lower `streamSeq` is ignored;
- a gap in a non-replayable stream invalidates affected projections and starts
  reconciliation;
- any observation with a stale `runtimeEpoch` is ignored after diagnostics;
- epoch changes clear incomplete deltas, pending runtime-only UI state and old
  stream watermarks;
- semantic events are not reconstructed from PTY output, stderr regexes or
  rendered Markdown.

## 4. Projection classes

### Durable projections

Durable projections include environment registry, workspace registry, thread
metadata and session-binding history. Each row or atomic snapshot records the
highest applied `commitSeq`.

They are deterministic functions of durable events and may be rebuilt offline.

### Runtime projections

Runtime projections include current OMP state, messages, tool activity,
subagent observations, permissions and capability status. They are keyed by the
active binding and `runtimeEpoch`. They are caches that may be discarded at any
time.

Runtime projections are rebuilt from public OMP snapshot/read APIs, then brought
current with buffered observations. Studio does not read or mutate private OMP
stores to repair a projection.

### Composite client read models

A client snapshot combines the two projection classes and carries:

- `commitSeq`: durable baseline included in the snapshot;
- the active `runtimeEpoch` for each binding;
- a `streamSeq` watermark for every included runtime stream;
- a generated-at timestamp and schema version.

The snapshot is a consistency boundary, not a new durable aggregate.

## 5. Race-free snapshot and live handoff

For each subscription the Host follows this order:

1. Attach the live runtime listener to a bounded buffer.
2. Enter the runtime ingestion actor/fence so snapshot responses and incoming
   observations are serialized through one owner.
3. Read durable projections through committed `commitSeq = C`.
4. Read authoritative OMP snapshots for the active `runtimeEpoch = R`.
5. Record per-stream watermarks `S` represented by that snapshot.
6. Emit the composite snapshot `(C, R, S)`.
7. Drain buffered durable events where `commitSeq > C` and runtime observations
   where the same epoch has `streamSeq > S[streamId]`.
8. Emit a synchronization barrier, then continue the same live streams.

If the adapter cannot establish a safe fence around a particular OMP snapshot,
it must conservatively invalidate and reread the affected projection. It must
not claim an atomic snapshot it cannot provide.

## 6. Reducer rules

A client or Host reducer must apply these checks in order:

1. Validate schema/protocol version and subscription scope.
2. Reject events for a different environment, workspace, thread or binding.
3. For durable events, require `previousCommitSeq` to equal the applied
   watermark and `commitSeq` to advance it; replay or snapshot when the chain
   does not join.
4. For runtime observations, require the active `runtimeEpoch` to match.
5. Require the next acceptable `streamSeq`, except for explicitly coalescible
   delta frames whose covered range is declared.
6. Apply the payload and advance the relevant watermark atomically.

Never use arrival timestamp to resolve ordering.

## 7. Reconciliation triggers

The runtime-owned portion of a read model is invalidated when:

- the OMP process restarts or reports a new runtime identity;
- a stream sequence gap cannot be replayed;
- a client resumes behind the bounded ephemeral buffer;
- capability negotiation changes the event shape or available snapshot APIs;
- session switch/resume returns an unexpected real session identity;
- the Host detects a projection reducer error.

Reconciliation obtains fresh public OMP state, messages and subagent snapshots,
sets a new watermark and resumes. It never automatically replays a mutation
whose outcome is `outcome_unknown`.

## 8. Retention and privacy

Durable domain events follow Studio retention and deletion policy. Ephemeral OMP
payloads may contain source code, prompts, tool output and secrets; they stay in
bounded memory by default and are excluded from analytics. Optional local debug
capture is explicit, size bounded, redacted where possible, and never becomes a
recovery dependency.

The normative envelopes and projection checkpoint are in
`contracts/event-model.ts`.
