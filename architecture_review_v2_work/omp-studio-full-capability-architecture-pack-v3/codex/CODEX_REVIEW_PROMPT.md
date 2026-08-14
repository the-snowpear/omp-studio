# Codex Architecture Review Prompt

You are reviewing the architecture of `the-snowpear/omp-studio`, a new graphical first-party-style client for `can1357/oh-my-pi` (OMP).

Read this entire architecture pack, then verify assumptions against the **current OMP source**, especially:

- `docs/rpc.md` and RPC types,
- task/subagent/Agent Hub code and docs,
- collaboration Agent Hub control path,
- settings/config/model/provider code,
- Skills/Agents/Plugins/Hooks/Tools/MCP discovery,
- Advisor runtime,
- extension UI behavior.

## Goal being reviewed

The product wants **OMP Harness parity**, not ACP parity and not only RPC parity. It is allowed to use multiple channels as long as the real OMP harness remains authoritative.

Proposed channels:

1. native `omp --mode rpc-ui`,
2. deterministic slash commands invoked through RPC,
3. short-lived OMP CLI commands,
4. schema-aware OMP-native config/file editing,
5. optional OMP Studio Companion Extension,
6. experimental Collab adapter for narrow Agent Hub gaps,
7. upstream RPC additions as the long-term solution.

## Review tasks

1. Identify incorrect claims about what current native RPC already exposes.
2. Identify OMP CLI/Harness capabilities omitted from `references/CAPABILITY_CHANNEL_MATRIX.csv`.
3. For every compatibility fallback, judge whether it preserves real OMP semantics.
4. Check whether slash-command-over-RPC is deterministic and safe for the listed use cases.
5. Check whether the Companion Extension can implement proposed Agent Hub/discovery operations through supported public extension APIs. If it would require private imports, identify exact imports/modules and fragility.
6. Inspect Agent Hub/TUI/collab implementation and verify chat/kill/revive/cancel behavior and lifecycle semantics.
7. Decide whether the experimental Collab adapter should exist at all.
8. Propose the smallest native RPC additions that eliminate the most compatibility code.
9. Check config scope handling: global config CLI vs project `.omp/config.yml`, profiles, models.yml, mcp.json, auth.
10. Check whether one active Thread per OMP process is still the correct runtime model.
11. Check security boundaries, especially credentials, project file writes, Host Tools, remote WebUI and companion code.
12. Check WebUI/Desktop parity and reconnect/event-journal design.
13. Check whether any proposed route creates a second source of truth.
14. Separate Harness parity gaps from TUI-presentation-only gaps.
15. Produce a prioritized list: BLOCKER / HIGH / MEDIUM / LOW.

## Required output

Return:

- Executive verdict.
- Architecture strengths.
- Incorrect assumptions with source references.
- Missing OMP capabilities.
- Channel-by-channel risk review.
- Subagent/Agent Hub control verdict.
- Required RPC upstream additions.
- Security issues.
- Simplifications that preserve feature coverage.
- Revised capability matrix entries where necessary.
- Recommended implementation order.

Do not review visual design. Do not propose reimplementing the OMP harness in Studio unless you can prove the real OMP runtime cannot provide the required semantics through any reasonable channel.
