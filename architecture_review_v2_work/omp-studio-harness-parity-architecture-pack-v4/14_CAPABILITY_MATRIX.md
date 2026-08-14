# OMP Capability Matrix Baseline

This table is an architecture baseline for OMP commit
`45e12e5bb758198a920c6070e7e64cb33b21beac`. It must become a generated CI
artifact. `yes` means direct structured support; `partial` means observation or
indirect behavior only; `no` means no stable public control surface.

| Capability | Harness | Native RPC | Recommended Studio route | Stable fallback | Product status |
|---|---|---|---|---|---|
| Prompt/steer/follow-up/abort | yes | yes | RPC | none | stable |
| Streaming text/thinking/tool args | yes | yes | RPC ephemeral stream | none | stable |
| Session state/history/stats | yes | yes | RPC paging | read-only native file for recovery only | stable |
| Branch/handoff/export | yes | yes | RPC | none | stable |
| Models/thinking/fast | yes | yes | RPC | CLI/config for administration | stable |
| Provider login/status | yes | partial | RPC plus official CLI/config | none | stable with route split |
| Roles/fallback chains | yes | partial | OMP config | versioned introspection | stable configuration |
| Advisor runtime control/stats | yes | no dedicated API | allowlisted Slash/config | none | degraded |
| Compaction/retry/queue modes | yes | yes | RPC | config | stable |
| Tool lifecycle | yes | yes | RPC observation | none | stable |
| Extension UI | yes | yes for standard methods | rpc-ui | arbitrary TUI unsupported | stable subset |
| Host Tools/Host URI | yes | yes | RPC | none | stable |
| Available command discovery | yes | yes | RPC discovery + static manifest | none | stable discovery only |
| Subagent lifecycle/progress/events | yes | yes | RPC | none | stable observation |
| Subagent list/transcript | yes | yes | RPC | constrained read-only file recovery | stable observation |
| Subagent message/kill/revive | yes | no | wait for `agent_command` RPC | Collab/private Companion prohibited by default | unavailable stable control |
| Manual Subagent spawn | yes through Harness | no direct API | wait for structured RPC | model-mediated `task` remains OMP-owned | unavailable stable control |
| Async job list/cancel | yes | no structured API | wait for `list_jobs/cancel_job` | textual command for diagnostics only | unavailable stable control |
| Skills/plugins/agents effective inventory | yes | partial | public discovery/config | Companion introspection if versioned | degraded |
| MCP inventory/status/control | yes | partial | config + safe RPC/Slash subset | Companion introspection | degraded |
| Memory/TTSR | yes | partial | config + observed runtime effects | allowlisted status commands | degraded |
| LSP/DAP/browser/computer | yes when enabled | tool events only | OMP owns invocation; Studio observes | no generic invoke-tool fallback | stable observation only |
| OMP Context Checkpoint/rewind | yes when enabled | no direct command | wait for structured RPC | OMP Agent tool use | degraded |
| Studio Workspace Snapshot | not OMP | n/a | WorkspaceGateway | Git/filesystem implementation | Studio capability |
| GUI Terminal/PTY | not OMP | n/a | TerminalGateway | none | Studio high-risk capability |
| Preview | not OMP | n/a | PreviewGateway | Host Tool bridge for model access | Studio high-risk capability |

## Channel exposure reference

Legend: `Y` direct structured support, `P` partial/indirect, `-` absent. Slash
availability remains build/manifest dependent. `Effect` is the earliest normal
effect point: immediate, next-turn, next-session, or restart.

