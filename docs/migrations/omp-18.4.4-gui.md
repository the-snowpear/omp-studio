# OMP 18.4.4 GUI implementation

**Local delivery complete (2026-09-30): Runtime 18.4.4-studio.31, Studio 0.1.7.** The approved local scope is implemented and validated. Real commercial IDA, paid model/Judge calls, voucher redemption, physical Windows IME interaction and remote publishing are not claimed as verified. See the final evidence section below.

Baseline: upstream 8ac1309bd8adaddc891eeb389c545345073875be, Runtime 18.4.4-studio.18; preserve the existing uncommitted upgrade. User approved the complete GUI plan on 2026-09-30. Backup location is recorded in `%TEMP%/omp-1844-gui-backup-path.txt`.

## Decisions

- Runtime-owned queue; edit takes a message back only after confirmed removal. Preserve/merge existing drafts; no uncertain resend.
- Full IDA operations panel in Capabilities; no IDA installation or real database acceptance required on this machine. Browser sidebar remains deferred.
- Local N-gram enabled by default, no automatic foreign-history import or model download. Keep existing explicit configuration. Separate Studio corpus; learn sent input only.
- Cache warming follows native configuration/default idle. All history in a standalone Stats page; native worker, no extra AgentSession or public HTTP.
- Complete real/preview data, Chinese/English, typed contracts, bounded streams, lifecycle cleanup and capability gating.
- Local Electron/performance/Runtime/signing/installer acceptance. No external paid requests, redemption, remote publishing or replacement of current installation. Keep Studio application version unchanged.

## Implementation checklist

- [x] Stable grouped Runtime queue, exact cancellation/takeback, client/UI migration
- [x] Ask answer/note image attachments and private transfer lifecycle
- [x] Subagent BTW target, histories and entrypoints (native protocol and Electron page acceptance)
- [x] Service-tier descriptors, per-session picker and configured role tiers
- [x] New typed settings, provenance/persistence and native cfg approval host
- [x] Skill identities/namespaces across list, mentions, serialization and transcript
- [x] Search/media routing descriptions and actual models
- [x] Typed paged resource viewer and non-file Changes exclusion
- [x] Actual/estimated/unknown cost semantics
- [x] Isolated native prediction corpus/backend/settings and Composer ghost text (automated acceptance; real Electron acceptance remains below)
- [x] Native benchmark phases, costs, cancellation and export
- [x] Host-owned native statistics worker, filters and complete statistics page (native worker and Electron page acceptance)
- [x] Frustration estimate/review/run/cancel/retry lifecycle (isolated fake Judge; no paid requests)
- [x] IDA backend, complete operations panel and unavailable state
- [x] Full checks/replay, real Electron + performance, signed Runtime, isolated rollback, local x64 installer

## Work log

- Prepared baseline backup (991 source/config/doc files). Implementation in progress; no GUI feature is accepted yet.

### 2026-09-30 implementation checkpoint

The full plan is **not delivered**. Runtime source is now `18.4.4-studio.22`; application version stays `0.1.7`. No new binary has been signed or packaged, and the existing installed application has not been replaced.

Implemented source paths:

- `session-gui` contracts and native service: stable grouped queue IDs, exact cancellation, takeback through private media artifacts, identity-preserving follow-up → steering, session tier descriptors and changes, resolved skill inventory. Desktop promotes recovered image artifacts before returning their metadata.
- Composer real queue reads Runtime snapshots; the automatic Renderer flush/retry effect was removed. Existing drafts require a merge decision before takeback; consumed messages are not copied. Draft recovery retains failed image reads for retry. Queue UI and tier picker have Chinese/English text; existing preview queue and new tier fixtures remain local.
- New settings rows expose native handles, provenance and session/user persistence. `cfg://` registers the existing typed interaction gateway with once/session/deny and expiry. Native defaults are covered by an isolated-settings test.
- Runtime skill identities feed mentions and the drawer; transcript parsing preserves one namespace separator and disambiguation suffixes. Source scope comes from native metadata, with an explicit Runtime category when unavailable.
- Agent spawn accepts an independent optional `solutionSpace` through the public contract, Desktop validation, Bridge and native task launcher.
- Benchmark detailed mode uses upstream single-user, parallel and adaptive-prefill execution. Workload phases are distinct from cold/warm cache phases; reports retain phase aggregates, failures, cancellation and export.

