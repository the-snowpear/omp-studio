import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppBackgroundLayer } from "./AppBackgroundLayer";
import { BackgroundProvider } from "./BackgroundProvider";
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundSettings,
} from "./backgroundSettings";
import {
  createMemoryBackgroundLibrary,
  type BackgroundAssetMeta,
  type BackgroundLibrary,
} from "./backgroundLibrary";

let reducedMotion = false;
let reducedTransparency = false;
let paused = false;

function settings(patch: Partial<BackgroundSettings> = {}): BackgroundSettings {
  return {
    ...DEFAULT_BACKGROUND_SETTINGS,
    enabled: true,
    activeId: "preset:aurora",
    ...patch,
  };
}

function videoMeta(id: string): BackgroundAssetMeta {
  return {
    id,
    kind: "video",
    name: "loop.mp4",
    mime: "video/mp4",
    bytes: 42,
    createdAt: 1,
    luma: 0.2,
    avgColor: "#223344",
    thumbDataUrl: "data:image/webp;base64,AAAA",
    fingerprint: "fp",
  };
}

function renderLayer(options: {
  readonly settings?: BackgroundSettings;
  readonly route?: string;
  readonly library?: BackgroundLibrary;
  readonly theme?: "light" | "dark";
}) {
  const library = options.library ?? createMemoryBackgroundLibrary();
  const view = render(
    <BackgroundProvider
      preview
      theme={options.theme ?? "light"}
      initialSettings={options.settings ?? settings()}
      library={library}
    >
      <AppBackgroundLayer route={options.route ?? "workbench"} theme={options.theme ?? "light"} />
    </BackgroundProvider>,
  );
  return { ...view, library };
}

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion")
        ? reducedMotion
        : query.includes("prefers-reduced-transparency")
          ? reducedTransparency
          : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

beforeEach(() => {
  reducedMotion = false;
  reducedTransparency = false;
  paused = false;
  document.documentElement.removeAttribute("data-backdrop");
  document.documentElement.removeAttribute("data-backdrop-scope");
  for (const name of [
    "--bd-shell",
    "--bd-media-opacity",
    "--bd-scrim",
    "--bd-blur",
    "--bd-fit",
    "--bd-focus",
  ]) {
    document.documentElement.style.removeProperty(name);
  }
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(() => { paused = true; }),
  });
});

afterEach(() => {
  cleanup();
  (globalThis as { ompStudioChrome?: unknown }).ompStudioChrome = undefined;
});

describe("AppBackgroundLayer", () => {
  it("renders the preset layer and writes the shell variables", () => {
    const { container, unmount } = renderLayer({
      settings: settings({ scope: "workbench", blur: 12, fit: "contain", focus: "top", opacity: 60, scrimAuto: false, scrim: 50 }),
    });
    expect(container.querySelector(".app-backdrop")).not.toBeNull();
    const root = document.documentElement;
    expect(root.dataset.backdrop).toBe("on");
    expect(root.dataset.backdropScope).toBe("workbench");
    expect(root.style.getPropertyValue("--bd-shell")).toBe("35%");
    expect(root.style.getPropertyValue("--bd-media-opacity")).toBe("0.6");
    expect(root.style.getPropertyValue("--bd-scrim")).toBe("0.5");
    expect(root.style.getPropertyValue("--bd-blur")).toBe("12px");
    expect(root.style.getPropertyValue("--bd-fit")).toBe("contain");
    expect(root.style.getPropertyValue("--bd-focus")).toBe("center top");
    unmount();
    expect(document.documentElement.dataset.backdrop).toBeUndefined();
  });

  it("hides the layer above the workbench unless the scope is the whole app", () => {
    const view = renderLayer({ settings: settings({ scope: "workbench" }) });
    expect(document.documentElement.dataset.backdrop).toBe("on");
    view.rerender(
      <BackgroundProvider preview theme="light" initialSettings={settings({ scope: "workbench" })} library={view.library}>
        <AppBackgroundLayer route="settings" theme="light" />
      </BackgroundProvider>,
    );
    expect(document.documentElement.dataset.backdrop).toBeUndefined();

    view.unmount();
    renderLayer({ settings: settings({ scope: "app" }), route: "settings" });
    expect(document.documentElement.dataset.backdrop).toBe("on");
    expect(document.documentElement.dataset.backdropScope).toBe("app");
  });

  it("does nothing when disabled or when the see-through strength is zero", () => {
    const disabled = renderLayer({ settings: settings({ enabled: false }) });
    expect(disabled.container.querySelector(".app-backdrop")).toBeNull();
    expect(document.documentElement.dataset.backdrop).toBeUndefined();
    disabled.unmount();

    const opaque = renderLayer({ settings: settings({ strength: 0 }) });
    expect(opaque.container.querySelector(".app-backdrop")).toBeNull();
    expect(document.documentElement.dataset.backdrop).toBeUndefined();
  });

  it("caps the see-through strength when the system reduces transparency", () => {
    reducedTransparency = true;
    renderLayer({ settings: settings({ strength: 80 }) });
    expect(document.documentElement.style.getPropertyValue("--bd-shell")).toBe("90%");
  });

  it("renders a still thumbnail for a video when motion is off", async () => {
    const library = createMemoryBackgroundLibrary([{
      meta: videoMeta("v1"),
      blob: new Blob(["video"], { type: "video/mp4" }),
    }]);
    const view = renderLayer({
      settings: settings({ activeId: "v1", motion: "off" }),
      library,
    });
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    expect(view.container.querySelector("video")).toBeNull();
  });

  it("plays muted video, pauses when the window hides, and revokes the URL", async () => {
    const createObjectURL = vi.fn(() => "blob:background");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const library = createMemoryBackgroundLibrary([{
      meta: videoMeta("v1"),
      blob: new Blob(["video"], { type: "video/mp4" }),
    }]);
    const view = renderLayer({
      settings: settings({ activeId: "v1", motion: "on" }),
      library,
    });
    const video = await waitFor(() => {
      const element = view.container.querySelector("video");
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.getAttribute("src")).toBe("blob:background");

    paused = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(paused).toBe(true);

    delete (document as unknown as Record<string, unknown>).hidden;
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:background");
  });

  it("sends a caption tint only when the whole app is covered", async () => {
    const setTheme = vi.fn(async () => undefined);
    (globalThis as { ompStudioChrome?: unknown }).ompStudioChrome = { setTheme };
    renderLayer({ settings: settings({ scope: "app" }) });
    await waitFor(() => expect(setTheme).toHaveBeenCalled());
    const [theme, tint] = setTheme.mock.calls[0] as unknown as [string, { color: string; symbolColor: string } | undefined];
    expect(theme).toBe("light");
    expect(tint?.color).toMatch(/^#[0-9a-f]{6}$/u);

    setTheme.mockClear();
    cleanup();
    renderLayer({ settings: settings({ scope: "workbench" }) });
    await waitFor(() => expect(setTheme).toHaveBeenCalled());
    const [, workbenchTint] = setTheme.mock.calls[0] as unknown as [string, unknown];
    expect(workbenchTint).toBeUndefined();
  });
});
