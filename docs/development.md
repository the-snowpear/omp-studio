# Development

Windows is the inner-loop platform. Node 22+ and npm workspaces drive this
repository; Bun is required inside the vendored OMP tree.

## Layout

| Path | Role |
|---|---|
| `apps/desktop/` | Electron main, IPC, Host composition |
| `apps/renderer/` | Vite + React UI |
| `packages/` | Protocol, Host, client, transports, platform, testkit |
| `omp-patch/overlay/` | Studio-owned Runtime sources (`src/studio/**`) |
| `omp-patch/patches/` | Seam patches on upstream-owned files |
| `omp-patch/vendor/oh-my-pi/` | Pinned submodule; do not commit overlay dirt |
| `packaging/` | electron-builder / NSIS installer |
| `ui_reference/ver1` | Visual reference (not runtime code) |
| `doc/feature-index.md` | Feature → file map |

`backup/` is a local snapshot directory. It is gitignored. Do not send it
in a pull request.

## Everyday commands

```powershell
npm install
npm run typecheck
npm test
npm run check          # typecheck && test
npm run build
npm run preview        # Electron from source
npm run pack:win       # unsigned Windows NSIS installer
```

Scoped UI work:

```powershell
npm run typecheck -w @omp-studio/renderer
npm run test -w @omp-studio/renderer
```

## Preview mode

The top-bar **预览** switch is a renderer display flag
(`apps/renderer/src/preview/mode.ts`). It is **not** a Host capability and
must not enter `client-contract`.

| | Read surfaces | Mutations |
|---|---|---|
| Preview on | Fixtures overlay the snapshot | Still the real API |
| Preview off | Host / desktop truth only | Same |

When you add a list, tree, or page, wire **both** paths. Do not fall back to
mock data when the real model is empty. The 0.1.0 snapshot keeps
`PREVIEW_MODE_SWITCH_ENABLED` at `false`; turn it on only for fixture work.

## Changing the Runtime fork

Two layers, never mixed:

1. **Overlay** — files upstream does not have. Edit
   `omp-patch/overlay/...` as ordinary source, **or** edit the applied copy
   under the vendor tree and regen.
2. **Seam** — edits to upstream-owned files. Only `omp-patch/patches/*.patch`,
   grouped by subsystem in `scripts/omp-seam.mjs`.

```powershell
npm run omp:overlay:apply     # idempotent: overlay + seam into vendor
# edit omp-patch/vendor/oh-my-pi if you need the full tree
npm run omp:patches:regen     # capture overlay, rewrite seam, bump series.json
npm run omp:verify:patches
```

Never hand-edit a `.patch`. Never `git submodule update` while the fork is
applied. Never `git add -A` at the repo root while the vendor tree is dirty.

Details: [`omp-patch/README.md`](../omp-patch/README.md).

## Tests

Tests must assert an observable contract (behaviour, error mapping, state
transition), not that a fixture was copied into memory. Do not source-grep
implementation files. Prefer the package-local test script; `npm run check`
is the merge gate.

## Feature map

Before editing a product surface, open [`doc/feature-index.md`](../doc/feature-index.md).
That file is the map; [`AGENTS.md`](../AGENTS.md) only routes to it.
