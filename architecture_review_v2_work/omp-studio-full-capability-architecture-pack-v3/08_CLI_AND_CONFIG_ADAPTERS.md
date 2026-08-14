# CLI and Config Adapters

## 1. `omp config` adapter

Use OMP's own machine-readable settings catalog and validator whenever possible.
Do not overstate `config list --json` as a complete JSON Schema for every native
file.

Startup probe:

```bash
omp config list --json
omp config path
```

Use `get/set/reset --json` for global settings. This gives Studio OMP-owned type validation and descriptions.

### Important scope rule

`omp config set/reset` write the global config. They do **not** write project `<cwd>/.omp/config.yml`.

Therefore:

- Global setting -> `omp config` CLI.
- Project setting -> project config file adapter.
- Temporary per-process override -> launch config/flag only, never persist silently.

## 2. Project config adapter

Target:

```text
<project>/.omp/config.yml
```

Must preserve unrelated keys, comments where possible, and external user edits.

Workflow:

```text
acquire workspace write lease
 -> read current file and record revision/content hash
 -> parse CST/AST
 -> patch exact path
 -> validate known value against latest OMP settings catalog/validator
 -> re-read and compare expected hash
 -> write temp
 -> optional validation launch/get from project cwd
 -> atomic rename
 -> notify running sessions whether restart/reload is required
```

Hash/revision mismatch returns `409 write_conflict`, preserves both versions and
never silently merges. See `contracts/workspace-write.md`.

## 3. Provider/model adapter

Conceptual default target (never hard-code it):

```text
~/.omp/agent/models.yml
```

Use for custom providers, endpoints, custom models, discovery, overrides, headers and compatibility.

After write:

- run model/config validation where available,
- query `omp models ... --json` and/or live RPC model list,
- show effective models rather than assuming save = availability.

## 4. MCP adapter

OMP-native preferred files:

```text
Project: .omp/mcp.json
User:    ~/.omp/agent/mcp.json
```

Named profiles relocate user-level paths. Studio must resolve active profile before editing.

All user-level paths, including `models.yml`, MCP and definition roots, are
derived from `omp config path`/the active profile and kept behind Host opaque
registries. Renderer input never selects an arbitrary local path.

Use direct schema-aware file editing for CRUD; use OMP slash/runtime flows for OAuth reauth or runtime refresh when needed.

## 5. Auth adapter

Do not read/write `agent.db` directly.

Prefer:

- RPC login for in-session login,
- OMP auth-broker CLI for headless/admin/list/status/login/logout/import/migrate where appropriate,
- environment/secret-source configuration for custom providers.

Renderer receives only masked credential metadata and status.

## 6. File-backed definitions

Studio may edit or create OMP-native definitions such as:

- Agents,
- Skills,
- MCP config,
- native extension/hook/tool source files,
- project instruction files.

Editing a definition is configuration management. Runtime discovery remains OMP-owned.

## 7. Reload behavior

Each write route must return:

```ts
{
  applied: true,
  runtimeEffect: "immediate" | "reload-command" | "new-session" | "restart-process",
  reloadCommand?: string,
}
```

Never claim a setting is active just because a file was saved.
