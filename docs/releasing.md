# Releasing

The release workflow builds, packages and verifies the files being published.
Source tests run during development and CI; release jobs do not repeat them.
See [development.md](development.md) for optional full tests, Runtime checks
and performance diagnostics.

## Automated release

Push a new desktop tag `v<workspace version>` or Runtime tag
`runtime-v<Runtime version>`, or run the Release workflow manually.

The preparation job rejects already published desktop versions and explicitly
tagged Runtime releases before starting native jobs. It also checks desktop
tag/version and stable-channel consistency. Draft releases remain retryable;
the publisher still checks the final artifacts and publication state.

1. Each platform independently prepares its signed Runtime, including binary
   smoke and identity checks, or reuses a matching signed Runtime from an earlier
   run. Desktop and remote jobs download that platform's same prepared artifact.
2. Build the workspace once and package the desktop when requested.
   `pack:win` / `pack:mac` / `pack:linux` audit the resulting package.
3. Collect previous update catalogs, build the new signed assets, and run
   `updates:verify` once.
4. Upload candidates. The publisher checks signatures and uploaded digests,
   then publishes only after all requested architectures succeed.

`release-platform.yml` starts desktop and remote packaging as soon as that
platform's `runtime-platform.yml` completes. A slow Intel macOS Runtime no longer
holds Windows/Linux packaging at a global Runtime barrier. Publication still
waits for every required desktop and remote candidate. Standalone Runtime and
remote-environment workflows call the same producer.

The Runtime is reused automatically: the shared Runtime producer hashes its inputs
(vendor commit, `omp-patch/overlay`, `omp-patch/patches`, `upstream.json`, the
trusted key table, the Runtime build scripts, Bun version, channel and
platform) and downloads the signed Runtime artifact of an earlier run with the
same key (artifacts are kept 90 days). A desktop-only fix therefore skips Bun
setup, Rust compilation and Runtime dependency installation; artifact reuse runs
on Linux without acquiring a Windows/macOS runner. Set `rebuild_runtime` to
rebuild the native addon and Runtime (valid Bazel action cache entries can still
be used). Existing matching signed Runtimes retain their immutable bytes during
the build-pipeline migration; new Runtime sources use the new producer. Neither path
runs workspace tests, full patch replay or GUI acceptance during publication.
The repeated P5 readiness gate and old v1 asset generator have been removed.

## Native compilation and reuse

Studio and OMP share the pinned vendor source, but Studio applies Rust as well as
TypeScript patches. Always build Studio's applied source tree: upstream release
executables and npm native modules cannot substitute for these artifacts.

Like upstream, native compilation uses its explicit Bazel `//:natives-*` targets
on Linux. Six Ubuntu 22.04 jobs cover Studio's six platforms; Linux x64 includes
both baseline and modern addons. The pinned OMP tree owns Rust, LLVM, Zig, MSVC,
macOS SDK and Swift toolchains. Studio pins Bazelisk and bounds concurrent compiler
jobs and linker memory for GitHub-hosted runners. It does not require upstream's
private vmon runners or remote cache service.

The resulting `.node` files are separate `studio-native-v1-*` workflow artifacts,
retained for 90 days and reusable across refs. Their key hashes actual native
source contents **after applying Studio patches**, including added seam files,
Cargo/Bazel/toolchain inputs and Studio's build policy. Git clean filters make
Windows CRLF and Linux LF checkouts agree. TypeScript-only changes and Studio
version bumps do not invalidate the native artifact. Source-changing Rust patches
do. Only this repository's push/dispatch producers can supply reusable native code.
Finish native warming before tagging when possible. A release that arrives
before the corresponding addon is uploaded can still build concurrently; the
release does not share a concurrency queue that a newer main push could replace.