Validation evidence (local temporary logs, not release artifacts):

- Complete repository gate passed: Renderer 691 tests and Desktop 388 tests, plus the package suites (`%TEMP%/omp-gui-check2.log`). Later targeted Renderer typecheck passed after default corrections and removal of unused flush state.
- Native coding-agent `tsgo` passed. All 51 `studio-*.test.ts` suites were run sequentially; the only failure was an old exact activation assertion missing the new provenance field. Its updated 27-test suite passed on rerun. New queue grouping/steering, detailed benchmark, settings-default/provenance and Renderer queue/tier tests passed without paid model calls.
- Runtime source pin verification passed. All four seam patches applied to an independent temporary Git index based on the pinned upstream tree; the resulting tracked tree matched the vendor working files. The standard `omp:verify:patches` wrapper refused the intentionally dirty vendor, so its full clean-checkout lint/check sequence has **not** passed for this GUI checkpoint.
- Artifact metadata suite: 47 passed (`%TEMP%/omp-gui-metadata.log`). This does not verify a new signed binary.

Still required before acceptance:

- Ask question/note attachments and expiry cleanup; target-scoped child BTW.
- Complete skill identity treatment in capability management, queue pagination and broader queue reconnect/receipt-race acceptance.
- Dedicated prediction daemon/corpus/privacy path, opt-in import/download and Composer IME/key handling. The settings row alone is not prediction implementation.
- Native Stats worker, filters/cache/sync, Frustration review and job lifecycle; full IDA operations and version-fenced edits.
- Resource pagination/viewer, comprehensive actual/estimated/unknown pricing, remaining MCP/Bedrock/search/media configuration surfaces and quota/wrapping-up acceptance.
- Real Electron UI/IME/lifecycle acceptance, performance gate, full clean patch verification, signed Runtime, isolated install/rollback and local Windows x64 installer.

### Prediction continuation checkpoint

Runtime source is now `18.4.4-studio.25`. The earlier `.22` checkpoint above is historical. No new Runtime binary or installer was built in this continuation.

- Native prediction uses the original engine and daemon under `<agentDir>/studio/prediction`, with foreign-history bootstrap disabled and automatic weight download disabled for this client. Native `auto` remains local N-gram; explicit existing settings are preserved.
- `prediction.query` is a client query → direct controller/Bridge read. The dispatcher returns an ephemeral result before replay/ledger handling and does not revive a dormant main Worker. Unsent drafts never enter the learning DB, command ledger or retained Runtime receipts.
- Actual user-message completion events feed the separate corpus. Submissions are deduplicated. Query and corpus mutations share a native cross-process file lock. Clear stops the daemon, removes only the Studio prediction state and securely clears its history database.
- Settings offer explicit reviewed clear, Claude/Codex history import and pinned/checksummed SmolLM2 download. Refresh only reads state; downloads are cancellable and keep the Runtime busy until settled. Model weights were **not downloaded** during acceptance.
- Composer ghost text lives outside its editable document. Queries use a 200 ms debounce, one in-flight request and document versions; Tab accepts and Escape hides. IME composition and mention/command menus take precedence. Automated tests cover draft privacy, deduplication, clear, no receipt retention/replay, no Worker revival, Tab, IME, late results and preview actions.
- Worker slot unsubscription now detaches the listener from the current replacement Worker, with a lifecycle regression test.
- Stats now has request-local model/provider/folder filters inside native rollup queries. Tool project filters use raw native tool facts because the tool rollup lacks a folder dimension. Tests verify filtered results before and after rollup refresh. **The Host-owned statistics worker, statistics GUI and Frustration remain unimplemented.**
- A stats test isolation mistake briefly inserted three synthetic messages and two synthetic tool rows into the local stats DB. All five were removed by exact IDs, timestamp and synthetic fields; real history was not deleted. Recovery evidence is under the task backup directory. Tests now assert the DB path is inside their temporary namespace before any insertion.
- Patch generation previously trimmed trailing whitespace-only context from `git diff`, corrupting a final hunk. `run(..., { trim: false })` now preserves raw diff bytes; regen remains the only patch writer.

