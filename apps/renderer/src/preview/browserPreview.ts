import type { BrowserEngine, BrowserInspectionView, BrowserObservationEvent, BrowserPageCapabilities, BrowserPageDescriptor, BrowserPageInspection, StudioBrowserTab } from "@omp-studio/studio-protocol";

export function previewBrowserDescriptor(engine: BrowserEngine, embedded = false): BrowserPageDescriptor {
  const capabilities: BrowserPageCapabilities = { observe: true, control: true, nativeViewer: engine === "webkit", history: true, console: true, network: true, downloads: true,
    webmcp: engine === "chromium", pdf: engine === "chromium", cdp: engine === "chromium", tracing: engine === "chromium", zoom: embedded, find: embedded, pick: embedded, devtools: embedded, settings: embedded, reasons: {} };
  if (engine === "webkit") {
    capabilities.reasons.webmcp = "WebMCP 需要实际 Chromium 引擎；WebKit 不提供此能力。";
    capabilities.reasons.pdf = capabilities.reasons.cdp = capabilities.reasons.tracing = "WebKit 不提供 PDF、完整 CDP、响应体或 tracing。";
    capabilities.reasons.network = "WebKit 只提供原生请求元数据，没有响应体。";
  }
  for (const key of ["zoom", "find", "pick", "devtools", "settings"] as const) if (!capabilities[key]) capabilities.reasons[key] = "此操作属于明确选择的 Studio embedded adapter。";
  return { targetId: `preview-${engine}-target`, ownerSessionId: "preview-native-owner", sessionId: "preview-session", generation: engine === "webkit" ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111",
    engine, ownership: "owned", transport: embedded ? "embedded" : "frames", capabilities };
}
export const PREVIEW_BROWSER_TAB: StudioBrowserTab = { ...previewBrowserDescriptor("chromium"), id: "11111111-1111-4111-8111-111111111111", name: "workspace", title: "Studio component preview", url: "http://localhost:5173", kind: "headless", busy: false, frozen: false, observable: true };
export function previewBrowserFrame(tabId: string, generation: string): Extract<BrowserObservationEvent, { kind: "frame" }> {
  return { kind: "frame", observationId: "preview-observation", tabId, generation, documentEpoch: 0, sequence: 1, data: "", width: 960, height: 600, cssWidth: 960, cssHeight: 600, timestamp: 0 };
}
export function previewBrowserInspection(view: BrowserInspectionView): BrowserPageInspection {
  if (view === "console") return { view, rows: [{ level: "info", text: "Browser view ready", location: "app.js:12" }, { level: "warn", text: "Native WebKit: response bodies and WebMCP are unavailable" }] };
  if (view === "network") return { view, rows: [{ id: "request-1", method: "GET", url: "http://localhost:4173/docs/browser", status: 200, resourceType: "Document" }], reason: "WebKit 只提供原生请求元数据，没有响应体。" };
  return { view, rows: [{ name: "browser-guide.pdf", url: "http://localhost:4173/docs/browser/guide.pdf", path: "browser-guide.pdf", bytes: 3145728, state: "completed" }] };
}
export const PREVIEW_BROWSER_IMAGE = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600"><rect width="960" height="600" fill="#f7f7f9"/><rect x="28" y="28" width="904" height="60" rx="12" fill="white"/><text x="52" y="67" font-family="sans-serif" font-size="22" fill="#26242e">OMP Studio · Component preview</text><rect x="28" y="116" width="210" height="456" rx="12" fill="white"/><rect x="50" y="140" width="168" height="36" rx="8" fill="#eee9fa"/><text x="65" y="165" font-family="sans-serif" font-size="16" fill="#7457bc">Workspace</text><rect x="264" y="116" width="668" height="456" rx="12" fill="white"/><text x="292" y="167" font-family="sans-serif" font-size="24" fill="#26242e">Local preview</text><text x="292" y="206" font-family="sans-serif" font-size="16" fill="#75727c">A sample page shown in observation mode.</text><rect x="292" y="242" width="150" height="40" rx="8" fill="#7457bc"/><text x="310" y="268" font-family="sans-serif" font-size="16" fill="white">Preview button</text></svg>');
