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
import { startTierControl } from "./perf/tierControl";

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
 * 软合成下字段完全相同）判定机器等级 L0–L3；`ompStudioPerf.cached` 是 preload
 * 同步读到的上一次快照，所以首帧不需要 IPC 往返。等级规则只在 Main 一处，渲染层
 * 只负责「保存最新机器等级 + 叠加用户的减少动效偏好」（见 `perf/tierControl.ts`），
 * 不再自己从 GPU/CPU/内存事实推导等级。
 *
 * 「减少动效」是用户能收紧的下限（L0 → L1），绝不会把 L2/L3 抬回去；系统的
 * `prefers-reduced-motion` 与显式 `omp.perf.motion=off` 走同一条路径。
 */
const reducedMotionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
const stopTierControl = startTierControl({
  root: document.documentElement,
  source: globalThis.ompStudioPerf,
  motionOff: () => {
    try {
      if (window.localStorage.getItem("omp.perf.motion") === "off") return true;
    } catch {
      /* storage blocked: fall through to the OS preference */
    }
    return reducedMotionQuery?.matches === true;
  },
  onMotionPreferenceChange: listener => {
    reducedMotionQuery?.addEventListener?.("change", listener);
    return () => reducedMotionQuery?.removeEventListener?.("change", listener);
  },
});
// One wiring per document: a hot reload must not stack a second set of listeners
// on the old module instance, and a page hide tears them down.
import.meta.hot?.dispose(stopTierControl);
window.addEventListener("pagehide", stopTierControl, { once: true });

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
