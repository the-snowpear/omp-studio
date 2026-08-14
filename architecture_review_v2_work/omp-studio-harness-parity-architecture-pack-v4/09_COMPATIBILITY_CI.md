# Compatibility CI

## 1. Goal

Compatibility CI proves behavior against real OMP builds. Type compatibility,
version comparison, or command discovery alone is insufficient.

The v4 reference baseline is:

```text
repository: can1357/oh-my-pi
branch observed: main
commit: 45e12e5bb758198a920c6070e7e64cb33b21beac
```

Every report records the immutable commit/build under test. `main` is resolved
to a commit before any job starts.

## 2. Build matrix

Run at least:

- the pinned reference commit,
- every Studio-supported OMP release/build,
- current OMP `main` nightly,
- Windows, macOS, and Linux for process/config/path behavior,
- SDK and RPC backends separately,
- ACP where its behavior informs compatibility or config precedence.

Nightly failures update Capability Debt; they do not silently change production
routes.

## 3. Contract extraction jobs

### RPC surface

- compile/import current `RpcCommand`, response, and event contracts,
- start a real RPC process, negotiate v2, and record ready limits,
- probe every command with non-destructive fixtures,
- exercise subagent `off/progress/events`, list, and incremental transcript,
- assert that absent controls remain absent rather than inferred.

For `45e12e5`, the golden baseline includes native subagent lifecycle, progress,
full events, list, and transcript; it excludes spawn/message/kill/revive/release
and async-job-cancel RPC commands.

### SDK surface

- compile the SDK backend using public package exports only,
- create/dispose a real session,
- exercise prompt, tools, task, async delivery, abort, and session persistence,
- fail if the adapter begins depending on an unexported module,
- record which event/control surfaces are actually public.

### ACP surface

- initialize/new/load/resume/fork/close/cancel sessions,
- verify public config options and session updates,
- confirm there is no assumed first-class subagent control API,
- run a cross-cwd settings precedence fixture.

The verified baseline exposes ACP config options for mode, model, and thinking;
other settings remain config/extension concerns.

### Companion and Slash Manifest

- handshake Companion protocol and exact OMP build identity,
- validate manifest schema and content hash,
- compare configured versus effective inventory,
- classify every slash entry as local deterministic, model-dispatched,
  TUI-only, or unknown,
- execute deterministic commands and prove their terminal signal,
- disable all Companion routes on ABI/build mismatch.

Unknown or changed slash semantics fail closed to diagnostics-only.

## 4. Semantic parity suites

Tests compare route semantics, not only success values:

- accepted versus completed,
- error codes and invalid-state behavior,
- cancellation and late completion,
- runtime crash/restart,
- session switch/branch/handoff,
- scope and authorization failures,
- event ordering and reconstruction,
- config effect: immediate/reload/new-session/restart.

A fallback is approved only when these tests show equivalence to the native
Harness behavior for that exact capability.

## 5. Host-default precedence matrix

For each path in the OMP host-default allowlist, test:

| Source combination | Expected |
|---|---|
| none configured | schema/host default |
| global | global preserved |
| project | project preserved |
| `--config` overlay | overlay preserved |
| isolated Settings/runtime override | explicit override preserved |
| ACP new session in different cwd | target project setting preserved |

Cover task, advisor, memory, `tier.advisor`, async, and bash
auto-background. Separately assert that non-allowlisted paths such as provider
tiers, `tier.subagent`, async poll duration, and bash enablement are not falsely
reported as host-defaulted.

## 6. Harness/Hub/Collab fixtures

Create deterministic agents and jobs to prove:

- task spawn and batch lifecycle,
- idle to parked to revived behavior,
- Hub message semantics for running/idle/parked agents,
- TUI/internal kill and release behavior,
- owner-scoped async-job cancel,
- Collab full-control chat/kill/revive/transcript,
- Collab read-only rejection,
- absence of Collab spawn, independent release, and job-cancel frames.

These fixtures document Harness facts. They do not automatically promote a
Studio route.

## 7. Generated artifacts

Each matrix cell publishes:

- `runtime-build.json`,
- normalized SDK/RPC/ACP surface manifests,
- `slash-manifest.json`,
- `capability-snapshot.json`,
- `capability-debt.json`,
- settings provenance report,
- protocol transcripts with secrets redacted,
- machine-readable test and failure classification.

Artifacts are diffed against the last approved build. Route changes require an
explicit review; updating a golden file alone cannot approve a new capability.

## 8. Gates

Release-blocking failures include:

- SDK public export or runtime construction breakage,
- RPC framing/correlation/event regression,
- capability promoted without executable evidence,
- Slash semantic change without a reviewed manifest,
- Companion build guard bypass,
- settings precedence or provenance mismatch,
- route cancellation/error semantics diverging from the Harness,
- private API route graded as native/supported,
- Capability Debt disappearing without an approved public replacement.

Nightly-only upstream drift is reported as `upstream-change-detected` with a
new debt item or route downgrade. Production remains pinned to the last passing
compatibility profile.

## 9. Capability Debt workflow

CI owns the evidence, not the product decision:

1. detect a missing or changed route,
2. emit/update `CapabilityDebtItem`,
3. attach source evidence and failing parity tests,
4. identify upstream API proposal or temporary exact-build route,
5. keep UI support downgraded,
6. close only after a public route passes the supported-build matrix.