On the native platform runner, `build-omp-host.mjs --native-artifact <directory>`
checks the input's source/platform identity and uses upstream's addon installer
to stamp its version and load-probe it. Bun then builds the patched CLI; native
architecture checks, macOS signing checks, smoke tests, Studio Bridge identity
probing and Ed25519 artifact signing remain on the target platform. Local
`omp:build:host` without this flag retains the Cargo host-build path.
The producer compiles only studio-protocol, runtime-installer and studio-host,
the dependency closure required by the identity probe, instead of all workspace
packages.

This separates two reuse decisions: a changed Studio Bridge can require a new
Runtime while reusing the same patched Rust addon. A completely unchanged Runtime
reuses its signed bytes and skips both stages.

## Shared caches

Release jobs also cache npm archives, Electron/electron-builder downloads and
the WebView2 SDK. Their dependency fingerprint excludes workspace versions, so
a Studio-only version bump keeps the same dependency cache. Download caches
may fall back within the same OS/CPU; `npm ci` still installs the full lockfile.
Workspace cache paths are relative so Windows runners using different workspace
drives share the same cache version.

Desktop jobs restore `node-pty/build/Release` after `npm ci`, including
electron-rebuild's architecture/ABI metadata. This native cache uses an exact
OS/CPU, Node major, external dependency and packaging-policy key, without a
fallback. Electron or dependency changes therefore rebuild the module. Normal
packaging keeps native rebuilding enabled; electron-rebuild decides whether
the restored output matches its target.

**Warm release caches** runs on `main` after relevant native, dependency or
packaging changes and can also run manually. The plan distinguishes native hunks
from TypeScript hunks inside seam patch files. Native changes prepare the compiled
addons and warm npm/Bun downloads on the six Runtime platforms without compiling
Rust there; desktop changes warm Electron downloads and node-pty for Windows x64/ARM64,
macOS ARM64 and Linux x64. Windows also warms NSIS/WebView2. Workspace version bumps
alone skip both groups. Superseded warm runs are cancelled; release runs are not.
Native warming never signs a replacement Runtime or publishes a release. The
optional `verify_remote` input instead prepares any missing signed Runtimes and
packages/verifies all six remote candidates, without publishing them.

Only `main` saves shared download, desktop-native and Bazel action caches. Tags
and other refs restore them, while compiled-addon and signed-Runtime artifacts
remain reusable across runs. Bun setup's additional download cache is disabled in
Runtime jobs to avoid duplicating the explicit Bun cache. Bazel action caches
retain at most 1 GiB of recently used blobs per platform; evicted blobs are ordinary
cache misses. Completed addon artifacts do not count against the Actions cache
quota. On main, maintenance removes superseded release-cache entries, tag-scoped
copies and the retired `v1-release-rust-*` / `desktop-tools-v1-*` caches. Unrelated source-test caches are
left to CI. No cache maintenance deletes a Release or workflow artifact.

The reusable **Prepare signed Runtimes** manual entry can prepare one platform
without publishing: select a platform and set `warm_cache: false`. With
`warm_cache: true` it only prepares the compiled addon. The first run after the
new native-artifact key requires compilation unless the Bazel action cache can
supply it. Existing signed Runtimes are still reusable. Validate Windows ARM64, both
macOS targets and Linux with this entry before the first production release;
local tooling tests and YAML validation alone cannot establish those runtimes'
behavior. Upstream's warm-cache timings are not a prediction for Studio's first
GitHub-hosted Bazel build.

Local validation on 2026-11-17 used an isolated Ubuntu 22.04 environment and the
patched OMP 18.20.2 tree. The Windows x64 baseline target built successfully with
Bazel 9.2.0; the addon was then stamped and loaded on Windows with Bun 1.4.4,
including Studio's `DesktopSession.observationOnly` and `settle` APIs. The cold
Bazel invocation took 22m07s including LLVM/MSVC preparation on that local network.
After pruning the action cache to 1 GiB and cleaning build outputs, rebuilding
took 3m57s in Bazel (4m02s including staging), with 1,585 disk-cache hits and 290
executed actions; the toolchain repositories were already present. The rebuilt
addon passed the Windows load/API check again. This is a feasibility check, not
a hosted-runner release benchmark. Other target
platforms and the full signing/publishing chain still need runner acceptance.

