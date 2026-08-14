# Version and Capability Negotiation

## Principle

Do not implement `if ompVersion >= X then feature = true` as the primary mechanism.

Versions are diagnostics. Runtime probes are authority.

## Probe sequence

### Binary/admin

```text
omp --version
omp config path
omp config list --json
```

Probe optional machine-readable CLI subcommands only after help/capability detection or known command availability.

### RPC

- ready frame,
- negotiate protocol v2,
- compare against the pinned compatibility band,
- get_state,
- get_available_commands,
- get_available_models,
- get_login_providers,
- subagent subscription.

The ready frame advertises framing/protocol support, not the RPC method list.
`get_available_commands` advertises slash commands only. Until OMP exposes
`get_capabilities`, Studio uses a conservative pinned-build method matrix plus
safe probes; an unknown build disables unproven controls.

### Files

Resolve profile/agent directory and check OMP-native config roots.

### Companion

Discover command and request protocol/capability manifest.

## Capability IDs

Use stable Studio IDs such as:

```text
session.prompt
session.steer
session.abort
session.branch
model.list
model.set
role.configure
advisor.configure
advisor.runtimeControl
subagent.observe
subagent.transcript
subagent.message
subagent.kill
subagent.revive
skill.listEffective
plugin.reload
mcp.configure
preview.hostTools
```

Map them to current OMP routes at runtime.

## Runtime epochs

Capability snapshots are not global. Each is tied to client authorization,
resource scope, `authzRevision`, `hostEpoch` and, when applicable, an OMP
`runtimeEpoch`. Host/project/runtime/preview capabilities are computed
separately. Restart, reload, lease change or authorization change invalidates
the affected snapshot; routes cannot be reused across Threads or Previews.

## Diagnostics

For each disabled feature provide:

```text
unsupported because:
- RPC command absent
- companion not installed
- configured fallback disabled
- requires OMP restart
```

This is preferable to generic "not supported by this version" messaging.
