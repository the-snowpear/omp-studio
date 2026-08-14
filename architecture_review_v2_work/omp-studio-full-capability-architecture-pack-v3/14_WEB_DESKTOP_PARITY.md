# WebUI and Desktop Parity

## One shared application

```text
packages/app
packages/ui
packages/host-client
```

Both clients render the same React application.

## Desktop

Electron adds OS-only services through a narrow preload bridge:

- native folder/file dialogs,
- external editor/file manager launch,
- desktop notifications,
- auto-update,
- native embedded Preview surface.

OMP business operations still go through the Host API.

Electron Main, not Renderer, owns the Host client credential and proxies a
narrow request surface. Preview uses a different untrusted session and receives
neither that bridge nor Host authentication.

## Local WebUI

`omp-studio serve` starts the Host and serves/connects the shared SPA over loopback.

The browser enters a short-lived one-time pairing code and exchanges it in a
POST body for an HttpOnly SameSite session. Exact Host/Origin, CSRF and
WebSocket-upgrade rules are normative in `contracts/host-auth.md`.

## Multiple clients

Allow many observers. Use a control lease for write/control operations on the same Thread:

```text
Desktop: controller
Browser: observer
```

The observer may request takeover. Read operations remain concurrent.

This client control lease is separate from the workspace write lease. Even two
different Threads cannot both write one canonical workspace in the MVP.

## Event resume

Every Host event has a sequence number scoped by `hostEpoch`; OMP state also
carries `runtimeEpoch`. Reconnect sends `{hostEpoch, afterSeq}`. Snapshot
creation buffers concurrent events and returns `snapshotSeq`; epoch mismatch or
journal gaps force a full resync. See `contracts/event-stream.ts`.

## Remote mode

Later only. Explicit opt-in, TLS/auth, per-project allowlist, strict terminal/preview policy. Never expose the local Host on `0.0.0.0` without authentication.
