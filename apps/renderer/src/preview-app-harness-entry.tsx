/**
 * 临时预览 harness：渲染完整 App 工作台（预览模式数据）。
 * 仅用于本地 UI 验证，不属于产品代码。
 *
 * 打开 `preview-app-harness.html?preview=1` 会强制预览夹具，便于截图。
 */
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientTransport } from "@omp-studio/client-contract";
import { createContractFixtureApi } from "@omp-studio/testkit";

import {
  STARTUP_NOTICE_ID,
  STARTUP_NOTICE_STORAGE_KEY,
} from "./settings/startupNotice";

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

// Explicit QA parameters affect only this local fixture entry, never the packaged app.
const qaParams = new URLSearchParams(window.location.search);
const qaTheme = qaParams.get("theme") === "dark" ? "dark" : "light";
const qaDensity = ["compact", "cozy"].includes(qaParams.get("density") ?? "")
  ? qaParams.get("density")!
  : "standard";
const qaLanguage = qaParams.get("lang") === "en" ? "en" : "zh";
const qaRoute = [
  "home",
  "history",
  "agent-hub",
  "capabilities",
  "model-config",
  "settings",
  "diagnostics",
  "media",
  "evaluation",
].includes(qaParams.get("route") ?? "")
  ? qaParams.get("route")!
  : "workbench";
try {
  if (qaParams.get("preserveSettings") !== "1") window.localStorage.setItem("omp.lastRoute", qaRoute);
  window.localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  if (qaParams.get("preserveSettings") !== "1") window.localStorage.setItem(
    "omp.appSettings",
    JSON.stringify({
      theme: qaTheme,
      density: qaDensity,
      language: qaLanguage,
      startupPage: "last",
      restoreLastProject: true,
      restoreLastSession: true,
      rememberLayout: false,
      toolActivity: "concise",
    }),
  );
  window.localStorage.setItem(
    "omp.gitGraphLayout",
    JSON.stringify({ open: true, splitRatio: 0.46 }),
  );
  // 背景截图：?wallpaper=1 打开内置预设；?wallpaperScope=app 覆盖整个应用。
  const wallpaper = {
    version: 1,
    enabled: true,
    activeId: qaParams.get("wallpaperPreset") ?? "preset:aurora",
    scope: qaParams.get("wallpaperScope") === "workbench" ? "workbench" : "app",
    opacity: Number(qaParams.get("wallpaperOpacity") ?? 70),
    strength: Number(qaParams.get("wallpaperStrength") ?? 65),
    scrimAuto: qaParams.get("wallpaperScrim") === null,
    scrim: Number(qaParams.get("wallpaperScrim") ?? 45),
    blur: 8,
    fit: "cover",
    focus: "center",
    motion: "auto",
  };
  if (qaParams.get("wallpaper") === "1") {
    window.localStorage.setItem("omp.background", JSON.stringify(wallpaper));
    // 预览模式的 Provider 读 sessionStorage 演示值，不读真实偏好。
    window.sessionStorage.setItem("omp.previewBackground", JSON.stringify(wallpaper));
  } else {
    window.localStorage.removeItem("omp.background");
    window.sessionStorage.removeItem("omp.previewBackground");
  }
  // 设置页截图：?settingsGroup=background 直接落在目标标签。
  if (qaParams.get("settingsGroup") !== null) {
    window.sessionStorage.setItem("omp.settingsIntent", JSON.stringify({ group: qaParams.get("settingsGroup") }));
  }
} catch {
  /* storage blocked */
}
document.documentElement.setAttribute("data-theme", qaTheme);
document.documentElement.setAttribute("data-density", qaDensity);

// Load the app after its persisted fixture settings are initialized. Several
// preference stores read storage at module evaluation time.
void import("./App").then(({ App }) => {
  const host = document.getElementById("root");
  if (host === null) return;
  const transport = createContractFixtureApi() as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  const mounted = createRoot(host);
  let active = true;
  mounted.render(<App client={client} />);
  // Bootstrap is asynchronous. Wait for the actual shell, then for finite
  // entrance animations; live fixture updates must not reset readiness.
  void (async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const deadline = performance.now() + 15_000;
    while (active && !host.querySelector("#appRoot")) {
      if (performance.now() > deadline) return;
      await frame();
    }
    await document.fonts.ready;
    let stableFrames = 0;
    while (active && stableFrames < 3) {
      if (performance.now() > deadline) return;
      await frame();
      const animations = document.getAnimations().filter((animation) => {
        const endTime = animation.effect?.getComputedTiming().endTime;
        return (animation.pending || animation.playState === "running")
          && typeof endTime === "number" && Number.isFinite(endTime);
      });
      stableFrames = animations.length ? 0 : stableFrames + 1;
      if (animations.length) await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    }
    await Promise.all(Array.from(host.querySelectorAll("img")).filter((image) => image.src).map((image) => image.decode().catch(() => {})));
    if (active) document.documentElement.setAttribute("data-qa-ready", "true");
  })();
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      active = false;
      mounted.unmount();
      void client.close();
    });
});
