/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalSessions, TerminalSessionsProvider, useTerminalSessions } from "./terminalSessions";

function api() {
  let data: (event: { id: string; data: string }) => void = () => {};
  const value = {
    create: vi.fn(async () => ({ id: "terminal", name: "SSH · test", cwd: "/project" })),
    write: vi.fn(async () => {}), resize: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    onData: (listener: typeof data) => { data = listener; return () => {}; }, onExit: () => () => {},
  };
  return { value, emit: (text: string) => data({ id: "terminal", data: text }) };
}
afterEach(() => { cleanup(); globalThis.ompStudioTerminal = undefined; });

it("keeps remote terminal output and identity while its target view is unmounted", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  let store!: TerminalSessions;
  function View() { const value = useTerminalSessions(); store = value.store; return <button onClick={() => void store.create("remote", "ws")}>create</button>; }
  const mounted = render(<TerminalSessionsProvider><View /></TerminalSessionsProvider>);
  fireEvent.click(screen.getByText("create"));
  await vi.waitFor(() => expect(store.snapshot().sessions.length).toBe(1));
  mounted.rerender(<TerminalSessionsProvider><div>Other target</div></TerminalSessionsProvider>);
  remote.emit("background SSH output");
  expect(remote.value.dispose).not.toHaveBeenCalled();
  expect(store.pending.get("terminal")).toBe("background SSH output");
  expect(store.snapshot().sessions[0]?.targetId).toBe("remote");
  mounted.rerender(<TerminalSessionsProvider><View /></TerminalSessionsProvider>);
  expect(store.snapshot().sessions[0]?.id).toBe("terminal");
  mounted.unmount();
  expect(remote.value.dispose).toHaveBeenCalledWith("terminal");
});

it("disposes a terminal whose asynchronous creation finishes after the window closes", async () => {
  const remote = api();
  let complete!: (value: { id: string; name: string; cwd: string }) => void;
  remote.value.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const store = new TerminalSessions(remote.value);
  const pending = store.create("remote", "ws");
  store.close();
  complete({ id: "late", name: "SSH", cwd: "/project" });
  await expect(pending).rejects.toThrow("closed");
  expect(remote.value.dispose).toHaveBeenCalledWith("late");
});
