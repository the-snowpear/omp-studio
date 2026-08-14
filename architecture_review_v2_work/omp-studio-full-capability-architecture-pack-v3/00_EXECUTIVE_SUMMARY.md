# Executive Summary

## Decision

Build OMP Studio as a first-party graphical surface for the real installed OMP runtime. The product target is **Harness parity**: preserve OMP's own model routing, subagents, Advisor, Skills, Plugins, MCP, tools, LSP/DAP/browser, async jobs, memory, compaction, fallback and session semantics.

“Harness parity” means preserving behavior through verified channels. It does not
mean that every TUI presentation primitive or private runtime control can be
made available in the GUI today. Capability status is always resource-scoped.

Do not force every feature through one protocol.

## Primary architecture

```text
React UI (Web + Desktop shared)
          |
          | HTTP/WS + narrow Desktop bridge
          v
OMP Studio Host
  |
  +-- Capability Broker
  |     +-- RPC UI v2 adapter              [primary runtime]
  |     +-- Slash-command adapter          [deterministic local commands]
  |     +-- OMP CLI adapter                [config/auth/models/admin]
  |     +-- Config/File adapter            [project/native config]
  |     +-- Companion extension adapter    [experimental exact-version bridge]
  |     +-- Collab adapter (experimental)  [rare compatibility fallback]
  |
  +-- Workspace/Git/Terminal/Preview
  +-- Event journal / projections
          |
          v
Real installed OMP CLI / Harness
```

## Channel policy

A missing RPC command does not automatically imply a missing Studio feature. Every feature is described in terms of five surfaces:

- **Execute**: can OMP itself perform the behavior?
- **Observe**: can Studio see state/events/results?
- **Control**: can Studio deterministically trigger/cancel/change it?
- **Configure**: can Studio edit the persistent behavior?
- **Diagnose**: can Studio explain why it is unavailable/broken?

The Capability Broker chooses a channel independently for each surface.

## Priority order

For active runtime operations:

```text
Native RPC > deterministic slash command > companion extension > upstream RPC required
```

For configuration/admin:

```text
OMP CLI with JSON/schema validation > schema-aware native file adapter > slash command
```

For discovery/introspection:

```text
RPC state/commands > machine-readable CLI > companion extension > conservative file scan
```

The experimental Collab adapter is not a general fallback. It exists because OMP's collaboration protocol already exposes Agent Hub chat/kill/revive/transcript operations that current native RPC does not expose. It should be feature-flagged and replaced by native RPC as soon as upstream commands exist.

## Important current gaps in native RPC

Native RPC already covers prompt/steer/follow-up/abort, model/thinking/fast mode, compaction/retry, session/branch/handoff/history, login, extension UI, Host Tools/URIs, and rich subagent observation. `rpc-ui` applies RPC defaults and disables PTY integration, so terminal/TUI parity is a separate surface.

The largest remaining gaps are **management/control surfaces**, including:

- Agent Hub direct chat/kill/revive/release/spawn controls.
- Async background job list/cancel/status as first-class commands.
- Dedicated Advisor status/control/stats commands.
- Agent definition discovery and metadata.
- Structured Skills/Plugins/Hooks/Custom Tools discovery.
- Config/provider/role/fallback CRUD through RPC.
- Credential logout/account management through RPC.
- Collab/share participants/control through RPC.
- Some TUI-only/custom extension UI primitives.
- Dedicated LSP/DAP/browser internal state control beyond ordinary tool events.

These do **not** require reimplementing OMP. Most can be covered today through config, slash commands, files, or a small compatibility extension; important active-session controls should become upstream RPC commands.

## Subagent conclusion

OMP's CLI/TUI Agent Hub is richer than current RPC. OMP documentation states that the Agent Hub can work with live subagents, and its collaboration full-control guest surface can chat with a subagent, kill it, revive it and fetch transcript. The `hub` control path can also cancel background jobs. Therefore the capability exists inside OMP; the missing piece is primarily transport/API exposure, not harness functionality.

Studio strategy:

1. Native RPC for lifecycle/progress/events/transcript observation.
2. Upstream RPC proposal for deterministic `agent_command` operations.
3. Experimental Companion Extension POC for exact-version-compatible direct controls.
4. Experimental Collab adapter only if needed before upstream lands.
5. Never fake Agent Hub behavior with natural-language prompts.

## Non-negotiable rule

**OMP owns the Agent. Studio owns transport selection, observation, desktop/runtime integration, and visualization.**
