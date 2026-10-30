/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PENDING_MAX_BYTES,
  TerminalSessions,
  TerminalSessionsProvider,
  useTerminalSessions,
  utf8Length,
} from "./terminalSessions";
import type { Terminal } from "@xterm/xterm";

interface SentBatch {
  readonly id: string;
  readonly data: string;
  readonly bytes?: number;
}

/**
 * Fake preload bridge. `ack` is optional so the "older preload" degradation can
 * be exercised, and every ACK is recorded so tests can assert the exact
 * accounting (never "some ACK", always the byte counts).
 */
function harness(options: { ack?: boolean } = {}) {
  const acked: Array<{ id: string; bytes: number }> = [];
  let dataListener: (event: SentBatch) => void = () => {};
  let exitListener: (event: { id: string }) => void = () => {};
  const value = {
    create: vi.fn(async (input?: { targetId?: string; workspaceId?: string }) => ({
      id: input?.targetId ? "ssh-terminal" : "terminal",
      name: input?.targetId ? "SSH · test" : "Shell",
      cwd: input?.targetId ? "/remote" : "D:/work",
    })),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...(options.ack === false
      ? {}
      : { ack: vi.fn((id: string, bytes: number) => { acked.push({ id, bytes }); }) }),
    onData: (listener: (event: SentBatch) => void) => { dataListener = listener; return () => {}; },
    onExit: (listener: (event: { id: string }) => void) => { exitListener = listener; return () => {}; },
  };
  return {
    value,
    acked,
    ackedBytes: (id = "terminal") => acked.filter((entry) => entry.id === id).reduce((sum, entry) => sum + entry.bytes, 0),
    emit(id: string, data: string, bytes?: number) {
      dataListener({ id, data, ...(bytes === undefined ? {} : { bytes }) });
    },
    exit(id: string) {
      exitListener({ id });
    },
  };
}

/**
 * Stand-in for Main's flow-control accounting (`terminal-batch.ts`): it pauses
 * at 500 KiB unacknowledged and resumes below 100 KiB, and only ever sends
 * while unpaused. This is the contract the renderer must satisfy.
 */
class FakeMain {
  static readonly HIGH = 500 * 1024;
  static readonly LOW = 100 * 1024;
  unacked = 0;
  paused = false;
  readonly sent: string[] = [];
  constructor(private readonly deliver: (text: string) => void) {}

  send(text: string): void {
    this.sent.push(text);
    this.deliver(text);
    this.unacked += utf8Length(text);
    if (this.unacked >= FakeMain.HIGH) this.paused = true;
  }

  /** Returns true when the write would have been sent (Main is not paused). */
  get totalSent(): number {
    return this.sent.reduce((sum, text) => sum + utf8Length(text), 0);
  }

  ack(bytes: number): void {
    this.unacked = Math.max(0, this.unacked - bytes);
    if (this.paused && this.unacked <= FakeMain.LOW) this.paused = false;
  }
}

/** Fake xterm screen: records writes, replays write callbacks on demand. */
function fakeScreen() {
  const writes: string[] = [];
  const callbacks: Array<() => void> = [];
  let disposed = 0;
  const host = {
    term: {
      write: (data: string, callback?: () => void) => {
        writes.push(data);
        if (callback) callbacks.push(callback);
      },
      // A real xterm has this; releasing a terminal calls it exactly once.
      dispose: () => { disposed += 1; },
    } as unknown as Terminal,
    fit: { fit: () => {} } as never,
  };
  return {
    host,
    writes,
    written: () => writes.join(""),
    get disposed(): number {
      return disposed;
    },
    fireCallbacks() {
      for (const callback of callbacks.splice(0)) callback();
    },
    get pendingCallbacks(): number {
      return callbacks.length;
    },
  };
}

afterEach(() => { cleanup(); globalThis.ompStudioTerminal = undefined; });

