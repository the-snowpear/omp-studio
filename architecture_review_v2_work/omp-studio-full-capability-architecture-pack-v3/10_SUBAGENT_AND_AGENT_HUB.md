# Subagents and Agent Hub

## What OMP already has

OMP task/subagent runtime includes:

- batch fan-out,
- per-spawn agent type and effort,
- blocking/background execution,
- session-scoped concurrency limits,
- isolated workspace modes and patch/branch merge,
- structured output,
- recursion/spawn policy,
- per-subagent transcript/artifacts,
- runtime statuses `running | idle | parked | aborted`,
- parking and revival,
- peer messaging via `hub`,
- background job cancellation.

Studio must preserve these semantics rather than building its own scheduler.

## Native RPC coverage today

Good observation surface:

```text
set_subagent_subscription
get_subagents
get_subagent_messages
subagent_lifecycle
subagent_progress
subagent_event
```

This is sufficient for a rich Agent Hub table/tree, progress stream and transcript viewer.

## Native RPC gap

Current RPC command surface does not provide first-class deterministic commands equivalent to the TUI Agent Hub's richer control plane, such as:

- message/chat with a specific subagent,
- kill/cancel a specific agent/job,
- revive a parked agent,
- explicit release,
- deterministic spawn from the UI.

## Does the CLI/TUI actually have these controls?

Yes. OMP's task documentation describes `hub` cancellation and revival semantics. OMP collaboration documentation explicitly states that a full-control guest can use the host Agent Hub for live progress, chat, kill, revive and transcript viewing. The guest-to-host protocol includes an `agent-cmd` frame for hub chat/kill/revive.

Therefore the missing Studio capability is primarily **transport exposure**, not missing OMP harness behavior.

## Studio control strategy

### Tier 1: native RPC observation

Always use native subagent RPC frames for list/progress/lifecycle/transcript.

### Tier 2: proposed native RPC control

Preferred long-term commands:

```text
agent_command
  action: message | kill | revive | release

spawn_agent
get_agent_definitions
get_async_jobs
cancel_async_job
```

See `21_UPSTREAM_RPC_PROPOSALS.md`.

### Tier 3: Companion Extension

Temporary supported fallback for chat/kill/revive if exact-version-compatible internal APIs are accessible.

### Tier 4: Experimental Collab Adapter

The existing `agent-cmd` path proves a direct control transport exists. Studio may experimentally reuse it only behind a feature flag and only until a native RPC path lands.

## Do not use prompts for Agent Hub buttons

Never implement:

```text
[Kill reviewer] -> prompt main model "kill reviewer"
```

The UI action must have deterministic acknowledgement and error semantics.

## UI state model

```ts
type AgentStatus = "running" | "idle" | "parked" | "aborted";

interface AgentControlCapabilities {
  canMessage: boolean;
  canKill: boolean;
  canRevive: boolean;
  canReadTranscript: boolean;
  canRelease: boolean;
  routeByAction: Record<string, string>;
}
```

An isolated completed agent may be parked but not revivable; Studio must reflect OMP's actual per-agent lifecycle capability rather than showing a universal Revive button.
