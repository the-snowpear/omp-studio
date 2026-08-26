# Managed OMP patch boundary

The managed Runtime pin is `can1357/oh-my-pi` `v18.0.3` at commit `160ed439ac0df594347e7d7018b813a7ffdb5e81`. The initial audited baseline was `45e12e5bb758198a920c6070e7e64cb33b21beac`.

The pinned upstream is attached as the Git submodule at `vendor/oh-my-pi/`. The root repository stores only the pinned gitlink; the upstream working tree keeps its own `.git` so the fork can be generated and reviewed without mixing upstream files into the Studio repository.

Executable names have separate responsibilities:

- `omp.exe` is the patched OMP CLI/runtime and is launched as `omp --mode studio-host`;
- `omp-studio.exe` is reserved for the future desktop Studio application and is not built by this backend-only phase.

## Two layers: overlay and seam

Studio's changes to the pinned tree split by file ownership, not by feature or date.

| Layer | Location | Contents | Size |
|---|---|---|---|
| Overlay | `overlay/` | Files upstream does not have at all: `packages/coding-agent/src/studio/**` and the `studio-*` tests | ~22,400 lines |
| Seam | `patches/*.patch` | The only edits that touch upstream-owned files | ~960 lines |

The overlay is ordinary tracked source in this repository. Editing it is an ordinary edit with an ordinary diff — no patch number, no apply/reverse cycle, and no rebase conflict when the pin moves, because upstream has nothing at those paths to conflict with. Only the seam is expressed as patches, and each patch is grouped by the upstream subsystem it touches, so an upstream bump maps to a small predictable set of refreshes:

| Patch | Upstream subsystem |
|---|---|
| `0001-studio-cli-entry.patch` | `main.ts`, `cli.ts`, CLI arg/flag tables, launch help, package manifest |
| `0002-studio-session-runtime.patch` | `session/**`, `registry/agent-registry.ts`, `plan-mode/approved-plan.ts` |
| `0003-studio-modes-and-pause.patch` | `modes/**`, `slash-commands/builtin-modes.ts`, `async/job-manager.ts` |
| `0004-studio-extensibility.patch` | `extensibility/extensions/**`, `sdk.ts`, `tools/context.ts` |

`scripts/omp-seam.mjs` holds the authoritative path list for each group. Adding a seam file means adding it to a group there and rerunning the regen script — an upstream file that no group claims makes regeneration fail rather than silently dropping the edit.

`packages/coding-agent/CHANGELOG.md` is deliberately excluded (`SEAM_EXCLUDED`). Fork-local changelog prose conflicts on every upstream release and carries no runtime behaviour; Studio's history lives in this repository.

## Working loop

Put the vendor tree into its working state, edit inside it, then capture the result back:

```powershell
npm run omp:overlay:apply    # overlay copied in + seam patches applied (idempotent)
# ... edit under omp-patch/vendor/oh-my-pi ...
npm run omp:patches:regen    # overlay captured back, seam patches rewritten, series.json updated
```

Never hand-write or hand-edit a `.patch`. Regeneration is the only supported producer; hand edits drift from the group definition and reintroduce the ordering problems this model removes.

Verify the whole fork from a clean vendor tree:

```powershell
npm run omp:verify:patches
```

The verifier copies the overlay in, applies the seam patches in series order, runs the root and OMP source gates, then reverses the patches and removes the overlay in a `finally` cleanup. Beyond "it builds" it enforces two invariants: the overlay may not modify any upstream-tracked file (that would smuggle a seam change past review), and every seam patch must pass `git apply --check` before being applied. It intentionally does not rebuild the compiled host binary; milestone binary validation runs with the fork applied via `npm run omp:build:host`.

Before the first source change against a fresh pin, both layers must be empty:

```powershell
npm run omp:install-deps
npm run omp:build:host
npm run omp:verify:prepatch
```

Never run `git submodule update` while the fork is applied, and never use root-wide `git add -A` while unrelated Studio/frontend work is present.

## Versioning

`patches/series.json` records `patchsetVersion` explicitly and pairs it with `patchsetDigest`, a content hash over the overlay bytes and the seam patch bytes. Within one upstream release line, the regen script advances the version only when that digest changes. A newly pinned upstream release may intentionally start a fresh `studio.1` patchset because the complete Runtime version also includes the upstream version (for example, `18.0.3-studio.1`).

The version is recorded rather than counted for a reason: it used to be derived from the number of patch files, so consolidating the series could reuse a Runtime directory name within the same upstream version. `derivePatchsetVersion` prefers the recorded field; the count remains only as a fallback for series files that predate it. Resetting to `studio.1` is allowed only when the upstream version component changes, so the complete installation directory remains unique.

Artifact provenance covers both layers — `patchHashes` for the seam, `overlayHash` for the overlay. A digest over paths *and* contents means a rename changes provenance even when no byte of code did.

## Upgrading the pin

1. Move the submodule to the new upstream commit and update `upstream.json` plus `series.json`'s `upstreamCommit`.
2. `npm run omp:overlay:apply`. The overlay always lands cleanly; only the four seam patches can reject.
3. Fix rejects in the vendor tree, then `npm run omp:patches:regen`.
4. `npm run omp:verify:patches`.

Overlay breakage from an upstream bump shows up as type errors, not merge conflicts — `bun check:ts` inside the vendor tree is the fast signal.

