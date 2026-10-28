# OMP 18.13.2 migration

OMP Studio 0.1.15 pins upstream `e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e`
and Runtime `18.13.2-studio.10`. Builds use Bun 1.4.4. Studio sources remain
in overlay; edits to existing upstream files remain in four generated seam
patches. The minimum desktop version for this release is 0.1.15.

## User-facing changes

- Session options and task settings expose native USD warning/cap controls.
  Spend includes the session tree. A cap blocks the next request; requests
  already running can exceed it. Clearing an override restores inherited settings.
- The token menu and command palette open a read-only context snapshot with
  categories, search and paged content. Closing releases it; it does not refresh
  the session or start a model request.
- Draft dictation uses the desktop microphone transport and native STT. Explicit
  stop fills the draft; cancel discards it. Live and dictation are mutually
  exclusive. Remote workspaces do not forward the local microphone.
- The `local://` editor opens native session-local text files and saves in place
  with a content-version check. It supports UTF-8 text up to 512 KiB.
- History can list the current directory or sibling repository worktrees and
  resolve continuation sessions before switching workspaces. Sidebar ownership
  remains scoped to each workspace.
- WATCHDOG configuration exposes advisor scope and reasoning visibility. Saving
  reloads the native roster after confirmation; enabled advisors may incur usage.
- Restricted-directory approvals offer once/deny, Ask notes retain their selected
  option, and BTW accepts images and native side commands. Its complete draft
  survives docking and undocking.
- New sessions can omit context instruction files. Idle recap/compaction require
  explicit settings and known, visible ownership without draft/interaction blockers.
- Model discovery preserves advertised reasoning ladders, decision models and
  new compatibility fields. The bundled model catalog is updated.

## Verification

The migration was checked with workspace architecture/type/core/production
checks, the complete renderer suite, packaging/update tooling, and a scratch
checkout replay of all four patches. The replay passed 884 Runtime tests and
the CLI smoke test with Bun 1.4.4. Release artifacts are built and audited by
the native CI runners. These checks do not exercise real OAuth accounts,
paid model requests, physical microphone hardware or macOS Gatekeeper prompts.

The release also fixes managed Runtime lookup for model login/refresh and
isolates compatibility probes from external configuration and shared temp
extensions. Earlier startup, session-lease and installer fixes retain their
original release attribution in CHANGELOG.md.
