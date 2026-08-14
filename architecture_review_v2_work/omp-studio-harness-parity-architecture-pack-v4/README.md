# OMP Studio Harness-Parity Architecture v4

Status: proposed implementation baseline

Evidence baseline: `can1357/oh-my-pi@45e12e5bb758198a920c6070e7e64cb33b21beac`

Planning horizon: 3-5 years

This package defines the v4 architecture for an OMP-native desktop and web GUI.
It supersedes the broker-centric v3 target without invalidating v3's verified
RPC, security, command-ledger, and single-writer work.

The decisive change is architectural ownership:

```text
v3: Studio Host -> Capability Broker -> channels -> OMP

v4: Studio Host Protocol -> Studio Application/Domain -> OmpRuntimeGateway
    -> internal CapabilityRouter -> channels -> installed OMP
```

The product model is expressed in stable Studio concepts (`Environment`,
`Workspace`, `Thread`, `Run`, `Message`, `AgentProjection`, `Approval`,
`Change`, `Preview`). RPC, Slash, CLI, Config, Companion, and Collab are adapter
details inside `OmpRuntimeGateway`.

## Non-negotiable boundaries

- The user's installed OMP is the only default Agent Runtime.
- Studio does not reimplement OMP Harness, scheduling, tool semantics, or
  subagent lifecycle.
- OMP RPC/rpc-ui is the primary live authority.
- Studio Domain state is not a second OMP session database.
- Renderer and browser clients use Studio opaque identifiers only.
- One `Environment` has one active `HostAuthority`.
- Desktop-only mode uses private local IPC and does not need a TCP listener.
- SDK is a separate `RuntimeBackend`, never a same-thread fallback.
- Private Companion routes are experimental compatibility debt, never normal
  supported behavior.
- Every fallback has an owner, risk classification, compatibility guard, and
  removal condition.

## Reading order

1. `00_EXECUTIVE_DECISION.md`
2. `01_GOALS_AND_INVARIANTS.md`
3. `02_V4_TARGET_ARCHITECTURE.md`
4. `03_DOMAIN_MODEL.md`
5. `04_EVENT_AND_PROJECTION_MODEL.md`
6. `05_ORDERED_PUSH_AND_BACKPRESSURE.md`
7. `06_OMP_RUNTIME_GATEWAY.md`
8. `07_CAPABILITY_ROUTING.md`
9. `08_RUNTIME_IDENTITY_AND_LAUNCH_PLAN.md`
10. `09_COMPATIBILITY_CI.md`
11. `10_HOST_AUTHORITY_AND_TRANSPORT.md`
12. `11_SECURITY_MODEL.md`
13. `12_TERMINAL_PREVIEW_AND_PROCESS.md`
14. `13_IMPLEMENTATION_PHASES.md`
15. `14_CAPABILITY_MATRIX.md`

`contracts/` contains normative TypeScript contracts. `adr/` contains binding
architecture decisions. Markdown prose is explanatory unless marked normative;
the TypeScript contracts and ADRs win on ambiguity.

## What v4 deliberately does not promise

- Stable direct Subagent message/kill/revive/manual-spawn/job-cancel until OMP
  exposes public RPC commands.
- Portable rendering of arbitrary OMP TUI components.
- Remote mode in the MVP.
- Replay of every token, terminal byte, preview console line, or progress tick.
- Atomic restoration across OMP Context Checkpoint and Studio Workspace
  Snapshot; they have different authorities and failure modes.
