# OMP Source Map

Research baseline: public OMP main branch as inspected on 2026-08-10, pinned to
commit `45e12e5bb758198a920c6070e7e64cb33b21beac`. Links below should be read at
that commit when making compatibility decisions; `main` links are convenient
navigation only.

## Native RPC

- `docs/rpc.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts

Key facts used by this pack:

- NDJSON stdio and protocol v2 chunking.
- `--mode rpc-ui` extension UI behavior.
- prompt/steer/follow-up/abort/state/model/thinking/fast/queue/compaction/retry/bash/session commands.
- Host Tools and Host URI schemes.
- subagent subscription/snapshot/message APIs and lifecycle/progress/event frames.
- available command updates and local command side channels.

## Subagents / Agent Hub

- `docs/tools/task.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md
- `docs/collab.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/collab.md

Key facts:

- task batch fan-out, async/background jobs, isolation, lifecycle and registry states.
- `hub` cancellation and revival semantics.
- Agent Hub/live registry behavior.
- Collab full-control guests can use Agent Hub chat/kill/revive/transcript.
- Collab guest->host includes `agent-cmd` for hub control.

## Settings / models / providers

- `docs/settings.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md
- `docs/models.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/models.md
- `docs/providers.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md

Key facts:

- global vs project settings precedence.
- `omp config ... --json` schema-driven operations.
- project config is not written by `omp config set/reset`.
- models.yml provider/model definitions and runtime discovery.
- credential/provider availability rules.

## MCP

- `docs/mcp-config.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md

Key facts:

- OMP-native project/user `mcp.json` paths.
- named profile path behavior.
- OAuth rehydration semantics.

## Skills / discovery / hooks

- `docs/skills.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md
- `docs/config-usage.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md
- `docs/hooks.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md

Key facts:

- capability provider discovery and precedence.
- configured vs effective discovery distinction.
- extension/hook/tool loading behavior.

## Advisor

- `docs/advisor-watchdog.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md

## SDK

- `docs/sdk.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md

The SDK is intentionally not the primary active-session channel in this architecture because Studio wants cross-process isolation and exact CLI runtime behavior. It remains useful as a reference for what OMP can expose internally.

## Auth broker

- `docs/auth-broker-gateway.md`
  - https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md
