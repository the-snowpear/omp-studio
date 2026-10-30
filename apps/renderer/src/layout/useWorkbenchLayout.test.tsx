import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchLayout } from "./useWorkbenchLayout";
import { CONVERSATION_MIN_WIDTH, SIDE_PANEL_LIMITS, type WorkbenchPreferences } from "./workbenchLayout";

/**
 * Focus priority is the "show this panel even if it has to float" gesture. The
 * narrow-window contract: taking a priority displaces the other panel, and
 * releasing one panel must never release a different panel's priority.
 */
const prefs: WorkbenchPreferences = {
  collapsed: false,
  sidebarWidth: 272,
  sideOpen: true,
  panelWidth: 480,
  bottomVisible: true,
  bottomOpen: true,
  bottomHeight: 240,
};
const NARROW = CONVERSATION_MIN_WIDTH + SIDE_PANEL_LIMITS.min - 40;

type Layout = ReturnType<typeof useWorkbenchLayout>;

function Probe({ prefs: preferences, onLayout }: { prefs: WorkbenchPreferences; onLayout: (layout: Layout) => void }) {
  const layout = useWorkbenchLayout(preferences, true);
  onLayout(layout);
  return (
    <div ref={layout.rootRef} className="app-body">
      <div id="workbench" />
      <div className="composer-region" />
    </div>
  );
}

/** jsdom has no layout: the solver reads `clientWidth` + one rect off the root. */
function harness(width: number) {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.matches(".app-body") ? width : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches(".app-body") ? new DOMRect(0, 0, width, 800) : new DOMRect(0, 0, 0, 0);
  });
  const captured: { layout: Layout } = { layout: undefined as unknown as Layout };
  const view = render(<Probe prefs={prefs} onLayout={(layout) => { captured.layout = layout; }} />);
  return {
    view,
    get layout() { return captured.layout; },
    call(action: (layout: Layout) => void) { act(() => { action(captured.layout); }); },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workbench focus priority", () => {
  it("floats the focused panel in a window too narrow to dock it", () => {
    const f = harness(NARROW);
    expect(f.layout.overlay).toBeNull();
    expect(f.layout.sideShown).toBe(false);
    f.call((layout) => layout.focusPanel("side"));
    expect(f.layout.overlay).toBe("side");
    expect(f.layout.sideShown).toBe(true);
    f.view.unmount();
  });

  it("releases only the panel that was asked to release", () => {
    const f = harness(NARROW);
    f.call((layout) => layout.focusPanel("side"));
    expect(f.layout.overlay).toBe("side");
    // Closing the bottom bar must not take the side drawer's priority with it.
    f.call((layout) => layout.releaseFocus("bottom"));
    expect(f.layout.overlay).toBe("side");
    expect(f.layout.sideShown).toBe(true);
    // Releasing the panel that actually holds the priority does drop the drawer.
    f.call((layout) => layout.releaseFocus("side"));
    expect(f.layout.overlay).toBeNull();
    expect(f.layout.sideShown).toBe(false);
    f.view.unmount();
  });

  it("ignores a release for a panel that holds nothing", () => {
    const f = harness(1440);
    expect(f.layout.sideShown).toBe(true);
    f.call((layout) => layout.releaseFocus("side"));
    f.call((layout) => layout.releaseFocus(null));
    expect(f.layout.overlay).toBeNull();
    expect(f.layout.sideShown).toBe(true);
    f.view.unmount();
  });

  it("treats a repeated focus on the same panel as no gesture at all", () => {
    // One gesture can reach the same panel twice: the topbar button acts, and the
    // dock region event it dispatches reaches this hook again.
    const before = vi.fn();
    window.addEventListener("omp-conversation-layout-before-change", before);
    const f = harness(1440);
    f.call((layout) => layout.focusPanel("side"));
    const settled = before.mock.calls.length;
    f.call((layout) => layout.focusPanel("side"));
    expect(before.mock.calls.length).toBe(settled);
    window.removeEventListener("omp-conversation-layout-before-change", before);
    f.view.unmount();
  });
});
