# OMP 18.3.0 Runtime / Studio migration

Status: local implementation and acceptance complete for 18.3.0-studio.12; prepared for Studio 0.1.7 publication at the user's request. Paid/cloud/production-write acceptance remains pending explicit authorization; see the final decision matrix.

## Fixed baseline and decisions

- Studio source baseline: `c16793b` / application `0.1.6`; release version: `0.1.7`.
- Original Runtime: `18.2.5-studio.9`, upstream `37273117021129e96bd05d8277b140ec3fd61990`.
- Target: released `v18.3.0`, `62bc57be1b03ef0802a33cf7f5f530e534527531`; do not follow main.
- Backup: `backup/2026-09-24/omp-18.3.0-221533/`, original paths and checksum manifest.
- Preserve the existing untracked HTML and browser sidebar plan. Browser sidebar work is deferred.
- Windows desktop is the full acceptance target. Web remains compatible and reports unavailable device capabilities honestly.
- Single AgentSession, typed Bridge, no slash/ANSI/keyboard control automation.
- All new reading surfaces require preview fixtures and real/empty/unavailable states. Demonstration actions never mutate Host state.

## Approved feature checklist

- [x] Pin, four seam groups, overlay, authentication/settings/SDK compatibility; preserve existing behavior.
- [x] All new model roles, type-filtered candidates, ordered fallback chains and migrated web/judge settings.
- [x] Find/wait/process/agent tool presentation; exclude non-file writes from Changes.
- [x] Full services management in Agent Hub: saved definitions, create/start/stop/restart, readiness/logs/input, lifecycle modes.
- [x] Account/quota/reset status, without full model-account administration.
- [x] Claude reset consent: initially unset; Yes explicitly remembers automatic use; No remembers disabled; cancel consumes nothing; settings can revoke.
- [x] General annotations for replies, selections, files and diffs; edit/delete/undo, stale anchors, prompt/review integration.
- [x] Full batch judgment controls, progress/results, failed-item retry and export.
- [x] Image/video generation UI, provider-supported parameters, asynchronous job recovery and honest cancellation.
- [x] Recording/import transcription, Composer draft insertion, TTS playback/save.
- [x] Live realtime audio with authenticated desktop input boundary, same-session delegation, transcript/mute/stop and resource cleanup.
- [x] Benchmark UI with live structured progress and offline token counting.
- [x] Real PTY recording/playback and .ompcast import; native TUI recording only when a TUI actually exists.
- [x] Full Skillshare use/publishing/maintenance/token management with concrete review before remote writes.
- [x] Prompt templates and MCP startup readiness settings/status.
- [x] Managed artifact library associated with workspace/session; configurable directory, new writes only on directory change.
- [x] Session deletion retains new managed artifacts by default; explicit cascade option; exported copies are untouched.
- [x] Documentation, full local gates, actual Windows Runtime, signing, isolated install/rollback, GUI/performance acceptance and local installer audit.

## Implementation boundaries

Services default to session ownership; saved definitions do not start automatically. Persist/detach is explicit. Runtime's native broker remains the only supervisor. Service actions carry scope and instance generation.

GUI placement follows existing design: services in Agent Hub, registry in Skills, annotations next to source, benchmarks in Models, tokens in usage, settings in Settings, recording in Terminal. Media gets a dedicated page and Composer shortcuts. No application-wide visual redesign.

Large files/audio do not enter snapshots, ledgers or transcript reducers. Use authenticated private media/file channels and opaque artifact IDs. New asynchronous tasks return IDs, provide bounded event/page access, and avoid duplicate paid or publication requests on retries.

Live stops and releases capture on session change, window hide/close or Runtime loss. It does not resume recording automatically. Native output follows the system device. Normal desktop Runtime has no TUI: do not create an extra AgentSession or artificial TUI to record it.

Use upstream native interfaces, including actual support for image `?q=`. Do not infer final APIs solely from release notes. Unsupported remote video cancellation means stop waiting locally, not claim remote cancellation.

## Acceptance and release boundary

Run relevant subsystem tests, then root `npm run check`, source and patch replay gates, metadata, Windows build/probe, isolated install/rollback, GUI/preview tests, existing streaming performance thresholds, and installer audit.

No real paid requests, production registry publishing, or reset-credit use during initial acceptance. After local validation, report a concrete live-service test matrix with available account requirements and estimated costs for user approval. Report unverified external paths explicitly.

