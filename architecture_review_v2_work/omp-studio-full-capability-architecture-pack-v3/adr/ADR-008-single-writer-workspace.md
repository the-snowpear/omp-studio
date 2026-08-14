# ADR-008: Single Writer per Workspace in the MVP

Status: Accepted for v3 baseline

## Decision

At most one write-capable Studio Thread may operate on a canonical workspace/worktree. Other Threads are read-only. Thread control leases remain necessary but are not sufficient; mutations also require a workspace write lease.

## Rationale

Two independent OMP processes can otherwise edit files and Git state concurrently even when each Thread has only one controller. Atomic file replacement detects neither lost updates nor cross-process semantic conflicts.

## Future

Concurrent writers require isolated Git worktrees/sandboxes plus an explicit merge workflow. Non-Git projects retain the single-writer rule.

Normative details: `contracts/workspace-write.md`.
