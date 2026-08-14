# Failure Recovery

## OMP process crash

1. Mark Thread runtime `crashed`.
2. Preserve last event sequence and projection.
3. Stop accepting mutating controls.
4. Offer automatic or explicit restart depending on crash frequency.
5. Spawn new OMP process and renegotiate capabilities.
6. Switch/load the same session through supported OMP session APIs.
7. Rebuild state from `get_state` + message history + subagent snapshot.
8. Resume UI with a new runtime epoch.

All unresolved commands from the old runtime become `interrupted` or
`ambiguous`; none are replayed automatically. Responses/events carrying the old
runtime epoch are ignored after reconciliation.

## Host process crash

1. A new Host creates a new `hostEpoch` and revokes all prior client sessions.
2. Previous replay cursors are invalid; clients authenticate again and request a fresh snapshot.
3. Non-terminal ledger entries are reported as interrupted/ambiguous, not retried.
4. OS containment closes old Host-owned process trees before a new writer lease is issued.

## Channel failure

A channel failure does not automatically trigger a different channel. The Capability Broker uses a declared fallback policy for each operation.

Example:

```text
subagent.kill:
 native RPC unavailable -> companion extension allowed -> experimental collab only when feature flag -> otherwise unsupported
```

Never silently fall back from deterministic control to model prompt.

## OMP upgrade while Studio is running

Existing live processes keep their negotiated snapshot. New processes probe the newly installed binary. Studio should display mixed-version runtime status if old processes remain alive.

## Config write failure

Do not partially replace target files. Keep original intact, return validation/permission/conflict details, and leave generated preview available for copy/export.

## WebSocket disconnect

Client reconnects with `{hostEpoch, afterSeq}`. The command continues while the
client is absent and its result is available through the ledger. Journal gaps
or epoch mismatch return `resync_required`; the client loads an atomic fresh
snapshot. OMP process continues independently of UI connectivity.

## Writer or Preview failure

Writer takeover first revokes the old fencing revision and terminates the old
runtime tree, then grants a new lease. Preview crash/stop destroys its isolated
partition and dev-server tree without affecting the OMP runtime. Repeated crash
loops use bounded retries and enter quarantine instead of restarting forever.

## Companion mismatch

Disable companion-only routes and recompute capability snapshot. Core RPC runtime remains usable.

## Collab adapter failure

Never affect the authoritative OMP session. Experimental adapter failure only removes its fallback control capabilities.
