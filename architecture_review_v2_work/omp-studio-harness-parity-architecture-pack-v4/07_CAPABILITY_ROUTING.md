# Capability Routing

## 1. Capability is scoped evidence

A capability is not a global boolean. It is an evaluated statement about:

```text
principal + resource scope + runtime epoch + surface + route + evidence
```

The same OMP build can support observation on one runtime, deny control on
another, and require a writer lease for a third. Capability snapshots are never
reused across `SessionBinding`, `runtimeEpoch`, or authorization revision.

The contract deliberately separates three structures:

1. `CapabilityDescriptor`: stable product semantics such as authority, effect
   timing, determinism, scope, risk, reversibility, idempotency, concurrency and
   completion policy.
2. `CapabilityRoute`: one adapter implementation, including channel,
   runtime-affinity, stability, build guard and evidence.
3. `ResolvedCapability`: current support, authorization, readiness, selected
   routes and disabled reason for one exact scope/epoch.

Dynamic availability must not be stored in the static descriptor or route.

## 2. Resolution pipeline

Every invocation follows this order:

1. authenticate the Host client,
2. resolve opaque Studio IDs to an authorized `SessionBinding`,
3. verify project/workspace/thread/runtime scope,
4. verify runtime epoch and required control/writer lease,
5. resolve a semantics-preserving route,
6. create a command-ledger entry for mutations,
7. invoke through `OmpRuntimeGateway`,
8. normalize result/events and update the scoped snapshot.

The UI-provided channel, OMP session path, process ID, and capability grade are
never trusted inputs.

## 3. Route classes and priority

Routes are chosen per capability surface, not by a universal adapter order.

| Route | Intended use | Grade ceiling |
|---|---|---|
| SDK public API | Real embedded Harness semantics exposed by supported exports | `native` |
| RPC UI | Public active-session command/event protocol | `native` |
| Deterministic Slash Manifest entry | Local OMP command with explicit completion semantics | `supported-fallback` |
| Config CLI/native file | OMP-owned persistent configuration | `supported-fallback` |
| Studio Host | Preview, workspace, Git, terminal and other Studio-owned resources | `native` for Studio capability |
| Companion introspection | Effective inventory and diagnostics | `supported-fallback` when public-extension-only |
| Companion private control | Exact-build temporary bridge | `experimental-exact-build` |
| Collab adapter | Research/temporary compatibility | `experimental` |

An adapter failure never means “try the next row.” Fallback is allowed only
when the capability declaration lists the alternate route and compatibility CI
proves equivalent success, error, cancellation, and lifecycle semantics.

## 4. Verified subagent routing baseline

Against OMP commit `45e12e5`:

| Capability | Public deterministic route | Result |
|---|---|---|
| `subagent.lifecycle.observe` | RPC subscription | Native |
| `subagent.progress.observe` | RPC subscription | Native |
| `subagent.event.observe` | RPC `events` subscription | Native |
| `subagent.list.observe` | RPC `get_subagents` | Native |
| `subagent.transcript.observe` | RPC `get_subagent_messages` | Native |
| `subagent.spawn.control` | No public RPC command or stable SDK Hub API | Capability Debt |
| `subagent.message.control` | No public RPC command or stable SDK Hub API | Capability Debt |
| `subagent.kill.control` | TUI/Collab/internal lifecycle exists; no public RPC/SDK control | Capability Debt |
| `subagent.revive.control` | TUI/Collab/internal lifecycle exists; no public RPC/SDK control | Capability Debt |
| `subagent.release.control` | Internal lifecycle exists; no independent public route | Capability Debt |
| `asyncJob.cancel.control` | Model-facing `hub cancel` exists; no public RPC/SDK Host command | Capability Debt |

The existence of `task`, `hub`, Agent Hub UI, or Collab `agent-cmd` proves
Harness behavior, not a Studio route. Natural-language prompting is not an
acceptable deterministic control fallback.

## 5. SDK backend rules

The SDK backend is selected at runtime launch, not as a per-call escape hatch.
Only published and compatibility-tested exports are eligible for `native`.

- `createAgentSession()` preserves OMP session/tool behavior.
- Studio may observe events provided through supported SDK callbacks.
- Unexported registry/lifecycle imports are private ABI.
- Model-facing tools are not automatically Host APIs.
- Direct invocation of a tool is acceptable only when the public SDK defines a
  supported, authorization-preserving invocation surface and CI proves parity.

## 6. Slash routing rules

A slash route is eligible only when its `SlashManifestEntry` states:

```text
semanticKind = local-deterministic
completion is explicit
scope and risk tier are known
build guard matches
compatibility tests pass
```

`get_available_commands` alone yields `discovered`, not `routable`. Commands
that invoke the model, depend on a TUI-only component, or have ambiguous
completion remain UI escape hatches rather than capability routes.

## 7. Capability Debt

Every desired surface without an approved route creates a durable
`CapabilityDebtItem`. It records:

- capability and scope,
- observed Harness evidence,
- missing public transport/API,
- temporary experimental route, if any,
- exact upstream proposal or patch needed,
- owner, target milestone, compatibility tests, and removal condition.

Debt is not a generic “unsupported” note. It is versioned with the capability
snapshot and emitted by compatibility CI. A temporary Companion/Collab route
does not close the debt; only a stable public route plus parity tests does.

## 8. Snapshot semantics

A `CapabilitySnapshot` contains both support and current invocability:

- `supported`: compatible route exists for this build,
- `authorized`: principal may use it for the exact scope,
- `ready`: epoch, lease, runtime state, and approvals allow invocation now.

Diagnostics must distinguish:

```text
unsupported API
build mismatch
unauthorized
approval required
control lease required
writer lease required
runtime busy
stale epoch
temporary route disabled
```

Capability and Slash manifests have content hashes. Any change invalidates the
route cache and triggers a new snapshot.
