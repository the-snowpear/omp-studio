# State and Data Ownership

| Domain | Source of truth | Studio persistence |
|---|---|---|
| Active messages/turn/tool state | OMP runtime/RPC | event journal/cache only |
| Subagent lifecycle/progress | OMP runtime/RPC | projection/cache only |
| Agent Hub control capability | OMP runtime | capability route metadata |
| Session history | OMP session files + RPC | read-only index/metadata |
| Files | filesystem | no duplicate authoritative copy |
| Diff/status | Git + filesystem | derived cache |
| OMP global settings | `config.yml` / OMP config CLI | no duplicate |
| OMP project settings | `.omp/config.yml` | no duplicate |
| Providers/custom models | `models.yml` | Studio-only notes may be separate |
| MCP definitions | OMP `mcp.json` | no duplicate |
| Credentials | OMP auth store/broker/env | status/masked metadata only |
| Host auth session/bootstrap code | Studio Host security store | short-lived, Host-only |
| Opaque ID mapping | Studio Host DB | authoritative mapping; paths remain private |
| Command ledger | Studio Host DB | Studio intent/transport outcome, not OMP live truth |
| Event journal | Studio Host replay buffer | epoch-scoped cache, not OMP live truth |
| Projection snapshot | derived from journal/runtime | replaceable cache |
| Workspace writer lease/fencing | Studio Host coordinator | authoritative coordination state |
| Process tree ownership | Studio Host supervisor / OS | runtime-only ownership state |
| Studio layout/pins/read markers | Studio DB | authoritative |
| Preview process/browser | Studio Host | optional restart metadata |

## Forbidden writes

Studio must not directly mutate:

- active OMP session JSONL,
- `agent.db`,
- process-global AgentRegistry,
- subagent transcript artifacts as a control mechanism.

## Session files

May be indexed read-only for offline history and search. Live state always wins over file snapshots.

## Artifact files

May be read when OMP documents them as artifacts/transcripts. Treat them as outputs, not a writable control API.

Host restart creates a new `hostEpoch`; OMP process restart creates a new
`runtimeEpoch`. Neither the journal nor command ledger becomes an alternative
source of live OMP state.