## Design constraints

The root `@omp-studio/studio-protocol` package is the canonical contract. Because the pinned vendor is an independently installable Bun workspace and cannot import the root private package, the overlay mirrors only the minimal frame/hello wire subset; root fixtures and bidirectional tests are the compatibility authority.

The fork must not introduce a second `AgentSession`, RPC/TUI hot switching, Slash-command automation, or PTY semantic parsing.

The Windows host native build uses the repository-pinned Rust toolchain. Bazel is not used for the Windows `host` target; `scripts/bazel-natives.ts` delegates to the local N-API/MSVC build. The root build wrapper defaults Cargo to four parallel jobs to avoid resource exhaustion during the first optimized build.

## Capability history

The fork was originally carried as 34 sequential patches, `0001-studio-host-cli-mode` through `0034-studio-next-turn-model`. That numbering is retired; the files and their per-patch narrative remain in this repository's Git history and in `backup/2026-08-17/omp-overlay-split-190333/`. The capabilities they introduced, in the order they were built:

- **Host entry and session identity** — the `studio-host` CLI mode with one shared `AgentSession`/`SessionManager` and one shared runtime identity; the optional backward-readable `studioOrigin: "studio-host"` creation marker, which leaves session schema version 3 unchanged and classifies missing or unknown markers as CLI/legacy. Resuming a CLI session in Studio does not rewrite its origin.
- **Transport, authentication, hello** — a local Named Pipe/UDS server. The Runtime atomically claims and deletes the one-time token file, accepts a length-prefixed hello only at pre-epoch `0`, returns a challenge proof bound to the process-stable runtime identity, and supports reconnect with a fresh Host nonce.
- **Snapshot and recovery** — the Host assigns a positive `runtimeEpoch` with `--bridge-runtime-epoch`; hello negotiates that epoch, then `runtime.snapshot` serves shared session identity with truthful streaming, compacting, plan, goal, and vibe state. TUI startup is held until the authenticated initial snapshot is written. Reconnect requires the same identity and epoch and always takes a fresh snapshot. The Host projection preserves Runtime `stateVersion`/`eventSeq`, detects event gaps, and returns to snapshot-required state without renumbering Runtime events.
- **Command lifecycle** — Host-side correlation of accepted and terminal receipts, persisted terminal outcomes, snapshot receipt-tail reconciliation, a separate Host `commitSeq`, and `outcome_unknown` fencing when the Bridge or owned process is lost.
- **Arbiter, pause, resume** — Runtime-side arbitration serializes GUI/TUI process-exclusive commands, interaction ownership is generation-fenced, and both the TUI pause screen and the Bridge call the same process-global pause service, with monotonic `pauseEpoch` and bounded same-process idempotency replay.
- **Session and core RPC** — the presentation-neutral surface shared by Bridge and TUI: queue enqueue, clear context, retry, prompt, steer, follow-up, abort. Rejected commands are idempotently replayable, receipts stay bound to the submitting socket, and reconnect snapshots bypass the mutation queue so an abandoned in-flight command cannot deadlock recovery.
- **Loop** — Runtime-owned and presentation-neutral: one scheduler and state source for enable, prompt capture, pause, disable, turn/time limits, reconnect projection, and shutdown cleanup. Token limits stay explicitly graded as limited because neither the v5 contract nor upstream OMP defines an accounting semantic.
- **Modes, tree, fork** — Runtime-owned Plan, Goal, Vibe, session-tree, and session-fork services sharing mode state and tool transitions with the TUI. Tree snapshots omit message content and filesystem paths, and fork rebinding uses the same live `AgentSession`. Ask-result tree navigation performs the native two-phase sibling-branch protocol through the generation-fenced Remote InteractionPort and resumes the agent only after the answer commits. Plan mode applies the configured `plan` role model, defers streaming transitions to the idle boundary, restores the pre-Plan model/thinking level, rolls back failed exits, and rejects mid-turn exits.
- **Remote ops** — the dynamic operator manifest, Remote InteractionPort and explicit GUI-to-TUI transfer, BTW/TAN/OMFG composite services, Runtime-owned Agent Hub and Job services with ownership/generation/confirmation fencing, and graceful `runtime.shutdown` quiesce/drain/completion signaling.
- **Command manifest conformance** — custom/MCP prompts exposed as `prompt-template`, file commands as `file-command`, every implementation value one of the canonical shared/headless/extension/TUI routes, so the Host process probe can validate `operator.manifest.get` and bind its hash and upstream commit to the authenticated Hello.
- **Live control plane** — presentation-neutral operations, snapshot state, and an injectable media-session boundary. Until a frontend-owned authenticated audio device/sideband exists, `live.start` fails closed with `CAPABILITY_UNAVAILABLE`; `live.stop` stays idempotent and Runtime shutdown always stops Live.
- **Conversation and transcript** — the conversation contract, session transcript service, live projector and bridge, transcript normalization and type hardening, provider-error surfacing, and subagent conversation reconstruction.
- **Telemetry** — session telemetry, archived-session telemetry, Agent Hub usage, and turn-rate accounting.
- **Later refinements** — session handoff, fast prewalk, session model control, multi-skill prompt expansion, abort during retry, and next-turn model selection.

Capability hashes include stable/limited grades and limitation text, so a parity-grade change cannot reuse stale packaged evidence.
