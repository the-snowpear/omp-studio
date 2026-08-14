# Host API Contract Sketch

The UI consumes semantic Studio APIs, never raw OMP channel APIs.

All resource IDs are opaque Studio handles. Browser authentication follows
`host-auth.md`; mutation routes require `Idempotency-Key` and the applicable
control/write lease preconditions.

## Authentication

```text
POST /api/auth/pair
GET  /api/auth/session
POST /api/auth/logout
```

## Capability

```text
GET  /api/capabilities
POST /api/capabilities/refresh
```

## Projects / Threads

```text
GET  /api/projects
POST /api/projects/open
GET  /api/threads/:id
POST /api/threads/:id/start
POST /api/threads/:id/stop
GET  /api/threads/:id/snapshot
```

## Runtime

```text
POST /api/threads/:id/prompt
POST /api/threads/:id/steer
POST /api/threads/:id/follow-up
POST /api/threads/:id/abort
POST /api/threads/:id/model
POST /api/threads/:id/thinking
```

Successful mutation acceptance returns `202 { commandId, statusUrl }`. The
response is not proof that OMP completed the operation.

## Commands

```text
GET  /api/commands/:commandId
POST /api/commands/:commandId/cancel
```

## Agents

```text
GET  /api/threads/:id/agents
GET  /api/threads/:id/agents/:agentId/transcript
POST /api/threads/:id/agents/:agentId/message
POST /api/threads/:id/agents/:agentId/kill
POST /api/threads/:id/agents/:agentId/revive
```

These endpoints may report `409 capability_unavailable` when the current OMP runtime lacks a deterministic route. UI can query the capability snapshot to avoid presenting unsupported actions.

## Config

```text
GET/PUT /api/config/global/:path
GET/PUT /api/projects/:id/config/:path
GET/PUT /api/providers
GET/PUT /api/mcp
GET/PUT /api/roles
```

Config/file PUT requires `If-Match` or an `expectedRevision`; conflict returns
`409 write_conflict` without overwriting the current file.

## Events

WebSocket is authenticated before upgrade. Its first client frame contains an
epoch-bound resume cursor. Snapshot/replay follows `event-stream.ts`; a gap or
epoch mismatch returns `resync_required`.

## Common errors

```text
401 unauthenticated
403 forbidden
404 resource_not_found
409 stale_epoch | lease_required | write_conflict | capability_unavailable
410 replay_expired
```
