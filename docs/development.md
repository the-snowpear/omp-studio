# Development

Windows is the main inner-loop platform; an Apple Silicon Mac runs the same
commands. Automatic CI builds and runs core tests on Windows. Node 22+ and
npm workspaces drive this repository; Bun is needed only for Runtime work.

## Layout

| Path | Role |
|---|---|
| `apps/desktop/` | Electron main, IPC, Host composition |
| `apps/renderer/` | Vite + React UI |
| `packages/` | Protocol, Host, client, transports, platform, testkit |
| `omp-patch/overlay/` | Studio-owned Runtime sources (`src/studio/**`) |
| `omp-patch/patches/` | Seam patches on upstream-owned files |
| `omp-patch/vendor/oh-my-pi/` | Pinned submodule; do not commit overlay dirt |
| `packaging/` | electron-builder / NSIS installer; macOS entitlements in `packaging/mac/` |
| `ui_reference/ver1` | Visual reference (not runtime code) |
| `doc/feature-index.md` | Feature → file map |

`backup/` is a local snapshot directory. It is gitignored. Do not send it
in a pull request.

## Everyday commands

```powershell
npm install
npm run omp:overlay:apply # once after cloning or changing the upstream pin
npm run check          # architecture rules, compile, core regression tests
npm run preview        # Electron from source
```

Choose other commands as needed; these are alternatives, not a checklist:

| Command | Use |
|---|---|
| `npm run check -- --fast` | Architecture rules, selector rules and an incremental compile only |
| `npm run check -- --only <package>` | Rebuild one dependency closure, then run that package's core suites |
| `npm run check -- --all` | Run every package test file instead of the core list |
| `npm run check -- --production` | Add the renderer and remote-host release bundles |
| `npm run build` | Production build, no tests |
| `npm test` | Build and run all workspace tests |
| `npm run test:tooling` | Build script dependencies and test packaging, signatures and updates |
| `npm run pack:win` / `npm run pack:mac` | Build and audit a desktop package on its native platform |

`scripts/check.mjs` is the only check entry point. Compilation is incremental
(`tsconfig.base.json` → `dist/.tsbuildinfo`) and runs in dependency order, so a
single package rebuilds in about two seconds and a cold full compile stays under
half a minute. A failing step prints the tail of its output only.

Renderer charts reuse the pinned native sources. Apply the overlay and generated seams before the first workspace build, including UI-only work. When editing native source, regenerate before reapplying so local edits are preserved. Ordinary builds need the applied sources but do not compile Rust or install the Runtime's Bun dependencies.

Scoped UI work:

```powershell
npm run check -- --only renderer
```

## Platform differences

Platform code lives in `apps/desktop/src/platform/`: paths, the login-shell
environment, process trees, window chrome, the native menu and lifecycle.
The renderer reads the platform only through `apps/renderer/src/platform.ts`.
Take a `platform` parameter instead of adding `process.platform` checks, and
keep Windows paths, names and behaviour pinned by tests. The 平台层 section of
[`doc/feature-index.md`](../doc/feature-index.md) maps each difference to its
file.

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

Tests should protect observable behaviour. Do not add fixture inventories,
source-text/AST equality checks, or tests that only pin a UI label or default
constant. Small copy/style changes usually need visual review, not new tests.

`npm run check` runs the architecture rules, the selector rules, an incremental
compile and the core list in `scripts/core-suites.mjs`: Bridge/client
communication, session lifecycle and history, Composer and approvals,
conversation state, local files, installation and update recovery. `npm test`
keeps the broader workspace regression suite available on demand. After a
current build, `test:core` and `test:built` rerun tests without rebuilding.
Package-local test commands are useful when editing one feature, and
`npm run check -- --only <package>` is the scoped equivalent of the full gate.

`scripts/architecture.test.mjs` runs before anything compiles. It fails on a new
workspace dependency cycle, a dependency outside the declared layering,
`electron` outside `apps/desktop`, `react` outside `apps/renderer`, Node built-ins
or `electron` in renderer sources, `@omp-studio/testkit` imported by a Host
package, or a second definition of `PREVIEW_MODE_SWITCH_ENABLED`. When a rule
must change, change the table and the code in the same commit.

Packaging scripts have a separate `test:tooling` entry. Runtime patch
verification is for Runtime/overlay/seam changes and upstream upgrades.
Performance benchmarks and `scripts/full-gui-e2e.mjs` are manual diagnostics for
affected behaviour.

Release jobs build and package artifacts, audit the package, and verify the
signed update assets. They do not repeat source tests. The duplicate P5
readiness gate and the unused v1 asset generator have been removed; the
current builder still preserves the signed migration feed for old clients.

## CI

PRs and pushes to `main` run `npm run check -- --production` on Windows: the
architecture rules, the compile, the core suite and the release bundles.
Documentation and UI-reference-only changes skip CI. The manual CI workflow has
three scopes:

- `core` (default): the same Windows checks.
- `full`: all workspace and tooling tests on Windows and macOS, plus native
  Runtime builds and patch verification.
- `macos-package`: an ad hoc signed test package and packaged Electron smoke
  checks, with evidence and installers retained for seven days; nothing is published.

The Streaming perf workflow is manual only. Run it when investigating or
changing streaming performance. No paid model calls are needed for packaged
Electron checks; physical IME, Gatekeeper and TCC still require device testing
when those behaviours change.

## Feature map

Before editing a product surface, open [`doc/feature-index.md`](../doc/feature-index.md).
That file is the map; [`AGENTS.md`](../AGENTS.md) only routes to it.