| Capability | Harness | RPC | Slash | CLI | Config | Extension | Collab | Recommended | Risk | Effect |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| Models | Y | Y | P | Y | Y | P | - | RPC; CLI/config for admin | low | immediate/session |
| Providers/Auth | Y | P | P | Y | Y | P | - | RPC login/status + official admin surfaces | medium | immediate/session |
| Roles | Y | P | - | Y | Y | P | - | OMP config | low | turn/session |
| Thinking | Y | Y | P | P | Y | - | - | RPC | low | immediate |
| Fast | Y | Y | P | P | Y | - | - | RPC | low | immediate |
| Fallback chains | Y | P | - | Y | Y | P | - | OMP config | medium | turn/session |
| Advisor | Y | - | P | P | Y | P | - | Config + allowlisted Slash | medium | turn/session |
| Subagent observe | Y | Y | - | - | Y | P | P | RPC | low | immediate |
| Subagent transcript | Y | Y | - | - | - | P | Y | RPC | medium | immediate |
| Agent message | Y | - | - | - | - | private | P | wait for `agent_command` | high | immediate |
| Agent kill/revive | Y | - | - | - | - | private | P | wait for `agent_command` | high | immediate |
| Manual spawn | Y | - | model-mediated | - | Y | private | - | wait for structured RPC | high | immediate |
| Async jobs | Y | P | P | - | Y | P | - | RPC observation; wait for list/cancel | high | immediate |
| Skills | Y | P | Y | P | Y | P | - | OMP files/config + RPC command view | medium | session/restart |
| Plugins/hooks | Y | P | P | P | Y | P | - | OMP config/files | medium | session/restart |
| MCP | Y | P | P | P | Y | P | - | OMP config + safe structured subset | medium | turn/session |
| Memory | Y | - | P | P | Y | P | - | OMP config | medium | turn/session |
| LSP | Y | P | P | P | Y | P | - | OMP owns invocation; Studio observes | medium | immediate/session |
| DAP | Y | P | P | P | Y | P | - | OMP owns invocation; Studio observes | high | immediate/session |
| Browser | Y | P | P | P | Y | P | - | RPC tool events | high | immediate/session |
| Computer | Y | P | P | P | Y | P | - | RPC + OMP approval | high | immediate/session |
| TTSR | Y | P | - | P | Y | P | - | Config + observed runtime effects | medium | turn/session |
| Compaction | Y | Y | P | P | Y | - | - | RPC | low | immediate |
| Retry | Y | Y | P | P | Y | - | - | RPC | low | immediate |
| Session/history | Y | Y | P | Y | Y | P | Y | RPC paging | medium | immediate |
| Branch | Y | Y | P | P | - | - | - | RPC | medium | immediate |
| Handoff | Y | Y | P | P | - | - | - | RPC | medium | immediate |
| OMP checkpoint | Y | P | - | P | Y | P | - | wait for structured RPC | high | immediate |
| Tool lifecycle | Y | Y | P | P | Y | Y | P | RPC observation | high | immediate |
| Approvals | Y | Y | P | - | Y | Y | P | RPC/Extension UI | high | immediate |
| Extension UI | Y | Y | - | - | - | Y | P | rpc-ui standard subset | medium | immediate |
| Host Tools | Y | Y | - | - | - | Y | - | RPC | high | next-turn |
| Host URI | Y | Y | - | - | - | Y | - | RPC | medium | immediate |
| GUI Terminal/PTY | not OMP | - | - | - | - | - | - | Studio TerminalGateway | critical | immediate |
| Preview | not OMP | - | - | - | - | - | - | Studio PreviewGateway | high | immediate |

This table distinguishes Harness behavior from Host-controllable protocol
exposure. A `P` cell never authorizes the CapabilityRouter to claim stable
control without route-specific compatibility evidence.

## Required upstream RPC priorities

P0:

- `get_capabilities` with build/protocol/schema/stability information;
- `agent_command` for message/kill/revive/release with generation fencing;
- `list_jobs` and owner-scoped idempotent `cancel_job`;
- structured Slash metadata;
- explicit runtime settled/quiescent semantics.

P1:

- structured `spawn_subagent` with owner/workspace/isolation semantics;
- advisor state/control/stats;
- agents/skills/plugins/MCP/effective-config inventory with provenance;
- schema-aware config CRUD;
- logout/account and model-role CRUD;
- direct context checkpoint/list/rewind.

P2:

- structured LSP/DAP/browser diagnostics;
- richer runtime telemetry and inventory-change notifications;
- schema bundle generation.

Do not request a generic invoke-any-tool API as a parity shortcut; it bypasses
OMP scheduling, context, and approval semantics.
