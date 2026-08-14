# OMP Integration Channels

## Channel A: Native RPC UI v2

Command:

```bash
omp --mode rpc-ui
```

Use for all live-session work whenever possible.

Best coverage:

- prompt, steer, follow-up, abort, abort-and-prompt,
- state, model, thinking, fast mode,
- queue modes,
- compact and auto-compaction,
- retry control,
- bash and bash abort,
- session stats/export/switch/branch/handoff/history,
- login provider discovery/login,
- Extension UI requests,
- Host Tools and Host URI schemes,
- subagent lifecycle/progress/full events/transcript reads,
- command metadata and local command side channels.

Properties:

- authoritative for active runtime state,
- structured,
- bidirectional,
- supports v2 chunking,
- preserves real CLI harness semantics.

## Channel B: Deterministic Slash Command over RPC

RPC prompt handling can execute local-only slash commands. OMP emits command output/config update side channels and can report that no model agent turn was invoked.

Use when OMP already owns a deterministic slash command but lacks a dedicated RPC command.

Candidate feature families:

- Advisor runtime controls/status,
- MCP interactive operations/reauth,
- plugin reload,
- some session/admin commands,
- future commands discovered by `get_available_commands`.

Rules:

- only invoke a slash command that was discovered and identified as local/deterministic,
- never use arbitrary natural-language prompts for control,
- render rpc-ui elicitation requests when the command requires selection/input,
- correlate command execution by request id and command_output/config_update frames.

## Channel C: OMP CLI

Use separate short-lived processes for machine/admin operations that are not tied to the active session process.

Preferred examples:

- `omp config list/get/set/reset --json`,
- `omp config path`,
- `omp models ... --json`,
- `omp auth-broker list/status/... --json` where applicable,
- version/update/diagnostic commands when OMP exposes them.

Do not use a second CLI process to manipulate active session state.

## Channel D: Schema-aware Native Files

Some OMP-native capabilities are intentionally file-defined.

Examples:

- `<project>/.omp/config.yml`,
- `~/.omp/agent/models.yml`,
- project/user `mcp.json`,
- `.omp/agents/*.md`,
- Skills directories,
- extension/hook/custom-tool files.

Requirements:

- parse with a comment-preserving YAML/JSON representation where practical,
- validate against OMP schema or an OMP subprocess before commit,
- atomic temp-file + fsync + rename writes,
- create backup/undo metadata,
- never write secrets into project files unless user explicitly chooses that source,
- watch for external edits and merge/reload safely.

## Channel E: OMP Studio Companion Extension

Optional exact-version-compatible bridge for OMP capabilities that exist internally but lack a public RPC control surface.

Routes implemented only through private OMP imports are always `experimental`;
the existence of an internal method is not a supported extension contract.

This is not a second harness. It runs inside the real OMP process and exposes only narrow structured operations.

Candidate uses:

- Agent Hub kill/revive/chat/release before native RPC lands,
- exact resolved agent/skill/plugin/hook/tool discovery,
- structured Advisor stats when no dedicated RPC exists,
- capability diagnostics.

Communication should use deterministic extension slash commands + machine-readable command output, or another explicitly supported extension-to-host mechanism. Do not invent a model-mediated protocol.

## Channel F: Collab Adapter (Experimental)

OMP's collaboration system already transports session state plus Agent Hub commands. Full-control guests can prompt/abort and issue agent commands for chat/kill/revive/transcript.

This demonstrates that these controls exist in OMP internally.

Studio may implement an experimental adapter only if necessary before native RPC/companion coverage exists.

Constraints:

- feature flag off by default,
- never require public relay for local Studio use,
- do not make private Collab frames part of Studio's stable API,
- treat as replaceable compatibility code,
- remove once native RPC provides the equivalent.

## ACP

ACP is a compatibility surface for third-party editors, not OMP Studio's primary backend.

Studio may optionally expose or test ACP compatibility, but should not route first-party capabilities through ACP when native OMP surfaces are richer.
