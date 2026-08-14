# Capability Broker

The Capability Broker is the central design change in v2.

## Why

OMP's feature surface is wider than any single transport. Native RPC is the best live-session transport but does not currently expose every management operation. Configuration and discovery are also intentionally spread across CLI/config/native files.

The Broker prevents this reality from leaking into React components.

## Capability model

```ts
export type CapabilitySurface =
  | "execute"
  | "observe"
  | "control"
  | "configure"
  | "diagnose";

export type OmpChannel =
  | "rpc-ui"
  | "slash-rpc"
  | "cli"
  | "config-cli"
  | "native-file"
  | "studio-host"
  | "companion-extension"
  | "collab-experimental";

export type SupportGrade =
  | "native"
  | "supported-fallback"
  | "experimental"
  | "unavailable";

export interface CapabilityRoute {
  capabilityId: string;
  surface: CapabilitySurface;
  channel: OmpChannel;
  grade: SupportGrade;
  reason: string;
  requiresRestart?: boolean;
  versionGuard?: string;
}
```

## Example

`subagent.lifecycle.observe`:

```text
rpc-ui / set_subagent_subscription(events)
Grade: native
```

`subagent.kill.control`:

```text
1. native RPC agent_command          -> preferred when upstream exists
2. companion extension             -> experimental exact-build bridge
3. collab agent-cmd                 -> experimental fallback
4. unavailable                     -> honest UI disable
```

`modelRole.configure`:

```text
Global: omp config set
Project: .omp/config.yml schema-aware atomic edit
```

## Capability snapshot

Host-wide probe results may be cached, but the effective snapshot is built per
principal + resource scope + runtime epoch. A capability may be supported by the
platform yet currently unauthorized, not ready, or blocked by a missing lease.

Build it from actual runtime probes:

1. `omp --version`.
2. `omp config path`.
3. `omp config list --json` as a machine-readable settings catalog, not a complete JSON Schema guarantee.
4. RPC ready + protocol negotiation.
5. `get_state`.
6. `get_available_commands`.
7. `get_available_models`.
8. `get_login_providers`.
9. `set_subagent_subscription` probe.
10. Companion extension command presence, if installed.
11. Presence/readability of native config roots.
12. Optional experimental Collab capability probe.

Never decide feature availability from a hard-coded version table alone. Route
cache keys include scope and runtime epoch; every invocation rechecks identity,
authorization, epoch and leases instead of trusting a stale UI snapshot.

`get_available_commands` enumerates slash commands. It must never be used to
infer the presence of RPC methods such as `set_fast_mode`.

## Route selection

Routes are selected by semantic policy, not simply first adapter that returns success.

Examples:

- Active session abort must use RPC, not shelling out to a second OMP process.
- Global boolean setting should use `omp config set` because it validates against OMP's schema.
- Project setting cannot use `omp config set` because that command writes global config; use the project file adapter.
- Provider definitions must use `models.yml`, not `config.yml`.
- A TUI-only custom component cannot be silently converted into a generic form; report limited compatibility.

## UI contract

UI receives both effective capability and route metadata:

```ts
{
  id: "subagent.kill",
  supported: true,
  grade: "supported-fallback",
  channel: "companion-extension",
  note: "Native OMP RPC does not expose kill yet"
}
```

Normal users need not see channel details. Diagnostics and developer mode should.
