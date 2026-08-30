import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeConnection } from "@omp-studio/client-contract";
import { HomePage, SecondaryPage } from "./HomePage";
import { PAGE_EXIT_MS } from "./pageTransition";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { __resetOperatorProfileForTests } from "./settings/operatorProfile";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  __resetOperatorProfileForTests(null);
});

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

import { I18nProvider } from "./i18n";

function renderHome(options: {
  preview?: boolean;
  runtime?: RuntimeConnection;
} = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === true ? "1" : "0");
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <HomePage
          {...(options.runtime === undefined ? {} : { runtime: options.runtime })}
          onRoute={() => undefined}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
}

describe("HomePage identity", () => {
  it("shows the greeting with the local name, omp is ready, and a single user avatar", () => {
    renderHome({ runtime: { status: "connected", classification: "managed" } });
    expect(screen.getByRole("heading", { level: 1, name: /，Studio$/ })).toBeTruthy();
    expect(screen.getByText("OMP 已就绪")).toBeTruthy();
    expect(screen.queryByText(/Runtime managed/)).toBeNull();
    expect(document.querySelectorAll(".home-avatar").length).toBe(1);
    expect(screen.getByRole("button", { name: "编辑用户名和头像" })).toBeTruthy();
  });

  it("keeps an honest omp status when Runtime is down", () => {
    renderHome({ runtime: { status: "unavailable", classification: "unavailable" } });
    expect(screen.getByText("Runtime 不可用")).toBeTruthy();
    expect(screen.queryByText("OMP 已就绪")).toBeNull();
  });

  it("saves a new display name from the edit dialog", () => {
    renderHome({ runtime: { status: "connected", classification: "managed" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑用户名和头像" }));
    const dialog = screen.getByRole("dialog", { name: "编辑个人资料" });
    expect(dialog).toBeTruthy();
    const file = dialog.querySelector("input[type='file']");
    expect(file?.getAttribute("accept") ?? "").toContain("image/");
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /，Ada$/ })).toBeTruthy();
  });

  it("renders an uploaded avatar on the greeting row", () => {
    __resetOperatorProfileForTests(JSON.stringify({ displayName: "Ada" }), "data:image/png;base64,QQ==");
    renderHome({ runtime: { status: "connected", classification: "managed" } });
    const photo = document.querySelector(".home-identity img.home-avatar");
    expect(photo).toBeInstanceOf(HTMLImageElement);
    expect((photo as HTMLImageElement).getAttribute("src")).toBe("data:image/png;base64,QQ==");
    expect(screen.getByRole("heading", { level: 1, name: /，Ada$/ })).toBeTruthy();
    expect(document.querySelectorAll(".home-avatar").length).toBe(1);
  });
});

describe("HomePage Token usage chart", () => {
  it("places the hover card beside the active day instead of over its curve", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("tk-card")) return domRect(100, 50, 600, 560);
      if (this.classList.contains("tk-tip")) return domRect(0, 0, 168, 64);
      return domRect(0, 0, 0, 0);
    });
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(domRect(114, 180, 572, 210));

    renderHome({ preview: true, runtime: { status: "connected", classification: "managed" } });
    const chart = document.querySelector<SVGSVGElement>("svg.tk-chart");
    expect(chart).toBeTruthy();

    fireEvent(chart!, new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 220 }));

    const cursor = chart!.querySelector<SVGLineElement>(".tk-cursor");
    const tip = document.querySelector<HTMLElement>(".tk-tip.show");
    expect(cursor).toBeTruthy();
    expect(tip).toBeTruthy();
    const pointXInCard = 14 + Number(cursor!.getAttribute("x1"));
    expect(Number.parseFloat(tip!.style.left)).toBeGreaterThanOrEqual(pointXInCard + 12);

    fireEvent(chart!, new MouseEvent("pointermove", { bubbles: true, clientX: 660, clientY: 220 }));

    const rightCursor = chart!.querySelector<SVGLineElement>(".tk-cursor");
    const flippedTip = document.querySelector<HTMLElement>(".tk-tip.show");
    const rightPointXInCard = 14 + Number(rightCursor!.getAttribute("x1"));
    expect(Number.parseFloat(flippedTip!.style.left) + 168).toBeLessThanOrEqual(rightPointXInCard - 12);
    expect(flippedTip!.style.top).toBe(tip!.style.top);
  });
});

describe("SecondaryPage body motion", () => {
  function renderPage(
    route: "home" | "settings",
    title: string,
    body: string,
    className?: string,
  ) {
    return (
      <I18nProvider forcedLanguage="zh">
        <SecondaryPage
          route={route}
          title={title}
          theme="dark"
          {...(className === undefined ? {} : { className })}
          onRoute={() => undefined}
          onToggleTheme={() => undefined}
        >
          <p>{body}</p>
        </SecondaryPage>
      </I18nProvider>
    );
  }

  it("does not play page-in on the body after mount or a same-route shell rerender", () => {
    const { rerender } = render(renderPage("home", "首页", "home-body"));
    expect(document.getElementById("pageBody")?.className).toBe("page-body");
    expect(screen.getByText("home-body")).toBeTruthy();

    rerender(renderPage("home", "首页", "home-body", "page-out"));
    expect(document.getElementById("pageRoot")?.className).toBe("page page-out");
    expect(document.getElementById("pageBody")?.className).toBe("page-body");
  });

  it("plays page-out then page-in on the body when switching secondary routes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(renderPage("home", "首页", "home-body"));
    rerender(renderPage("settings", "设置", "settings-body"));
    expect(document.getElementById("pageBody")?.className).toBe("page-body page-out");
    expect(screen.getByText("home-body")).toBeTruthy();
    expect(screen.queryByText("settings-body")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAGE_EXIT_MS);
    });
    expect(document.getElementById("pageBody")?.className).toBe("page-body page-in");
    expect(screen.getByText("settings-body")).toBeTruthy();
    expect(screen.queryByText("home-body")).toBeNull();
  });
});
