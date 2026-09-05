# Releasing

OMP Studio is versioned from the workspace root `package.json` (`0.1.0` at
the first public snapshot). Workspace packages share that version today.

## Automated Release (GitHub Actions)

The repository provides a release workflow in `.github/workflows/release.yml` with two jobs:

1. **Job `runtime`** (Optional, triggered by `build_runtime: true`):
   - Builds OMP Runtime from source using `bun` and native toolchains.
   - Only needed when `omp-patch/**` is modified or `patchsetVersion` in `series.json` is bumped.
   - Signs the runtime using `OMP_RUNTIME_SIGNING_KEY` stored in GitHub Environment `release`.
2. **Job `app`**:
   - Runs full verification gates (`check`, `omp:test:metadata`, `omp:verify:patches`).
   - Retrieves Runtime artifacts (from `runtime` job, or from `reuse_runtime_tag`, e.g. `v0.1.3`).
   - Packs Windows installer (`pack:win -- --skip-host`).
   - Builds update assets (`scripts/build-update-assets.mjs`): signed app payload `tar.gz`, `update-index.json`, and `update-index.sig.json`.
   - Runs `p5:gate` after assets exist; a missing or invalid index signature fails the release.
   - Uploads all assets to a draft release, including the four Runtime files even when reused, then publishes it. Published releases are immutable to this workflow.

The workflow serializes releases and reads the previous published index before allocating its next sequence. For a local release, download the previous `update-index.json` and set `OMP_PREVIOUS_UPDATE_INDEX` to that file's path; omit it only for the first indexed release. A missing or invalid configured file fails the builder. The ABI is probed from the packaged `OMP Studio.exe --omp-print-abi`; the Node process running the builder is not an Electron ABI source. Both jobs install Bun and Runtime dependencies, and native command failures stop their steps.

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
   the changelog section). Attach the Setup exe, payload `tar.gz`, `update-index.json`, `update-index.sig.json`, and all four Runtime files (`omp.exe`, `runtime-manifest.json`, `checksums.json`, `runtime-signature.json`), including when reusing an older Runtime.

Do not put signing private keys, `%APPDATA%` logs, or `backup/` into the tag.

## Update Contracts and Policies

- **PAYLOAD_FORMAT**: Currently `1`. Only increment `PAYLOAD_FORMAT` when the bootstrap ↔ payload interface changes. Each payload declares its `payloadFormat`.
- **Main-process compatibility**: A payload updates only renderer and preload. Its `minAppVersion` defaults to the version being released, so older installed main processes use the full Setup. Only after reviewing compatibility with an older bundled main process may a release set `OMP_PAYLOAD_MIN_APP_VERSION` to that baseline. Matching Electron ABI and contract versions alone do not establish compatibility. Client contract and Studio protocol values are read from the built workspace constants.
- **Forced Full Upgrade**: To force all users to run the full installer, omit the `app.payload` section from `update-index.json`. The app update plan will classify this as `full` ("no-payload").
- **Key Rotation**: To rotate update signing keys, add the new public key to `packaging/keys/trusted-keys.json`. Publish **one full-installer** intermediate release still signed with the **old** private key but containing the new public key in `trusted-keys.json`. A renderer/preload payload cannot update the installed trust store. Only after that version is distributed should you switch the active signing key. Skipping this step leaves existing installations without a trust anchor for subsequent updates.
- **Trust Root vs Authenticode**: The root of trust for OMP Studio updates is Ed25519 signatures and SHA-256 digests on the index and assets, not the transport channel or Windows Authenticode. Authenticode is an independent OS-level signature for the Setup installer.
- **Registry DisplayVersion**: After hot-updating, HKLM `DisplayVersion` remains the baseline version from the installer (we intentionally do not modify registry from the app runtime). Consequently, Windows "Installed Apps" displays the baseline version number, and rerunning the installer will trigger an upgrade rather than repair.

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
