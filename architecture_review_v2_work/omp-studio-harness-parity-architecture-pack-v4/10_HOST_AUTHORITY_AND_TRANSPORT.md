# Host Authority and Transport

## Decision

The OMP Studio Host is the sole business authority. Electron Main, Renderers,
browser clients and Preview contents are clients; they do not own OMP runtime,
session, approval, workspace, terminal or Preview truth.

```text
Desktop Renderer -- narrow preload --> Electron Main -- private IPC --+
                                                                    |
Local WebUI -- explicit loopback HTTP + WebSocket ------------------+--> Host
                                                                    |      |
Remote WebUI -- explicit HTTPS + WSS -------------------------------+      +--> OMP actors
                                                                           +--> filesystem/Git
                                                                           +--> PTY/Preview domains
```

The three transports expose the same versioned semantic operations and events.
They do not expose raw OMP frames, filesystem paths, process identifiers or
Electron channels.

## Host-owned authority

Only the Host may:

- map opaque Studio project/thread IDs to canonical paths and OMP session IDs;
- start, resume, replace or stop an OMP process actor;
- assign `authorityEpoch` and per-runtime `runtimeEpoch` generations;
- issue and revoke client sessions, control leases and workspace writer leases;
- accept, correlate and terminate approval/extension-UI requests;
- maintain the command ledger and classify uncertain outcomes as `outcome_unknown`;
- create PTYs, Preview runtimes and process-containment domains;
- publish authoritative snapshots and replayable semantic events.

Electron Main owns native window lifecycle and the private-IPC client connection,
but it is not a second Host. A Renderer owns only ephemeral view state. A browser
refresh must not kill an OMP run, PTY or Preview process.

## Desktop transport: private IPC by default

The packaged desktop application does **not** start an HTTP listener by default.
Electron Main starts or attaches to the Host over an owner-only private channel:

- Windows: named pipe with an ACL restricted to the current user logon SID;
- macOS/Linux: Unix-domain socket in an owner-only directory, mode `0600`;
- an inherited anonymous pipe may be used for the initial child bootstrap.

The private endpoint name contains an unguessable component and is stored only in
an owner-only profile discovery record. Endpoint possession is not sufficient:
Main performs a challenge-response bootstrap bound to `authorityEpoch`, then receives
a short-lived client session.

Renderer calls a narrow typed preload API. Main attaches the authenticated
authority context and proxies semantic requests. The Renderer never receives the
Host instance secret, private endpoint credential or a generic
`invoke(channel, payload)` primitive. Preview WebContents receive no preload.

Private IPC has bounded frames, request IDs, cancellation, flow control and the
same command/event schemas as Web transport. Peer identity is verified before a
session is issued; filesystem permissions alone are defense in depth.

## Local Web listener: explicit opt-in

Local WebUI is disabled until the user explicitly runs `omp-studio serve` or
enables the Web listener in a trusted desktop settings surface. Enabling it:

1. binds an ephemeral or explicitly selected port to `127.0.0.1` and `::1` only;
2. displays a short-lived, single-use pairing code on the trusted local surface;
3. exchanges that code by same-origin `POST` for a scoped browser session;
4. enables authenticated HTTP commands and an authenticated WebSocket event
   stream.

Never bind the local mode to `0.0.0.0`. A port number, loopback peer address or
successful `/health` response is not authorization. The listener can be stopped
without stopping the Host or active runtimes; stopping it revokes browser
sessions created for that listener.

## Remote listener: separate TLS mode

Remote access is off by default and is not an extension of the loopback exemption.
It requires an explicit remote profile containing:

- allowed bind addresses and project allowlists;
- HTTPS/WSS with TLS 1.2 or newer and validated certificates;
- strong pairing/login, short-lived sessions, revocation and rate limiting;
- exact Origin allowlists and audit retention;
- explicit terminal, Preview input and workspace-write grants.

Plain HTTP on a non-loopback interface is forbidden. A trusted TLS reverse proxy
is allowed only when its source addresses are pinned and forwarded host/scheme/
client-address headers are accepted solely from those proxies. Otherwise the
Host terminates TLS itself. Certificate validation must not be disabled for
desktop or mobile clients.

## Transport semantics

### Request path

Every semantic request carries:

- `requestId`, protocol version and operation name;
- authenticated client session and `authzRevision` from the transport;
- one opaque resource scope;
- `idempotencyKey` for mutations;
- expected runtime/control/workspace revisions where applicable.

The Host executes this fixed order:

```text
authenticate transport
 -> validate protocol and request shape
 -> authorize opaque scope
 -> validate authz/runtime/lease revisions
 -> durably accept mutation in command ledger
 -> invoke exactly one declared capability route
 -> publish outcome/events
```

Authentication or authorization is performed before resource lookup so an
out-of-scope opaque ID cannot be used as an existence oracle.

### Event path

Durable events are scoped to `authorityEpoch` and ordered by persistent
`commitSeq`. Runtime streams are separately scoped by `runtimeEpoch + streamId +
streamSeq`; transport delivery uses connection-local `deliverySeq`. A resume
cursor contains `authorityEpoch`, `afterCommitSeq`, and active stream watermarks.
Authority mismatch, durable journal gaps, or an unavailable ephemeral range
force a fresh snapshot. Snapshot publication follows the subscribe-before-read
barrier defined in `04_EVENT_AND_PROJECTION_MODEL.md` and
`05_ORDERED_PUSH_AND_BACKPRESSURE.md`.

High-rate non-authoritative deltas may be batched or dropped under pressure. Run,
tool, approval, lease, command outcome and process terminal events are replayable
semantic events and must not be silently dropped.

### Backpressure and limits

- Bound request/frame size before parsing large payloads.
- Bound per-client outstanding requests and event queues.
- Disconnect a persistently slow observer rather than exhausting Host memory.
- Keep PTY bytes and Preview logs on dedicated streams, not the semantic event
  stream.
- Cancellation is idempotent and cannot re-authorize a stale request.

## Lifecycle and discovery

Each successful authority acquisition creates a new `authorityEpoch`. An
Environment has one active Host authority at a time, enforced by an owner-only
lock and fencing record. A discovery record contains only non-secret endpoint
metadata and is written atomically.

Host replacement invalidates old client sessions, IPC challenges, Web pairing
codes, event cursors and runtime ownership generations. A newly started Host may
reconcile persisted Studio metadata with OMP/filesystem truth, but must not reuse
the prior authority epoch or replay commands that may already have reached OMP.

## Normative contract

See `contracts/host-authority.ts`. Security/session types are defined in
`contracts/security-types.ts`.
