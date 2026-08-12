# Managed OMP patch boundary

The v5 architecture pins `can1357/oh-my-pi` at commit `45e12e5bb758198a920c6070e7e64cb33b21beac` for the initial audited baseline.

The pinned upstream is attached as the Git submodule at `vendor/oh-my-pi/`. The root repository stores only the pinned gitlink; the upstream working tree keeps its own `.git` so patches can be generated and reviewed without mixing upstream files into the Studio repository.

Executable names have separate responsibilities:

- `omp.exe` is the patched OMP CLI/runtime and is launched as `omp --mode studio-host`;
- `omp-studio.exe` is reserved for the future desktop Studio application and is not built by this backend-only phase.

Before writing the first OMP source patch, run:

```powershell
npm run omp:install-deps
npm run omp:build:host
npm run omp:verify:prepatch
```

After a patch is registered in `patches/series.json`, verify the complete series from a clean vendor tree:

```powershell
npm run omp:verify:patches
```

The verifier applies patches in series order, runs the root and OMP source gates, and reverses the patches in a `finally` cleanup. It intentionally does not rebuild the compiled host binary; milestone binary validation is performed with the series applied using `npm run omp:build:host`.

Author patches from the vendor root with standard `git diff` paths. New files must first be made visible to the diff with intent-to-add:

```powershell
git -C omp-patch/vendor/oh-my-pi add -N packages/coding-agent/src/studio packages/coding-agent/test/studio-host-args.test.ts packages/coding-agent/test/studio-host-mode.test.ts
git -C omp-patch/vendor/oh-my-pi diff --check
git -C omp-patch/vendor/oh-my-pi diff > omp-patch/patches/0001-studio-host-cli-mode.patch
git -C omp-patch/vendor/oh-my-pi reset -q
```

Never run `git submodule update` while patches are applied, and never use root-wide `git add -A` while unrelated Studio/frontend work is present.

The Windows host native build uses the repository-pinned Rust toolchain. Bazel is not used for the Windows `host` target; `scripts/bazel-natives.ts` delegates to the local N-API/MSVC build. The root build wrapper defaults Cargo to four parallel jobs to avoid resource exhaustion during the first optimized build.

Patches must be small and ordered in `patches/series.json`, with the first vertical slice limited to:

1. the `studio-host` CLI mode;
2. local Bridge authentication and hello;
3. state projection and snapshot;
4. the command arbiter;
5. shared pause/resume service wiring.

WP-010 stops at the `studio-host` CLI mode, one shared `AgentSession`/`SessionManager`, one shared runtime identity, and an unbound Bridge lifecycle seam. Named Pipe/UDS transport, authentication, and protocol hello belong to WP-011; the WP-010 seam must not report fake readiness.

Session transcripts remain authoritative in the normal OMP session store. Patch `0002-studio-session-origin.patch` adds the optional, backward-readable `studioOrigin: "studio-host"` creation marker without changing session schema version 3. Missing or unknown markers classify as CLI/legacy. Resuming a CLI session in Studio does not rewrite its origin; subsequent sessions created by the Studio process receive the marker. This provides the classification basis for a later read-only `session.list` service without moving JSONL files or creating a second session writer.

Patch `0003-studio-bridge-transport-auth-hello.patch` binds the lifecycle seam to a local Named Pipe/UDS server. The Runtime atomically claims and deletes the one-time token file, accepts a length-prefixed hello only at pre-epoch `0`, returns a challenge proof bound to the process-stable runtime identity, and supports reconnect with a fresh Host nonce. Until WP-012 supplies the authoritative projector/snapshot, the hello truthfully advertises an empty `limited` manifest and does not emit a fake `runtime.ready` event or accept mutations.

Patch `0004-studio-runtime-snapshot-recovery.patch` adds the first authoritative Runtime projection and read-only snapshot flow. The Host assigns a positive `runtimeEpoch` with `--bridge-runtime-epoch`; hello negotiates that epoch, then the Runtime serves `runtime.snapshot` with the shared session identity and truthful streaming, compacting, plan, goal, and vibe state. TUI startup is held until the authenticated initial snapshot is written. Reconnect requires the same runtime identity and epoch and always takes a fresh snapshot; stale-epoch snapshot requests are closed. The Host projection preserves Runtime `stateVersion`/`eventSeq`, detects event gaps, and returns to snapshot-required state without renumbering Runtime events.

WP-013 command lifecycle composition is Host-side. The Host now correlates accepted and terminal receipts, persists terminal outcomes, reconciles snapshot receipt tails, publishes a separate Host `commitSeq`, and fences unresolved commands as `outcome_unknown` when the Bridge or owned process is lost. Patch `0005-studio-bridge-lifecycle-race.patch` is a narrow Runtime reliability repair discovered by the WP-013 clean-series gate: stopping before the first snapshot now resolves a typed startup outcome instead of racing an unhandled Promise rejection. It adds no mutation capability; OMP continues to reject non-snapshot requests until a later shared-service command patch can execute them truthfully.

