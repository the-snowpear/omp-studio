# Goals and Invariants

## Product goals

- Deliver a high-quality Desktop GUI for the real installed OMP Harness.
- Provide Local WebUI using the same product client and Host Authority.
- Preserve a migration path to explicit Remote WebUI.
- Approach OMP Harness parity without reproducing OMP internally.
- Remain upgradeable across OMP version bands through probes, schemas, and real
  compatibility tests.
- Support long-running sessions, concurrent subagents, large terminal output,
  and slow/background clients without unbounded memory growth.

## Architecture invariants

### Runtime authority

1. OMP is authoritative for Agent runtime semantics.
2. A live OMP process is controlled by exactly one `OmpRuntimeActor`.
3. Adapters cannot mutate Renderer state or Read Models directly.
4. Native OMP identifiers and file paths remain Host-private.
5. The Studio SDK backend, if enabled, creates a distinct runtime binding.

### Environment and workspace authority

1. One `Environment` has at most one active `HostAuthority`.
2. `Project` is logical identity; `Workspace` is a concrete checkout in one
   Environment.
3. Every write-capable Thread owns or leases one `WorkspaceBinding`.
4. The canonical checkout has at most one writer unless writers use isolated
   worktrees.
5. OMP Context Checkpoint and Studio Workspace Snapshot are separate concepts.

### Protocol and state

1. The public Studio Host Protocol is transport neutral and versioned.
2. All client-visible durable changes are committed before publication.
3. Durable ordering is defined by `(authorityEpoch, commitSeq)`.
4. High-rate streams are scoped by `runtimeEpoch` and a stream key.
5. Client reconnect uses snapshot plus bounded durable replay; token replay is
   not required.
6. Command timeout does not imply runtime termination.

### Security

1. Renderer, Preview, browser content, OMP output, and Markdown are untrusted.
2. Loopback is a routing property, not authentication.
3. Approval is not an OS sandbox.
4. Process-tree containment is not an OS sandbox.
5. Desktop Renderer never receives the Host authority secret.
6. Remote listening is explicit opt-in and requires transport security,
   authentication, authorization, expiry, rate limiting, and audit.

### Compatibility

1. Capability presence, safe invocation, and current authorization are separate.
2. Slash discovery never proves headless safety or determinism.
3. Private Companion imports are experimental and exact-build gated.
4. Every fallback is recorded in the Capability Debt Registry.
5. CI-generated fingerprints, not handwritten matrices, are the compatibility
   source of truth.

## Non-goals

- Cross-provider Agent abstraction in the first architecture.
- A generic invoke-any-OMP-tool API.
- Direct editing of OMP session JSONL, `agent.db`, or internal registries.
- Rendering arbitrary custom TUI components in React.
- Treating CLI text output as a stable structured control protocol.
- Persisting all terminal, browser network, thinking, or token events forever.

