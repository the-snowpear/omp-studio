/**
 * OMP Studio renderer entry.
 *
 * `mountRenderer` is the public mounting API: it takes a semantic
 * `StudioClient` supplied by the caller (desktop shell, local WebUI bridge,
 * or a test) and never imports or constructs a transport itself.
 *
 * When this module is loaded directly by Vite (the auto-bootstrap entry),
 * the hosting page injects that client on `globalThis.OMP_STUDIO_CLIENT`
 * before the bundle runs. If it is absent but the desktop preload bridge
 * (`globalThis.ompStudio`) is present, the entry constructs the client
 * itself: `createDesktopTransport(ompStudio)` → `StudioClientImpl`. If
 * neither exists we render an explicit unavailable state instead of
 * failing.
 */

import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { StudioClientImpl } from "@omp-studio/client";
import { createDesktopTransport } from "@omp-studio/transport-desktop";
import { App, Unavailable } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { getAppSettings } from "./settings/appSettings";
import { applyTypography } from "./settings/typography";
import { resolveLanguage } from "./i18n";
import { initPerformanceTimelineCleanup } from "./performanceTimelineCleanup";
import { createRendererPerformanceReporter } from "./rendererPerformance";
import { PLATFORM } from "./platform";
import { applyTier, TIER_ATTRIBUTES, type PerfTier } from "./perf/tiers";

const stopPerformanceReporter = createRendererPerformanceReporter(globalThis.ompStudioChrome);
window.addEventListener("pagehide", stopPerformanceReporter, { once: true });
import.meta.hot?.dispose(() => { window.removeEventListener("pagehide", stopPerformanceReporter); stopPerformanceReporter(); });

/* 首屏预应用主题 / 密度 / 语言：打包 CSP 是 script-src 'self'，不能靠 index.html
   内联脚本；这里在 React 挂载前同步 DOM 属性，避免首帧闪回默认主题。 */
const initialSettings = getAppSettings();
applyTypography(initialSettings);
document.documentElement.setAttribute("data-theme", initialSettings.theme);
document.documentElement.setAttribute("data-platform", PLATFORM);
document.documentElement.setAttribute("data-density", initialSettings.density);
document.documentElement.setAttribute("lang", resolveLanguage(initialSettings.language));

/**
 * P0-6：首帧前把 GPU / 低配 / 动效分级写到 `<html>`。
 *
 * Main 用 `app.getGPUFeatureStatus()`（不是 `getGPUInfo("basic")`：实测两者在
 * 软合成下字段完全相同）探测并给出 L0–L3，`ompStudioPerf.cached` 是 preload
 * 同步读到的上一次快照，所以这里不需要 IPC 往返、也不会出现「先全效再降级」
 * 的闪烁。浏览器 / harness 没有这个桥：保持 L0，不猜机器等级。
 *
 * 用户覆盖只有「减少动效」一个旋钮（系统 `prefers-reduced-motion` 或显式
 * `omp.perf.motion=off`）。它只会把层级压到 L1 或更低，绝不会把 L2/L3 抬回去
 * ——降级是「少画」，不是「少校验」。
 */
function motionOffRequested(suggested?: "full" | "reduced" | "off"): boolean {
  // Main's own verdict for this machine (L3 grades motion off) is a floor,
  // never a ceiling: a user setting can only make it stricter.
  if (suggested === "off") return true;
  try {
    if (window.localStorage.getItem("omp.perf.motion") === "off") return true;
  } catch {
    /* storage blocked: fall through to the OS preference */
  }
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function applyPerformanceTier(snapshot?: { readonly tier: PerfTier; readonly motion?: "full" | "reduced" | "off" } | null): void {
  const resolved = snapshot?.tier ?? globalThis.ompStudioPerf?.cached?.tier ?? "L0";
  const suggested = snapshot?.motion ?? globalThis.ompStudioPerf?.cached?.motion;
  applyTier(document.documentElement, resolved);
  // `applyTier` writes the tier's canonical motion value; the machine verdict
  // and the user's override only ever tighten it, so they are applied after
  // (an unchanged `setAttribute` does not invalidate style).
  if (motionOffRequested(suggested)) document.documentElement.setAttribute(TIER_ATTRIBUTES.motion, "off");
}

applyPerformanceTier();
const perfBridge = globalThis.ompStudioPerf;
if (perfBridge !== undefined) {
  perfBridge.onChanged(snapshot => applyPerformanceTier(snapshot));
  if (perfBridge.cached === null) void perfBridge.probe().then(snapshot => applyPerformanceTier(snapshot)).catch(() => undefined);
}
if (typeof window.matchMedia === "function") {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduced.addEventListener?.("change", () => applyPerformanceTier());
}

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./styles/agent-hub.css";
import "./styles/models-roles.css";
import "./styles/btw.css";
import "./App.css";
import "./styles/typography.css";
import "./styles/tabs.css";

if (import.meta.env.DEV) {
  const disposePerformanceTimelineCleanup = initPerformanceTimelineCleanup();
  import.meta.hot?.dispose(() => {
    disposePerformanceTimelineCleanup();
  });
}

/** Mount the renderer into `element` with an injected semantic client. */
export function mountRenderer(element: Element, client: StudioClient): void {
  createRoot(element).render(
    <ErrorBoundary>
      <App client={client} />
    </ErrorBoundary>,
  );
}

const host = document.getElementById("root");
if (host !== null) {
  let client: StudioClient | undefined = globalThis.OMP_STUDIO_CLIENT;
  if (client === undefined) {
    const bridge = globalThis.ompStudio;
    if (bridge !== undefined) {
      client = new StudioClientImpl(createDesktopTransport(bridge));
    }
  }
  createRoot(host).render(
    <ErrorBoundary>
      {client === undefined ? <Unavailable /> : <App client={client} />}
    </ErrorBoundary>,
  );
}
