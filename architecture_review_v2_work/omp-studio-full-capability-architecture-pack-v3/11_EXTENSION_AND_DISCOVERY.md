# Extensions, Skills, Agents, Hooks, Tools and MCP

## Principle

Studio may manage definitions and display effective discovery, but OMP remains the authoritative loader/resolver.

## Capability sources

OMP discovery can aggregate native `.omp` content and compatible sources from other coding tools. The exact precedence is OMP-owned and may evolve.

Studio therefore needs two views:

1. **Configured**: files/settings that exist on disk.
2. **Effective/Loaded**: what the active OMP process actually resolved.

Do not conflate them.

## Skills

Possible Studio channels:

- Native file CRUD for OMP-native skills.
- Config CLI/file for skill filters and source toggles.
- `get_available_commands` when `/skill:<name>` commands are enabled.
- Companion Extension for exact resolved skill inventory when RPC/CLI lacks a structured lister.

Studio should display source/provider, winning path, collision warnings, enabled/ignored/include filters and whether a skill is invocable as a command.

## Agent definitions

Configured definitions can be managed from OMP-native agent directories. Runtime resolution should be OMP-owned.

Preferred discovery order for Studio:

1. future `get_agent_definitions` RPC,
2. Companion Extension resolved inventory,
3. infer active task-agent choices from OMP tool schema/state when possible,
4. conservative native file scan as configured view only.

Do not claim a raw file scan equals OMP's effective agent registry when plugins/bundled agents/collisions are involved.

## Extensions / Plugins

Studio should manage:

- configured sources/paths,
- enabled/disabled state,
- reload requests,
- errors,
- contributions: commands/tools/skills/hooks/agents where discoverable.

Runtime contribution truth should come from OMP command/tool state or Companion Extension, not a Studio-side TypeScript loader.

## Hooks and Custom Tools

Studio can edit files and settings but should not import arbitrary extension/hook code in the Host just to inspect it. That would execute third-party code in the wrong process/security context.

For effective metadata, prefer OMP-side introspection.

## MCP

Use OMP-native `mcp.json` files for definitions. OMP owns protocol connections, OAuth, tools and runtime behavior.

Studio responsibilities:

- CRUD definitions,
- show configured vs connected,
- trigger supported reauth/reload commands,
- display tool/resource/prompt metadata when OMP exposes it,
- surface connection/auth errors.

## Custom Extension UI

`rpc-ui` supports a useful cross-process UI subset such as select/confirm/input/editor/notify/status/widget/title/editor text/open URL.

Arbitrary TUI custom components are not automatically portable. Studio must not pretend to render unknown TUI primitives.

Compatibility policy:

- standard rpc-ui request -> render natively,
- unsupported custom TUI component -> show compatibility notice and optional "Open in OMP terminal" escape hatch,
- future Studio-specific extension UI schema -> separate opt-in contract, not inferred from TUI code.
