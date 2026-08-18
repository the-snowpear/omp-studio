# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Internal implementation notes from the closed development period are not
carried forward here. That history remains in Git. From this file onward,
only user-facing and contributor-facing changes belong under `[Unreleased]`
until the next tagged release.

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.1.0] - 2026-08-19

First public source snapshot. OMP Studio is a **development preview**: the
workbench is usable from source on Windows, several surfaces are still honest
empty shells, and there is no signed installer on GitHub Releases yet.

### Added

- Electron desktop shell with a React workbench: home, history, conversation,
  Agent Hub, skills / capabilities, model config, diagnostics, and settings.
- Typed Studio Bridge to a patched OMP Runtime (`omp --mode studio-host`):
  session lifecycle, prompt / steer / follow-up / queue / abort, pause and
  resume, plan / vibe / goal modes, tool approval, and interaction cards.
- Conversation UI: transcript, tool cards, composer (chips, mentions, slash
  commands, images), session changes, subagent inspect, and task progress.
- Host-owned workspace, Git, terminal PTY, and file-tree surfaces that never
  leak native paths into the renderer.
- Runtime overlay + four subsystem seam patches on pinned
  [oh-my-pi](https://github.com/can1357/oh-my-pi) `v17.3.7`
  (`8500092296621a6826b7136e840f8a59ea338958`).
- Ed25519-signed Runtime artifact install / activate / rollback. Signing
  private keys stay in the Host profile, not in git.
- Windows installer skeleton (electron-builder NSIS) under `packaging/`.
- Preview mode in the renderer (display-layer fixtures only; mutations still
  hit the real Host).
- CI on Windows: `npm run check`, Runtime metadata tests, and patch verify.

### Known limitations

- macOS packaging is not a release target. Some platform ports exist so the
  tree does not hard-wire Windows-only types.
- Live audio / media sessions fail closed (`CAPABILITY_UNAVAILABLE`) until a
  desktop sideband exists.
- Several Hub / capabilities / git / preview-iframe controls remain
  capability-gated empty shells by design.
- The in-app “preview” switch is still enabled
  (`PREVIEW_MODE_SWITCH_ENABLED`). Production builds should turn it off.

[Unreleased]: https://github.com/the-snowpear/omp-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.0
