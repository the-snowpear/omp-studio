import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { SlidingTabs, type SlidingTabItem } from "./SlidingTabs";

const items: SlidingTabItem<string>[] = ["Files", "Changes", "A long tab title"].map((label, index) => ({
  id: String(index), icon: "file", label, buttonId: `tab-${index}`, panelId: `panel-${index}`,
}));
const resizeCallbacks = new Set<() => void>();
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) { resizeCallbacks.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
});
afterEach(() => { cleanup(); resizeCallbacks.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Harness({ orientation = "horizontal", initial = "0" }: { orientation?: "vertical" | "horizontal"; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <I18nProvider forcedLanguage="en">
    <SlidingTabs ariaLabel="Workspace" orientation={orientation} value={value} items={items} onChange={setValue} />
    {items.map((item) => <section key={item.id} id={item.panelId} role="tabpanel" aria-labelledby={item.buttonId} hidden={value !== item.id}>{item.label} content</section>)}
  </I18nProvider>;
}

// jsdom cannot lay out a strip. Model only its real scroll bounds so these tests
// exercise selection/reveal/overflow behavior, not the old mirror coordinates.
function geometry(orientation: "horizontal" | "vertical", extent: number) {
  const strip = screen.getByRole("tablist");
  let size = extent;
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, get: () => orientation === "horizontal" ? size : 200 },
    clientHeight: { configurable: true, get: () => orientation === "vertical" ? size : 32 },
    scrollWidth: { configurable: true, get: () => orientation === "horizontal" ? 300 : 200 },
    scrollHeight: { configurable: true, get: () => orientation === "vertical" ? 96 : 32 },
  });
  vi.spyOn(strip, "getBoundingClientRect").mockImplementation(() => ({ left: 20, top: 30, right: 20 + strip.clientWidth, bottom: 30 + strip.clientHeight, width: strip.clientWidth, height: strip.clientHeight }) as DOMRect);
  within(strip).getAllByRole("tab").forEach((button, index) => {
    vi.spyOn(button, "getBoundingClientRect").mockImplementation(() => {
      const left = 20 + (orientation === "horizontal" ? index * 100 - strip.scrollLeft : 0);
      const top = 30 + (orientation === "vertical" ? index * 32 - strip.scrollTop : 0);
      const width = orientation === "horizontal" ? 100 : 200;
      return { left, top, right: left + width, bottom: top + 32, width, height: 32 } as DOMRect;
    });
  });
  const resize = (nextSize = size) => {
    size = nextSize;
    act(() => { for (const callback of [...resizeCallbacks]) callback(); });
  };
  resize();
  return { strip, resize };
}

describe("page tabs", () => {
  it("renders one accessible button per item with full-title tips and panel links", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll("button")).toHaveLength(items.length);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[2]?.getAttribute("data-tip")).toBe("A long tab title");
    expect(tabs[2]?.getAttribute("aria-controls")).toBe("panel-2");
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(tabs[2]!);
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").id).toBe("panel-2");
  });

  it.each(["horizontal", "vertical"] as const)("supports %s arrow keys, Home/End, wrapping and roving focus", (orientation) => {
    render(<Harness orientation={orientation} />);
    const [first, second, last] = screen.getAllByRole("tab");
    first!.focus();
    fireEvent.keyDown(first!, { key: orientation === "horizontal" ? "ArrowDown" : "ArrowRight" });
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first!, { key: orientation === "horizontal" ? "ArrowRight" : "ArrowDown", ctrlKey: true });
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first!, { key: orientation === "horizontal" ? "ArrowRight" : "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(second!, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last!, { key: orientation === "horizontal" ? "ArrowRight" : "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: orientation === "horizontal" ? "ArrowLeft" : "ArrowUp" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last!, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it.each(["horizontal", "vertical"] as const)("reveals the active %s tab without scrolling ancestors", (orientation) => {
    render(<div data-testid="parent"><Harness orientation={orientation} /></div>);
    const parent = screen.getByTestId("parent");
    parent.scrollTop = 120;
    const { strip } = geometry(orientation, orientation === "horizontal" ? 100 : 64);
    expect(screen.getByRole("combobox", { name: "Workspace · All tabs" })).toBeTruthy();
    fireEvent.keyDown(screen.getAllByRole("tab")[0]!, { key: "End" });
    expect(orientation === "horizontal" ? strip.scrollLeft : strip.scrollTop).toBe(orientation === "horizontal" ? 200 : 32);
    expect(parent.scrollTop).toBe(120);
    fireEvent.keyDown(screen.getAllByRole("tab")[2]!, { key: "Home" });
    expect(orientation === "horizontal" ? strip.scrollLeft : strip.scrollTop).toBe(0);
  });

  it("makes overflow tabs selectable, restores selected-tab focus, and closes on Escape", () => {
    render(<Harness />);
    const { strip } = geometry("horizontal", 100);
    const picker = screen.getByRole("combobox", { name: "Workspace · All tabs" });
    fireEvent.click(picker);
    expect(screen.getAllByRole("option")).toHaveLength(items.length);
    fireEvent.click(screen.getByRole("option", { name: "A long tab title" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "A long tab title" }));
    expect(strip.scrollLeft).toBe(200);
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(picker);
  });

  it("reveals restored selection after a resize and removes the picker when everything fits", () => {
    render(<Harness initial="2" />);
    const { strip, resize } = geometry("horizontal", 300);
    expect(screen.queryByRole("combobox")).toBeNull();
    resize(100);
    expect(strip.scrollLeft).toBe(200);
    expect(screen.getByRole("combobox")).toBeTruthy();
    resize(300);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
