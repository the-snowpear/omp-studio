# Implementation Plan

## M0A - Contracts and security foundation

- Opaque ID registry and scoped authorization.
- Desktop/WebUI Host bootstrap.
- Command ledger and host/runtime epoch event contracts.
- Workspace single-writer decision and process ownership model.

Exit: auth, IDOR, command/replay and process-containment contract tests pass.

## M0B - RPC compatibility spike

- Pin and fixture the supported OMP commit band.
- Validate rpc-ui start, framing, prompt lifecycle, local-only commands and crash behavior.
- Publish a scoped capability snapshot without compatibility adapters.

## M1 - Capability-first foundation

- Monorepo scaffold.
- Standalone OMP Studio Host.
- Shared React app.
- Capability IDs/types.
- Capability Broker + diagnostics.
- Event journal and projections.

Exit: UI can render capability snapshot even before full OMP interaction.

## M2 - Native RPC complete vertical slice

- `omp --mode rpc-ui` supervisor.
- v2 framing.
- prompt/stream/tool/abort.
- state/model/thinking/fast.
- Extension UI.
- session load/resume/history.
- subagent observation/transcripts.
- Host Tools skeleton.

Exit: real OMP single-thread coding flow works without compatibility adapters;
the command ledger, epoch replay and Job/process-group cleanup pass E2E.

## M3 - CLI/config coverage

- `omp config` JSON adapter.
- project config YAML adapter.
- `models.yml` provider/model editor.
- auth/login/admin adapter.
- MCP native files.
- model/role/fallback pages backed by real config.

Exit: major persistent OMP settings are manageable without ACP; workspace
writer lease and CAS reject stale/external writes without data loss.

## M4 - Discovery and extensions

- available commands integration.
- skills/agents/plugins/hooks/tools configured/effective distinction.
- Optional Companion Extension POC for pinned-build resolved discovery; keep
  private-import routes experimental.
- reload/restart semantics.

## M5 - Agent Hub parity

- native RPC proposal implementation if available.
- otherwise only a pinned-build, explicitly enabled experimental Companion POC
  for message/kill/revive; it is not a stable release requirement.
- Agent Hub UI capability-gated per action.
- optional experimental Collab adapter only for unresolved gaps.

## M6 - Preview and verification

- dev-server manager.
- Electron WebContentsView.
- browser/console/network/DOM/screenshot.
- Host Tools for Agent self-verification.

Exit: malicious Preview isolation and whole dev-server-tree cleanup tests pass.

## M7 - Advanced OMP surfaces

- Advisor rich state.
- memory/autolearn diagnostics.
- async job UI.
- collaboration/share UI.
- LSP/DAP/browser deeper state where OMP exposes deterministic APIs.

## M8 - Remote WebUI

Only after local security and control lease model are stable.