/** Let the microtask-coalesced ACK flush run. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

async function storeWith(...args: Parameters<TerminalSessions["create"]>): Promise<{ store: TerminalSessions; api: ReturnType<typeof harness>; id: string }> {
  const api = harness();
  globalThis.ompStudioTerminal = api.value as unknown as typeof globalThis.ompStudioTerminal;
  const store = new TerminalSessions(globalThis.ompStudioTerminal);
  const id = await store.create(...args);
  return { store, api, id };
}

// ---- The P2-1 regression: no ACK for output that is only queued -------------

describe("unmounted terminal: queued output is never acknowledged", () => {
  it("keeps 300 KiB queued without a single ACK (the old store acked all of it and kept 64K chars)", async () => {
    const { store, api, id } = await storeWith(null);
    const chunks = Array.from({ length: 6 }, (_, index) => `chunk-${index}-`.padEnd(50 * 1024, "x"));
    for (const chunk of chunks) api.emit(id, chunk);
    await settle();

    // The old behaviour: ACK 6×50 KiB and keep only the tail 64K characters.
    expect(api.acked).toEqual([]);
    expect(api.value.ack).not.toHaveBeenCalled();
    const queue = store.pending.get(id);
    expect(queue?.bytes).toBe(300 * 1024);
    expect(queue?.truncated).toBe(false);
    expect(queue?.text).toBe(chunks.join(""));
  });

  it("delivers the backlog in order on re-attach and only then credits Main", async () => {
    const { store, api, id } = await storeWith(null);
    const chunks = ["first\r\n", "second\r\n", "third\r\n"];
    for (const chunk of chunks) api.emit(id, chunk);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    await settle();

    // One write per queued batch, in the original order.
    expect(screen.writes).toEqual(chunks);
    expect(api.acked).toEqual([]);
    expect(store.pending.get(id)?.bytes).toBe(0);

    screen.fireCallbacks();
    await settle();
    expect(api.ackedBytes()).toBe(chunks.join("").length);
    expect(api.value.ack).toHaveBeenCalledTimes(1);
  });

  it("drains the backlog once: repeating attachHost never duplicates output", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "before-");
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    // A second mount (pane re-render) must not replay what was already written.
    store.attachHost(id, screen.host);
    screen.fireCallbacks();
    await settle();
    expect(screen.written()).toBe("before-");

    // Once a host exists, later output goes straight to xterm (hidden terminal
    // keeps working) instead of being queued.
    api.emit(id, "after-");
    screen.fireCallbacks();
    await settle();
    expect(screen.written()).toBe("before-after-");
    expect(api.ackedBytes()).toBe(utf8Length("before-after-"));
    expect(store.pending.get(id)?.bytes).toBe(0);
  });

  it("keeps a split multi-byte character intact across the backlog", async () => {
    const { store, api, id } = await storeWith(null);
    // Main decodes UTF-8 already; a batch boundary may still fall inside a
    // character's *string*, which must not change the reconstructed text.
    api.emit(id, "中文");
    api.emit(id, "输出-€");
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    screen.fireCallbacks();
    await settle();
    expect(screen.written()).toBe("中文输出-€");
    expect(api.ackedBytes()).toBe(utf8Length("中文输出-€"));
  });
});

// ---- Backpressure: Main pauses while the terminal is unmounted --------------

describe("unmounted terminal: Main's watermark drives the back-pressure", () => {
  it("stops the PTY at 500 KiB unacknowledged and resumes once the backlog is written", async () => {
    const runtime = harness();
    globalThis.ompStudioTerminal = runtime.value as unknown as typeof globalThis.ompStudioTerminal;
    const store = new TerminalSessions(globalThis.ompStudioTerminal);
    const main = new FakeMain((text) => runtime.emit("terminal", text));
    const originalAck = runtime.value.ack;
    runtime.value.ack = vi.fn((id: string, bytes: number) => {
      runtime.acked.push({ id, bytes });
      main.ack(bytes);
    });
    void originalAck;
    const id = await store.create(null);

    const batch = "y".repeat(64 * 1024);
    for (let index = 0; index < 9 && !main.paused; index += 1) main.send(batch);
    await settle();
    // Main paused after 500 KiB went unacknowledged.
    expect(main.paused).toBe(true);
    // Still nothing acknowledged while unmounted.
    expect(runtime.acked).toEqual([]);
    const queued = store.pending.get(id);
    expect(queued?.bytes).toBe(main.totalSent);
    expect(queued?.truncated).toBe(false);

    // Re-attach: the backlog is written in order, each batch credits Main, and
    // the paused PTY resumes once the unacknowledged window drops below 100 KiB.
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    expect(screen.written()).toBe(main.sent.join(""));
    screen.fireCallbacks();
    await settle();
    expect(main.unacked).toBe(0);
    // Main resumed after the ACKs.
    expect(main.paused).toBe(false);
  });

  it("keeps the backlog bounded and reports truncation instead of dropping silently", async () => {
    const { store, api, id } = await storeWith(null);
    const chunk = "z".repeat(64 * 1024);
    const batches = Math.ceil(PENDING_MAX_BYTES / chunk.length) + 4;
    for (let index = 0; index < batches; index += 1) api.emit(id, chunk);
    await settle();

    const queue = store.pending.get(id);
    expect(queue).toBeDefined();
    expect(queue!.bytes).toBeLessThanOrEqual(PENDING_MAX_BYTES);
    expect(queue!.truncated).toBe(true);
    expect(store.snapshot().notices[id]).toMatch(/3 MiB/u);
    // The newest output is what survives (a returning user needs the tail).
    expect(queue!.text.endsWith(chunk)).toBe(true);
    expect(api.value.ack).not.toHaveBeenCalled();
  });

  it("credits the dropped bytes once the retained tail is written, so the PTY cannot stay paused", async () => {
    const { store, api, id } = await storeWith(null);
    const chunk = "z".repeat(64 * 1024);
    const batches = Math.ceil(PENDING_MAX_BYTES / chunk.length) + 4;
    for (let index = 0; index < batches; index += 1) api.emit(id, chunk);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    screen.fireCallbacks();
    await settle();

    const totalSent = batches * chunk.length;
    // Retained bytes plus the explicitly reported dropped bytes are credited.
    expect(api.ackedBytes()).toBe(totalSent);
    expect(store.pending.get(id)?.truncated).toBe(false);
    expect(store.snapshot().notices[id]).toBeDefined();
  });
});

// ---- Batches that occupy no backlog ---------------------------------------

describe("zero-text batches", () => {
  it("acknowledges a graphics-only batch immediately, even without a host", async () => {
    const { store, api, id } = await storeWith(null);
    // Invalid Kitty payload: the decoder strips the escape and reports the error.
    api.emit(id, "\x1b_Ga=T,f=100;AAAA\x1b\\");
    await settle();

    expect(api.value.ack).toHaveBeenCalledTimes(1);
    expect(api.ackedBytes()).toBeGreaterThan(0);
    expect(store.pending.get(id)?.bytes ?? 0).toBe(0);
    expect(store.snapshot().graphicsErrors[id]).toBeDefined();
    // A zero-text batch must never leave Main parked at its watermark.
    expect(api.ackedBytes()).toBe(utf8Length("\x1b_Ga=T,f=100;AAAA\x1b\\"));
  });

  it("still acknowledges later text batches once a host is attached", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "\x1b_Ga=T,f=100;AAAA\x1b\\");
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    api.emit(id, "text");
    screen.fireCallbacks();
    await settle();
    expect(screen.written()).toBe("text");
    expect(api.ackedBytes()).toBe(utf8Length("\x1b_Ga=T,f=100;AAAA\x1b\\") + 4);
  });
});

// ---- Exit / dispose / teardown -------------------------------------------

describe("teardown releases the backlog without crediting it", () => {
  it("a natural exit keeps an unmounted terminal's output for the first attach", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "queued-but-never-shown");
    api.exit(id);
    await settle();

    // The process ending is not the user closing the tab: the output the user
    // never saw must survive until the screen exists.
    expect(store.pending.get(id)?.text).toBe("queued-but-never-shown");
    expect(api.value.ack).not.toHaveBeenCalled();
    expect(store.snapshot().sessions[0]?.status).toBe("ended");
  });

  it("a write callback that fires after exit does not credit the dead terminal", async () => {
    const { store, api, id } = await storeWith(null);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    api.emit(id, "in-flight");
    api.exit(id);
    screen.fireCallbacks();
    await settle();
    expect(api.value.ack).not.toHaveBeenCalled();
  });

  it("best-effort writes the backlog into an attached screen before releasing it", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "last words");
    const screen = fakeScreen();
    // Registered but not drained: simulates teardown ordering.
    store.hosts.set(id, screen.host);
    api.exit(id);
    expect(screen.written()).toBe("last words");
    expect(store.pending.get(id)).toBeUndefined();
  });

  it("a chunk that arrives after the exit event is appended, not dropped", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "queued");
    api.exit(id);
    // Main keeps the batcher open for one window after the exit notification
    // because ConPTY can hand over the shell's last line afterwards.
    api.emit(id, "trailing");
    await settle();
    expect(store.pending.get(id)?.text).toBe("queuedtrailing");
    expect(api.value.ack).not.toHaveBeenCalled();
  });

  it("dispose (user closed the tab) drops the queue, the ACK credit and the callbacks", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "discarded");
    await store.remove(id);
    await settle();
    expect(store.pending.get(id)).toBeUndefined();
    expect(api.value.ack).not.toHaveBeenCalled();
    expect(store.snapshot().notices[id]).toBeUndefined();
  });

  it("closing the window drops every queue without acknowledging", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "orphan");
    store.close();
    await settle();
    expect(store.pending.size).toBe(0);
    expect(api.value.ack).not.toHaveBeenCalled();
  });
});

// ---- A natural exit must not destroy output the user never saw ------------

describe("terminal lifecycle: natural exit preserves the backlog", () => {
  it("replays the whole backlog on the first attach after the exit", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "line 1\r\n");
    api.emit(id, "line 2\r\n");
    api.exit(id);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    expect(screen.written()).toBe("line 1\r\nline 2\r\n");
    // The flow-control session is over; replaying is display, not credit.
    await settle();
    expect(api.value.ack).not.toHaveBeenCalled();
    expect(store.pending.get(id)).toBeUndefined();
  });

  it("keeps output from both sides of the exit in arrival order", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "before-exit ");
    api.exit(id);
    api.emit(id, "after-exit");
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    expect(screen.written()).toBe("before-exit after-exit");
  });

  it("re-attaching an ended terminal does not replay the output twice", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "once");
    api.exit(id);
    const first = fakeScreen();
    store.attachHost(id, first.host);
    expect(first.written()).toBe("once");
    const second = fakeScreen();
    store.attachHost(id, second.host);
    expect(second.written()).toBe("");
  });

  it("writes a mounted terminal's tail into its screen without crediting it", async () => {
    const { store, api, id } = await storeWith(null);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    api.emit(id, "before");
    screen.fireCallbacks();
    await settle();
    expect(api.ackedBytes(id)).toBe(utf8Length("before"));
    api.exit(id);
    api.emit(id, "tail");
    expect(screen.written()).toBe("beforetail");
    await settle();
    expect(api.ackedBytes(id)).toBe(utf8Length("before"));
  });

  it("keeps truncation visible after a natural exit and clears it on close", async () => {
    const { store, api, id } = await storeWith(null);
    for (let chunk = 0; chunk < 50; chunk += 1) api.emit(id, "x".repeat(64 * 1024));
    api.exit(id);
    const queue = store.pending.get(id);
    expect(queue?.truncated).toBe(true);
    expect(queue?.bytes).toBe(PENDING_MAX_BYTES);
    expect(store.snapshot().notices[id]).toMatch(/3 MiB/u);

    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    expect(screen.written().length).toBe(PENDING_MAX_BYTES);
    expect(store.snapshot().notices[id]).toMatch(/3 MiB/u);

    await store.remove(id);
    expect(store.pending.get(id)).toBeUndefined();
    expect(store.snapshot().notices[id]).toBeUndefined();
  });

  it("releases an ended terminal when the user closes it", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "shown");
    api.exit(id);
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    await store.remove(id);
    expect(store.pending.get(id)).toBeUndefined();
    expect(store.hosts.get(id)).toBeUndefined();
    expect(store.snapshot().sessions.some(session => session.id === id)).toBe(false);
    expect(store.snapshot().notices[id]).toBeUndefined();
    expect(screen.disposed).toBe(1);
  });

  it("ignores data that arrives after the user closed an ended terminal", async () => {
    const { store, api, id } = await storeWith(null);
    api.emit(id, "shown");
    api.exit(id);
    await store.remove(id);
    api.emit(id, "late");
    await settle();
    expect(store.pending.get(id)).toBeUndefined();
    expect(api.value.ack).not.toHaveBeenCalled();
  });

  it("does not resurrect a queue for data that arrives while close is in flight", async () => {
    const api = harness();
    let releaseClose: () => void = () => {};
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    api.value.dispose = vi.fn(async () => { await closing; });
    globalThis.ompStudioTerminal = api.value as unknown as typeof globalThis.ompStudioTerminal;
    const store = new TerminalSessions(globalThis.ompStudioTerminal);
    const id = await store.create(null);
    const removing = store.remove(id);
    api.emit(id, "during-close");
    releaseClose();
    await removing;
    expect(store.pending.get(id)).toBeUndefined();
    expect(store.snapshot().sessions.some(session => session.id === id)).toBe(false);
    expect(api.value.ack).not.toHaveBeenCalled();
  });

  it("drops nothing when the process exits before create returns", async () => {
    const api = harness();
    globalThis.ompStudioTerminal = api.value as unknown as typeof globalThis.ompStudioTerminal;
    const store = new TerminalSessions(globalThis.ompStudioTerminal);
    const creating = store.create(null);
    api.emit("terminal", "early output");
    api.exit("terminal");
    const id = await creating;
    expect(store.snapshot().sessions[0]?.status).toBe("ended");
    expect(store.pending.get(id)?.text).toBe("early output");
    const screen = fakeScreen();
    store.attachHost(id, screen.host);
    expect(screen.written()).toBe("early output");
    await settle();
    expect(api.value.ack).not.toHaveBeenCalled();
  });
});

// ---- Local shell and SSH behave identically ------------------------------

describe("local PTY and SSH terminals share one contract", () => {
  for (const [label, target] of [["local", null], ["ssh", "remote-target"]] as const) {
    it(`${label}: queues without ACK, drains in order, then credits`, async () => {
      const { store, api, id } = await storeWith(target, target === null ? undefined : "ws");
      const chunks = ["line 1\r\n", "line 2\r\n"];
      for (const chunk of chunks) api.emit(id, chunk);
      await settle();
      expect(api.value.ack).not.toHaveBeenCalled();
      expect(store.pending.get(id)?.text).toBe(chunks.join(""));

      const screen = fakeScreen();
      store.attachHost(id, screen.host);
      screen.fireCallbacks();
      await settle();
      expect(screen.written()).toBe(chunks.join(""));
      expect(api.ackedBytes(id)).toBe(utf8Length(chunks.join("")));
    });
  }

  for (const [label, target] of [["local", null], ["ssh", "remote-target"]] as const) {
    it(`${label}: a natural exit keeps the backlog and replays it without crediting`, async () => {
      const { store, api, id } = await storeWith(target, target === null ? undefined : "ws");
      api.emit(id, "before exit\r\n");
      api.exit(id);
      api.emit(id, "after exit\r\n");
      await settle();
      expect(store.snapshot().sessions.find(session => session.id === id)?.status).toBe("ended");

      const screen = fakeScreen();
      store.attachHost(id, screen.host);
      expect(screen.written()).toBe("before exit\r\nafter exit\r\n");
      expect(api.value.ack).not.toHaveBeenCalled();
      expect(store.pending.get(id)).toBeUndefined();

      await store.remove(id);
      expect(screen.disposed).toBe(1);
      expect(store.pending.get(id)).toBeUndefined();
    });
  }

  it("two terminals do not cross-talk and are credited independently", async () => {
    const runtime = harness();
    globalThis.ompStudioTerminal = runtime.value as unknown as typeof globalThis.ompStudioTerminal;
    const store = new TerminalSessions(globalThis.ompStudioTerminal);
    const local = await store.create(null);
    const ssh = await store.create("remote-target", "ws");
    expect(local).not.toBe(ssh);

    runtime.emit(local, "local-1");
    runtime.emit(ssh, "ssh-1");
    await settle();
    expect(runtime.value.ack).not.toHaveBeenCalled();

    const localScreen = fakeScreen();
    store.attachHost(local, localScreen.host);
    localScreen.fireCallbacks();
    await settle();
    expect(localScreen.written()).toBe("local-1");
    expect(runtime.acked).toEqual([{ id: local, bytes: 7 }]);

    const sshScreen = fakeScreen();
    store.attachHost(ssh, sshScreen.host);
    sshScreen.fireCallbacks();
    await settle();
    expect(sshScreen.written()).toBe("ssh-1");
    expect(runtime.acked).toEqual([{ id: local, bytes: 7 }, { id: ssh, bytes: 5 }]);
  });

  it("switching the active target keeps both backlogs separate", async () => {
    const runtime = harness();
    globalThis.ompStudioTerminal = runtime.value as unknown as typeof globalThis.ompStudioTerminal;
    const store = new TerminalSessions(globalThis.ompStudioTerminal);
    const local = await store.create(null);
    const ssh = await store.create("remote-target", "ws");
    runtime.emit(local, "local-bg");
    runtime.emit(ssh, "ssh-bg");
    store.activeIds.set(null, local);
    store.activeIds.set("remote-target", ssh);
    expect(store.pending.get(local)?.text).toBe("local-bg");
    expect(store.pending.get(ssh)?.text).toBe("ssh-bg");
    await settle();
    expect(runtime.value.ack).not.toHaveBeenCalled();
  });
});

// ---- Previously covered behaviour, kept intact ---------------------------

it("keeps remote terminal output and identity while its target view is unmounted", async () => {
  const remote = harness(); globalThis.ompStudioTerminal = remote.value as unknown as typeof globalThis.ompStudioTerminal;
  let store!: TerminalSessions;
  function View() { const value = useTerminalSessions(); store = value.store; return <button onClick={() => void store.create("remote", "ws")}>create</button>; }
  const mounted = render(<TerminalSessionsProvider><View /></TerminalSessionsProvider>);
  fireEvent.click(screen.getByText("create"));
  await vi.waitFor(() => expect(store.snapshot().sessions.length).toBe(1));
  mounted.rerender(<TerminalSessionsProvider><div>Other target</div></TerminalSessionsProvider>);
  const sessionId = store.snapshot().sessions[0]!.id;
  remote.emit(sessionId, "background SSH output");
  expect(remote.value.dispose).not.toHaveBeenCalled();
  expect(store.pending.get(sessionId)?.text).toBe("background SSH output");
  expect(store.snapshot().sessions[0]?.targetId).toBe("remote");
  mounted.rerender(<TerminalSessionsProvider><View /></TerminalSessionsProvider>);
  expect(store.snapshot().sessions[0]?.id).toBe(sessionId);
  mounted.unmount();
  expect(remote.value.dispose).toHaveBeenCalledWith(sessionId);
});

it("disposes a terminal whose asynchronous creation finishes after the window closes", async () => {
  const remote = harness();
  let complete!: (value: { id: string; name: string; cwd: string }) => void;
  remote.value.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const store = new TerminalSessions(remote.value as unknown as typeof globalThis.ompStudioTerminal);
  const pending = store.create("remote", "ws");
  store.close();
  complete({ id: "late", name: "SSH", cwd: "/project" });
  await expect(pending).rejects.toThrow("closed");
  expect(remote.value.dispose).toHaveBeenCalledWith("late");
});

it("opts in to output flow control when creating a terminal", async () => {
  const remote = harness(); globalThis.ompStudioTerminal = remote.value as unknown as typeof globalThis.ompStudioTerminal;
  const store = new TerminalSessions(globalThis.ompStudioTerminal);
  await store.create(null);
  expect(remote.value.create).toHaveBeenCalledWith(expect.objectContaining({ flowControl: true }));
});

it("acknowledges only after xterm's write callback fires", async () => {
  const { store, api, id } = await storeWith(null);
  const screen = fakeScreen();
  store.attachHost(id, screen.host);
  api.emit(id, "written");
  await settle();
  expect(api.value.ack).not.toHaveBeenCalled();
  screen.fireCallbacks();
  await settle();
  expect(api.value.ack).toHaveBeenCalledWith(id, 7);
});

it("uses the byte length Main reported instead of re-measuring the payload", async () => {
  const { store, api, id } = await storeWith(null);
  const screen = fakeScreen();
  store.attachHost(id, screen.host);
  // Main counts what it sent; the renderer may have stripped graphics escapes.
  api.emit(id, "stripped", 42);
  screen.fireCallbacks();
  await settle();
  expect(api.value.ack).toHaveBeenCalledWith(id, 42);
});

it("coalesces acknowledgements from one tick into a single message", async () => {
  const { store, api, id } = await storeWith(null);
  const screen = fakeScreen();
  store.attachHost(id, screen.host);
  api.emit(id, "one");
  api.emit(id, "two");
  screen.fireCallbacks();
  await settle();
  expect(api.value.ack).toHaveBeenCalledTimes(1);
  expect(api.value.ack).toHaveBeenCalledWith(id, 6);
});

it("works without an ack method (older preload) and queues instead of losing output", async () => {
  const remote = harness({ ack: false });
  globalThis.ompStudioTerminal = remote.value as unknown as typeof globalThis.ompStudioTerminal;
  const store = new TerminalSessions(globalThis.ompStudioTerminal);
  const id = await store.create(null);
  remote.emit(id, "世界");
  await settle();
  expect(store.pending.get(id)?.text).toBe("世界");
  expect(store.pending.get(id)?.bytes).toBe(6);
  expect(utf8Length("世界")).toBe(6);
  expect(utf8Length("plain ascii")).toBe(11);
});