## Release inputs

| Manual input | Purpose |
|---|---|
| `release_kind` | Complete desktop release or independent Runtime |
| `target_arch` | Windows x64, ARM64, or both for Runtime-only releases; desktop always builds both |
| `runtime_channel` | Stable, or canary for Runtime-only releases |
| `runtime_min_app_version` | Tested desktop compatibility floor; blank uses the workspace version |
| `rebuild_runtime` | Rebuild the Runtime even when its inputs are unchanged |
| `include_macos` | Include macOS Apple Silicon for Runtime-only releases; desktop always includes it |
| `include_linux` | Include Linux x64 for Runtime-only releases; desktop always includes it |

Desktop releases always build Windows x64, Windows ARM64, macOS Apple Silicon,
and Linux x64, whether started from a tag or manually. Publication waits for
all four desktop targets and the remote environments. Runtime-only releases never
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
| Linux x64 | `outputs/release/linux-x64/` | AppImage and blockmap, deb, Runtime ZIP and blockmap, signed `updates-linux-x64.json` |
| SSH targets (six OS/CPU combinations) | `outputs/remote-environments/<platform>/` | Signed `remote-environment-<platform>.json` and complete `omp-studio-remote-<version>-<platform>.zip` / `.tar.gz` |

Desktop releases also build remote environments on native Windows, Linux and
macOS x64/arm64 runners. Each archive contains private Node, the Host bundle
and signed Runtime. All six jobs must succeed before the desktop publication.

Runtime-only releases build `build:release-tools` instead of the complete workspace:
they skip the Renderer, remote Host bundle, Electron binary download, desktop
native cache and Linux installer tools. They still stage and verify the signed
Runtime and generate the signed update catalog. Windows also retains the
signed v1 migration feed unchanged so old installations can migrate to Setup;
removing the old generator does not remove client migration support.
The macOS DMG and Linux deb digests are signed into their respective catalogs.
Mac packages remain ad hoc signed and not notarized until a Developer ID is configured.
Linux desktop updates link to the matching manual download; Runtime updates
remain automatic when compatible. The Linux job uses a native Ubuntu 24.04 x64
runner and a glibc 2.39 baseline. All selected desktop candidate directories must
be present, so a missing Linux candidate cannot silently publish a partial release.

Desktop notes use `docs/releases/v<version>.md` when present. Download links
must name assets actually built for that tag. Runtime notes are generated.
The publisher rejects missing files, inconsistent digests and attempts to
replace a published release.

## Preparing a version

Before cutting a release or writing a pre-release review
(`docs/reviews/*-release-review.md`), read [release-review.md](release-review.md)
and walk through its historical failure guards and review checklist.

Update the root/workspace versions and lockfile together, record user-facing
changes in the changelog, and keep `PREVIEW_MODE_SWITCH_ENABLED=false`.
Run checks for the affected code before tagging: the daily command is
`npm run check`; packaging/update changes use `npm run test:tooling`, and
Runtime changes use `npm run omp:verify:patches`. Full tests and GUI acceptance
are available on demand rather than mandatory on every release.

For local packages, apply the overlay and run `npm run pack:win`,
`npm run pack:mac` or `npm run pack:linux` on the target platform. When the workspace and signed Runtime
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
`macos-package` and `linux-package` scopes also produce test packages and GUI evidence without
publishing. Linux acceptance covers native Runtime/tool/PTY operation and data
retention across reinstall/removal, with a local model endpoint. Unit tests and package audits do not demonstrate an actual
Gatekeeper prompt, UAC flow or clean-machine launch.

For key rotation, first distribute a full installer containing the new public
key while still signing with the old key. Switch signing identities only after
that trust root is installed. Update signatures and SHA digests remain the
application's trust mechanism; OS code signing is separate.

Update behaviour and recovery: [updates.md](updates.md).
