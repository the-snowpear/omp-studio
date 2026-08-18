# Contributing to OMP Studio

Thank you for considering a contribution. This document is the human entry
point. Agent / IDE collaborators should also read [`AGENTS.md`](AGENTS.md).

中文请先读 [`README.md`](README.md) 与 [`docs/development.md`](docs/development.md)。

## Before you start

1. Search [existing issues](https://github.com/the-snowpear/omp-studio/issues)
   and discussions. Open an issue for anything larger than a typo.
2. Do not report security issues in public. Follow [`SECURITY.md`](SECURITY.md).
3. This is **not** a fork of the OMP CLI. Changes to upstream behaviour that
   belong in [oh-my-pi](https://github.com/can1357/oh-my-pi) should go there.
   Studio only carries overlay files and four seam patches.

## Development setup

See [`docs/development.md`](docs/development.md). Short version:

```powershell
git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git
cd omp-studio
npm install
npm run omp:install-deps
npm run omp:overlay:apply
npm run omp:keys          # first machine only
npm run check
```

Windows is the supported desktop. Node.js 22+ is required. Building the
managed Runtime also needs Bun and a working MSVC / Rust toolchain; the
install script documents those.

## How to send a change

1. Branch from `main`. Use a short prefix: `fix/`, `feat/`, `docs/`, `patch/`.
2. Touch only files that belong to the task. Start from
   [`doc/feature-index.md`](doc/feature-index.md) instead of a repo-wide search.
3. Preview-mode pages must keep **both** preview fixtures and the real Host
   read model. Never fill an empty real surface with mock data.
4. Do not edit `omp-patch/patches/*.patch` by hand. Apply the overlay, edit
   inside `omp-patch/vendor/oh-my-pi`, then `npm run omp:patches:regen`.
5. Do not commit `backup/`, `node_modules/`, `dist/`, Host logs, signing
   private keys, or a dirty vendor gitlink. The submodule pin is a gitlink
   only; overlay apply **will** dirty the vendor working tree locally.
6. Add or update tests that protect an observable contract. Do not add
   tautologies (`expect(true).toBe(true)`, source-text greps).
7. Put user-facing changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
8. Run the gate that matches the change. The full gate is `npm run check`.
   Runtime / patch work also needs `npm run omp:verify:patches`.

## Pull request checklist

Use the GitHub PR template. At minimum:

- [ ] `npm run check` (or a documented subset plus why the rest is N/A)
- [ ] `CHANGELOG.md` updated when the change is user-facing
- [ ] Preview and real data paths both handled, if you touched a read surface
- [ ] No secrets, local paths, or `backup/` files

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
