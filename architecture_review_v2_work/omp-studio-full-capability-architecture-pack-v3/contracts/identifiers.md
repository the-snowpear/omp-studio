# Public Identifier and Path Boundary Contract

- `StudioProjectId`, `StudioThreadId`, `StudioAgentId`, `StudioSessionId`, `StudioTerminalId` and `StudioPreviewId` are random, opaque, non-path handles with at least 128 bits of entropy.
- OMP `sessionPath`, session JSONL paths, subagent `sessionFile`, canonical workspace paths and database keys remain Host-only.
- The client may select only handles returned by an authenticated Host registry. It may not submit a local session path to switch/resume/transcript APIs.
- Every handle resolution checks the caller grant and its project/thread scope before revealing whether the target exists.
- Invalid, stale and out-of-scope handles return the same public error shape.

## Path validation

Before registering a project or opening an OMP session, the Host:

1. resolves the absolute path before changing `cwd`;
2. resolves symlinks and Windows junctions where the target exists;
3. normalizes drive letter, UNC form, separators and case according to the volume;
4. verifies the final target belongs to an allowed project root or active OMP session root;
5. stores a file identity/content fingerprint when later TOCTOU protection is required.

Opaque IDs never encode a path, array index or enumerable database primary key.
