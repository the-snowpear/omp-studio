# Preview Isolation and Host Tool Contract

Project Preview content is untrusted, even when it is served from loopback.

## Electron WebContentsView

Use a unique non-persistent session partition per Preview and:

```ts
{
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  preload: undefined
}
```

- Do not share cookies, cache, storage, permissions or the Studio Host credential with the app Renderer.
- Default-deny permission requests, downloads, new windows and external protocols.
- Intercept navigation and redirects; allow only the bound Preview origin unless the user explicitly approves a new origin.
- Preview content has no Electron IPC and cannot reach the Host API origin.
- Destroy the partition, workers and service-worker state when the Preview closes.

## WebUI Preview

Serve Preview proxy content from an origin distinct from the Host API. Never inject Host cookies or authorization headers. Preserve `webSecurity`; define CSP, redirect, cookie, service-worker and HMR WebSocket policy explicitly. If isolation cannot be proven, use a new tab instead of an iframe.

## Host Tool policy

Every Host Tool declares:

```ts
interface HostToolPolicy {
  capabilityId: string;
  risk: "read_preview" | "browser_input" | "workspace_write" | "network" | "os_control";
  projectId: string;
  previewId?: string;
  requiresApproval: "never" | "session" | "each_call";
  timeoutMs: number;
  maxOutputBytes: number;
}
```

- No generic `exec`, arbitrary filesystem path or unrestricted URL navigation Host Tool.
- `preview_click/type` are limited to the bound Preview origin; sensitive input and cross-origin navigation require per-call approval.
- Validate all arguments, audit call/result/cancel and cap output.
- After cancellation or timeout, a late result cannot mutate Studio state.