The initial implementation scope excluded publication and a Studio version bump. On 2026-09-25 the user explicitly requested a completed changelog and publication, authorizing Studio 0.1.7 and the existing stable Windows x64/ARM64 release workflow. Do not install system-wide or replace global OMP as part of this release. This publication approval does not authorize paid/cloud/production-write acceptance.

## Work log

The following entries are chronological checkpoints. Earlier pending-work statements were resolved by the final acceptance evidence below.

- 2026-09-24: confirmed clean tracked root/vendor baselines and created the pre-edit backup. Found that the legacy prepatch verifier incorrectly required empty canonical overlay/series and Bun 1.3.14; adapt it to verify an unmodified vendor tree with the maintained overlay stored separately.
- Built the unpatched v18.3.0 Windows native addon and executable with the existing isolated Bun 1.4.2 and pinned Rust nightly. Prepatch gate passed, including root check, upstream source tests and binary smoke. Log: `%TEMP%/omp-1830-prepatch.log`.
- Transplanted 37 seam files with seven semantic conflict resolutions. Preserved both native attachment source notices and Studio prepended messages, native job cancellation states and Studio change notifications. Pristine target seams additionally backed up in `backup/2026-09-24/omp-18.3.0-pristine-seams-223109/`.
- Generated `18.3.0-studio.1`; full patch replay with `--skip-workspace-check` passed and restored vendor clean, then reapplied for further feature development. Log: `%TEMP%/omp-1830-replay.log`. This is an intermediate version, not the final binary.
- Native authentication and asynchronous OMFG validation migrated; Runtime typecheck and targeted BTW/OMFG/session-compatibility/job tests passed. Judge settings now expose `modelRoles.judge`; root accepts old snapshot fields for backward reads without exposing them on new Runtime UI.
- Added model-kind preservation, role candidate filtering, initial new-role previews, and managed artifact storage. Four artifact tests passed (directory changes, session detach, partial writes, concurrent completion/pagination). Artifact streaming/import/export and GUI library are being integrated; not yet fully accepted.
- In progress after studio.1: typed native reset-consent callback, proxy rebinding across worker recycling, reset/MCP/judge settings, artifact IPC and library UI, new tool display classification. Regenerate and rerun final gates after these changes; most approved feature checklist entries above remain pending.

### 2026-09-25 implementation checkpoint

- Backup for this wave: `backup/2026-09-24/omp-1830-workbench-231848/` (97 files, including pristine native launch files). No user files were removed or overwritten.
- Added the typed Workbench operation family through protocol, validator, Bridge dispatcher/arbiter, Desktop command adapter, client and Renderer. Native service management reuses the existing broker and ToolSession; no additional supervisor or AgentSession. Named mutations are serialized in the broker and fenced by native instance identity. Older brokers fail closed for GUI control. Nonblocking starts let users stop a service while its readiness condition is pending.
- Agent Hub now has services, readiness/state, bounded logs, stdin, explicit stop/restart/lifetime confirmation, create form and encrypted saved configurations. Saving does not launch. Preview actions stay local. Services UI still needs full desktop interaction/visual acceptance.
- Added offline token counting to the token panel, native model catalog pagination and role candidates, role-keyed fallback edits/reordering, kind metadata through discovery/import/YAML, and new-kind preview fixtures. Web search writes `modelRoles.web` + `retry.fallbackChains.web`, distinguishes native defaults from an explicitly empty chain, and removes retired provider settings. Host kind-role migration mirrors the pinned native source. New writes preserve unrelated YAML comments.
- Claude reset and MCP startup settings are rendered. Native mock tests verified Yes/redeem-and-remember, No/remember-disabled, cancel/unchanged and interaction failure/no redemption. No real reset calls were made.
- Session deletion now retains managed artifacts by default, with an explicit cascade checkbox. Persisted deletion policy fences streams already in flight. Exported copies remain untouched. Private media streaming supports Range and HEAD.
- Validation so far: model adapter/migration tests **113 passed**; artifact storage/streaming and secure service definitions **8 passed**; native service fencing, reset consent, modes/settings and launch protocol tests **41 passed**. These are component checks, not final acceptance. Root checks reached Renderer tests; 10 outdated/UI assertions were corrected and all 23 affected tests passed. A later full run reached 667 passing Renderer tests, with two heavy settings-page cases exceeding 5 seconds under parallel load; those specific cases now use a 15-second timeout. Final full check remains pending.
- Captured intermediate `18.3.0-studio.4` with regen, including new Workbench/account protocol, service and test files. `captureOverlay()` visits canonical paths only: seed each new vendor-only Studio file into the same canonical overlay path before regen so it is included. The built executable is still the earlier unpatched baseline; do not ship it as the final Runtime.
- Account/quota/reset status is wired in the Models roles panel. Opening reads local identities; an explicit refresh calls native quota/reset listing, never the auto-redemption heartbeat. One native test (13 assertions) verifies coalescing, no redemption, no secret/credit-ID leakage and ambiguous organization isolation. Services UI tests (2) verify preview isolation and save-without-start. Account-enabled root build and Renderer/Runtime typechecks passed; fixed preload API whitelist test passed (15).
- Remaining major work: annotations; batch judgments; media generation/transcription/TTS/Live; benchmark; recordings; Skillshare; prompt templates and MCP readiness status; final source/patch replay, patched binary/signing, isolated installer and Windows GUI/performance acceptance. Do not mark the overall upgrade complete yet.

