# Terminal, Preview and Process Model

## Principle

Terminal and Preview are separate Host-owned process domains. They are not OMP
subagents and are not Renderer children. Process containment guarantees lifecycle
cleanup; it does **not** make arbitrary project code safe.

```text
Host
 +-- OMP domain       one process actor per active Thread
 +-- PTY domain       one shell process tree per Terminal
 +-- Preview domain   one dev-server process tree + isolated browser surface
 +-- helper domain    bounded, purpose-specific helper
```

Each domain has an opaque ID, owner scope, generation, containment handle,
resource limits and exactly one terminal lifecycle event.

## Terminal/PTY authority

A terminal is equivalent to interactive shell access. Creating, attaching,
writing, resizing, signaling and terminating a PTY are independently authorized
Host operations.

### Creation

- Requires an authenticated client with terminal risk grant, project scope and,
  for a write-capable shell, the current workspace writer lease.
- Host selects a validated canonical `cwd`, absolute shell executable, explicit
  argv and filtered environment.
- Client cannot provide an arbitrary executable path unless an admin policy
  explicitly permits it.
- PTY belongs to one project/workspace and one process-containment domain.

### One-time PTY attachment tickets

After authorization, the Host issues a cryptographically random ticket that is:

- single-use and stored only as a hash server-side;
- bound to client session, terminal ID, terminal generation and allowed
  direction (`read`, `write`, `resize`, `signal`);
- short-lived, with a maximum lifetime of 30 seconds before attachment;
- delivered in an authenticated response body, never URL/query, logs or
  localStorage.

The dedicated PTY WebSocket/private stream consumes the ticket during handshake.
Reconnect requires a new ticket. A controller lease transfer, auth revision
change, terminal generation change or terminal exit invalidates unused tickets.

### PTY protocol and backpressure

- Use explicit binary/output, input, resize, signal, ack and exit frames.
- Sequence output chunks within a terminal generation. Reconnect may request only
  the bounded retained tail; PTY execution itself continues independently.
- Bound input frames, output retention and per-client queues. Slow observers lose
  output and receive a gap marker; they cannot make the PTY block indefinitely.
- Resize is rate-limited and validated. Signals are an allowlist, not arbitrary
  OS control.
- Terminal output is untrusted text. Strip unsafe control sequences for non-PTY
  projections; the terminal emulator must disable arbitrary hyperlink/open and
  clipboard escape actions by default.
- Disconnect does not imply process termination. Termination policy is explicit;
  MVP terminals terminate with Host unless the user chooses a documented
  persistent-terminal mode.

## Preview runtime

PreviewManager owns launch presets and the dev-server process tree. A launch
preset contains an exact executable/argv, canonical cwd, filtered environment,
readiness probe, expected bind host/port policy and resource limits.

Starting an arbitrary project script can execute code and requires explicit user
approval unless it matches a previously approved project-scoped preset. Use
`shell:false`. Detecting a package-manager script does not authorize it.

Dev servers default to loopback. A server must not bind to LAN merely because the
Studio Web listener is enabled. Preview exposure and Host API exposure are
separate settings.

### Desktop Preview isolation

Project Preview content is untrusted. Each Preview uses an isolated
`WebContentsView` with a unique non-persistent session partition and:

```ts
{
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  preload: undefined
}
```

Required controls:

- no Studio preload, IPC, Host cookies, bearer secrets or shared storage;
- default-deny permissions, downloads, popups and external protocols;
- intercept initial URL, redirects and `will-navigate`; default allow only the
  bound Preview origin;
- `setWindowOpenHandler` denies by default;
- do not disable certificate checks or web security;
- destroy WebContents, partition data, workers and service workers on final stop;
- bound console/network capture and redact credential-like headers.

Preview browser crashes do not kill the dev server. Dev-server exit does not grant
the Preview permission to navigate elsewhere. Both produce independent state.

### Web Preview isolation

Direct iframe is allowed only when the Preview server's framing policy permits it
and Studio can apply an appropriate `sandbox` attribute. Otherwise use a separate
tab or an explicit reverse proxy.

A Preview proxy uses an origin distinct from the Host API and never injects Host
authentication. Its policy explicitly covers redirects, CSP, cookies, HMR
WebSockets, service workers, absolute URLs, cache and response-size limits. It
does not become an open proxy. Remote clients cannot use server-side localhost
directly; remote Preview remains disabled until this proxy boundary is implemented
and reviewed.

### Agent-visible Preview tools

`preview_status`, screenshot, console, DOM, click and type are Host Tools bound at
registration time to project, thread, Preview ID and runtime epoch. The model
cannot nominate an arbitrary Preview or URL. Read-only inspection and browser
input have separate risk tiers; click/type, sensitive input and cross-origin
navigation require the configured approval policy. Cancelled/timed-out calls
discard late results.

## Process containment

### Common spawn rules

- Resolve an absolute executable before setting project `cwd`.
- Use explicit argv and `shell:false`; platform wrapper launchers are dedicated
  code, not string concatenation.
- Filter environment and set resource/output limits before useful work begins.
- Assign the child to its containment domain before accepting client commands.
- Drain stdout and stderr concurrently with bounded buffers.

### Windows

Create the root process suspended, create one Job Object per domain with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign it, disable breakaway and only then
resume. Assignment failure terminates the suspended child and fails creation.
ConPTY handles and the Job Object have distinct ownership; both are closed during
terminal teardown.

### macOS/Linux

Start each domain in a new process group/session. Signal the group, not only the
root PID. Where supported, use parent-death/lifetime primitives as defense in
depth, but do not depend on them as the sole cleanup mechanism.

### Stop sequence

1. mark domain `stopping` and reject new work;
2. revoke attach tickets and browser/tool controls;
3. send the protocol-specific interrupt/graceful shutdown;
4. drain output until a bounded deadline;
5. terminate the entire containment domain;
6. close PTY/browser/process handles and emit one terminal event;
7. ignore late callbacks carrying the retired generation.

Stop is idempotent. Host crash recovery, half-created domain, forked child,
preview restart, terminal disconnect and Windows assignment failure are required
tests.

## Containment is not sandboxing

A Job Object or POSIX process group groups descendants for limits and cleanup. It
does not prevent filesystem reads/writes, credential access, network access,
process injection, registry changes or child escape through external services.

Likewise Electron Renderer sandboxing does not sandbox a dev-server process.
Claims such as “safe Preview process” or “sandboxed terminal” are forbidden unless
the product separately implements and verifies an OS sandbox/container policy.
MVP security comes from explicit user authorization, workspace scoping, filtered
launch configuration, least privilege and reliable process-tree reclamation.

Ticket, Preview and containment contract types are in
`contracts/security-types.ts`.

