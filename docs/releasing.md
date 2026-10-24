# Releasing

The release workflow builds, packages and verifies the files being published.
Source tests run during development and CI; release jobs do not repeat them.
See [development.md](development.md) for optional full tests, Runtime checks
and performance diagnostics.

## Automated release

Push a new desktop tag `v<workspace version>` or Runtime tag
`runtime-v<Runtime version>`, or run the Release workflow manually.

1. Build and sign the Runtime, including its binary smoke and identity checks,
   or reuse a matching signed Runtime from a previous workflow run.
2. Build the workspace once and package the desktop when requested.
   `pack:win` / `pack:mac` audit the resulting package.
3. Collect previous update catalogs, build the new signed assets, and run
   `updates:verify` once.
4. Upload candidates. The publisher checks signatures and uploaded digests,
   then publishes only after all requested architectures succeed.

The Runtime is reused automatically: each build job hashes the Runtime inputs
(vendor commit, `omp-patch/overlay`, `omp-patch/patches`, `upstream.json`, the
trusted key table, the Runtime build scripts, Bun version, channel and
platform) and downloads the signed Runtime artifact of an earlier run with the
same key (artifacts are kept 90 days). A desktop-only fix therefore skips Bun
setup, Rust compilation and Runtime dependency installation. Set
`rebuild_runtime` to force a fresh build. Neither path
runs workspace tests, full patch replay or GUI acceptance during publication.
The repeated P5 readiness gate and old v1 asset generator have been removed.

| Manual input | Purpose |
|---|---|
| `release_kind` | Complete desktop release or independent Runtime |
| `target_arch` | Windows x64, ARM64, or both (default) |
| `runtime_channel` | Stable, or canary for Runtime-only releases |
| `runtime_min_app_version` | Tested desktop compatibility floor; blank uses the workspace version |
| `rebuild_runtime` | Rebuild the Runtime even when its inputs are unchanged |
| `include_macos` | Also build and publish macOS Apple Silicon; off by default |

Tag pushes build both Windows architectures. Runtime-only releases never
become Latest; canary releases are prereleases. Desktop releases use stable
Runtime. Versions are unique across channels, and published assets are immutable.
Reuse still validates signatures, source identity, platform and channel.
A desktop release cannot bundle an older Runtime than one already published
for that channel and architecture.

Signing uses the existing GitHub Environment `release` and its
`OMP_RUNTIME_SIGNING_KEY`. The key must match the active public key in
`packaging/keys/trusted-keys.json`. `omp:keys` creates development keys only;
it does not replace the release identity. Custody and recovery are documented
in [release-operations.md](release-operations.md).

## Published files

| Platform | Output directory | Desktop artifacts |
|---|---|---|
| Windows | `outputs/release/<arch>/` | Setup EXE and blockmap, Runtime ZIP and blockmap, signed `updates-win32-<arch>.json` |
| macOS arm64 | `outputs/release/darwin-arm64/` | App ZIP and blockmap, first-install DMG, Runtime ZIP and blockmap, signed `updates-darwin-arm64.json` |

Runtime-only releases omit the desktop package. Windows also retains the
signed v1 migration feed unchanged so old installations can migrate to Setup;
removing the old generator does not remove client migration support.
The macOS DMG digest is signed into the catalog. Packages remain ad hoc signed
and not notarized until a Developer ID is configured.

Desktop notes use `docs/releases/v<version>.md` when present. Download links
must name assets actually built for that tag. Runtime notes are generated.
The publisher rejects missing files, inconsistent digests and attempts to
replace a published release.

## Preparing a version

Update the root/workspace versions and lockfile together, record user-facing
changes in the changelog, and keep `PREVIEW_MODE_SWITCH_ENABLED=false`.
Run checks for the affected code before tagging: the daily command is
`npm run check`; packaging/update changes use `npm run test:tooling`, and
Runtime changes use `npm run omp:verify:patches`. Full tests and GUI acceptance
are available on demand rather than mandatory on every release.

For local packages, apply the overlay and run `npm run pack:win` or
`npm run pack:mac` on the target platform. When the workspace and signed Runtime
are already current, `--skip-host --skip-build` reuses them. A package is audited
automatically; it does not run source tests.

To create public update assets locally, configure the release signing identity,
collect verified previous catalogs with `scripts/collect-update-history.mjs`,
set `OMP_PREVIOUS_CATALOG_DIR` and the Windows `OMP_PREVIOUS_UPDATE_INDEX` to
the downloaded history, then run `npm run updates:build` and
`npm run updates:verify`. The Actions workflow handles this history wiring.
Never change a catalog after signing or include private keys, logs or backups.

When installer, update recovery or platform permissions change, test the
affected installation/upgrade on a suitable machine. The manual CI
`macos-package` scope also produces a test package and GUI evidence without
publishing. Unit tests and package audits do not demonstrate an actual
Gatekeeper prompt, UAC flow or clean-machine launch.

For key rotation, first distribute a full installer containing the new public
key while still signing with the old key. Switch signing identities only after
that trust root is installed. Update signatures and SHA digests remain the
application's trust mechanism; OS code signing is separate.

Update behaviour and recovery: [updates.md](updates.md).