### Annotations and batch judgment checkpoint

- Task snapshots: annotations wave in `backup/2026-09-25/omp-annotations-003639/`; subsequent annotation finalization and batch work in `backup/2026-09-25/omp-1830-batches-011726/`.
- General annotations now capture replies, selections, workspace text files and native-filtered diffs. Exact source versions, selection offsets, edit/delete/undo, scoped drafts and managed immutable snapshots are implemented. Preparation rechecks sources and the overall session context; changed or foreign sources require explicit stale-snapshot approval. Native prompt builders prepare text for the main Composer without sending or calling a model. The dialog restores focus and names stale sources.
- Added bounded artifact text save/read operations with SHA256 verification and annotation reopening. Artifact text tests: 6 passed; native annotation tests: 3 passed; GUI annotation tests: 2 passed.
- Batch judgments have typed list/create/read/cancel/close/retry operations, active-session fencing, bounded inputs/pages, shared native Judge concurrency/accounting, and failed-input-only retries as separate native jobs. A small seam adds non-consuming observation and retry hooks; eval's single drain cursor is untouched. Agent Hub has progress, result probabilities, request review before paid actions, pagination, attach, cancellation, and multipart JSON saves to the artifact library for export. Preview actions remain local.
- Root build and Renderer typecheck passed after batches. Protocol suite: 86 passed. Batch GUI tests: 2 passed. Native Studio batch tests: 2 passed / 16 assertions; native types passed. Combined native regression: 14 passed with the upstream Python prelude case exceeding its 5-second default; separate longer-timeout investigation is in progress. No real paid calls were made.
- Windows GUI acceptance, complete replay and patched binary still remain pending. Major remaining implementation: media generation/transcription/TTS/Live; benchmark; recordings; Skillshare; prompt templates and MCP readiness.

### Templates, MCP readiness and benchmark checkpoint

- The upstream Python judgment prelude test passed alone with a 30-second ceiling (actual 1.9 seconds). Its earlier failure was the default 5-second timeout under combined test load.
- Prompt templates now list the active Runtime's loaded user/project templates, show content and source, expand arguments with the native pure template function, and insert reviewed text into the main Composer without sending. Template identity/version and session fences prevent stale application. MCP readiness reads the native manager's startup and tool state with a bounded observation, separately from Host configuration probes; errors/configuration/credentials are not forwarded. Native tests: 2 passed; related Renderer tests: 6 passed; root build and typechecks passed.
- Benchmarks now use the native chat/prefill/generation/mix/cache workloads with a structured progress callback and AbortSignal seam. Models page shows per-model progress, ranked TTFT/prefill/decode/end-to-end throughput, per-kind distributions, individual measurements and cache evidence. Starting requires a concrete reviewed request count; only exact chat model selectors are accepted. JSON reports save to the artifact library. One run at a time, bounded history; session switch/disposal cancels work and stops queued provider calls. Worker recycling is blocked while a benchmark is active. Tests use synthetic streams only.
- Benchmark wave backup: `backup/2026-09-25/omp-1830-benchmark-014521/`. Native benchmark regression: 40 passed / 185 assertions. Related Renderer tests: 10 passed. Protocol suite: 88 passed. Captured `18.3.0-studio.7` with regen.
- Full root `npm run check` passed at this checkpoint (`%TEMP%/omp-1830-stage-check4.log`), including 675 Renderer tests and 379 Desktop tests. This is still source/local acceptance, not final Windows GUI, binary or external-service acceptance.
- Remaining major implementation: shell recording/ompcast playback; image/video/transcription/TTS/Live; Skillshare. Final replay, patched executable/signing, isolated install/rollback, GUI/performance checks and installer audit remain required.

