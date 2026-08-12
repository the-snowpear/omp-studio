# OMP pre-patch baseline

Verified on Windows x64 on 2026-08-10, before the first OMP source patch.

## Identity and naming

- Upstream commit: `45e12e5bb758198a920c6070e7e64cb33b21beac`
- OMP version: `17.2.12`
- Patched CLI/runtime executable: `omp.exe`
- Future desktop application executable: `omp-studio.exe` (reserved; not part of this backend-only phase)

## Toolchain

- Bun: `1.3.14+0d9b296af`
- Rust: `nightly-2026-07-28-x86_64-pc-windows-msvc`
- rustc: `1.99.0-nightly (09ee43b2d 2026-07-27)`
- Visual Studio: Community 2022 `17.7.4`, with MSVC, CMake, and Ninja
- Node.js: `v24.13.0`

Bazel is not required for a Windows `host` native build. The upstream driver delegates that target to the local N-API/MSVC build.

## Green baseline

- Studio foundation: typecheck/build passed; 24 tests passed.
- OMP TypeScript/Biome check: 4,209 files checked with no fixes.
- OMP pause/CLI regression selection: 35 tests passed.
- OMP source CLI smoke: passed.
- Windows native addon: `pi_natives.win32-x64-modern.node` built successfully.
- Windows host binary: `packages/coding-agent/dist/omp.exe` built successfully; `--version` and `--smoke-test` passed.

The first optimized Rust build must use a bounded Cargo job count on this workstation. `npm run omp:build:host` defaults to four jobs and reuses Cargo's build cache on subsequent runs.
