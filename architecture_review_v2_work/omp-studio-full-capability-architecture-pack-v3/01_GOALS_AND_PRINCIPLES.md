# Goals and Principles

## Product goal

OMP Studio is a graphical client for the real OMP harness. The architectural goal is not to reproduce a subset of OMP features behind a prettier chat surface; it is to expose as much of OMP's real behavior as possible while keeping OMP itself authoritative.

## Goals

1. Preserve behavior parity with the installed OMP CLI/Harness.
2. Cover features even when one transport lacks a dedicated API.
3. Make App and WebUI first-class clients of the same Host.
4. Prefer deterministic machine interfaces over natural-language control.
5. Detect capabilities dynamically and degrade honestly.
6. Keep unsafe/private compatibility adapters isolated and replaceable.
7. Make upstream RPC improvements easy to propose and adopt.

## Non-goals

- Reimplement OMP's agent loop, prompts, tool semantics or subagent scheduler.
- Use ACP as the primary first-party integration surface.
- Directly mutate OMP active session JSONL or `agent.db`.
- Promise automatic compatibility with arbitrary TUI-only custom components.
- Make every OMP internal implementation detail part of Studio's public contract.

## Architecture rules

### Rule 1: Harness parity over protocol parity

A feature is not "unsupported" just because RPC does not expose a dedicated command. Check slash commands, CLI, config, native files, extension bridge and upstream options first.

### Rule 2: Never use natural-language prompts as a control API

The UI must not implement a deterministic button such as "Kill Agent" by asking the model to "please kill agent X". Deterministic local slash commands are acceptable; model interpretation is not.

### Rule 3: Channel choice is capability-specific

There is no universal fallback ordering. Runtime controls prefer RPC. Global settings prefer `omp config`. Project settings require a project file adapter. Provider definitions live in `models.yml`. Agent Hub control may temporarily require a bridge.

### Rule 4: One source of truth per domain

- Runtime/session/agent/tool state: OMP runtime/RPC.
- Workspace content: filesystem.
- Git state: Git.
- Persistent OMP config: OMP config files/official CLI.
- Studio-only metadata: Studio DB.
- Preview state: Preview runtime/browser host.

### Rule 5: Private compatibility paths are quarantined

Any adapter relying on OMP private internals, Collab frame internals, or version-coupled imports must be behind:

- explicit capability probe,
- version/ABI guard,
- feature flag,
- telemetry-free local diagnostics,
- graceful disable path.

### Rule 6: Missing critical controls become upstream work

For an important active-session feature that cannot be deterministically controlled through a public surface, add it to `21_UPSTREAM_RPC_PROPOSALS.md` instead of building a parallel implementation in Studio.

### Rule 7: Security and recovery invariants are mandatory

- Host API is authenticated before use and public resource IDs are opaque.
- Capability decisions are bound to identity, resource scope and runtime epoch.
- One canonical workspace has at most one write-capable runtime in the MVP.
- Every mutation enters the command ledger before dispatch.
- Event replay is bound to `hostEpoch`; OMP state is bound to `runtimeEpoch`.
- Preview is untrusted content and never inherits Host/Desktop credentials.
- Every Host-owned child belongs to a whole-tree containment domain.

The files under `contracts/` and Accepted ADRs are normative for these rules.
