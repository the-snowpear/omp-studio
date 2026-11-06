import type { ComputerAction, ComputerFrame, ComputerStructureSnapshot, ComputerWorkspaceSnapshot, FeatureSettingRow, StudioComputerStatus } from "@omp-studio/studio-protocol";

export const COMPUTER_PREVIEW_SCENARIOS = ["running", "disabled", "observe-only", "waiting", "stopped", "history", "target-gone", "locked", "asleep", "permission-denied", "expired", "unconfirmed"] as const;
export type ComputerPreviewScenario = typeof COMPUTER_PREVIEW_SCENARIOS[number];
export const COMPUTER_PREVIEW_SCENARIO_LABELS: Record<ComputerPreviewScenario, string> = {
  running: "执行中", disabled: "未启用", "observe-only": "仅可观察", waiting: "等待审批", stopped: "已停止", history: "历史画面", "target-gone": "目标消失", locked: "已锁屏", asleep: "休眠", "permission-denied": "权限撤销", expired: "图像过期", unconfirmed: "停止未确认",
};
export const COMPUTER_PREVIEW_TIME = Date.parse("2026-11-05T11:24:00+08:00");
export function previewComputerFrame(sessionId: string, index = 1): ComputerFrame {
  return { frameId: `computer-preview-frame-${index}`, sessionId, source: "execution", capturedAt: COMPUTER_PREVIEW_TIME + index * 2000,
    targetId: "demo-window", targetName: "OMP Studio · Workspace", runId: "computer-preview-run", actionId: `computer-preview-action-${index}`,
    toolCallId: "computer-preview-eval", width: 1280, height: 800, coordinateWidth: 1280, coordinateHeight: 800, screenLocked: false, delivered: true, availability: "available" };
}
export function buildComputerPreview(sessionId: string, scenario: ComputerPreviewScenario = "running"): { snapshot: ComputerWorkspaceSnapshot; actions: ComputerAction[] } {
  const frames = [previewComputerFrame(sessionId, 1), previewComputerFrame(sessionId, 2)];
  const actions: ComputerAction[] = [
    { id: "computer-preview-action-0", sessionId, runId: "computer-preview-run", toolCallId: "computer-preview-eval", method: "windows", mode: "read", status: "completed", startedAt: COMPUTER_PREVIEW_TIME - 1000, endedAt: COMPUTER_PREVIEW_TIME, frameIds: [] },
    ...frames.map((frame, i): ComputerAction => ({ id: frame.actionId!, sessionId, runId: frame.runId!, toolCallId: frame.toolCallId!, method: i ? "observe" : "screenshot", targetId: frame.targetId, targetName: frame.targetName!, mode: "read", status: "completed", startedAt: frame.capturedAt - 800, endedAt: frame.capturedAt, frameIds: [frame.frameId] })),
  ];
  const active: ComputerAction[] = scenario === "running" || scenario === "waiting" ? [{ id: "computer-preview-action-3", sessionId: `${sessionId}:child`, agentId: "ui-check", agentName: "界面检查", runId: "computer-preview-child", toolCallId: "computer-preview-child-eval", method: "run", targetId: "demo-window", targetName: "OMP Studio · Workspace", mode: "unknown", status: scenario === "waiting" ? "waiting" : "running", startedAt: COMPUTER_PREVIEW_TIME + 5000, frameIds: [] }] : [];
  const snapshot: ComputerWorkspaceSnapshot = { version: 1, sessionId, revision: 8, updatedAt: COMPUTER_PREVIEW_TIME + 5000, enabled: scenario !== "disabled", preludeAvailable: scenario !== "observe-only", backend: "win32",
    capabilities: { capture: scenario !== "permission-denied", input: scenario !== "observe-only", accessibility: scenario !== "observe-only", globalEscape: false, observationOnly: true },
    permissions: { capture: scenario === "permission-denied" ? "denied" : "granted", input: scenario === "observe-only" ? "denied" : "granted", accessibility: scenario === "observe-only" ? "unavailable" : "granted" },
    screen: { locked: scenario === "locked", asleep: scenario === "asleep", known: true },
    control: { status: scenario === "stopped" ? "stopped" : scenario === "unconfirmed" ? "unconfirmed" : "allowed", revision: 3, updatedAt: COMPUTER_PREVIEW_TIME, foreground: scenario === "waiting" ? "requested" : "unknown" },
    targets: scenario === "target-gone" ? [] : PREVIEW_COMPUTER.targets, active, frames: scenario === "disabled" ? [] : frames,
    ...(scenario === "target-gone" ? { reason: "所选窗口已关闭。请选择仍然存在的观察目标。" } : scenario === "permission-denied" ? { reason: "屏幕录制权限已撤销。请在系统设置中重新授权。" } : {}),
  };
  if (scenario === "expired") snapshot.frames = frames.map(frame => ({ ...frame, availability: "expired" }));
  return { snapshot, actions: [...actions, ...active] };
}
export function previewComputerStructure(sessionId: string, targetId: string): ComputerStructureSnapshot {
  return { snapshotId: "computer-preview-structure", sessionId, targetId, capturedAt: COMPUTER_PREVIEW_TIME, coordinateSpace: "frame", frame: { ...previewComputerFrame(sessionId, 2), targetId }, truncated: false, nodes: [
    { id: "root", role: "window", name: "OMP Studio · Workspace", enabled: true, bounds: { x: 82, y: 82, width: 1116, height: 625 }, children: [
      { id: "explorer", role: "tree", name: "Explorer", enabled: true, bounds: { x: 82, y: 125, width: 220, height: 554 }, children: [] },
      { id: "editor", role: "text", name: "ComputerPane.tsx", enabled: true, bounds: { x: 302, y: 161, width: 896, height: 385 }, children: [] },
    ] },
  ] };
}
export const PREVIEW_COMPUTER_TOOL_MEDIA = [{ type: "image", mimeType: "image/png", computerFrame: { frameId: "computer-preview-frame-1", sessionId: "preview", toolCallId: "computer-preview-eval" } }];
export const PREVIEW_COMPUTER_SETTINGS: FeatureSettingRow[] = [
  { key: "computer.enabled", value: true, source: "runtime" }, { key: "computer.display", value: "active", source: "default" },
  { key: "computer.maxWidth", value: 3840, source: "default" }, { key: "computer.maxHeight", value: 2400, source: "default" },
  { key: "computer.backgroundFallback", value: "refuse", source: "global" },
];

