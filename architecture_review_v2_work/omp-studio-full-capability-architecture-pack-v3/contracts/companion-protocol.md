# Companion Extension Protocol Sketch

Temporary compatibility contract carried through deterministic extension commands.

This route is experimental whenever implementation requires OMP private imports.
The Host command ledger `commandId` is authoritative; the Companion `requestId`
is only a transport correlation ID.

## Discovery command

```text
/studio capabilities
```

Output payload:

```json
{
  "protocol": "omp-studio-companion/1",
  "ompVersion": "...",
  "capabilities": {
    "agent.message": true,
    "agent.kill": true,
    "agent.revive": true,
    "agent.release": false,
    "discovery.agents": true,
    "discovery.skills": true
  }
}
```

## Agent command

```text
/studio agent-command <base64url-json>
```

Payload shape:

```json
{
  "requestId": "uuid",
  "agentId": "ReviewerFox",
  "action": "kill | revive | message | release",
  "message": "optional"
}
```

Response is versioned JSON in command output.

Exactly one machine-readable terminal response is allowed per request. Duplicate
request IDs return the original response when the payload matches and an error
when it differs. Timeout, private ABI mismatch and malformed response have
distinct error codes. A response received after `runtimeEpoch` changes is
discarded. If reliable correlation is unavailable, the route is single-flight.

## Safety

- No arbitrary eval.
- Validate agent ids/actions.
- Command returns machine-readable errors.
- No secret access.
- Disable on unsupported OMP version/private ABI mismatch.
- Verify the Companion package from a trusted absolute path and expected hash;
  a project extension must not be able to spoof `/studio` capability discovery.
