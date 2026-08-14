# ADR-010: Isolate Preview and Contain Process Trees

Status: Accepted for v3 baseline

## Decision

Preview content runs as untrusted web content in an isolated, non-persistent Electron session with sandboxing, no Node/preload/IPC and default-deny permissions. Preview never shares Host authentication.

OMP, Preview/dev server and Studio helper processes use separate ownership domains. Windows uses Job Objects with kill-on-close; macOS/Linux use process groups. Shutdown is graceful-first, then whole-tree termination after a deadline.

## Consequences

- A malicious project page cannot inherit desktop privileges.
- Host crash and Preview stop do not leave uncontrolled descendants.
- Host Tools remain separately scoped and approved; OMP tool approval does not authorize a Studio Host Tool automatically.

Normative details: `contracts/preview-security.md` and `contracts/process-containment.md`.
