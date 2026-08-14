# Workspace Write Coordination Contract

## MVP decision

One canonical workspace/worktree has at most one write-capable Studio Thread at a time. Other Threads may run in read-only mode. A Thread control lease is not a workspace write lease.

The write lease covers all Studio-mediated mutations:

- OMP prompts/runs allowed to invoke write tools;
- OMP bash and Studio terminals;
- Host Tools that write files or control Git;
- config/file adapter writes under the project;
- Git helpers, formatters, generators and Preview start commands that may mutate files.

```ts
interface WorkspaceWriteLease {
  workspaceId: string;
  holderThreadId: string;
  revision: number;
  acquiredAt: number;
  expiresAt: number;
}
```

Every mutation supplies `expectedWorkspaceLeaseRevision`. A stale or missing revision returns `409 workspace_write_lease_required` before dispatch.

## External writes and conditional files

External editors cannot be locked reliably. For Studio-managed file writes, record the pre-edit content hash and metadata; commit only when `expectedRevision/contentHash` still matches. On mismatch, return `409 external_change_detected`, preserve both versions and require an explicit user choice.

Do not attribute an unobserved filesystem change to a particular Agent.

## Future concurrency

True concurrent write-capable Threads require separate Git worktrees/sandboxes and an explicit merge flow. Non-Git projects continue to use the single-writer rule. Worktree identity uses the canonicalization rules in `identifiers.md`.
