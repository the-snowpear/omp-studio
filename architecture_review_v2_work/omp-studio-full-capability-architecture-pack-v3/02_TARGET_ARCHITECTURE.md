# Target Architecture

```text
                           +---------------------------+
                           | Shared React Application  |
                           | Workbench / Agents / Diff |
                           | Models / Roles / Settings |
                           +------------+--------------+
                                        |
                        HTTP / WebSocket| + Desktop-only bridge
                                        v
+------------------------------------------------------------------+
|                       OMP Studio Host                              |
|                                                                   |
|  +--------------------+     +----------------------------------+   |
|  | Capability Broker  |---->| Capability Snapshot / Resolver   |   |
|  +---------+----------+     +----------------------------------+   |
|            |                                                      |
|   +--------+--------+--------+--------+----------+----------+      |
|   |                 |        |        |          |          |      |
| RPC UI          Slash/RPC   CLI    Config/File Companion  Collab   |
| Adapter          Adapter  Adapter    Adapter    Extension   Exp.    |
|   |                 |        |        |          |          |      |
|   +-----------------+--------+--------+----------+----------+      |
|                         |                                         |
|  Project/Thread Manager | Workspace/Git | Terminal | Preview       |
|  Event Journal          | Security Gate | Diagnostics              |
+-------------------------+-----------------------------------------+
                          |
                          | spawn / stdio / config / local files
                          v
                  +---------------------+
                  | Real installed OMP  |
                  | `omp --mode rpc-ui` |
                  | OMP Harness         |
                  +---------------------+
```

## App surfaces

### Desktop

Electron owns OS integration only:

- windows and menus,
- native dialogs,
- `WebContentsView` preview,
- notifications,
- auto-update,
- external editor/file-manager launch.

The Electron renderer uses the same Host API as the browser client for OMP business capabilities.

### Local WebUI

The browser connects to the same Host over loopback HTTP/WebSocket. The Host performs all privileged work.

### Remote WebUI

A later mode. The same Host contract can be exposed remotely only with explicit TLS/auth/project allowlists. Remote mode is not required for the first release.

## Host modules

Mandatory control-plane modules are `AuthBootstrap/SessionManager`,
`OpaqueIdRegistry`, `CommandLedger`, `WorkspaceWriteCoordinator` and
`ProcessTreeSupervisor` beside the Capability Broker. Preview runs across an
untrusted boundary and cannot call the privileged Host surface directly.

```text
Host
├── CapabilityBroker
├── CapabilityProbe
├── OmpProcessSupervisor
├── RpcUiAdapter
├── SlashCommandAdapter
├── OmpCliAdapter
├── OmpConfigAdapter
├── OmpNativeFilesAdapter
├── CompanionExtensionAdapter
├── ExperimentalCollabAdapter
├── ProjectManager
├── ThreadManager
├── AgentProjection
├── ToolProjection
├── WorkspaceObserver
├── GitService
├── TerminalService
├── PreviewManager
├── HostToolRegistry
├── EventJournal
├── SecurityGate
└── DiagnosticsService
```

## Key boundary

The Host can have many ways to *reach* an OMP capability, but it must expose one stable Studio API to the UI. UI components never import RPC frame types, parse OMP YAML directly, or know whether a button used RPC, CLI, config, or a compatibility extension.
