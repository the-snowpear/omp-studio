# Implementation Phases and Test Gates

Phases are capability gates, not calendar commitments. A phase cannot be called
complete while its mandatory tests are flaky or skipped on a supported OMP
version band.

## Phase 0 - Contracts and evidence baseline

Build:

- protocol package and schema generation;
- Environment, WorkspaceBinding, SessionBinding, HostAuthority identifiers;
- Capability descriptor/route/resolution types;
- RuntimeLaunchPlan and secret-redacted diagnostics;
- real-OMP compatibility harness and fingerprint format.

Gate:

- ready/protocol-v1/protocol-v2 fixtures against supported OMP builds;
- config precedence and RPC/ACP host-default tests;
- Studio/native identifier race and generation-fence tests;
- protocol encode/decode and backward-compatibility tests;
- no capability claim without fingerprint evidence.

## Phase 1 - Desktop single-thread vertical slice

Build:

- one local Environment and one HostAuthority;
- private Desktop IPC;
- one OmpRuntimeActor per live Thread;
- prompt, stream, steer/follow-up, abort, model, thinking, fast;
- Extension UI and approval projection;
- incremental Claude-style rendering from native deltas.

Gate:

- more than 100,000 deltas without lost completion or unbounded memory;
- duplicate/late/out-of-order frame handling;
- abort and runtime-generation fencing;
- OMP crash, Host crash, Renderer reload, and stdin-close recovery;
- Renderer has no Node access or Host credential.

## Phase 2 - Durable state, reconnect, and long sessions

Build:

- durable event journal and rebuildable Read Models;
- snapshot plus bounded replay;
- partial-stream checkpoints;
- OMP history paging and client hot/cold transcript windows;
- DOM virtualization;
- byte-bounded queues and terminal spool foundation.

Gate:

- million-message synthetic transcript without full client materialization;
- 100 MB terminal stream without Host or Renderer memory growth;
- background client disconnected/slow for 30 minutes and correct recovery;
- no snapshot-subscribe race;
- ephemeral gaps never cause false durable-gap resync.

## Phase 3 - Workspace, Git, and worktrees

Build:

- canonical/working root distinction;
- workspace write lease and revision CAS;
- canonical-checkout and managed-worktree modes;
- Git/diff Read Models;
- Studio Workspace Snapshot, explicitly separate from OMP checkpoint.

Gate:

- same repository with multiple worktrees;
- dirty canonical checkout and safe handoff;
- already-checked-out branch handling;
- symlink/junction/path traversal tests;
- interrupted worktree creation/cleanup and stale metadata recovery;
- stale write revision rejected without data loss.

## Phase 4 - Configuration and capability discovery

Build:

- models, providers, roles, fallback configuration;
- effective agents/skills/plugins/MCP/tool discovery where public surfaces allow;
- SlashCapabilityManifest;
- Capability Debt Registry;
- global/project config editor with provenance and conflict detection.

Gate:

- unknown OMP build quarantines unverified routes;
- discovered but unallowlisted Slash commands cannot be invoked as GUI actions;
- concurrent external config edits produce explicit conflict;
- secrets never enter Renderer state, URLs, logs, snapshots, or diagnostics;
- experimental/private route without owner and `removeWhen` fails CI.

## Phase 5 - Subagent observation and Agent Hub projection

Build now:

- lifecycle/progress/full-event subscription;
- roster and hierarchy projection;
- transcript paging/incremental read;
- unread/focus/UI metadata.

Defer until public upstream RPC:

- direct message, kill, revive, release, manual spawn, and job cancellation.

Gate:

- stale event cannot update a new runtime generation;
- transcript byte-offset reads never expose arbitrary paths;
- parked/revived agents keep stable Studio identity;
- child execution policy cannot exceed parent policy;
- Companion-disabled build has no hidden loss of advertised stable controls.

## Phase 6 - Terminal, Preview, and browser integration

Build:

- Studio-owned PTY actor and rotating spool;
- Preview process supervisor and reverse proxy;
- Preview isolation and short-lived scoped operation tickets;
- Markdown sanitizer, CSP, URL/navigation policy;
- Host Tools for controlled model access to Studio services.

Gate:

- XSS-to-Host/PTY attack-chain suite;
- ticket scope, expiry, replay, and origin tests;
- orphan process-tree cleanup;
- Preview receives no Desktop preload or Host session;
- filesystem and network policy tests;
- process containment is documented separately from OS sandbox status.

## Phase 7 - Local WebUI

Build:

- opt-in loopback HTTP/WebSocket listener on the existing HostAuthority;
- one-time pairing, HttpOnly session, CSRF, controller takeover;
- multi-client publication/backpressure.

Gate:

- Desktop and browser attach to the same authority;
- observer cannot invoke control or terminal mutations;
- controller/write-lease races are deterministic;
- Host/Origin, DNS rebinding, CSRF, WS-upgrade, pairing brute-force tests;
- one slow client cannot delay runtime ingestion or other clients.

## Phase 8 - Explicit Remote WebUI

Build:

- TLS or trusted authenticated proxy;
- strong identity, scoped authorization, expiry, revocation, audit;
- project allowlists and hardened Terminal/Preview policy;
- remote discovery and upgrade compatibility.

Gate:

- credential rotation/revocation;
- network interruption and generation migration;
- rate limit/abuse testing;
- cross-version client/Host upgrade tests;
- independent security review before enabling non-loopback bind.

