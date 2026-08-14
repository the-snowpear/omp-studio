# Domain Model

## 1. Boundary

OMP Studio is a client and host around the real OMP Harness. It does not own or
reimplement OMP's agent loop, prompt semantics, tool execution, permission
policy, compaction, subagent scheduler, session transcript, or model fallback.
Those facts remain authoritative in the installed OMP process and its public
interfaces.

The Studio domain owns only:

- registration of environments and workspaces;
- the user's Studio thread organization and presentation metadata;
- the binding between a Studio thread and a real OMP session/runtime;
- Host command receipt, routing outcome, security grants, writer leases, and
  Studio-only UI state;
- projections of OMP observations used to render the UI.

An OMP observation can change a projection, but it does not become a second
authoritative copy of the OMP Harness.

## 2. Core objects

```text
Project 1 ── * Workspace * ── 1 Environment
                 │
                 └── * Thread 1 ── * SessionBinding
                                      └── at most one active binding

Environment ── owns runtime processes identified by runtimeEpoch
Workspace   ── owns canonical root and write-coordination scope
Thread      ── owns Studio metadata and user-facing continuity
Binding     ── points to a real OMP session without exposing its filesystem path
```

### Environment

An `Environment` is one Host-reachable execution and trust boundary. It
describes where OMP, the workspace filesystem, Git, terminal and preview
services run. Kinds are `local`, `ssh`, and an explicitly managed `remote`
authority. A remote Host is a different environment even if it opens the same
repository URL.

Studio owns the environment registration, display name and connection policy.
The environment reports, but Studio does not invent, the installed OMP version,
runtime health and negotiated capabilities.

Important invariants:

- every privileged operation is scoped to one `environmentId`;
- credentials and absolute paths remain inside that environment's Host;
- a newly spawned OMP process receives a fresh opaque `runtimeEpoch`;
- observations from a previous `runtimeEpoch` cannot update the current runtime
  projection.

### Workspace

A `Workspace` is a concrete canonical checkout for one logical Project,
registered in one Environment. It
is not a copy of the repository and it does not own file contents or Git state.
Those sources of truth remain the filesystem and Git.

Studio owns the opaque workspace handle, presentation metadata and writer-lease
coordination. The Host resolves symlinks, junctions, case and volume identity
before registering a root. Two paths resolving to the same canonical identity
must not create independent write domains.

Important invariants:

- a workspace belongs to exactly one environment;
- a workspace belongs to exactly one logical project;
- in the MVP, a canonical workspace has at most one write-capable runtime;
- a writer lease is fenced by a monotonically increasing revision;
- clients receive an opaque `workspaceId`, never an unrestricted path handle;
- filesystem watches and Git status are replaceable projections, not durable
  Studio-owned file state.

### Project

A `Project` is Studio's logical identity for a repository or product. It does
not imply a local directory. One Project may have canonical and managed-worktree
Workspaces in one or more Environments. Repository identity is descriptive and
cannot be used as filesystem authority.

Important invariants:

- Project metadata is Studio-owned and durable;
- commands always target a concrete Workspace, not only a Project;
- opening the same repository in another Environment creates another Workspace,
  not another write authority over the first Workspace;
- deleting a Project registration never silently deletes checkouts or OMP
  sessions.

### Thread

A `Thread` is Studio's durable user-facing unit of work inside a workspace. It
owns title, pin/archive state, creation time and other Studio-only metadata. It
is deliberately not called an OMP session and does not contain an agent loop.

A thread can survive Host restarts and can temporarily have no live runtime. It
may be rebound to a resumed OMP session after reconciliation. Thread continuity
therefore must not be inferred from a process ID or a WebSocket connection.

Important invariants:

- a thread belongs to exactly one workspace;
- Studio metadata may be changed without mutating the OMP transcript;
- active messages, turns, tools, permissions and subagents are OMP-owned
  observations;
- deleting or archiving a thread never silently deletes an OMP session or
  workspace files.

### SessionBinding

A `SessionBinding` records how a Studio thread is associated with a real OMP
session and, while live, an OMP process epoch. It is the anti-corruption boundary
between durable Studio organization and OMP-owned runtime/session semantics.

Once OMP establishes or resolves the session, the binding stores an opaque
Host-side OMP session handle. It must not expose or accept an OMP session JSONL
path. A binding may pass through:

```text
requested -> attaching -> reconciling -> ready -> detached
                 \             \          \
                  +-----------> failed <---+
```

`ready` means that the Host has attached to the real session, negotiated the
runtime and completed an authoritative snapshot reconciliation. It does not mean
that a model turn is idle or complete.

Important invariants:

- a thread has at most one active binding;
- every live binding names exactly one `runtimeEpoch`;
- `ready` requires a resolved real OMP session handle;
- `runtimeEpoch` is cleared when the binding is detached;
- switching or resuming uses a documented OMP API; Studio never edits active
  session files to manufacture a binding;
- a runtime crash makes the binding stale/reconciling; it does not authorize
  automatic replay of an `outcome_unknown` mutation;
- historical bindings may be retained for audit, but only the active binding
  can receive runtime observations.

## 3. Supporting concepts

### Command receipt

Every Studio mutation is durably accepted under a `commandId` and idempotency
key before dispatch. The receipt proves Studio accepted an intent; it does not
prove OMP executed it. Outcomes distinguish accepted, dispatched, succeeded,
failed, deadline-exceeded and outcome-unknown. A runtime epoch change never automatically
replays a dispatched command.

### Runtime observation

A runtime observation is a fact received from the public OMP integration
surface and tagged with the current `runtimeEpoch`. Studio may attach routing
metadata and a local `streamSeq`, but must preserve the upstream event type and
payload rather than redefining tool or agent semantics.

### Read model

A read model is a disposable projection for a client screen. It combines:

1. durable Studio-owned state through a committed `commitSeq`; and
2. current OMP observations through per-stream `streamSeq` watermarks bound to
   a `runtimeEpoch`.

It is never a new source of truth. After a gap or epoch change, the Host rebuilds
the OMP-owned portion from public snapshots such as runtime state, messages and
subagent state.

## 4. Ownership matrix

| Fact | Authority | Studio treatment |
|---|---|---|
| Environment/workspace registration | Studio Host | Durable domain state |
| Project registration and metadata | Studio Host | Durable domain state |
| Thread title, pin, archive state | Studio Host | Durable domain state |
| Thread-to-session association | Studio Host mapping to real OMP session | Durable binding metadata |
| OMP version and capability result | Installed OMP/runtime | Epoch-scoped observation/cache |
| Messages, turns, tools, permissions | OMP runtime/session | Projection only |
| Subagent lifecycle and transcripts | OMP runtime/artifacts | Projection/read-only access |
| Session history | OMP RPC and documented session files | Read-only index/cache |
| Files and Git | Filesystem and Git | Derived views only |
| Command intent and transport outcome | Studio Host | Durable ledger |
| Preview process and browser tab | Studio Host runtime | Ephemeral with restart metadata |

## 5. Forbidden designs

- No Studio agent state machine that predicts or replaces OMP behavior.
- No durable re-emission of every OMP delta as if it were a Studio domain fact.
- No dual write to a Studio transcript and an OMP transcript.
- No control implemented by parsing rendered text or prompting the model.
- No cross-epoch merge based only on thread or session ID.
- No public identifier that embeds a path, PID, port, array index or database
  primary key.

The normative TypeScript shapes are in `contracts/domain-types.ts`.