export const PREVIEW_COMPUTER: StudioComputerStatus = {
  enabled: true, available: true, backend: "demo",
  capturePermission: "granted", inputPermission: "granted", axPermission: "granted", running: 1,
  targets: [
    { id: "demo-display", kind: "display", name: "Display 1", width: 1920, height: 1080 },
    { id: "demo-window", kind: "window", name: "OMP Studio · Workspace", width: 960, height: 600 },
  ],
};

// A local, static desktop fixture. Never used when preview mode is off.
export const PREVIEW_COMPUTER_IMAGE = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#dfe3ee"/>
  <path d="M0 560 720 120l560 330v350H0Z" fill="#d2d9e9"/>
  <path d="m300 800 980-590v590Z" fill="#c7d0e3"/>
  <rect width="1280" height="32" fill="#f5f6fa"/>
  <g fill="#53596b" font-family="Segoe UI, sans-serif" font-size="12"><text x="24" y="21" font-weight="600">OMP Studio</text><text x="130" y="21">File</text><text x="171" y="21">Edit</text><text x="211" y="21">View</text><text x="1130" y="21">Workspace</text><text x="1224" y="21">11:24</text></g>
  <rect x="82" y="91" width="1116" height="625" rx="12" fill="#a1aac2" opacity=".2"/>
  <rect x="82" y="82" width="1116" height="625" rx="12" fill="#222530"/>
  <path d="M94 82h1092a12 12 0 0 1 12 12v31H82V94a12 12 0 0 1 12-12" fill="#2a2d39"/>
  <g><circle cx="104" cy="104" r="5" fill="#e08a8d"/><circle cx="122" cy="104" r="5" fill="#debe7b"/><circle cx="140" cy="104" r="5" fill="#89ba9b"/></g>
  <text x="641" y="109" fill="#b0b5c7" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="12">omp-studio — Workspace</text>
  <path d="M82 125h220v554H82" fill="#252834"/>
  <g font-family="Segoe UI, sans-serif" font-size="12"><text x="102" y="155" fill="#9da4ba" font-weight="600" font-size="10" letter-spacing="1">EXPLORER</text><text x="102" y="190" fill="#d7dae5">⌄  omp-studio</text><text x="120" y="223" fill="#a8b0c6">⌄  apps</text><text x="138" y="253" fill="#a8b0c6">⌄  renderer</text><text x="155" y="283" fill="#a8b0c6">⌄  src</text><text x="172" y="313" fill="#a8b0c6">⌄  browser</text></g>
  <rect x="94" y="326" width="199" height="28" rx="4" fill="#7160a0" opacity=".28"/>
  <g font-family="Segoe UI, sans-serif" font-size="12"><text x="185" y="344" fill="#c6b6f0">ComputerPane.tsx</text><text x="185" y="374" fill="#a8b0c6">computer.css</text><text x="172" y="414" fill="#a8b0c6">preview</text><text x="172" y="445" fill="#a8b0c6">styles</text><text x="120" y="486" fill="#a8b0c6">packages</text><text x="120" y="517" fill="#a8b0c6">package.json</text></g>
  <rect x="302" y="125" width="896" height="36" fill="#282b37"/>
  <rect x="302" y="125" width="181" height="36" fill="#222530"/>
  <rect x="302" y="125" width="181" height="2" fill="#a48fdb"/>
  <text x="324" y="148" font-family="Segoe UI, sans-serif" font-size="12" fill="#c8bddf">ComputerPane.tsx</text>
  <text x="505" y="148" font-family="Segoe UI, sans-serif" font-size="12" fill="#858da3">computer.css</text>
  <g font-family="Consolas, monospace" font-size="14" fill="#6c748c" text-anchor="end"><text x="338" y="197">1</text><text x="338" y="225">2</text><text x="338" y="253">3</text><text x="338" y="281">4</text><text x="338" y="309">5</text><text x="338" y="337">6</text><text x="338" y="365">7</text><text x="338" y="393">8</text><text x="338" y="421">9</text><text x="338" y="449">10</text><text x="338" y="477">11</text><text x="338" y="505">12</text></g>
  <g font-family="Consolas, monospace" font-size="14"><text x="362" y="197" fill="#bb9cde">import <tspan fill="#d9ddea">{ useState } </tspan>from <tspan fill="#a7c6b1">"react"</tspan>;</text><text x="362" y="253" fill="#bb9cde">export function <tspan fill="#d8c6a3">ComputerPane</tspan><tspan fill="#d9ddea">() {</tspan></text><text x="386" y="281" fill="#bb9cde">const <tspan fill="#d9ddea">[target, setTarget] = </tspan><tspan fill="#d8c6a3">useState</tspan><tspan fill="#d9ddea">();</tspan></text><text x="386" y="337" fill="#7c879f">// Observe the agent's workspace</text><text x="386" y="365" fill="#bb9cde">return <tspan fill="#d9ddea">(</tspan></text><text x="410" y="393" fill="#a3bddd">&lt;section <tspan fill="#d8c6a3">className</tspan><tspan fill="#d9ddea">=</tspan><tspan fill="#a7c6b1">"computer-pane"</tspan>&gt;</text><text x="434" y="421" fill="#a3bddd">&lt;ScreenPreview <tspan fill="#d8c6a3">target</tspan><tspan fill="#d9ddea">={target} </tspan>/&gt;</text><text x="410" y="449" fill="#a3bddd">&lt;/section&gt;</text><text x="386" y="477" fill="#d9ddea">);</text><text x="362" y="505" fill="#d9ddea">}</text></g>
  <path d="M302 546h896" stroke="#3b3e4b"/>
  <text x="324" y="571" font-family="Segoe UI, sans-serif" font-size="10" letter-spacing="1" fill="#d0d4e2">TERMINAL</text><text x="421" y="571" font-family="Segoe UI, sans-serif" font-size="10" fill="#7c849b">OUTPUT</text>
  <g font-family="Consolas, monospace" font-size="12"><text x="324" y="603" fill="#9da6bf">$ npm run dev</text><text x="324" y="635" fill="#a7c6b1">VITE ready <tspan fill="#7c879f">in 284 ms</tspan></text><text x="324" y="658" fill="#9da6bf">Local: <tspan fill="#a6bce4">http://localhost:5173/</tspan></text></g>
  <path d="M82 679h1116v16a12 12 0 0 1-12 12H94a12 12 0 0 1-12-12" fill="#746293"/>
  <g font-family="Segoe UI, sans-serif" font-size="10" fill="#ede8f6"><text x="102" y="697">main*</text><text x="1070" y="697">TypeScript JSX</text></g>
  <rect x="530" y="746" width="220" height="42" rx="13" fill="#f5f6fa" opacity=".8"/>
  <g><rect x="544" y="753" width="28" height="28" rx="7" fill="#9a8bb9"/><rect x="584" y="753" width="28" height="28" rx="7" fill="#879ebd"/><rect x="624" y="753" width="28" height="28" rx="7" fill="#d0b78f"/><rect x="664" y="753" width="28" height="28" rx="7" fill="#93ad9d"/><rect x="704" y="753" width="28" height="28" rx="7" fill="#3c4357"/></g>
</svg>`);
