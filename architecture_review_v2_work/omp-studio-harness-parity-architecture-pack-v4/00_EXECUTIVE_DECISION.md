# Executive Architecture Decision

## Decision

Adopt a domain-first Studio Host with an internal OMP compatibility gateway.
Do not place `CapabilityBroker` at the center of the product architecture.

```text
Clients
  -> Studio Host Protocol
  -> Application Services and Studio Domain
  -> Read Models / Command Ledger / Publication
  -> OmpRuntimeGateway
  -> CapabilityRouter
  -> RPC / Slash / CLI / Config / Companion / Collab
  -> installed OMP
```

`CapabilityRouter` remains important, but only as an internal mechanism that
selects the safest available implementation of a stable Studio capability.

## Why

Channel-centered architecture leaks compatibility mechanics into product state,
tests, UI, and long-term terminology. It also encourages feature claims based
on theoretical fallbacks rather than stable runtime control.

Domain-first architecture lets the Studio API remain stable while OMP removes
RPC gaps over time. When an upstream RPC replaces a fallback, only the gateway
route changes.

## Guardrail against a second OMP

Domain-first does not mean reimplementing OMP:

- OMP remains authoritative for conversation, model execution, tool execution,
  approval semantics, context, compaction, retry, subagents, and async jobs.
- Studio stores projections, opaque identity bindings, command outcomes, UI
  metadata, workspace/Git state, security state, and diagnostics.
- OMP raw events may be retained temporarily for diagnostics, but Studio does
  not invent missing OMP lifecycle transitions.
- A projection marked `unknown` or `interrupted` is preferable to fabricating a
  successful or terminal state.

## Principal consequences

1. Introduce `Environment`, `HostAuthority`, `WorkspaceBinding`, and
   `SessionBinding` in the first implementation.
2. Give each live Thread one `OmpRuntimeActor` that exclusively owns the OMP
   process and protocol stream.
3. Split durable semantic commits from high-rate ephemeral streams.
4. Use a Host-authority `commitSeq` for durable state, per-runtime
   `runtimeEpoch`, and per-stream `streamSeq`.
5. Make client queues byte bounded and capability aware.
6. Use typed awaited receipts for coordination; never depend on a global
   production receipt pub/sub bus.
7. Treat worktrees as a foundational workspace mode, even if the first release
   defaults to one writer on the canonical checkout.
8. Generate capability claims from compatibility tests against real OMP builds.
9. Quarantine private or unverified routes automatically.

## Immediate product capability boundary

Stable now:

- streaming conversation and thinking;
- prompt/steer/follow-up/abort;
- session history, branch, handoff, model, thinking, fast, compaction and retry;
- Extension UI, Host Tools and Host URI;
- Subagent lifecycle/progress/events/list/transcript observation.

Not stable for product controls yet:

- direct Subagent message, kill, revive, release, or manual spawn;
- structured async-job list and cancellation;
- complete effective agents/skills/plugins/MCP/config inventory.

Harness support for an operation does not imply public RPC exposure. Studio may
show an unavailable control with an upstream requirement, but must not silently
turn a private import into a supported product path.

