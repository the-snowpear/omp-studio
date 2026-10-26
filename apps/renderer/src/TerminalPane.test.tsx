import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { __resetAppSettingsForTests, updateAppSettings, useAppSettings } from "./settings/appSettings";
import { applyTypography } from "./settings/typography";
import { TerminalPane } from "./TerminalPane";
import { TerminalSessionsProvider } from "./terminalSessions";

const mocks = vi.hoisted(() => ({ terminals: [] as { options: Record<string, unknown>; write: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: Record<string, unknown>;
  cols = 80; rows = 24;
  element = document.createElement("div");
  write = vi.fn(); focus = vi.fn(); dispose = vi.fn(); onData = vi.fn(); loadAddon = vi.fn();
  constructor(options: Record<string, unknown>) { this.options = options; mocks.terminals.push(this); }
  open(node: HTMLElement) { node.append(this.element); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));

function Harness({ visible }: { visible: boolean }) {
  const { settings } = useAppSettings();
  useLayoutEffect(() => { applyTypography(settings); }, [settings]);
  return <TerminalSessionsProvider><TerminalPane visible={visible} /></TerminalSessionsProvider>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.terminals.length = 0; __resetAppSettingsForTests(null); });

it("updates live and hidden terminal fonts without recreating the shell or stealing focus", async () => {
  __resetAppSettingsForTests(null);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let onData: (event: { id: string; data: string }) => void = () => {};
  const api = {
    create: vi.fn().mockResolvedValue({ id: "shell-1", name: "Shell", cwd: "D:/workspace" }),
    write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(listener => { onData = listener; return () => {}; }), onExit: vi.fn(() => () => {}),
  };
  vi.stubGlobal("ompStudioTerminal", api);
  const view = render(<Harness visible />);
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  act(() => onData({ id: "shell-1", data: "retained shell output" }));
  const terminal = mocks.terminals[0]!;
  const focusCalls = terminal.focus.mock.calls.length;
  act(() => updateAppSettings({ terminalFontSize: 20, terminalFontFamily: "Consolas" }));
  expect(terminal.options.fontSize).toBe(20);
  expect(terminal.options.fontFamily).toContain("Consolas");
  expect(terminal.write).toHaveBeenCalledWith("retained shell output");
  expect(terminal.focus).toHaveBeenCalledTimes(focusCalls);
  view.rerender(<Harness visible={false} />);
  act(() => updateAppSettings({ terminalFontSize: 28 }));
  expect(terminal.options.fontSize).toBe(28);
  view.rerender(<Harness visible />);
  expect(mocks.terminals).toHaveLength(1);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.dispose).not.toHaveBeenCalled();
  expect(terminal.dispose).not.toHaveBeenCalled();
});
