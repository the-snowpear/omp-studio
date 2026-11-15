# Architecture

OMP Studio is a desktop console in front of a **patched OMP Runtime**. The
GUI does not parse TUI text, ANSI, or key macros. Control goes through a
typed Studio Bridge.

```
Renderer (apps/renderer)
  → @omp-studio/client          StudioClient + conversation reducer
  → transport-desktop           preload `window.ompStudio`
  → apps/desktop                ipc.ts
  → @omp-studio/host-client-api product facade
        ├─ Host-owned: session catalog, archive, models.yml,
        │              skills scan, git, workspace registry, system files
        └─ Runtime Bridge: studio-host
              → overlay packages/coding-agent/src/studio/**
```

## Packages

| Package | Responsibility |
|---|---|
| `@omp-studio/studio-protocol` | Bridge frames, command kinds, validators |
| `@omp-studio/client-contract` | Renderer-visible queries, commands, read models |
| `@omp-studio/client` | Client state machine, conversation reducer |
| `@omp-studio/host-client-api` | Facade: query/command → Host or Runtime |
| `@omp-studio/studio-host` | Runtime process, Bridge, ledger, catalog, telemetry |
| `@omp-studio/transport-desktop` | Fixed IPC channel names and validation |
| `@omp-studio/transport-web` | Optional local web transport |
| `@omp-studio/runtime-installer` | Signed artifact install / rollback |
| `@omp-studio/platform*` | Single-instance lock, Job Object, private endpoint |
| `@omp-studio/testkit` | Shared fixtures and contract suites |

Authoritative lists:

- Client operations: `packages/client-contract/src/operations.ts`
- Runtime command `kind`: `packages/studio-protocol/src/contracts/commands.ts`
- Facade dispatch: `packages/host-client-api/src/facade.ts`

## Invariants

- When prose and types disagree, **contracts win**.
- The renderer may call Host domain APIs only. It must never receive bridge
  tokens, process handles, or OMP session filesystem paths.
- Unknown mutations fail closed.
- `accepted` is not success. Only a terminal receipt commits a terminal
  outcome.
- Runtime loss fences the old epoch and maps unresolved accepted work to
  `outcome_unknown`.
- PTY bytes are not a control protocol.
- Workspace file operations resolve workspace-relative paths inside the Host
  and enforce containment. The file browser's `fs.*` operations explicitly
  accept user-selected absolute paths on the selected Host. `system-files.ts`
  is their execution and validation boundary; forwarding layers do not repeat
  validation. `workspace.openPath` registers an existing directory through
  the workspace service. Private Runtime paths are never exposed implicitly.
- Local and SSH Hosts share the same system-file service and file I/O. Only
  the local Electron composition injects a recycle-bin operation. Explicit
  `systemFile*` shell IPC actions are local-only, and Main resolves their
  paths before opening an application or the file manager.
- File documents and `omp-file:` resource leases carry their source and Host
  target. Files inside registered projects use workspace identities and
  share Explorer buffers; other files use the system backend with the same
  version conflicts, text formats, resource streaming and close confirmation.

## Runtime pin

`omp-patch/upstream.json` pins [oh-my-pi](https://github.com/can1357/oh-my-pi).
Studio-owned code lives in `omp-patch/overlay/`. Edits to upstream files are
four seam patches. See [`omp-patch/README.md`](../omp-patch/README.md).

`omp.exe` is the patched CLI/Runtime. `OMP Studio.exe` is the Electron app.

## Historical notes

[`doc/BACKEND_FOUNDATION.md`](../doc/BACKEND_FOUNDATION.md) and
[`doc/FRONTEND_INTEGRATION.md`](../doc/FRONTEND_INTEGRATION.md) describe the
phase before the renderer landed. They are kept as archaeology. Prefer this
file and the TypeScript contracts.