Validation: full repository gate passed (694 Renderer tests, 388 Desktop tests, package suites); all 53 native `studio-*` suites passed in an isolated test profile; native TypeScript passed; 48 metadata tests passed. All four regenerated seam patches replayed in a temporary Git index, and the replayed tracked tree matched the vendor tree. Logs: `%TEMP%/omp-predict-check.log`, `omp-prediction-runtime-all.log`, `omp-predict-native-final2.log`, `omp-predict-metadata-final.log`. Real Electron/IME, signed Runtime and installer acceptance are still outstanding.

### Statistics continuation checkpoint

Runtime source is now `18.4.4-studio.26`; application version remains `0.1.7`. This supersedes the historical statements above that statistics and Frustration are unimplemented. No new binary or installer has been built.

- The sidebar Statistics page provides overview, models/providers, costs/quotas, tools/errors, projects/sessions and Frustration. It defaults to all local history, supports native time/model/provider/project filters and supplies separate preview fixtures, including sessions and unknown pricing. Actual billing is not available from the statistics DB; displayed amounts are explicitly API-equivalent estimates.
- Host owns one private stdio worker selected by `__omp_worker_studio_stats` in the managed Runtime. No AgentSession, HTTP server or iframe is created. Disk cache appears first; background reads/sync use native SQLite aggregation and synchronization locks. Runtime maintenance and Host shutdown dispose the worker.
- Frustration reads do not resolve or invoke Judge. Explicit estimate/start actions freshly resolve the configured standalone Judge using the worker's working-directory settings. Quotes expire after five minutes, bind the filters and exact pending text hashes, are single-use, and are rechecked under the native synchronization lock. Host command receipts enforce idempotency.
- Native cancellation propagates to Judge requests; another analysis cannot start until in-flight work drains. Completed verdicts remain in the native DB. Native runs expose exact exhausted hashes so failed-only retries work even after the native circuit breaker stops a run, without including unattempted, cancelled or newly added messages. Retries require another estimate and confirmation.
- Public protocol validation rejects internal hash filters, unexpected result fields, invalid counters and malformed prices. The worker retains the originating job filter and treats unpriced estimates as unknown. Per-session error totals are unavailable upstream and render as a dash.
- Targeted validation passed: five isolated native tests (50 assertions), native `tsgo`, desktop cache/private-worker test, Host query/idempotency test, Renderer preview/confirmation test and protocol boundary test. Native tests guard the DB location before writes and use synthetic Judge implementations only. Source pin and four-patch replay against an isolated Git index passed.

Remaining delivery includes IDA, Ask images, subagent BTW, resource pagination, remaining settings/cost surfaces and the overall Electron/performance/signing/installer acceptance. The full plan is not delivered.

### MCP and Bedrock configuration continuation

- MCP inventory now exposes the native per-server `instructions` policy (default true) and whether its owning configuration is writable. The Capabilities page includes a toggle in real and preview modes. `mcp.setInstructions` writes only the effective native source in the specified scope, preserves transport/arguments/secrets/enabled state, rejects shadowed or non-native owners and reports new-session activation. Old Host records disable this control.
- Custom models and catalog overrides expose a tri-state Bedrock Messages compatibility option. It writes the native `compat.bedrockMessagesApi` field, preserves unrelated compatibility flags and mirrors the actual YAML write in the form's preview. This flag fits Anthropic Messages request bodies to Bedrock constraints (tool `strict` and request metadata); it does not change the API endpoint or credentials.
- Focused checks passed: 13 MCP adapter tests, 8 statistics/capabilities UI tests, 108 model-adapter tests and the YAML preview suite. Native Stats source, type checks, isolated tests and four-patch replay remain verified at `18.4.4-studio.26`. All 48 artifact metadata tests passed; this is not signed-binary acceptance.
- The full gate after statistics passed (695 Renderer tests, 389 Desktop tests and package suites). A subsequent gate caught the new Bedrock YAML test running against the earlier built client-contract; rebuilding that package made the targeted suite pass. The final full gate is recorded separately below once complete.

