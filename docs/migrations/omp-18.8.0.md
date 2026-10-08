# OMP 18.8.0 / Studio 0.1.9 migration

## Release scope

Studio 0.1.9 is released after code, migration and signed-artifact verification. This acceptance scope does not certify the entire manual GUI matrix.

- Original worktree: Studio 0.1.7, Runtime 18.3.0-studio.13, source 35ab6d05a2fe9b882d4336d973a6fa5c7dbd382d.
- Published baseline incorporated before release: Studio 0.1.8, Runtime 18.4.4-studio.38, main e16fabb73c9248296c7155bbea3da1464aae2f39.
- Frozen upstream: OMP v18.8.0, **4ef97c8826ee012829a3e756b693a2a16a414f47**.
- Final Runtime: **18.8.0-studio.20**, generated from omp-patch/patches/series.json; patch digest sha256:35feefcd307d7f891db0c15f400368f31c2955bec9c39c622f808fa619e1a768. The pre-integration 18.8.0-studio.18 binary is not the release artifact.
- Existing installations, independent global CLI configuration and original untracked files are preserved. Source backups are under backup/2026-10-07 and backup/2026-10-08. Generated evidence is not committed.

## Upstream changes

[Changes from the original 18.3.0 baseline](https://github.com/can1357/oh-my-pi/compare/v18.3.0...v18.8.0), [changes since published 18.4.4](https://github.com/can1357/oh-my-pi/compare/v18.4.4...v18.8.0), and the [frozen upstream changelog](https://github.com/can1357/oh-my-pi/blob/4ef97c8826ee012829a3e756b693a2a16a414f47/packages/coding-agent/CHANGELOG.md) are the authoritative history.

| Area | Native change and Studio treatment |
|---|---|
| Models/accounts | Service tiers, custom model kinds, logout, quota scopes and expiring resets. Studio shows supported choices and preserves explicit redemption policies. |
| Sessions/queue | Admission-aware operations, exact withdrawal/promotion, branch/recovery and final-message fixes. Missing models require an explicit replacement; the current session survives. |
| Settings | Registered handles, temporary overrides, provenance and cfg approval. Unconfigured warming defaults to off only inside Studio. |
| Prediction | Native daemon and word completion. No unsolicited external-history learning or model download. New private and published ephemeral transports share one engine and corpus. |
| Advisors/maintenance | Review cadence, final review and waiting policies; full export, archive/recaps, OTLP and GC preview. Cleanup requires an explicit current request. |
| Browser/computer | Native target ownership, lifecycle/CDP fixes and richer targets/screenshots/stop. Studio observes Runtime targets without a second execution engine. |
| Figures/titles | Numeric charts, streamed SVG and completed Mermaid/3D parsing; native 18.8 title icons, shortcodes and generation policy. |
| Performance | Frozen upstream fixes to large files/output, JSON/JSONL queries, memory, image retention, session locks, subprocess cleanup, fetching and long-session streaming. |

Terminal-specific Tern layouts, bare commands and RPC UI are not copied into Electron; Studio uses their corresponding native behavior.

## Implemented workspaces

| Workspace | Behavior |
|---|---|
| Media | Generate, Voice (transcription/TTS/Live), Library, task/result detail, local import/export, recordings and graphics. Hidden viewers release resources. |
| Agent Hub | Agents, background tasks and saved services, parent navigation, model overrides, real execution state/logs. Save-only does not start a service. Published child BTW remains available. |
| Models | Providers, roles, agents, search, presets and accounts. Benchmarks link to Evaluation. Speed and warming come from Runtime state. |
| Evaluation | Native benchmark phases, judgment batches and Ratchet. Retry keeps original evidence. Ratchet uses native isolated experiments and approval hashes. |
| Capabilities | Skills/Skillshare, plugins, MCP, templates, resources and IDA. IDA combines configuration/detection with reviewed database views and edits. |
| History/diagnostics | Stable catalog, Archive/Recap, title adornments, complete exports, cleanup preview and connection checks. |
| Context | Message/file/Diff annotations remain near their source. Terminal recording stays at the terminal; Library also opens playback. Token counting stays in Usage. |
| Statistics | Retains the 0.1.8 native worker, filters, cost semantics and Frustration flow. |

## Published protocol compatibility

The merge retains 0.1.8 Ask attachments, namespaced skills, child BTW, resource pagination, statistics, Frustration and benchmark APIs.

- Published ida.status keeps its original shape. New detection/configuration data uses ida.status.details; per-database cancellation uses ida.database.cancel.
- Published session.queue.remove keeps its original request/result. The new entry operation uses session.queue.entry.remove and a separate capability.
- prediction.query remains ephemeral and bypasses command retention. Private channel drafts never enter snapshots, ledgers or conversation reducers.
- Browser/Computer frames, audio, files and large results use private bounded channels. Renderer gets opaque identities and fixed operations, not raw CDP endpoints.
- Mutating settings, models, queues, exports and cleanup are fenced during resync. Durable results are queried after reconnect; mutations are not automatically repeated.
- Old Fast remains valid; new speed/model metadata is separately advertised to keep strict older result validators readable.

## Lifecycle and resource boundaries

Browser control is an exclusive per-tab lease: wait for an existing action, then prevent new agent operations on that target. Releasing it sends no prompt. Hidden windows, session changes, disconnects and replaced target identities release observations and leases. Viewing does not resize or refresh the target.

Computer Use exposes native screen/window observation and owner-scoped stopping. Studio does not forward desktop keyboard/mouse input.

Ratchet uses native state, approvals, scoring and keep/revert decisions. Existing source changes outside the isolated experiment are not rollback targets. Limits cover rounds and reported model cost; in-flight or external evaluator charges may finish separately.

SVG, Mermaid, charts and OBJ/PLY/WRL/X3DV/STL/glTF/GLB/USDA use pinned local parsers. Workers, geometry/texture budgets, sandboxed X_ITE and controlled ZIP sidecars reject scripts, uncontrolled remote resources, malformed files and excessive input.

## Verification record

Pre-integration evidence for 18.8.0-studio.18 remains useful for unchanged behavior, but does not replace merged-source gates:

| Evidence | Result |
|---|---|
| Pristine upstream | Native rebuild, CLI smoke and prepatch gate passed. |
| Root gate | root-check-final18-2.log passed before the 0.1.8 merge. |
| Patch replay | replay-18.log passed native lint/types/tests and smoke. |
| Metadata | metadata-current-18-2.log: 80 checks passed. |
| Chromium/Chrome/Edge | Native same-target observation, takeover and cleanup passed. |
| Browser isolation | Parent/child/foreign ownership, in-flight action fencing, frame backpressure and replaced identities passed. |
| Computer | Native Windows screenshot/release and owner-scoped stop passed. |
| Runtime rollback | Isolated 18.2.5-studio.6 → 18.8.0-studio.18 → old → new passed. |
| Windows installer | Standard candidate audited; disposable namespace installed and same-version repair passed. Original executable/manifest hashes were unchanged. |
| Streaming | Existing thresholds passed: busy p95 12.5 ms, no >48 ms stalls; layout ratio 1.50 ≤ 2.50; heap/DOM ratios 1.00. |
| Preview UI | Themes, densities, Chinese/English, 1280×720, 1440×900 and 1920×1080 screenshots; service save-only, Skillshare review, templates, presets, IDA/Ratchet demos, retry, annotations and playback flows. |

Merged-source verification for **18.8.0-studio.20**:

| Gate | Result |
|---|---|
| Workspace build and Node suites | Production build passed; 1,213 tests passed, with 14 platform-specific skips on Windows. |
| Renderer | 135 files / 779 tests passed. The merged IDA fixture import was corrected; the full renderer suite passed with four workers to avoid CPU-contention timeouts. |
| Native Studio suites | All 78 suite files passed against the working native tree. |
| Independent patch replay | Clean v18.8.0 checkout: 191 overlay files + four generated seams; lint, formatting, all-package types, 806 tests across 100 processes and CLI smoke passed. Checkout restored clean. |
| Metadata | 81 checks passed, including signed manifest, update assets and platform validation. Capability membership is checked independently of list ordering. |
| Native artifact | Rebuilt win32-x64 module and Runtime. Authenticated Bridge probe confirmed 18.8.0-studio.20, 214 capabilities and matching manifest hashes. Local artifact uses the development key. |
| Runtime install / rollback | In an isolated temporary root: 18.2.5-studio.6 → 18.8.0-studio.20 → old → new passed with the production verifier and executable smoke checks. Existing installation was read only. |
| Compatibility regressions | Published/new IDA and queue contracts stay distinct; per-spawn model chains coexist with solution space. IDA write/close checkpoints fail closed, execute once and preserve both disk/in-memory versions. Configuration approval rebind and disposal passed. |

Local evidence is retained under output/omp-1880/release: root-check-019.log, renderer-tests-019-3.log, native-suites-019.log, patch-replay-020.log, metadata-020-2.log, runtime-build-020.log and runtime-install-rollback20.log. The initial workspace log includes the corrected renderer fixture failure; the separate full renderer rerun is the final result.

The [release workflow](https://github.com/the-snowpear/omp-studio/actions/workflows/release.yml) rebuilds Windows x64/ARM64 on native runners using the existing release signing identity, checks source and patch replay, audits packages, verifies the update catalogs and publishes only after both architectures succeed. Developer-key artifacts are not uploaded as official assets. Minimum app compatibility remains 0.1.9; earlier installations use the complete Setup. No new macOS binary is part of this release.


## macOS compatibility review

POSIX sockets remain short and private under the existing per-user namespace; writable state stays outside signed app bundles. Browser/prediction transports share the Runtime platform path source. Apple prediction is platform-gated. Hiding, closure and process disposal keep cleanup hooks. Graphics assets are local and resolved relative to renderer resources. Existing macOS CI gates remain.

This is code compatibility review, not a new physical-device GUI certificate. No new macOS microphone/TCC, browser capture, IDA installation or installer interaction is claimed.

## Unverified manual/external scenarios

Windows packaged graphics/CSP, browser takeover/Computer UI, the full zoom/narrow-sidebar interaction matrix and disposable-app uninstall were not all completed before publication was authorized. Prior UI automation was explicitly stopped. These boundaries remain in the release notes.

Paid model/media/Live/Ratchet experiments, production Skillshare writes, reset credits and licensed IDA databases remain outside default acceptance. Building, testing and publishing require no paid model request.