Patch `0006-studio-runtime-arbiter-pause-resume.patch` closes the first real mutation vertical slice. Runtime-side arbitration serializes GUI/TUI process-exclusive commands, interaction ownership is generation-fenced, and both the TUI pause screen and Bridge call the same process-global pause service. Authenticated `runtime.pause` and `runtime.resume` requests now produce accepted/terminal receipts, monotonic `pauseEpoch`, Runtime-owned state events, snapshot recovery, and bounded same-process idempotency replay. The hello remains `limited` and advertises only the three implemented Runtime capabilities: snapshot, pause, and resume.

Patch `0008-studio-loop-service.patch` makes Loop Runtime-owned and presentation-neutral. Bridge and the `studio-host` TUI share one scheduler and state source for enable, prompt capture, pause, disable, turn/time limits, reconnect projection, and shutdown cleanup; token limits remain explicitly graded as limited.

Patch `0009-studio-modes-tree-fork.patch` adds Runtime-owned Plan, Goal, Vibe, session-tree, and session-fork services. The Bridge and `studio-host` TUI share mode state and tool transitions, tree snapshots omit message content and filesystem paths, and fork rebinding uses the same live `AgentSession`. Patch 0013 completes Tree Ask re-answer through the Remote InteractionPort and Plan-role model transitions.

Patch `0010-studio-remote-ops-agent-jobs-shutdown.patch` completes the backend surface needed before renderer integration. It adds the dynamic operator manifest, Remote InteractionPort and explicit GUI-to-TUI transfer, BTW/TAN/OMFG composite services, Runtime-owned Agent Hub and Job services with ownership/generation/confirmation fencing, real roster/job projection, and graceful `runtime.shutdown` quiesce/drain/completion signaling. The patch deliberately does not add renderer UI or rename the Runtime executable: the patched CLI remains `omp.exe`, while the future desktop shell remains `omp-studio.exe`.

Patch `0011-studio-live-control-plane.patch` adds the presentation-neutral Live control plane, Bridge operations, snapshot state, and an injectable media-session boundary. Before WP-061 supplies a frontend-owned authenticated audio device/sideband, `live.start` fails closed with `CAPABILITY_UNAVAILABLE`; `live.stop` remains idempotent and Runtime shutdown always stops Live. The capability is therefore advertised as limited rather than pretending that headless voice media is available.

Patch `0012-studio-command-manifest-conformance.patch` aligns dynamic command descriptors with the canonical v5 manifest vocabulary. Custom/MCP prompts are exposed as `prompt-template`, file commands as `file-command`, and every implementation value is one of the canonical shared/headless/extension/TUI routes. This allows the Host process probe to validate `operator.manifest.get` and bind its hash and upstream commit to the authenticated Hello before claiming compatibility.

Patch `0013-studio-tree-ask-plan-model-parity.patch` closes the remaining backend-only Tree and Plan gaps. Ask-result tree navigation now performs the native two-phase sibling-branch protocol through the generation-fenced Remote InteractionPort and resumes the agent only after the answer commits; an empty single-question selection cancels without mutating the tree. Plan mode applies the configured `plan` role model, defers streaming transitions to the idle boundary, tracks role changes, restores the pre-Plan model/thinking level, rolls back failed exits, and rejects mid-turn exits before changing the active tool set. Capability hashes now include stable/limited grades and limitation text, so a parity-grade change cannot reuse stale packaged evidence. Loop token limits remain fail-closed because neither the v5 contract nor upstream OMP defines an accounting semantic.

Patch `0007-studio-session-control-core-rpc.patch` adds the presentation-neutral session/core command surface shared by Bridge and TUI: queue enqueue, clear context, retry, prompt, steer, follow-up, and abort. Rejected commands are idempotently replayable, command receipts stay bound to the socket that submitted them, and reconnect snapshots bypass the mutation queue so an abandoned in-flight command cannot deadlock recovery. `session.drop` is advertised as limited and fails closed with `INTERACTION_REQUIRED` until WP-040 supplies the approval port. The managed Runtime remains `limited` and now truthfully advertises eleven implemented operations.

The root `@omp-studio/studio-protocol` package is the canonical contract. Because the pinned vendor is an independently installable Bun workspace and cannot import the root private package, patch 0003 mirrors only the minimal frame/hello wire subset; root fixtures and bidirectional tests are the compatibility authority. Patches must not introduce a second `AgentSession`, RPC/TUI hot switching, Slash-command automation, or PTY semantic parsing.
