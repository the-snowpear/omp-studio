# Security Model

## Threat model

OMP Studio exposes a local coding harness that can read and write files, execute
commands, use provider credentials, open network connections, automate Preview
content and load third-party OMP extensions. A Host endpoint is therefore an RCE
control plane, even when it listens only on loopback.

Threats include:

- a malicious website targeting loopback or using DNS rebinding;
- compromised Renderer, extension UI or rendered Markdown;
- untrusted project code running as a Preview/dev server;
- stale browser tabs replaying control, approval or PTY messages;
- path traversal, symlink/junction escape and opaque-ID authorization bugs;
- secret leakage through URL, argv, logs, diagnostics, Markdown or Preview;
- a child process escaping cleanup or exceeding resource limits;
- a remote client with valid authentication but excessive scope.

## Trust boundaries and principals

Authenticated principals are limited to Desktop Main and issued Web client
sessions. OMP runtimes are capability subjects when they call Host Tools, but
they are not browser principals. Renderer, Markdown, Preview page, dev server,
terminal child and arbitrary local webpage are never trusted principals.

```text
untrusted content/client
 -> authenticated transport session
 -> authorization + revision checks
 -> SecurityGate
 -> one scoped Host capability
 -> owned runtime/resource
```

Authentication answers who the caller is. Authorization independently answers
which project/thread/resource and risk tier that session may use. A control lease
does not grant workspace write, terminal or remote access by itself.

## Authentication by transport

### Desktop

- Bootstrap only through owner-authenticated private IPC.
- Electron Main holds the short-lived client session and proxies requests.
- Renderer and Preview never receive the Host instance secret or session secret.
- Authority replacement changes `authorityEpoch` and requires a new bootstrap;
  an IPC reconnect to the same live authority does not invent a new epoch.

### Local WebUI

- Web listener must be explicitly enabled.
- Pairing code is at least 128 bits, single-use, rate-limited and expires within
  60 seconds.
- Pair with same-origin `POST`; never put pairing/session secrets in URLs.
- Issue an `HttpOnly; Secure` cookie when HTTPS is used and always use
  `SameSite=Strict`; loopback HTTP development may omit `Secure` only while bound
  strictly to loopback.
- Mutations require a per-session CSRF proof in addition to the cookie.

### Remote

- HTTPS/WSS only; TLS 1.2+, certificate and hostname validation required.
- Remote sessions are shorter-lived than local Desktop sessions and are
  revocable per device.
- Remote project scope is an allowlist. Terminal, browser input, network and
  workspace-write grants are separately opt-in.
- Brute-force throttling and security audit events are mandatory.

## Host, Origin, CORS, CSRF and WebSocket policy

Before any Web authentication or resource lookup:

1. Validate the `Host`/authority against exact configured hosts and ports. A
   loopback peer with a non-loopback Host is rejected to stop DNS rebinding.
2. Validate `Origin` by exact serialized origin; no suffix, substring, reflected
   or wildcard matching. Requests requiring an Origin reject missing Origin
   unless they use an explicitly non-browser authenticated channel.
3. CORS is deny-by-default. If enabled for a configured Web app origin, allow
   only required methods/headers and credentials for that exact origin.
4. Cookie-authenticated mutations require `X-Studio-CSRF` bound to the current
   client session and auth generation. Safe GET endpoints never mutate state.
5. WebSocket validates Host, Origin, session, grant scope and protocol before
   upgrade. The first application frame binds a resume cursor and requested
   scopes. Authentication tokens and PTY tickets are not accepted in query
   strings.

WebSocket messages after logout, expiry, auth-generation change or Host epoch
change are rejected even if the TCP connection remains open.

## Authorization and opaque resources

Client grants contain role, risk tiers, project/thread allowlists, expiry and
`authzRevision`. Every operation declares a resource scope and required risks.
The Host resolves client-visible random opaque IDs only after checking the grant.

OMP session paths, subagent transcript paths, PTY handles, process IDs, Preview
partition names and canonical workspace paths remain Host-private. Invalid,
stale and out-of-scope IDs use the same public error shape.

Mutations additionally check:

- current client/control lease revision;
- workspace writer lease for any write-capable operation;
- `runtimeEpoch` for OMP/approval operations;
- one-time ticket generation for PTY/Preview stream attachment.

## Filesystem and executable boundary

- Resolve configured executable and resource paths to absolute canonical paths
  before changing `cwd`.
- Handle symlinks, Windows junctions, drive aliases, UNC paths, case behavior and
  nonexistent leaf paths explicitly.
- Spawn programs with explicit argv and `shell:false`; never compose project
  strings into a shell command.
- Filter inherited environment variables and redact secrets from diagnostics.
- Studio-managed writes use atomic replace plus expected revision/content hash.
- Never accept OMP session/transcript paths from a client.

## Markdown, HTML, CSP and URLs

Assistant, tool, terminal and project output is untrusted text.

- Parse Markdown with raw HTML disabled. If a feature requires HTML, sanitize it
  with an allowlist after parsing; script/style/iframe/object/embed/form, inline
  handlers and dangerous CSS are removed.
- Do not use `dangerouslySetInnerHTML` with unsanitized model/tool output.
- Highlighting and Mermaid-like renderers run without eval and produce sanitized
  output; oversized/complex diagrams are rejected or rendered out of process.
- Link schemes default to `https:` and `http:`. `mailto:` is optional. Reject
  `javascript:`, `data:`, `file:`, `vbscript:`, `shell:`, custom application
  schemes and control characters from untrusted content.
- External navigation requires an explicit user gesture and passes through Main's
  URL policy. Never pass an untrusted string directly to shell-open APIs.
- Remote images are disabled by default or fetched by a bounded, privacy-aware
  image proxy. `data:` is limited to allowed image MIME types and size.
- The app document uses a restrictive CSP: `default-src 'self'`, no object/embed,
  no unrestricted `connect-src`, no `unsafe-eval`, and nonce/hash-based scripts.
  Preview content has a different CSP/origin/session and never inherits app CSP
  exceptions or Host credentials.

## Host Tools and extension UI

OMP's tool policy does not automatically authorize Studio Host Tools. Each Host
Tool declares a risk tier, fixed project/thread/runtime scope, schema, timeout,
output cap and approval policy. The model cannot choose an arbitrary path,
terminal, Preview or URL outside the bound registration.

Extension UI request IDs are bound to the originating `runtimeEpoch`. Only the
current controller may submit a terminal answer. Timeout, cancellation, lease
transfer or runtime replacement closes the request; late answers are ignored and
audited.

## Secrets, logging and audit

- Provider credentials remain OMP-owned. Do not read or mirror OMP credential DBs.
- Secrets never appear in URL, argv, localStorage, crash report, analytics or
  normal structured logs.
- Diagnostic export is redacted and requires explicit user action.
- Record security audit events for authentication, grant/lease changes, approvals,
  terminal attach, Preview browser input, remote access and denied capability
  attempts. Do not record terminal contents or model prompts by default.
- Logs and event journals have size/time limits and safe file permissions.

## Security gates before release

- DNS rebinding, hostile Origin, CSRF and unauthenticated WebSocket tests.
- Session expiry/revocation and stale `authzRevision` tests.
- IDOR and opaque-ID enumeration tests across projects/threads.
- malicious Markdown/link/image/CSP tests.
- symlink/junction/UNC/path-case tests on supported platforms.
- PTY ticket replay and stolen-ticket cross-session tests.
- malicious Preview navigation, popup, download, permission, service-worker and
  Host-origin access tests.
- remote TLS/certificate validation and trusted-proxy spoofing tests.

Normative types are in `contracts/security-types.ts`.