### Shell recordings and initial browser acceptance

- Backup: `backup/2026-09-25/omp-1830-recordings-020539/`. Added authenticated, fixed-name terminal recording IPC with window ownership. Real PTY output/resize events stream to the artifact library as `.studiocast`; input keystrokes are not recorded. Pipe fallback is explicitly unavailable. Start requires an on-screen review. Size, duration, event count and queue bounds stop recording and save the captured prefix while leaving the shell running. Terminal exit/window teardown finalizes recording; application shutdown awaits the flush.
- Added read-only `.ompcast`/`.studiocast` playback with a bounded parser Worker, imported-file support, seek/speed controls, native viewport/patch/history/resize semantics and truncated-final-line recovery. Playback never opens a PTY or forwards input. Files stream through the private artifact protocol rather than the Host command ledger.
- Synchronized Desktop and packaged Renderer CSP for artifact image/audio/video/fetch access; cross-origin fetch permission is limited to the Renderer origin. Related Desktop tests: 66 passed; recording parser tests: 2 passed; lifecycle tests: 14 passed, including flush-before-shutdown. Renderer/Desktop typechecks and Renderer production build passed.
- Used the Playwright skill with a disposable component harness. A real Chromium browser verified Shell playback completion and backward seek, imported native `.ompcast` row patches/resize, benchmark ranking display, and annotation initial focus/add-note/insertion into a local Composer without Host calls. Inspected screenshots under `output/playwright/`. The harness needed the Vite React preamble; this was only a test harness setup issue. Browser was closed after checks. Full Electron/private-protocol/real-PTY acceptance remains pending.
- Current major implementation still outstanding: image/video generation, audio recording/import/transcription/TTS, Live realtime audio, and full Skillshare. Final patched executable and installer acceptance are still outstanding.

### Media implementation checkpoint

- Backups: media wave in `backup/2026-09-25/omp-1830-media-023551/`; lifecycle and input hardening in `backup/2026-09-25/omp-1830-media-hardening-031821/`.
- Typed image/video/STT/TTS tasks reuse native provider clients and role chains. Models and transport parameters are explicit, paid submission is reviewed, video polling recovery retains the original provider job ID, and uncertain submission never resubmits automatically. Native local STT accepts normalized 16 kHz mono WAV; local speech keeps native WAV substitution.
- Private current-user file channel stages single-use grants, streams and verifies outputs into the artifact library, deduplicates promotion and respects deletion fences. Public Desktop and Host/Web inputs reject private grants. Intermediate outputs are removed after promotion; session deletion promotes unread outputs by default, explicit cascade removes them.
- Renderer has media workbench, Composer shortcuts, recording/import normalization, transcription draft insertion, audio playback and file previews. Browser upload is window-owned, chunked with acknowledgement/backpressure and bounded; audio metadata duration is checked before full decode. Hidden/unmounted/session-changed capture releases microphone tracks, including late permission responses. Shared Web honestly reports missing private file preview/capture.
- Current component results: native media 2 tests / 27 assertions; Desktop file lifecycle 2 tests; protocol 89 tests; capture/preflight/workbench UI 5 tests. No paid model calls or reset-credit consumption. Final gates, real Electron fake-device acceptance, Live and Skillshare are still pending.

### Live audio checkpoint

- Backup: `backup/2026-09-25/omp-1830-live-032817/`. Added a narrow input factory to native LiveSessionController; the CLI still defaults to native AudioCapture. Studio uses the same AgentSession and native Codex OAuth/WebRTC controller and delegation path.
- Live prepare/start/status/mute/release operations are session-fenced. Current-user private descriptors authenticate one Main-owned named pipe connection; descriptor paths/tokens and float PCM never enter Bridge payloads or ledgers. Preparation expires without any provider connection. Window-owned IPC enforces sequence, bounded frames, backpressure, visibility and cleanup. AudioWorklet bounds its queue to 100 ms.
- UI reviews microphone/voice/account use before connecting, shows bounded coalesced transcripts and levels, supports explicit mute/stop, and has isolated preview and honest Web unavailable states. Hide/minimize, page leave, session change, device loss and Runtime socket loss stop capture; no automatic reconnect. Worker recycling is blocked while Live is active.
- Local checks: native Live audio/control 5 tests / 37 assertions; Desktop PCM/preload 16 tests; Live UI/capture 3 tests; Renderer build passed. Real Chromium with fake media produced 53 PCM frames in the test interval and confirmed detach. MediaRecorder output normalized to 44,204-byte 16 kHz mono PCM16 WAV. Screenshot reviewed: `output/playwright/live-audio-preview.png`. This is isolated browser/component acceptance, not final full Electron or paid-service acceptance.
- Still pending: Skillshare, full final gates/replay, patched Windows binary/signing, isolated install/rollback and full desktop/performance/installer acceptance.

