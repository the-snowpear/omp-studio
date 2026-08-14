# v3 Changes

This revision turns the v2 review findings into implementation contracts.

## Closed architecture gaps

| Gap | v3 resolution |
|---|---|
| Host auth/bootstrap | Desktop private-IPC bootstrap; Browser one-time pairing; scoped sessions; Origin/Host/CSRF/WS rules. |
| Workspace concurrency | One writer per canonical workspace; separate workspace lease; future isolated worktrees; CAS for external edits. |
| Command lifecycle | Mandatory command ledger, idempotency keys, explicit terminal/ambiguous states and outcome lookup. |
| Snapshot/replay | `hostEpoch + seq`, per-process `runtimeEpoch`, atomic snapshot barrier and `resync_required`. |
| Session/path exposure | Opaque public handles; OMP session paths and subagent files remain Host-only. |
| Preview isolation | Non-persistent sandboxed Electron session, no Node/preload/IPC/Host auth, default-deny permissions/navigation. |
| Windows process tree | Suspended spawn into Job Object with kill-on-close; separate ownership domains; whole-tree stop. |
| Capability negotiation | Scoped snapshots; RPC methods separated from slash commands; pinned-build matrix; upstream `get_capabilities` proposal. |
| Companion risk | Private-import routes downgraded to experimental exact-build POC; trusted path/hash required. |
| Capability truthfulness | Added full GUI implementability matrix and corrected unsupported TUI/Agent Hub/tool-control claims. |

## Accepted MVP decisions

- Local Desktop/WebUI share one authenticated Host, but Renderer/Preview never own the master credential.
- One canonical workspace has at most one write-capable runtime.
- Host-owned terminals terminate with the Host in MVP; persistent terminals are a future explicit opt-in.
- Agent Hub direct control and Collab active-session management are not stable MVP capabilities without upstream RPC.
