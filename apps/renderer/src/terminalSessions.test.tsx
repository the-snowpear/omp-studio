/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalSessions, TerminalSessionsProvider, useTerminalSessions, utf8Length } from "./terminalSessions";
import type { Terminal } from "@xterm/xterm";

function api() {
  let data: (event: { id: string; data: string; bytes?: number }) => void = () => {};
  const value = {
    create: vi.fn(async () => ({ id: "terminal", name: "SSH · test", cwd: "/project" })),
    write: vi.fn(async () => {}), resize: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    ack: vi.fn(),
    onData: (listener: typeof data) => { data = listener; return () => {}; }, onExit: () => () => {},
  };
  return { value, emit: (text: string, bytes?: number) => data({ id: "terminal", data: text, ...(bytes === undefined ? {} : { bytes }) }) };
}
afterEach(() => { cleanup(); globalThis.ompStudioTerminal = undefined; });

/** Let the microtask-coalesced ACK flush run. */
const settle = () => new Promise<void>((resolve) => { queueMicrotask(resolve); });

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

it("opts in to output flow control when creating a terminal", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  const store = new TerminalSessions(remote.value);
  await store.create(null);
  expect(remote.value.create).toHaveBeenCalledWith(expect.objectContaining({ flowControl: true }));
});

it("acknowledges buffered output that has no xterm attached yet", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  const store = new TerminalSessions(remote.value);
  await store.create(null);
  remote.emit("hello");
  expect(remote.value.ack).not.toHaveBeenCalled();
  await settle();
  expect(remote.value.ack).toHaveBeenCalledWith("terminal", 5);
});

it("acknowledges only after xterm's write callback fires", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  const store = new TerminalSessions(remote.value);
  await store.create(null);
  const callbacks: Array<() => void> = [];
  store.hosts.set("terminal", {
    term: { write: (data: string, callback?: () => void) => { if (callback) callbacks.push(callback); } } as unknown as Terminal,
    fit: { fit: () => {} } as never,
  });
  remote.emit("written");
  await settle();
  expect(remote.value.ack).not.toHaveBeenCalled();
  callbacks.forEach((callback) => callback());
  await settle();
  expect(remote.value.ack).toHaveBeenCalledWith("terminal", 7);
});

it("uses the byte length Main reported instead of re-measuring the payload", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  const store = new TerminalSessions(remote.value);
  await store.create(null);
  // Main counts what it sent; the renderer may have stripped graphics escapes.
  remote.emit("stripped", 42);
  await settle();
  expect(remote.value.ack).toHaveBeenCalledWith("terminal", 42);
});

it("coalesces acknowledgements from one tick into a single message", async () => {
  const remote = api(); globalThis.ompStudioTerminal = remote.value;
  const store = new TerminalSessions(remote.value);
  await store.create(null);
  remote.emit("one");
  remote.emit("two");
  await settle();
  expect(remote.value.ack).toHaveBeenCalledTimes(1);
  expect(remote.value.ack).toHaveBeenCalledWith("terminal", 6);
});

it("works without an ack method (older preload) and measures UTF-8 bytes", async () => {
  const remote = api();
  delete (remote.value as { ack?: unknown }).ack;
  globalThis.ompStudioTerminal = remote.value as unknown as typeof globalThis.ompStudioTerminal;
  const store = new TerminalSessions(globalThis.ompStudioTerminal);
  await store.create(null);
  remote.emit("世界");
  await settle();
  expect(store.pending.get("terminal")).toBe("世界");
  expect(utf8Length("世界")).toBe(6);
  expect(utf8Length("plain ascii")).toBe(11);
});
