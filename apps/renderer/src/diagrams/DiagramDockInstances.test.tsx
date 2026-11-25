import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DockProvider } from "../dock/DockContext";
import { DockStore } from "../dock/store";
import { I18nProvider } from "../i18n";
import { PreviewSurface } from "../preview/PreviewContext";
import { MermaidFigure } from "./MermaidFigure";
import { DiagramDockInstances } from "./DiagramDockInstances";
import type { PanelVisibility } from "../dock/types";
import type { ReactNode } from "react";

vi.mock("../dock/DockContext", async importOriginal => ({
  ...await importOriginal<typeof import("../dock/DockContext")>(),
  DockPanel: ({ children }: { children: (visibility: PanelVisibility) => ReactNode }) => <>{children({ visible: true, width: 600, height: 400 })}</>,
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("keeps the diagram after its message unmounts and focuses a repeated open (preview=%s)", async preview => {
  const NativeUrl = URL, revoked = vi.fn();
  vi.stubGlobal("URL", class extends NativeUrl { static createObjectURL = () => "blob:retained-diagram"; static revokeObjectURL = revoked; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const store = new DockStore(null); store.switchScope({ target: "local", project: "workspace", session: "conversation" }, preview);
  const code = "flowchart LR\n A-->B", svg = '<svg viewBox="0 0 1500 800"><text>Kept diagram</text></svg>';
  const ui = (message: boolean) => <I18nProvider forcedLanguage="en"><PreviewSurface preview={preview}>
    <DockProvider store={store} definitions={[]}>
      {message ? <MermaidFigure code={code} svg={svg} /> : null}<DiagramDockInstances />
    </DockProvider>
  </PreviewSurface></I18nProvider>;
  const mounted = render(ui(true));
  fireEvent.click(screen.getByRole("button", { name: "View diagram" }));
  await screen.findByRole("region", { name: "Diagram viewport" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "View diagram" }));
  expect(Object.keys(store.getSnapshot().layout.diagramViews)).toHaveLength(1);
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  mounted.rerender(ui(false));
  expect(screen.getByRole("region", { name: "Diagram viewport" })).toBeDefined();
  expect(screen.getByRole("status", { name: "Zoom level" }).textContent).toBe("125%");
  const id = Object.keys(store.getSnapshot().layout.diagramViews)[0] as `diagram-view:${string}`;
  act(() => store.dispatch({ type: "diagram-close", panels: [id] }));
  expect(screen.queryByRole("region", { name: "Diagram viewport" })).toBeNull();
  expect(revoked).toHaveBeenCalledWith("blob:retained-diagram");
  store.dispose();
});
