# Releasing

OMP Studio is versioned from the workspace root `package.json` (`0.1.0` at
the first public snapshot). Workspace packages share that version today.

## Automated Release (GitHub Actions)

The configured key identity, local custody location, and recovery procedure
are recorded in [Release Operations](release-operations.md).

The repository provides a release workflow in `.github/workflows/release.yml` with two jobs:

1. **Job `runtime`** (Always runs on tag pushes; defaults to enabled on manual runs):
   - Builds OMP Runtime from source using `bun` and native toolchains.
   - May be skipped explicitly on manual runs only when reusing a published Runtime matching the current source version and architecture.
   - Signs the runtime using `OMP_RUNTIME_SIGNING_KEY` stored in GitHub Environment `release`.
2. **Job `app`**:
   - Runs full verification gates (`check`, `omp:test:metadata`, `omp:verify:patches`).
   - Retrieves Runtime artifacts from `runtime`, or from `reuse_runtime_tag` when rebuilding is explicitly disabled. The reused release must contain the four prefixed Runtime assets; the original v0.1.3 release does not.
   - Packs Windows installer (`pack:win -- --skip-host`).
   - Builds update assets (`scripts/build-update-assets.mjs`): signed app payload `tar.gz`, `update-index.json`, and `update-index.sig.json`.
   - Runs `p5:gate` after assets exist; a missing or invalid index signature fails the release.
   - Uploads all assets to a draft release, including the four Runtime files even when reused, then publishes it. Published releases are immutable to this workflow.

The workflow serializes releases and reads the previous published index before allocating its next sequence. For a local release, download the previous `update-index.json` and set `OMP_PREVIOUS_UPDATE_INDEX` to that file's path; omit it only for the first indexed release. A missing or invalid configured file fails the builder. The ABI is probed from the packaged `OMP Studio.exe --omp-print-abi`; the Node process running the builder is not an Electron ABI source. Both jobs install Bun and Runtime dependencies, and native command failures stop their steps.

After `npm run check` passes for the current source, patch verification may
use `--skip-workspace-check` to avoid repeating that same workspace gate.
Runtime type checks, every Runtime suite, and smoke tests still run. Native
Runtime suites use separate processes with bounded execution time on Windows.

Before the first run, configure the `release` GitHub Environment and its
`OMP_RUNTIME_SIGNING_KEY` secret with the Ed25519 private key matching the
active public key in `packaging/keys/trusted-keys.json`. A fresh key created
by `npm run omp:keys` is a development identity and cannot replace the
release identity. The first indexed release must be a full Setup upgrade
for existing installations; keep both minimum-version inputs blank.

Manual inputs `payload_min_app_version` and `runtime_min_app_version` are
reviewed compatibility baselines for the installed Main process. Blank
means the new release's application version. They map to local builder
variables `OMP_PAYLOAD_MIN_APP_VERSION` and `OMP_RUNTIME_MIN_APP_VERSION`.
Lower them only after validating the new payload or Runtime against that
specific older installed Main. A hot payload's displayed application
version does not upgrade the Main process.

If a run successfully uploaded Runtime but failed later, a manual retry can
set `build_runtime=false` and `reuse_runtime_run_id` to that run's ID. This
downloads its signed architecture-specific artifact directly; source-version,
architecture and signature validation still apply during packaging.

### Stable and Canary

Application updates always read the stable `releases/latest/download`
index. Runtime stable uses that same signed index. Runtime canary discovers
the newest published prerelease with a `-canary` tag and both signed index
assets for the local architecture among the latest 30 releases. It never
falls back to an unsigned asset or silently switches back to stable.
Canary discovery errors do not suppress a successful stable application check.
The two channels retain independent sequence watermarks.

For canary, use a workspace application version such as `0.1.5-canary.1`
and select `runtime_channel=canary`, or push its matching tag. The workflow
publishes it as a prerelease without changing stable latest. Rebuild
Runtime and use a new Runtime version for every distinct signed artifact,
including channel changes; do not publish different bytes under the same
Runtime version. The corresponding previous index is selected within the
same channel. Set `runtime_min_app_version` to a tested stable Main baseline
when distributing canary Runtime to stable application installations.

### Published Assets

Upload the Setup from `outputs/installer/` and these files from `outputs/release/`:

- `omp-studio-app-<appVersion>-win32-<arch>.tar.gz`
- `update-index.json` and `update-index.sig.json` for x64
- `update-index-win32-arm64.json` and `update-index-win32-arm64.sig.json` for arm64
- All four `omp-runtime-<version>-win32-<arch>-*` files emitted by the builder

The four Runtime suffixes are `omp.exe`, `runtime-manifest.json`,
`checksums.json`, and `runtime-signature.json`. Publish the generated names
unchanged: the signed index maps them back to the installer's fixed local
names. For offline directory import, restore those four original local
names in a single directory. Do not publish the staging `app-payload/` tree.
Retain the other architecture's index and signature as the workflow does.
Never edit an index after signing it.

## Local / Hotfix Manual Checklist

1. **Changelog.** Move items from `## [Unreleased]` in `CHANGELOG.md` into a
   new `## [X.Y.Z] - YYYY-MM-DD` section. Keep `[Unreleased]` headings empty.
   Update the compare links at the bottom of the file.
2. **Version.** Bump `version` in the root `package.json` and in workspace
   `package.json` files that still hard-code the same number.
3. **Preview switch.** For a build you would give to end users, set
   `PREVIEW_MODE_SWITCH_ENABLED` in `apps/renderer/src/preview/mode.ts` to
   `false`.
