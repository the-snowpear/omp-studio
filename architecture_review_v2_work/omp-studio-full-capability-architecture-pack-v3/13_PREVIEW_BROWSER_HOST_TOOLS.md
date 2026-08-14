# Preview, Browser and Host Tools

## Ownership

OMP owns the Agent and tool-call decision. Studio owns the developer server, embedded preview surface and desktop/browser observations it chooses to expose as Host Tools.

## Preview runtime

```text
Project
 -> PreviewManager
 -> dev server process
 -> browser surface
```

Desktop: Electron `WebContentsView`.
WebUI: iframe/proxy/new-tab depending on page policy. Remote: Host proxy/remote browser strategy.

The Preview is untrusted content. Desktop uses a unique non-persistent Electron
session with `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`,
`webSecurity:true` and no preload/IPC. It does not share cookies, permissions,
storage or Host credentials with the app. Navigation, new windows, downloads,
external protocols and permissions are default-deny. WebUI Preview uses a
different origin from the Host API. Full rules are in
`contracts/preview-security.md`.

## Host Tools

Register Studio-owned capabilities through native RPC Host Tools, for example:

```text
preview_start
preview_stop
preview_status
preview_screenshot
preview_dom_snapshot
preview_console
preview_network_errors
preview_click
preview_type
preview_wait_for
```

This allows the real OMP Agent to verify its work without embedding Studio logic into OMP.

## Host URI schemes

Use Host URI schemes for stable Studio-managed resources where appropriate, e.g. preview snapshots, issue objects or other local structured resources.

## Browser/computer/LSP/DAP

If OMP already exposes a tool internally, Studio can observe ordinary tool events without rebuilding the tool.

Dedicated GUI control/state for those subsystems should only be added when there is a deterministic API. Otherwise render tool execution/result and leave execution semantics in OMP.

## Security

Preview/browser Host Tools must pass through Studio's SecurityGate and have separate approval tiers from ordinary read-only observation.

Tool registration binds `projectId`, `previewId`, `threadId` and
`runtimeEpoch` in Host-owned state; the model cannot select arbitrary resource
IDs or paths. Preview stop destroys the isolated session and terminates the
owned dev-server process tree.
