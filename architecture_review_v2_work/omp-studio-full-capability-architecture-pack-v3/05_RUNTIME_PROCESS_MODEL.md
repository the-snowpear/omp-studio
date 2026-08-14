# Runtime and Process Model

## Recommended process topology

```text
OMP Studio Host
├── Project A
│   ├── Thread A1 -> omp --mode rpc-ui
│   ├── Thread A2 -> omp --mode rpc-ui
│   └── Preview process(es)
└── Project B
    └── Thread B1 -> omp --mode rpc-ui
```

## Rule: one active Thread, one OMP process

An active Studio Thread owns one live OMP process/session runtime.

Reasons:

- avoids cross-thread queue/model/compaction state leakage,
- preserves CLI session semantics,
- simplifies crash recovery,
- subagents remain children of the owning OMP harness,
- process-level capability negotiation is isolated.

Idle threads may be suspended by terminating the OMP process after state is flushed. Reopening uses the OMP session file through supported session commands.

## Rule: one writable workspace, one writer

One canonical workspace/worktree may have only one write-capable runtime in the
MVP. Additional Threads are read-only unless they use isolated Git worktrees.
Thread control leases do not replace the workspace write lease. See
`contracts/workspace-write.md`.

## Subagents are not Studio processes

OMP's task system creates child AgentSession instances inside OMP's own runtime. Studio must not spawn a separate `omp` process for each subagent.

## Process startup

```text
resolve and verify absolute omp executable
  -> create process containment domain
  -> acquire workspace write lease when write-capable
  -> spawn omp --mode rpc-ui with explicit argv and shell=false
  -> ready
  -> negotiate protocol v2
  -> register host tools / URI schemes
  -> set subagent subscription = events
  -> load/switch/new session
  -> get_state
  -> get_available_commands
  -> get_available_models
  -> build runtime capability snapshot
  -> publish UI snapshot
```

## Background processes

Studio also owns non-agent runtime processes:

- developer server,
- user terminals,
- Git helpers,
- optional local relay for experimental Collab adapter,
- diagnostics helpers.

These are separate from OMP Agent processes and have separate lifecycle/security policies.

Every Host-owned process belongs to an explicit ownership domain. Windows uses
Job Objects; macOS/Linux use process groups. Whole-tree shutdown follows
`contracts/process-containment.md`.
