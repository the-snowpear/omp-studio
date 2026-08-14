# Host Authentication and Bootstrap Contract

This contract is normative for local Desktop and local WebUI. The Host is a privileged loopback service; possession of a port number is never authorization.

## Host instance and discovery

- Each Host start creates a random `hostEpoch`, a 256-bit instance secret and a random loopback port.
- Bind only to `127.0.0.1` and `::1` by default. Never bind a local instance to `0.0.0.0`.
- A discovery record may contain only `{ hostEpoch, endpoint, pid, protocolVersion, startedAt }`; it must not contain a bearer secret.
- Store the record under the active Studio profile with an owner-only ACL. Create it atomically and hold a single-instance lock for the profile.
- Validate `Host` and `Origin` against exact allowlists before authentication. WebSocket upgrades use the same checks.

## Desktop bootstrap

1. Electron Main starts or attaches to the Host.
2. Main proves possession of the instance secret over an inherited private pipe or an owner-only local IPC endpoint.
3. The Host issues Main a short-lived, scoped client session.
4. Renderer calls a narrow preload API; Main proxies Host requests. The Renderer never receives or persists the Host credential.
5. Preview WebContents never receives this preload API or the client session.

## Browser bootstrap

1. `omp-studio serve` prints or displays a one-time pairing code on a trusted local surface.
2. The user enters the code into the same-origin Studio page. The code is sent only in a POST body to `/api/auth/pair`.
3. A valid code is single-use, expires within 60 seconds and is rate-limited.
4. The Host returns an HttpOnly, SameSite=Strict session cookie and a non-authoritative CSRF token. The cookie is never exposed to JavaScript.
5. Mutations require both the session cookie and `X-Studio-CSRF`; WebSocket authentication occurs before upgrade.

Long-lived secrets are forbidden in URLs, localStorage, command-line arguments, analytics and normal logs.

## Authorization

Every client session contains:

```ts
interface ClientGrant {
  clientId: string;
  role: "observer" | "controller";
  projectIds: string[];
  threadIds?: string[];
  expiresAt: number;
  authGeneration: number;
}
```

- Read APIs require an observer grant for the resource.
- Mutations additionally require controller role, the current control lease and any workspace write lease.
- Host restart, explicit logout, session expiry or `authGeneration` change revokes existing sessions.
- `/health` returns only liveness and protocol compatibility; all diagnostic detail is authenticated.

## Failure responses

- `401 unauthenticated`: missing, expired or revoked session.
- `403 forbidden`: authenticated but outside grant scope.
- `409 lease_required`: valid identity but no current control/write lease.
- Authentication failures never reveal whether a project, thread or opaque ID exists.