No paid model analysis, real IDA operation, reset-credit redemption, remote publication or installed-app replacement was performed. IDA/Ask/BTW/resources and final Electron, performance, signing and installer delivery remain outstanding.

Final evidence for this continuation:

- Runtime source is **18.4.4-studio.27**, with upstream still pinned to 18.4.4. The final increment includes the native statistics test helper: on Windows only, an `EBUSY` directory cleanup retains the fixture and lets remaining cleanup hooks run; functional assertions are unchanged. The unmodified helper previously failed all 24 upstream cases during teardown and left one Judge reset hook unexecuted. All 24 cases then passed (108 assertions) from an OS temporary working directory.
- Desktop checks the signed managed Runtime manifest version before passing the private statistics worker selector. Known 18.4.4 Studio patches from `.26` support it; older and unknown versions are refused before process creation, followed by a protocol handshake for supported binaries.
- Final `npm run check` passed: **698 Renderer tests, 390 Desktop tests**, and every package suite. Log: Git Bash `/tmp/omp-gui-stats-settings-gate.log`. All five Studio statistics tests passed (50 assertions); native coding-agent `tsgo` and four-patch replay passed after `.27` regeneration. All **48 metadata tests** passed (`/tmp/omp-stats-metadata-final.log`). Upstream statistics log: `%TEMP%/omp-stats-upstream-final.log`.
- The initial cleanup of repository-root `studio-stats-worker-kTQSyq` and `studio-stats-worker-F3LNMJ` was rejected by automatic approval with `blocked by policy`; these directories remain excluded from source changes and deliverables. Locked fixtures from the later upstream tests remain under the OS temporary directory.

This is a source-and-automated-test checkpoint, **not the full GUI delivery**. No new signed Runtime binary, Windows installer or real Electron acceptance result is claimed.

### Child BTW continuation

Runtime source advances to **18.4.4-studio.28**, still on the pinned 18.4.4 upstream; Studio stays at 0.1.7.

- Agent Hub has a BTW tab and action; the child inspection card and sidebar roster open the same target-specific tab. Old Runtime capabilities and unavailable/historical targets disable real writes. Preview has independent local topics and never dispatches commands.
- Typed `agent.btw.read/ask/abort` operations obtain and carry an opaque target-incarnation binding. Runtime resolves only descendants of its actual main session and rechecks parent identity, child object and child session ID. Every mutation requires the binding; target replacement/removal invalidates it and aborts active work. UI keeps drafts and stops requests after a failed or uncertain receipt, without rebinding or falling back to main BTW.
- The pool reuses each real child AgentSession's native ephemeral-turn engine and native BTW history store; no AgentSession is created. Each target owns its own current snapshot, topics and follow-up history. These snapshots never enter the main BTW event slot; branch tokens are not exposed. Pool size is bounded, in-flight child work prevents idle Worker recycling, and session transitions settle child BTW alongside main BTW.
- Native targeted tests passed: child-context and history isolation, cross-target binding rejection, replacement/deletion fencing and abort propagation, plus existing BTW/Bridge/host lifecycle coverage (28 tests, 151 assertions). Renderer targeted tests passed (27 tests), including IME Enter, preview isolation, old Runtime state and uncertain-receipt draft preservation. Native typecheck, source pin, all four patch replays and 48 metadata tests passed.
- The first regen attempt hit a transient Windows `UNKNOWN` file-open error on a patch file; a normal regen retry succeeded. Patches were generated exclusively by regen, and the replayed tracked tree matches vendor.

Full repository gate and final GUI build evidence are recorded below once complete. IDA, Ask images, paged resources and remaining end-to-end acceptance/signing/installer work are still outstanding; no new binary has been signed or installed.

Child BTW final validation: `npm run check` passed with **701 Renderer tests, 390 Desktop tests** and all package suites (`/tmp/omp-agent-btw-check.log`). After the final history-display and main-agent entry guards, the production Renderer build and all 27 targeted Renderer tests passed again (`/tmp/omp-agent-btw-render-final.log`, `/tmp/omp-agent-btw-ui-final.log`). Runtime remains `.28`; no paid requests were used. Real Electron interaction/IME/lifecycle acceptance is still pending, so this checkpoint does not claim the complete GUI plan or an installer delivery.


