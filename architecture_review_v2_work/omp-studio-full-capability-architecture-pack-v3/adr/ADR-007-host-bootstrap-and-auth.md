# ADR-007: Host Bootstrap and Local Authentication

Status: Accepted for v3 baseline

## Decision

The Host uses a per-start `hostEpoch` and secret, exact loopback Host/Origin validation, scoped short-lived client sessions and a profile single-instance lock.

Electron Main authenticates over private IPC and proxies requests through a narrow preload bridge; Renderer and Preview never receive the Host credential. Local WebUI pairs with a single-use short-lived code and receives an HttpOnly SameSite session plus CSRF protection.

## Consequences

- Port discovery is not authentication.
- Credentials never appear in URLs, argv, localStorage or ordinary logs.
- Observer/controller and project/thread scopes are enforceable server-side.
- Host restart revokes all client sessions.

Normative details: `contracts/host-auth.md`.