4. **Gate.**

   ```powershell
   npm run check
   npm run omp:test:metadata
   npm run omp:verify:patches
   ```

5. **Commit** on `main` with a message such as `release: vX.Y.Z`.
6. **Tag** annotated: `git tag -a vX.Y.Z -m "OMP Studio vX.Y.Z"`.
7. **Push** `main` and the tag: `git push origin main --tags`.
8. **Installer + assets + readiness.** Build the Windows artifact, build update assets, then run the
   readiness gate — see [Windows installer](#windows-installer) below:

   ```powershell
   npm run pack:win
   node scripts/build-update-assets.mjs
   npm run p5:gate
   ```

9. **GitHub Release.** `gh release create vX.Y.Z --notes-file ...` (or paste
   the changelog section). Attach the eight generated assets described above,
   including all four prefixed Runtime files when reusing an older Runtime.
   For canary use `--prerelease --latest=false`. Local manual publishing and
   the tag-triggered workflow are alternative release paths; do not publish
   the same version through both.

Do not put signing private keys, `%APPDATA%` logs, or `backup/` into the tag.

## Update Contracts and Policies

- **PAYLOAD_FORMAT**: Currently `1`. Only increment `PAYLOAD_FORMAT` when the bootstrap ↔ payload interface changes. Each payload declares its `payloadFormat`.
- **Main-process compatibility**: A payload updates only renderer and preload. Its `minAppVersion` defaults to the version being released, so older installed main processes use the full Setup. Only after reviewing compatibility with an older bundled main process may a release set `OMP_PAYLOAD_MIN_APP_VERSION` to that baseline. Matching Electron ABI and contract versions alone do not establish compatibility. Client contract and Studio protocol values are read from the built workspace constants.
- **Update security and recovery migration**: The release introducing retirement of the unsigned legacy update IPC, the `payload-health` acknowledgement, and Runtime maintenance transactions requires the full Setup for earlier installations. Keep the default `minAppVersion` at that release's version; do not lower `OMP_PAYLOAD_MIN_APP_VERSION` to a main-process baseline lacking these changes. A renderer/preload payload alone cannot remove the old installed handlers or replace the Runtime lifecycle code.
- **Forced Full Upgrade**: To force all users to run the full installer, omit the `app.payload` section from `update-index.json`. The app update plan will classify this as `full` ("no-payload").
- **Key Rotation**: To rotate update signing keys, add the new public key to `packaging/keys/trusted-keys.json`. Publish **one full-installer** intermediate release still signed with the **old** private key but containing the new public key in `trusted-keys.json`. A renderer/preload payload cannot update the installed trust store. Only after that version is distributed should you switch the active signing key. Skipping this step leaves existing installations without a trust anchor for subsequent updates.
- **Trust Root vs Authenticode**: The root of trust for OMP Studio updates is Ed25519 signatures and SHA-256 digests on the index and assets, not the transport channel or Windows Authenticode. Authenticode is an independent OS-level signature for the Setup installer.
- **Registry DisplayVersion**: After hot-updating, HKLM `DisplayVersion` remains the baseline version from the installer (we intentionally do not modify registry from the app runtime). Consequently, Windows "Installed Apps" displays the baseline version number, and rerunning the installer will trigger an upgrade rather than repair.
- **Interrupted payload updates**: A repeated download re-verifies both the source and installed copy and reuses only identical signed file digests. Different content under the same version is rejected. Activation remains explicit; closing the app before activation does not activate the staged version.
- **Runtime recovery**: Active work blocks maintenance. Idle sessions are stopped and restored on the candidate Runtime. If activation succeeds but actual session startup fails, the previous distinct Runtime is re-verified, activated, and used to restore the original sessions. The update still reports failure even when recovery succeeds. First installs and same-version repairs have no distinct previous version to recover automatically.

## Windows installer

Build the NSIS artifact from the repository root:

```powershell
npm run pack:win
```

That rebuilds the signed Runtime (`omp:build:host`), emits the sandboxed
preload, copies the **public** Runtime key into `packaging/runtime-keys/`
(gitignored), runs electron-builder, then audits `outputs/installer/`
(gitignored). Fail closed if the renderer, preload, `omp.exe`, or public key
is missing, or if a private key is present.

If electron-builder times out downloading Electron (common on some networks):

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm run pack:win
```

### Readiness gate

Once the installer exists and update assets are built, run the release readiness verifier:

```powershell
npm run p5:gate
```

`pack:win` audits `outputs/installer/` only. `p5:gate` re-runs the PTY /
installer / Host security tests, verifies `update-index.sig.json` against trusted keys,
and then scans **all** candidate publish surfaces for private material — `apps/desktop/dist`,
`apps/renderer/dist`, `packages/runtime-installer/dist/artifacts` and `outputs/` — before writing
`outputs/p5-readiness.json`. It exits non-zero when a test fails or a key
marker is found. Run it after `pack:win`, not before: it skips directories
that do not exist yet, so an early run silently scans less.

`productionWindowsCleanRun` in the report stays `manual-required` — a clean
Windows boot is still a human check.

Details: [`packaging/README.md`](../packaging/README.md).

## What not to publish

- `signing-private.pem` or any `.pem` except a documented public key
- Session transcripts, `models.yml` with secrets, Host logs
- `architecture_review_v2_work/`, `ui_reference/test/`, `backup/`
- A dirty `omp-patch/vendor/oh-my-pi` gitlink