### 2026-09-30 final source and native artifact checkpoint (.31)

The earlier checkpoints above are chronological records. Source now includes the IDA panel and native atomic database/version fence; Ask answer/note images, controlled local conversion and question ownership; paged native resources; queue paging; actual provider media model; search routing explanations; conservative unknown-cost display; effective/restart-required setting values; and Runtime identities in the capability skills list. Unsupported name-based changes to resolved skills are disabled instead of guessing a disk target.

- Signed Runtime: `18.4.4-studio.31`, app version unchanged at `0.1.7`.
- `npm run check`: 705 Renderer tests, 390 Desktop tests, all package suites passed. `runtime:verify-source` and 48 metadata tests passed.
- Native Studio tests ran in 57 separate Bun processes. The only failing suite used an obsolete fake without child BTW settlement; updating that fake made all 26 targeted dispatcher/IDA tests pass. Native coding-agent typecheck passed.
- Four seam patches replayed against a fresh temporary Git index at the pinned commit, then matched the current vendor tracked contents byte-for-byte. The dirty vendor was preserved; the clean-tree verification wrapper was not run against it.
- Signed artifact authenticated successfully; isolated activation/rollback `.18 → .31 → .18 → .31` passed. No installed application or real user config was replaced.
- Real IDA, paid provider/Judge/media calls, actual voucher redemption and remote publishing remain explicitly unverified. IDA unavailable-state and simulated protocol tests cover the agreed local scope.
- Electron acceptance uses the existing `?preview=1` fixture entry. The release preview switch remains disabled. Chinese input uses CDP composition events, not a manual physical Windows IME session.

Final Electron, streaming performance and installer results follow below.


## Final local delivery evidence

- **Full repository gate:** `npm run check` passed: 111 Renderer files / 705 tests; 390 Desktop tests and all package suites. After the final layout/availability fixes, the production Renderer build and 11 affected GUI tests passed again.
- **Native/source:** coding-agent typecheck; 57 Studio test files executed in separate Bun processes; the repaired dispatcher fake and IDA suites passed (26 tests). All 137 overlay files exactly match vendor. Four patches replayed at the fixed upstream commit and matched vendor; `runtime:verify-source`, 48 metadata tests and `git diff --check` passed.
- **Source Electron:** `outputs/full-gui-e2e/report.json` is `passed`, with 18 checks. Real signed Runtime handshake/capabilities, IDA unavailable state, queue/tier/skill reads, native resource read, ephemeral prediction, isolated statistics worker, Chinese CDP composition, five pages in real and preview modes, and per-question Ask images/notes were exercised.
- **Packaged Electron:** `outputs/packaged-gui-e2e/report.json` is `passed`, with the same flows plus native PTY creation/disposal (19 checks). This run used `outputs/installer/win-unpacked/OMP Studio.exe`, its packaged renderer/preload and shipped signed Runtime, with isolated application/Runtime profiles. It did not install over the existing application.
- **Streaming:** `outputs/streaming-perf.json` is `passed` using the unchanged default thresholds, including long history, expansion, session transitions, tool handoff and memory checks.
- **Runtime install/rollback:** `.18 → .31 → .18 → .31` passed in an isolated installation. The Runtime artifact contains Ed25519-signed metadata; installer staging and auditing verified it against the local public key. No private key is packaged.
- **Windows x64 installer:** `outputs/installer/OMP-Studio-Setup-0.1.7-windows-x64.exe`, 208,702,574 bytes. SHA-256: `e23cd905c921cd350520a5f7c89e8126ebc28b213c1dace4fa540c0a7ed4cfcf`. `outputs/installer/SHA256SUMS.txt` records the digest. NSIS/asar/CSP/preload/PE architecture/Runtime/public-key audit passed. The Setup executable has no Authenticode signature; the requested Runtime signature is present.
- **Documentation:** [User guide](../gui-18.4.4.md), [upstream version-by-version changes](omp-18.4.4.md) and `doc/feature-index.md` are updated.

No paid model requests, real redemption, commercial IDA installation, remote publication, current-installation replacement or Git commits were performed. Browser sidebar remains deferred as approved. Existing backup and unrelated uncommitted work were preserved.