### Skillshare implementation checkpoint

- Backup: `backup/2026-09-25/omp-1830-skillshare-035140/`, including pristine native Skillshare client and seam registry. The only new native client seam is an optional lifecycle/deadline AbortSignal; default CLI behavior remains unchanged.
- Native typed service supports status, home/search/package versions/files/provenance, installed manifests, install/restore/update/uninstall, pack/publish, local version bump, Claude .skill import-and-publish, tags, yank/restore, deprecation, owners, token listing/creation/revocation and explicit refreshSkills. It does not simulate slash commands or parse terminal output.
- Every write has a session/workspace-bound, expiring, digest-checked review. Install resolution and script file listings are frozen for execution; packed bytes and local manifests are checked again, local metadata is backed up, and each review is consumed once. Failed remote connections are reported as uncertain and never automatically retried.
- New tokens travel through a private current-user, one-time, two-minute handoff to a named Desktop IPC. No token bytes enter the public contract, ledger or snapshots. UI displays only on explicit reveal/copy, clears plaintext on hiding/tab/session changes and does not automatically store it. The user explicitly confirmed one-time display, manual copy and no automatic persistence.
- Skills UI now includes native registry discovery, install and management forms, exact file/script/secret review, progress and result recovery, and token metadata/reveal. Preview actions are isolated; Web disables token creation without the private desktop channel.
- Component checks: native Skillshare 4 tests / 33 assertions; Desktop token/preload 16 tests; Skillshare GUI 2 tests. Typechecks and final combined gates remain to be completed after capture. No production registry mutations occurred.

## Changes from 18.2.5 to the fixed 18.3.0 target

This is a fixed release comparison against the checked-out upstream commit. Source: vendor `packages/coding-agent/CHANGELOG.md` and the pinned native implementations.

| Release | Main changes relevant to Studio | Studio treatment |
|---|---|---|
| 18.2.6 | Clipboard responsiveness, stable recall prompts, Windows auth token creation fixes | Native fixes inherited |
| 18.2.7 | Semantic find, judgment batches/jevify, model kinds and image/web/speech/dictation/judge/memory roles with ordered fallbacks, system prompt templates, native OpenRouter images | Tool presentation, batch UI, role/kind filtering and fallback editor; native configuration preserved |
| 18.2.8 | Expanded browser automation, cloud STT, video analysis, custom native judges/headers; faster credential scanning and LSP cancellation | STT/parameters and model kinds adapted; browser sidebar deferred, native browser tool retained |
| 18.2.9 | Claude saved resets, OAuth metadata refresh, discovery/fallback resilience, plugin MCP variable expansion, session/artifact and memory fixes | Consent through InteractionDeck; initially unset, no implicit redemption; status/settings exposed |
| 18.2.10 | Benchmark rankings/prefill metrics, native terminal recording/playback, judgment progress | Benchmark UI, batch observation, actual PTY recording and recording parser/player |
| 18.2.11 | Eval/Todo/schema, TTSR, browser and first LSP diagnostics fixes | Native fixes inherited |
| 18.3.0 | Services and proc/agent protocols, offline toks, annotations, MCP startup readiness, terminal OAuth/account metadata, Anthropic snapshot compaction | Typed service controls, annotations, tokens, readiness/account views; native compaction inherited |

Breaking changes accounted for: deprecated hub replaced by wait/write/proc; process cancellation uses explicit kill targets; removed bash env parameter and irc.timeoutMs; new edit/find/replace and insert headers; model-selected image/search overrides and awaited native judgments. Non-file proc/agent writes are excluded from file Changes. Release prose about image `?q=` conflicts with the pinned implementation; Studio preserves the actual native `?q=` behavior and its upstream tests.

Some approved surfaces (Live, Skillshare, managed artifacts and media orchestration) expose native functionality that existed before this version span; they are new Studio integrations, not all new upstream in 18.3.0. Apple Foundation Models discovery is platform-native and remains unavailable on Windows.

