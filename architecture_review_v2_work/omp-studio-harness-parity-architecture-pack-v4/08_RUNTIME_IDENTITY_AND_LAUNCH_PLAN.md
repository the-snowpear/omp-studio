# Runtime Identity and Launch Plan

## 1. Identity domains

Studio identity and OMP identity are separate domains.

| Public Studio identity | Private Gateway binding |
|---|---|
| `EnvironmentId` | Host authority and execution trust boundary |
| `ProjectId` | canonical project path |
| `WorkspaceId` | canonical checkout/worktree path |
| `ThreadId` | OMP session ID/session file |
| `RuntimeId` + `runtimeEpoch` | SDK object or contained RPC process |
| `SessionBindingId` | complete mapping above |

Public IDs are random opaque handles. URLs and renderer messages never contain
an OMP session path, workspace path, PID, SDK object identity, or raw session
file selector.

## 2. SessionBinding

A durable `SessionBinding` joins one Studio Thread to an opaque OMP session
handle. `RuntimeSessionBinding` is its Host-private operational expansion,
joining that Thread to one OMP session and one live-or-suspended runtime
generation.

Required invariants:

- exactly one active binding per Thread,
- exactly one Environment and Host authority per binding,
- exactly one backend per runtime epoch,
- an OMP runtime/session pair cannot be bound to two Threads,
- binding resolution always checks principal/project authorization,
- changing backend or OMP process creates a new runtime epoch,
- changing the underlying OMP session increments `bindingRevision`,
- stale command/event epochs cannot mutate the new projection.

OMP session IDs and paths are stored as private `OmpSessionLocator` values. A
client may request “new”, “resume this Thread”, “branch”, or “handoff”; it may
not submit an arbitrary session file path to a generic Host endpoint.

## 3. RuntimeLaunchPlan

Every launch is driven by an immutable, schema-validated
`RuntimeLaunchPlan`. The plan is persisted after secret redaction and hashed.
The running handle reports the same `planId` and `planHash`.

The plan contains:

### Build and backend

- exact executable or SDK package resolution,
- OMP version, build ID/commit when available,
- backend `sdk` or `rpc-ui`,
- protocol requirement and allowed compatibility profile,
- expected Companion protocol/build guard.

### Scope and session intent

- environment/project/workspace/thread opaque IDs,
- canonical paths held only in the Host plan,
- writer mode and lease/fencing requirement,
- `new | resume | switch | branch | handoff` intent,
- private OMP session locator resolved by the Gateway.

### Configuration provenance

The plan records final values **and their source**:

```text
schema-default | host-default | global | project |
config-overlay | runtime-override | session-entry
```

At minimum it captures all behavior-affecting settings for:

- task isolation/apply/merge/commits, eager, batch, concurrency, recursion,
  runtime limits, idle TTL, disabled agents, model/prewalk overrides,
- advisor enabled/subagents/backlog/immune turns,
- memory backend,
- provider-family, subagent, and advisor service tiers,
- async enablement, max jobs, and poll duration,
- bash enablement and auto-background enablement/threshold,
- model, thinking, fast mode, approval mode, and tool restrictions.

The verified OMP baseline applies common RPC/ACP host defaults only to the
selected task paths, memory, advisor, and `tier.advisor`. RPC additionally
host-defaults async enable/max-jobs and bash auto-background enable/threshold.
The plan must record whether each host default actually applied; it must not
infer coverage from mode alone.

### Extensibility and resources

- effective extension, skill, agent, hook, custom-tool, and MCP roots,
- configured versus loaded inventory and load errors,
- Host Tools/URI schemes and their bound scopes,
- Companion introspection enablement,
- redacted environment references,
- process/resource containment policy.

## 4. ACP and cross-cwd planning

ACP can host multiple sessions with distinct cwd values. OMP clones settings
for the requested cwd. Therefore a launch plan for ACP is process-level plus a
separate per-session resolved plan.

Compatibility CI must specifically verify that a host-default runtime override
created in the process launch cwd does not incorrectly shadow an explicit
project setting in a later ACP session cwd. Until proven, Studio must display
the effective value returned by the runtime and its provenance rather than
claiming project precedence.

## 5. Plan construction

```text
resolve opaque scope
  -> canonicalize Host-only paths
  -> identify OMP build/backend
  -> load global + project + overlays
  -> apply explicit Studio runtime overrides
  -> compute host defaults only for still-unconfigured paths
  -> resolve model/roles/tier/auth availability
  -> resolve extension/MCP inventory
  -> validate writer/process/security requirements
  -> redact secrets
  -> canonical serialize and hash
```

No environment variable or CLI flag may silently change the effective plan
after hashing. A permitted runtime setting change creates a plan amendment with
its own revision and declared effect: immediate, reload, new session, or new
process.

## 6. Recovery

- Host-authority restart creates a new `authorityEpoch` and revalidates bindings.
- Runtime restart creates a new `runtimeEpoch` but retains the Thread ID.
- Resume re-resolves the OMP session locator through supported APIs.
- If the stored build or settings provenance no longer matches, the binding is
  `needs-rebind`; the Gateway does not guess.
- A stale capability snapshot or command must fail with `stale_epoch`.
- Migration between SDK and RPC is explicit and auditable.

## 7. Diagnostics

The UI may show redacted launch diagnostics:

- OMP version/build/backend,
- plan and binding revision,
- effective setting value/source,
- loaded extension/MCP status,
- capability and Slash manifest hashes,
- compatibility profile and outstanding Capability Debt.

It must never show raw credentials or make private session paths usable as API
handles.
