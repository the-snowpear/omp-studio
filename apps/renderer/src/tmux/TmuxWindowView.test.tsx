import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TmuxTopology } from "../../../desktop/src/tmux/tmux-shared";
import { TerminalSessions } from "../terminalSessions";
import { TmuxWindowView } from "./TmuxWindowView";
import { I18nProvider } from "../i18n";

const mocks = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  element = document.createElement("div"); options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) { this.options = options; mocks.options.push(options); }
  open(node: HTMLElement) { node.append(this.element); }
  onData() {} resize() {} focus() {} dispose() {} write() {}
  registerLinkProvider() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.options.length = 0; });
function topology(): TmuxTopology {
  return { connectionId: "connection", targetId: "remote", workspaceId: "ws", state: "attached", windows: [{ id: "@0", index: 0, name: "shell", cols: 80, rows: 24, zoomed: false, layout: { type: "row", x: 0, y: 0, cols: 80, rows: 24, children: [{ type: "pane", paneId: "%0", x: 0, y: 0, cols: 40, rows: 24 }, { type: "pane", paneId: "%1", x: 41, y: 0, cols: 39, rows: 24 }] } }], panes: { "%0": { terminalId: "pane0", windowId: "@0", active: true, title: "shell", paused: false, dead: false, off: false }, "%1": { terminalId: "pane1", windowId: "@0", active: false, title: "server", paused: true, dead: false, off: false } } };
}
it("places panes in character cells, preserves the border gap, and selects the clicked pane", () => {
  const value = topology(), command = vi.fn(async () => {}), store = new TerminalSessions(undefined);
  const view = render(<I18nProvider forcedLanguage="en"><TmuxWindowView topology={value} window={value.windows[0]!} store={store} active demo command={command} /></I18nProvider>);
  const right = view.container.querySelector<HTMLElement>('[data-pane-id="%1"]')!;
  expect(right.style.left).toBe("328px"); expect(right.style.top).toBe("0px"); expect(right.style.width).toBe("312px"); expect(right.style.height).toBe("384px");
  fireEvent.mouseDown(right);
  expect(command).toHaveBeenCalledWith({ kind: "selectPane", paneId: "%1" });
  expect(view.getByRole("status").textContent).toContain("resynchronizing");
});
it("converts divider movement into cells before requesting resize", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const value = topology(), command = vi.fn(async () => {}), store = new TerminalSessions(undefined);
  const view = render(<TmuxWindowView topology={value} window={value.windows[0]!} store={store} active demo command={command} />);
  const divider = view.getByRole("separator");
  divider.setPointerCapture = vi.fn();
  fireEvent.pointerDown(divider, { clientX: 320, pointerId: 1 });
  fireEvent.pointerMove(divider, { clientX: 344, pointerId: 1 });
  fireEvent.pointerUp(divider, { pointerId: 1 });
  expect(command).toHaveBeenCalledWith({ kind: "resizePane", paneId: "%0", axis: "x", cells: 43 });
});
it("tmux xterms use raw line feeds and native pane dimensions", () => {
  const value = topology(), store = new TerminalSessions(undefined);
  render(<TmuxWindowView topology={value} window={value.windows[0]!} store={store} active={false} demo={false} command={async () => {}} />);
  expect(mocks.options).toHaveLength(2);
  expect(mocks.options[0]).toMatchObject({ convertEol: false, cols: 40, rows: 24 });
  expect(mocks.options[1]).toMatchObject({ convertEol: false, cols: 39, rows: 24 });
  store.close();
});