## Final local acceptance evidence

- Canonical patchset: `18.3.0-studio.12`; upstream `62bc57be1b03ef0802a33cf7f5f530e534527531`. Root `npm run check` passed with **687 Renderer tests** and **388 Desktop tests**. Source/patch replay passed all four seam groups and 114 overlay files; vendor was restored clean and then reapplied. The patchset includes Broker project-path canonicalization for Windows 8.3 temp paths.
- Metadata gate: **47 passed** after updating the old-version assertion and synchronizing signed packaging with all **49 Workbench operations**. Signed binary probe matched capability and command hashes.
- Patched Windows executable built with isolated Bun 1.4.2 and pinned Rust nightly; native smoke and authenticated Bridge probe passed. Local Ed25519 artifact: `packages/runtime-installer/dist/artifacts/win32-x64/18.3.0-studio.12/`.
- Isolated install/self-check/rollback/reactivation passed against available signed baseline `18.2.5-studio.6` (original source baseline was studio.9; no studio.9 artifact was in the local cache). Global OMP and the operator's installed runtime were not replaced.
- Real Electron with context isolation and sandbox: fake-device PCM reached the private pipe; hiding closed it and ended microphone tracks. Recording/import produced 16 kHz mono PCM16 WAV, streamed through private `omp-artifact` Range requests and played successfully. Real PowerShell PTY recording saved output and resize events as `.studiocast`. Report: `output/playwright/electron-media-report.json`.
- Full desktop composition connected the signed binary and read media models/tasks, Live state, benchmarks, templates, MCP readiness, services, tokens, installed Skillshare and accounts through the authenticated Bridge. The media page opened through the real menu. Cold startup now uses the same 30-second deadline as the compatibility probe. Report: `output/playwright/full-desktop-report.json`.
- Streaming gate passed all 18 checks on repeat. First run under concurrent builds had layout ratio **2.73 > 2.50**; no threshold was relaxed. Production Electron render/visibility benchmark passed, median scripting **236.8 ms** for its 100-block sample; hidden publication and worker/queue cleanup passed.
- Local NSIS build/audit passed in `outputs/omp-1830-acceptance/`: Runtime, preload, Renderer CSP and public verification key present, no private key. Setup is approximately **193.5 MiB**. This is a local acceptance build using the local key, not a published or Authenticode-signed release. The final repack includes the cold-start timeout correction. Packaged entry/media/startup code and the entire Renderer were compared byte-for-byte with the final build.
- The user explicitly confirmed Skillshare token policy: display once, manual copy, no automatic persistence.

## External acceptance decisions

No paid model/media/Live requests, production Skillshare mutations or reset redemption were used. These small live test sets require selected accounts/models and explicit approval:

| Test set | Proposed actions | Required decision/input |
|---|---|---|
| Cloud media | One image; one shortest supported video with stop/resume of that same job; one short transcription; one brief speech output | Provider/model selections and total spending cap; exact cost depends on the selections |
| Live | One short Codex OAuth call; mute/unmute; same-session delegation of a harmless read; hide-window disconnect | Authorized account, microphone and maximum call duration |
| Judge / benchmark | One two-item judgment batch and one single-model minimum-size benchmark | Models and request/spending limits |
| Skillshare writes | Disposable namespace: publish once, set/remove a non-latest tag, yank/restore, deprecate/clear, add/remove an approved test owner, create/revoke a restricted token | Test registry/namespace and approved owner; no production package by default |
| Claude reset | Real redemption is an optional separate test; status and consent already have local coverage | Explicit permission to consume one eligible reset, otherwise retain mocked acceptance |

Confirmed policies remain: browser sidebar deferred; services default to session ownership and never auto-start on save; old artifact locations stay indexed; session deletion retains artifacts unless cascade is selected; exports remain untouched; Skillshare tokens are shown once and manually copied.

Final local gate log: `%TEMP%/omp-1830-final-check3.log` (687 Renderer / 388 Desktop tests). Patch replay: `%TEMP%/omp-1830-final-replay3.log`. Metadata: `%TEMP%/omp-1830-final-metadata5.log`. Installer audit: `%TEMP%/omp-1830-final-pack4.log`. These local checks used application 0.1.6 and did not alter the global installation. Studio 0.1.7 publication rebuilds and verifies both architectures with the production release signing identity in GitHub Actions; the local development-signed installer is not a release asset.
