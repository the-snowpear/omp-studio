# Security Model

## Threat model

OMP Studio combines an AI coding harness, shell/tool execution, local filesystem access, credentials, browser automation and optional remote clients. The Host is a privileged local service and must be treated accordingly.

## Trust boundaries

```text
Renderer / Browser
  -> authenticated Host API
  -> SecurityGate
  -> OMP / filesystem / shell / preview / config
```

Renderer never receives arbitrary Node access.

## Loopback Host

Default bind is explicit loopback only. Use the Desktop private-IPC or Browser
one-time pairing bootstrap in `contracts/host-auth.md`; no long-lived token may
appear in URLs, argv, renderer storage or logs. Validate exact Host and Origin,
CSRF-protect mutations and authenticate before WebSocket upgrade.

Clients use only opaque handles defined by `contracts/identifiers.md`. Every
request is authorized against its project/thread/preview scope before capability
resolution, so diagnostics cannot become an IDOR oracle.

## Remote mode

Off by default. Require explicit enablement, TLS or trusted reverse proxy, strong authentication, project allowlists, session expiry and audit events.

## Secrets

- Never send plaintext provider secrets to the renderer after submission.
- Never read/write `agent.db` directly.
- Prefer OMP login/auth-broker/environment/command-secret mechanisms.
- Redact secrets from logs and diagnostics.
- Project config must warn before persisting secrets into a repository path.

## Config/file writes

- canonicalize target paths,
- prevent symlink escapes for guarded project writes,
- use atomic writes,
- keep undo/backups,
- schema-validate before replace,
- detect concurrent external modification.

Project mutations additionally require the workspace write lease and a matching
revision/content hash. The CAS and conflict behavior is defined in
`contracts/workspace-write.md`.

## Companion Extension

Treat as privileged code running inside OMP. Verify expected package/protocol version. Do not auto-enable private-internal features on an unknown OMP build.

## Experimental Collab adapter

Disabled by default. If used locally, avoid public relay dependency. Do not persist full-control links or keys in normal logs.

## Host Tools

Each Host Tool declares a capability tier. Read-only inspection, workspace writes, browser input, network and OS interaction are separate approval classes.

OMP's own tool approval does not automatically authorize a Host Tool. Preview is
not a Host principal and is isolated according to `contracts/preview-security.md`.
Host-owned children are reclaimed as whole process trees according to
`contracts/process-containment.md`.
