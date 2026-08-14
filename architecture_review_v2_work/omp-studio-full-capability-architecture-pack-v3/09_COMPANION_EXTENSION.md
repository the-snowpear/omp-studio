# OMP Studio Companion Extension

## Purpose

The Companion Extension is an optional, narrow compatibility bridge installed into the **same real OMP runtime**. It exists only for capabilities that:

1. OMP already implements internally,
2. Studio needs deterministic structured control/inspection,
3. public RPC/CLI/config does not expose yet.

It is not an alternative Agent runtime.

If any implementation uses OMP private imports, every such route is graded
`experimental`, never `supported-fallback`, until the exact pinned build passes
its integration suite.

## Candidate feature surface

- Agent Hub chat/kill/revive/release.
- Resolved agent-definition inventory and metadata.
- Resolved Skills/Plugins/Hooks/Custom Tools inventory.
- Advisor runtime stats/state if no structured command exists.
- Selected internal diagnostics needed to explain capability failures.

## Communication model

Preferred temporary protocol:

```text
Studio Host
 -> RPC prompt: /studio <structured subcommand>
 -> OMP extension command handler
 -> command_output with versioned JSON envelope
 -> Studio Host
```

Example envelope:

```json
{
  "protocol": "omp-studio-companion/1",
  "requestId": "...",
  "ok": true,
  "data": {}
}
```

No LLM turn is invoked.

## Installation and detection

- Extension is optional.
- Studio detects its command via `get_available_commands`.
- Studio verifies a trusted absolute extension path/package hash; command
  discovery alone cannot prove that `/studio` was not shadowed by project code.
- Extension reports its own protocol version and OMP compatibility range.
- Studio does not auto-install or modify OMP without explicit user action.

## Internal API risk

Some desired Agent Hub operations may require imports that are not part of OMP's stable extension API.

If private imports are necessary:

- pin exact compatible OMP versions,
- isolate imports in one module,
- refuse to load on mismatch,
- keep fallback disabled rather than guessing,
- upstream the missing RPC promptly.

## Exit strategy

Every companion command must have a tracked replacement condition:

```text
when OMP native RPC gains equivalent command -> prefer RPC -> deprecate bridge command
```
