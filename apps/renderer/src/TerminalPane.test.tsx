import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useCallback, useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { __resetAppSettingsForTests, updateAppSettings, useAppSettings } from "./settings/appSettings";
import { applyTypography } from "./settings/typography";
import { TerminalPane } from "./TerminalPane";
import { PENDING_MAX_BYTES, TerminalSessionsProvider, useTerminalSessions } from "./terminalSessions";

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

it("an explicit create on first mount does not also auto-create a shell", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const api = {
    create: vi.fn().mockResolvedValue({ id: "explicit-shell", name: "Shell", cwd: "D:/workspace" }),
    write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
  };
  vi.stubGlobal("ompStudioTerminal", api);
  function ExplicitCreate() {
    const attach = useCallback((handle: import("./TerminalPane").TerminalPaneHandle | null) => { handle?.create(); }, []);
    return <TerminalSessionsProvider><TerminalPane ref={attach} visible /></TerminalSessionsProvider>;
  }
  render(<ExplicitCreate />);
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  await act(async () => {});
  expect(api.create).toHaveBeenCalledOnce();
});

it("fits automatic resize without taking focus away from the composer", async () => {
  const observers: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  const api = {
    create: vi.fn().mockResolvedValue({ id: "resize-shell", name: "Shell", cwd: "D:/workspace" }),
    write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
  };
  vi.stubGlobal("ompStudioTerminal", api);
  render(<><input aria-label="Composer" /><Harness visible /></>);
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  await waitFor(() => expect(mocks.terminals[0]!.focus).toHaveBeenCalled());
  const terminal = mocks.terminals[0]!;
  const composer = document.querySelector<HTMLInputElement>('input[aria-label="Composer"]')!;
  composer.focus();
  const focusCalls = terminal.focus.mock.calls.length;
  const resizeCalls = api.resize.mock.calls.length;
  act(() => observers.forEach(resize => resize()));
  await waitFor(() => expect(api.resize.mock.calls.length).toBeGreaterThan(resizeCalls));
  expect(document.activeElement).toBe(composer);
  expect(terminal.focus).toHaveBeenCalledTimes(focusCalls);
  expect(api.create).toHaveBeenCalledTimes(1);
});

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
  // The write carries the flow-control ACK callback (P0-4).
  expect(terminal.write).toHaveBeenCalledWith("retained shell output", expect.any(Function));
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

it("shows a truncation notice instead of dropping a large background backlog silently", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let emit: (event: { id: string; data: string; bytes?: number }) => void = () => {};
  const api = {
    create: vi.fn().mockResolvedValue({ id: "shell-1", name: "Shell", cwd: "D:/workspace" }),
    write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn(),
    onData: vi.fn((listener: typeof emit) => { emit = listener; return () => {}; }), onExit: vi.fn(() => () => {}),
  };
  vi.stubGlobal("ompStudioTerminal", api);

  // Create the terminal with no pane rendered at all, so its output has nowhere
  // to go but the bounded backlog (the reviewed defect: this used to be acked
  // and cut to the last 64K characters).
  let store!: ReturnType<typeof useTerminalSessions>["store"];
  function Probe() { store = useTerminalSessions().store; return null; }
  const view = render(<TerminalSessionsProvider><Probe /></TerminalSessionsProvider>);
  const id = await store.create(null);
  const chunk = "z".repeat(64 * 1024);
  const batches = Math.ceil(PENDING_MAX_BYTES / chunk.length) + 2;
  for (let index = 0; index < batches; index += 1) emit({ id, data: chunk });
  expect(store.pending.get(id)?.truncated).toBe(true);
  expect(api.ack).not.toHaveBeenCalled();

  // Mounting the pane drains the retained tail into xterm and shows the notice.
  view.rerender(<TerminalSessionsProvider><Probe /><TerminalPane visible /></TerminalSessionsProvider>);
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  await waitFor(() => expect(screenText()).toContain("3 MiB"));
  expect(store.pending.get(id)?.truncated).toBe(false);
  view.unmount();
});

function screenText(): string {
  return document.body.textContent ?? "";
}
