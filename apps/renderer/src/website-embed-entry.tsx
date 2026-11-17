import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./styles/agent-hub.css";
import "./styles/model-picker.css";
import "./styles/btw.css";
import "./App.css";
import "./styles/typography.css";
import "./styles/tabs.css";
import { createElement } from "react";
import {
  WEBSITE_EMBED_SOURCE,
  getCurrentEmbedRoute,
  isTrustedEmbedHostEvent,
  parseEmbedInboundMessage,
  parseEmbedRoute,
  postEmbedMessage,
  requestEmbedRoute,
  setCurrentEmbedRoute,
  setExpectedHostTheme,
  type EmbedTheme,
} from "./embed/websiteEmbed";
import type { Route } from "./workbench/types";

type AppDensity = "standard" | "compact" | "cozy";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(String(key)) ?? null;
    },
    key(index: number) {
      const numeric = Number(index);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric >= store.size) return null;
      return Array.from(store.keys())[Math.trunc(numeric)] ?? null;
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}

function installEmbedStorageSandbox(): void {
  for (const prop of ["localStorage", "sessionStorage"] as const) {
    const memory = createMemoryStorage();
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        enumerable: true,
        get: () => memory,
      });
    } catch {
      // Ignore locked host environments where window Storage accessors are non-configurable.
    }
  }
}

function parseTheme(raw: string | null): EmbedTheme {
  return raw === "dark" ? "dark" : "light";
}

function parseDensity(raw: string | null): AppDensity {
  return raw === "compact" || raw === "cozy" ? raw : "standard";
}

function parseLanguage(raw: string | null): "zh" | "en" {
  return raw === "en" ? "en" : "zh";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForEmbedReady(): Promise<void> {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    if (!document.querySelector('[aria-busy="true"]')) break;
    await nextFrame();
  }
  try {
    await Promise.race([document.fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 1500))]);
  } catch {
    // Ignore font readiness rejections.
  }
  const pendingImages = Array.from(document.images).filter((img) => !img.complete);
  if (pendingImages.length > 0) {
    await Promise.all(
      pendingImages.map((img) => new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1200);
        const done = () => {
          window.clearTimeout(timer);
          resolve();
        };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      })),
    );
  }
  await nextFrame();
  await nextFrame();
}

async function bootstrapWebsiteEmbed(): Promise<void> {
  // Replace window Web Storage with in-memory maps BEFORE dynamic imports evaluate appSettings.ts.
  installEmbedStorageSandbox();

  const params = new URLSearchParams(window.location.search);
  const embedParam = params.get("embed");
  if (embedParam === "1" || embedParam === null) {
    document.documentElement.dataset.embed = "1";
  }

  const initialTheme = parseTheme(params.get("theme"));
  const initialDensity = parseDensity(params.get("density"));
  const initialLang = parseLanguage(params.get("lang"));
  const initialRoute: Route = parseEmbedRoute(params.get("route")) ?? "home";

  document.documentElement.setAttribute("data-theme", initialTheme);
  document.documentElement.setAttribute("data-density", initialDensity);
  setCurrentEmbedRoute(initialRoute);

  let pendingHostTheme: EmbedTheme | null = null;
  let applyHostThemeFn: ((theme: EmbedTheme) => void) | null = null;

  window.addEventListener("message", (event: MessageEvent) => {
    if (!isTrustedEmbedHostEvent(event)) return;
    const message = parseEmbedInboundMessage(event.data);
    if (!message) return;
    if (message.type === "set-route") {
      requestEmbedRoute(message.route);
      return;
    }
    if (message.type === "set-theme") {
      if (applyHostThemeFn) {
        applyHostThemeFn(message.theme);
      } else {
        pendingHostTheme = message.theme;
        document.documentElement.setAttribute("data-theme", message.theme);
      }
    }
  });

  const [
    { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY },
    { ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID },
  ] = await Promise.all([
    import("./settings/startupNotice"),
    import("./onboarding/onboardingState"),
  ]);

  localStorage.setItem("omp.lastRoute", initialRoute);
  localStorage.setItem("omp.appSettings", JSON.stringify({
    language: initialLang,
    theme: pendingHostTheme ?? initialTheme,
    density: initialDensity,
    startupPage: "last",
    restoreLastProject: true,
    rememberLayout: false,
  }));
  localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem("omp.gitGraphLayout", JSON.stringify({ orientation: "vertical", railSide: "right" }));

  const [
    { flushSync },
    { createRoot },
    { StudioClientImpl },
    { createContractFixtureApi },
    { getAppSettings, updateAppSettings },
    { App },
  ] = await Promise.all([
    import("react-dom"),
    import("react-dom/client"),
    import("@omp-studio/client"),
    import("@omp-studio/testkit"),
    import("./settings/appSettings"),
    import("./App"),
  ]);

  const applyHostTheme = (theme: EmbedTheme): void => {
    if (getAppSettings().theme !== theme) {
      setExpectedHostTheme(theme);
      document.documentElement.setAttribute("data-theme", theme);
      flushSync(() => {
        updateAppSettings({ theme });
      });
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    postEmbedMessage({ source: WEBSITE_EMBED_SOURCE, type: "theme-ack", theme });
  };
  applyHostThemeFn = applyHostTheme;

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  const api = createContractFixtureApi();
  const client = new StudioClientImpl(api);
  createRoot(rootElement).render(createElement(App, { client }));

  if (pendingHostTheme !== null) {
    const queued = pendingHostTheme;
    pendingHostTheme = null;
    applyHostTheme(queued);
  }

  await waitForEmbedReady();
  document.documentElement.dataset.qaReady = "true";
  postEmbedMessage({
    source: WEBSITE_EMBED_SOURCE,
    type: "ready",
    route: getCurrentEmbedRoute(),
    theme: getAppSettings().theme,
  });
}

void bootstrapWebsiteEmbed();
