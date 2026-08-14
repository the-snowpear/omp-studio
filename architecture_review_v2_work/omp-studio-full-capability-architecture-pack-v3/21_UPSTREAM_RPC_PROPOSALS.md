# Upstream RPC Proposals

These are proposed additions to OMP native RPC that would remove compatibility bridges and improve first-party GUI control.

## P0 - Capability manifest

```text
get_capabilities
```

Return the OMP build/commit identifier, supported RPC methods, emitted event
families, standard Extension UI request types, feature flags and relevant
limits. Slash command metadata remains separate. This removes unsafe inference
from protocol v2 or `get_available_commands`.

## P0 - Agent Hub control

```ts
type AgentCommand =
  | { type: "agent_command"; agentId: string; action: "kill" }
  | { type: "agent_command"; agentId: string; action: "revive" }
  | { type: "agent_command"; agentId: string; action: "release" }
  | { type: "agent_command"; agentId: string; action: "message"; message: string };
```

Response should include resulting status and a machine-readable failure code.

## P0 - Async jobs

```text
get_async_jobs
cancel_async_job
get_async_job
```

Needed because not all background jobs should be modeled only through subagent snapshots.

## P1 - Agent definitions

```text
get_agent_definitions
```

Return resolved effective definitions with source, model selectors, tools, spawns, blocking, prewalk, output schema metadata and availability/errors.

## P1 - Advisor

```text
get_advisor_state
set_advisor_enabled
get_advisor_stats
```

Keep config mutations separate from per-session runtime controls.

## P1 - Configuration schema/value API

```text
get_config_schema
get_config_value(scope)
set_config_value(scope)
reset_config_value(scope)
```

Project scope support is particularly useful because the current config CLI writes global settings only.

## P1 - Provider/model config

```text
get_provider_definitions
validate_provider_definition
write_provider_definition
remove_provider_definition
refresh_model_registry
```

Could remain CLI/file-based if OMP intentionally prefers file ownership; validation/refresh endpoints are the highest-value pieces.

## P1 - Auth account lifecycle

```text
get_auth_accounts
logout_provider
```

Do not expose raw tokens.

## P2 - Extensibility inventory

Structured effective inventory APIs:

```text
get_skills
get_extensions
get_hooks
get_custom_tools
get_mcp_servers
```

Each should distinguish configured source, loaded state, collision/winner, errors and runtime contribution metadata.

## P2 - Collaboration

```text
get_collab_state
start_collab
stop_collab
get_collab_participants
```

Avoid Studio depending on internal Collab frames.

## Design principle

New RPC commands should expose OMP-owned semantics, not Studio-specific abstractions. Studio adapts them into its own Host contract.
