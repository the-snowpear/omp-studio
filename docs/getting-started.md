# Getting started

OMP Studio currently ships **from source**. There is no signed GitHub Release
installer yet. Windows 10/11 x64 is the supported desktop.

## Requirements

- Node.js 22 or newer, with npm
- Git (clone with submodules)
- [Bun](https://bun.sh) (OMP vendor workspace)
- For a real Runtime: MSVC Build Tools + Rust, via `npm run omp:install-deps`

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
npm run preview
```

Or double-click `preview.cmd` / `启动预览.cmd` at the repository root. This builds the
Electron main process and renderer, then opens the desktop window.

The first start may take several minutes. The window’s **预览** switch uses
in-app fixtures for read surfaces; composer, terminal, pause/resume, and
approvals still talk to a real Host when one is running.

## Run with a managed Runtime

```powershell
npm install
npm run omp:install-deps
npm run omp:overlay:apply
npm run omp:keys              # once per machine; writes keys under %APPDATA%\omp-studio\keys
npm run omp:build:host
npm run preview
```

`omp:overlay:apply` copies Studio’s overlay and seam patches into the
submodule working tree. That **will** show as modified content inside
`omp-patch/vendor/oh-my-pi`. Do not `git add` that dirty vendor tree. The
source of truth is `omp-patch/overlay/` plus `omp-patch/patches/`.

Host logs: `%APPDATA%\omp-studio\logs\host-YYYY-MM-DD.log`.

## Verify

```powershell
npm run check                 # typecheck + tests
npm run omp:test:metadata
npm run omp:verify:patches    # clean vendor tree, apply overlay+patches, reverse
```

## Next

- [development.md](development.md) — inner loop and patch regen
- [architecture.md](architecture.md) — what talks to what
- [releasing.md](releasing.md) — tagging and the Windows installer
