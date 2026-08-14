# OMP Runtime Gateway

## 1. Purpose

`OmpRuntimeGateway` is the only Host boundary allowed to create, attach to, or
control a live OMP Harness runtime. React, HTTP handlers, Preview, config
editors, and compatibility adapters never import OMP runtime objects or emit
raw OMP frames directly.

The Gateway preserves one rule:

> OMP owns agent, tool, session, task, advisor, memory, and async-job semantics.
> Studio owns identity, authorization, process containment, projections, and
> compatibility diagnostics.

The verified upstream baseline for this contract is
`can1357/oh-my-pi@45e12e5bb758198a920c6070e7e64cb33b21beac`.

## 2. Runtime backends

### 2.1 SDK backend

The SDK backend embeds the published OMP coding-agent SDK and calls its public
session construction surface, including `createAgentSession()`. It is a
first-class backend, not a reimplementation of the Harness.

Use it when all of the following are true:

- the installed SDK build passed the compatibility suite,
- the Host can provide an isolated `Settings` instance and resource owners,
- the required extensions, MCP servers, and session storage can be scoped to
  one `SessionBinding`,
- no adapter imports unexported `AgentRegistry` or `AgentLifecycleManager`
  modules.

At the verified baseline, the SDK can create the real session and preserves
task/async-job semantics. The package root does not expose a stable named-agent
Hub control API. Therefore SDK embedding alone does **not** prove deterministic
Studio routes for subagent message, kill, revive, release, or job cancellation.
Those remain capability probes or Capability Debt.

### 2.2 RPC backend

The RPC backend owns one contained `omp --mode rpc-ui` process per active
Thread. It negotiates protocol v2 and uses the public RPC command/event surface.

At the verified baseline, native RPC provides:

- prompt, steer, follow-up, abort, model/thinking/fast and session commands,
- Host Tools and Host URI schemes,
- subagent subscription levels `off | progress | events`,
- `subagent_lifecycle`, `subagent_progress`, and full `subagent_event` frames,
- `get_subagents`,
- incremental `get_subagent_messages` transcript reads.

It does not provide native commands for subagent spawn, message, kill, revive,
release, or async-job cancellation. The Gateway must not synthesize those
buttons by sending a natural-language prompt.

### 2.3 Backend selection

Backend selection is part of `RuntimeLaunchPlan` and immutable for a
`runtimeEpoch`. A live session never silently falls from SDK to RPC or RPC to
SDK after an operation fails.

Changing backend requires an explicit migration:

1. stop accepting mutations,
2. settle or mark in-flight commands `outcome_unknown`,
3. flush through supported OMP session APIs,
4. terminate/dispose the old runtime,
5. create a new `runtimeEpoch`,
6. attach through a new `SessionBinding`,
7. reprobe capabilities and rebuild projections.

CLI/config/file adapters are administrative channels. They must not manipulate
active session state behind the owning runtime.

## 3. Gateway interface

```ts
interface OmpRuntimeGateway {
  launch(plan: RuntimeLaunchPlan): Promise<RuntimeHandle>;
  attach(binding: RuntimeSessionBinding): Promise<RuntimeHandle>;
  inspect(bindingId: SessionBindingId): Promise<RuntimeSnapshot>;
  invoke(request: RuntimeInvocation): Promise<RuntimeDispatchReceipt>;
  stop(bindingId: SessionBindingId, reason: RuntimeStopReason): Promise<void>;
  dispose(): Promise<void>;
}
```

Every mutation must include an opaque Studio command ID, exact Environment and
resource scope,
expected runtime epoch, and authorization context supplied by the Host. Backend
responses are normalized into command-ledger transitions, runtime observations,
and only where Studio owns the fact, durable domain events.

Raw SDK objects, RPC session paths, OMP session IDs, process IDs, and extension
objects never cross the Gateway boundary.

## 4. Startup sequence

```text
validate RuntimeLaunchPlan and planHash
  -> resolve exact OMP build identity
  -> acquire workspace writer lease when required
  -> create process/resource containment domain
  -> create SDK session OR spawn RPC process
  -> bind the OMP session to opaque Studio identities
  -> negotiate/probe the selected backend
  -> load Companion introspection when explicitly enabled
  -> collect Slash Manifest
  -> build scoped CapabilitySnapshot and Capability Debt
  -> publish an atomic RuntimeSnapshot
```

Startup fails closed when the executable/package identity, settings provenance,
session binding, or required compatibility probes do not match the plan.

## 5. Companion introspection

The Companion is optional, exact-build-compatible code running inside the same
OMP runtime. Its default role in v4 is **introspection**, not a second control
plane.

The Companion may report a versioned, machine-readable manifest for:

- effective agent definitions and sources,
- loaded skills/plugins/extensions/hooks/custom tools,
- available slash commands and their semantic classification,
- advisor/memory/async status that public surfaces cannot describe,
- public-versus-private API availability and build guards.

Required handshake fields are:

```text
protocol, companionVersion, ompCommit/buildId, capabilities,
privateAbiUsed, manifestHash
```

If the build identity mismatches, the Gateway disables all Companion routes and
continues with public SDK/RPC capabilities. Private imports are never graded as
native or supported fallback. A control route backed by a private import must
be exact-build guarded, explicitly enabled, marked `experimental-exact-build`,
and represented in Capability Debt until a public upstream API replaces it.

## 6. Slash Manifest

`get_available_commands` proves command discovery, not semantics. The Gateway
builds a `SlashManifest` by combining native metadata with Companion
introspection or an audited built-in table for the exact OMP build.

Each entry declares:

- canonical name, aliases, source, and input shape,
- whether it is local/deterministic or model-dispatched,
- side-effect class and required scope,
- completion signal (`prompt_result`, `command_output`, `config_update`, or
  another explicit terminal frame),
- whether elicitation is possible,
- build/protocol guard and evidence.

Only entries classified `local-deterministic` may back a Studio control. An
unknown or changed command is diagnostics-only until compatibility CI approves
its manifest.

## 7. Failure rules

- Backend crash creates a new runtime epoch on restart.
- Late events from an old epoch are discarded.
- A failed route does not trigger an undeclared channel fallback.
- Capability probes never mutate user state unless the probe is explicitly
  modeled as destructive and runs in an isolated fixture.
- Gateway shutdown disposes the SDK session or the entire RPC process tree and
  releases its writer lease.
- Capability Debt is emitted even when the UI hides unsupported actions.

## 8. Non-goals

- Recreating the Agent loop in Studio.
- Treating ACP parity as Harness parity.
- Using Collab as the normal local runtime backend.
- Importing OMP private stores or editing active session JSONL.
- Claiming a control capability because a TUI button or model-facing tool
  exists somewhere inside OMP.
