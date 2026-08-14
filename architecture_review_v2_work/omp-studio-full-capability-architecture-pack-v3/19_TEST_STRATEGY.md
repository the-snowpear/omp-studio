# Test Strategy

## 1. Protocol unit tests

- NDJSON framing.
- v2 chunk reassembly.
- malformed chunks.
- command correlation.
- local-only prompt completion.
- Extension UI request/response.
- Host Tool and Host URI cancellation.
- acknowledgement/event reordering, lost acknowledgement and duplicate terminal frames.
- local-only slash completion without `agent_end` and late same-id errors.
- runtime epoch change with pending commands and no automatic replay.

## 2. Capability Broker tests

For every capability ID:

- probe native route,
- fallback selection,
- forbidden fallback cases,
- downgrade after adapter failure,
- route diagnostics.
- same capability under different principal/scope/epoch/lease combinations.

Golden table should be generated from `references/CAPABILITY_CHANNEL_MATRIX.csv`.

## 3. Fake OMP server

Provide deterministic fixtures for:

- streaming text/thinking,
- tool execution,
- approval,
- compaction/retry/fallback,
- subagent lifecycle/progress/events,
- reconnect/state rebuild,
- command_output/config_update.
- snapshot-time concurrent events, journal gaps and host/runtime epoch mismatch.

## 4. Real OMP integration matrix

CI/nightly should test multiple supported OMP builds, not only a mocked protocol.

Scenarios:

- new session -> prompt -> tools -> abort,
- session resume,
- model/thinking/fast,
- branch/handoff,
- subagent observation,
- config set/get,
- project config override,
- provider/model custom config,
- MCP config,
- companion capability probe where enabled.

## 5. File adapter tests

Use isolated temp homes/projects. Verify:

- comments/unrelated keys preserved,
- atomic replacement,
- concurrent edit detection,
- project/global precedence,
- profile path relocation,
- invalid YAML/schema rejection.

## 6. Security tests

- loopback auth token,
- Origin validation,
- path traversal/symlink escape,
- secret redaction,
- renderer cannot invoke arbitrary Host methods,
- remote mode disabled by default.
- one-time bootstrap expiry/replay/rate limit, CSRF and unauthenticated WebSocket.
- exact Host/Origin validation and Host-restart credential revocation.
- opaque ID guessing/cross-project IDOR and Windows junction/UNC/case aliases.
- malicious Preview cannot access Node, IPC, Host auth, permissions, downloads or new windows.

## 7. E2E

Run both Electron and browser clients against the same Host. Verify control lease, disconnect/reconnect and consistent projections.

Also verify two Threads competing for one workspace, stale fencing revisions,
external-editor CAS conflicts, and Windows descendant cleanup after Host crash,
Preview stop, half-start and repeated stop. These are release gates, not best-effort tests.
