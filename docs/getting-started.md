# Getting started

OMP Studio ships Windows x64 and ARM64 Setup packages through [GitHub Releases](https://github.com/the-snowpear/omp-studio/releases). You can also build from source with `npm run pack:win`. Runtime and update catalogs use Ed25519 signatures; Windows Setup is not Authenticode-signed.

macOS 13 or later on Apple Silicon also runs from source, or as an ad hoc signed
app built with `npm run pack:mac` (not notarized yet; see
[macOS app](#macos-app-ad-hoc-signed)).

## Requirements

- Node.js 22 or newer, with npm
- Git (clone with submodules)
- [Bun](https://bun.sh) (OMP vendor workspace)
- For a real Runtime: MSVC Build Tools + Rust, via `npm run omp:install-deps`
- On macOS instead: the Xcode Command Line Tools (`xcode-select --install`),
  Rust from rustup (host `aarch64-apple-darwin`), Bun 1.4.2 or newer and a
  native arm64 Node, not one running under Rosetta. `npm run omp:install-deps`
  checks all of these before it builds anything.

You still need an OMP-compatible model provider. Studio reads the same
`models.yml` / login flow as the OMP CLI. It does not embed API keys.

## Clone

```powershell
git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git
cd omp-studio
```

If you already cloned without submodules:

```powershell
git submodule update --init --recursive
```

## Install and run (preview)

```powershell
npm install
npm run omp:overlay:apply
npm run preview
```

On Windows you can also double-click `preview.cmd` at the repository root.
This builds the Electron main process and renderer, then opens the desktop
window. On macOS the preview is the stock Electron app, so the Dock shows
"Electron" rather than OMP Studio.

The first start may take several minutes. This snapshot hides the in-app
**预览** switch (`PREVIEW_MODE_SWITCH_ENABLED=false`) and uses Host / desktop
data only. Composer, terminal, pause/resume, and approvals talk to a real Host
when one is running.

## Run with a managed Runtime

```powershell
npm install
npm run omp:install-deps
npm run omp:overlay:apply
npm run omp:keys              # once per machine; writes keys under %APPDATA%\omp-studio\keys
                              # (macOS: ~/Library/Application Support/omp-studio/keys)
npm run omp:build:host
npm run preview
```

`omp:overlay:apply` copies Studio’s overlay and seam patches into the
submodule working tree. That **will** show as modified content inside
`omp-patch/vendor/oh-my-pi`. Do not `git add` that dirty vendor tree. The
source of truth is `omp-patch/overlay/` plus `omp-patch/patches/`.

Host logs: `%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`; on macOS
`~/Library/Application Support/omp-studio/logs/host-YYYY-MM-DD.log`.

## Windows installer (unsigned)

Requires a machine that can already `npm run omp:build:host` (Bun, MSVC, Rust,
and `npm run omp:keys` once). Then:

```powershell
npm run pack:win
```

Output: `outputs/installer/OMP-Studio-Setup-<version>-windows-<arch>.exe` (gitignored).
The Setup is not Authenticode-signed; SmartScreen will warn. `pack:win` audits
the unpacked tree so a Runtime **private** key cannot ship.

Reuse an existing signed Runtime artifact:

```powershell
npm run pack:win -- --skip-host
```

## macOS app (ad hoc signed)

On an Apple Silicon Mac that can already run `npm run omp:build:host`:

```bash
npm run pack:mac                   # add -- --skip-host to reuse the signed Runtime artifact
```

Output in `outputs/installer-mac/` (gitignored):

- `mac-arm64/OMP Studio.app`;
- `OMP-Studio-<version>-macos-arm64.dmg`, for a first install;
- `OMP-Studio-<version>-macos-arm64.zip`, the in-app update payload.

The build fails closed if the bundle audit finds a problem (see
[packaging/README.md](../packaging/README.md)).

The app is signed ad hoc and not notarized, so the first launch is blocked.
Choose "Open Anyway" in System Settings › Privacy & Security, or run
`xattr -dr com.apple.quarantine "/Applications/OMP Studio.app"`. Every update
changes the ad hoc signature, so macOS asks again for microphone, folder and
local network access, and the Keychain may ask to allow access once more.

## Verify

```powershell
npm run check                 # typecheck + tests
npm run omp:test:metadata
npm run omp:verify:patches    # clean vendor tree, apply overlay+patches, reverse
```

## Next

- [development.md](development.md) — inner loop and patch regen
- [architecture.md](architecture.md) — what talks to what
- [releasing.md](releasing.md) — tagging, the Windows installer and the macOS build
