/**
 * P0-4: PTY output batching + bounded flow control.
 *
 * The batcher is the piece that turns per-chunk `sender.send` into one IPC
 * message per 8 ms window, and the piece that keeps the buffer bounded without
 * dropping a byte. These tests drive it with a manual clock, so every window
 * boundary is exact and nothing sleeps.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  TERMINAL_BATCH_MS,
  TERMINAL_BUFFER_HARD_CAP_BYTES,
  TERMINAL_FLOW_HIGH_BYTES,
  TERMINAL_FLOW_LOW_BYTES,
  TerminalOutputBatcher,
  type TerminalBatchSink,
  type TerminalBatchTimers,
} from "../src/terminal-batch.js";

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
  cancelled: boolean;
}

/** Manual clock: `run()` fires every timer scheduled since the last run. */
class ManualTimers implements TerminalBatchTimers {
  readonly scheduled: Timer[] = [];

  setTimeout(handler: () => void, ms: number): unknown {
    const timer: Timer = { handler, ms, cancelled: false };
    this.scheduled.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    const timer = handle as Timer;
    timer.cancelled = true;
    const index = this.scheduled.indexOf(timer);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  run(): void {
    for (const timer of this.scheduled.splice(0)) {
      if (!timer.cancelled) timer.handler();
    }
  }

  get pending(): number {
    return this.scheduled.length;
  }
}

interface Recorded {
  readonly sends: Array<{ id: string; data: string; bytes: number }>;
  readonly records: Array<{ id: string; data: string }>;
  readonly paused: Array<{ id: string; paused: boolean }>;
  readonly caps: Array<{ id: string; bufferedBytes: number }>;
}

function harness(options: {
  flowControl?: boolean;
  batchMs?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  hardCapBytes?: number;
  id?: string;
} = {}): { batcher: TerminalOutputBatcher; timers: ManualTimers; recorded: Recorded } {
  const recorded: Recorded = { sends: [], records: [], paused: [], caps: [] };
  const sink: TerminalBatchSink = {
    send: (id, data, bytes) => recorded.sends.push({ id, data, bytes }),
    record: (id, data) => recorded.records.push({ id, data }),
    pauseSource: (id, paused) => recorded.paused.push({ id, paused }),
    capReached: (id, bufferedBytes) => recorded.caps.push({ id, bufferedBytes }),
  };
  const timers = new ManualTimers();
  const batcher = new TerminalOutputBatcher({
    sink,
    timers,
    ...(options.batchMs === undefined ? {} : { batchMs: options.batchMs }),
    ...(options.highWaterBytes === undefined ? {} : { highWaterBytes: options.highWaterBytes }),
    ...(options.lowWaterBytes === undefined ? {} : { lowWaterBytes: options.lowWaterBytes }),
    ...(options.hardCapBytes === undefined ? {} : { hardCapBytes: options.hardCapBytes }),
  });
  batcher.open(options.id ?? "term-1", { flowControl: options.flowControl === true });
  return { batcher, timers, recorded };
}

describe("terminal output batching", () => {
  test("chunks inside one window become a single message", () => {
    const { batcher, timers, recorded } = harness();
    batcher.push("term-1", "line 1\r\n");
    batcher.push("term-1", "line 2\r\n");
    batcher.push("term-1", "line 3\r\n");
    assert.deepEqual(recorded.sends, [], "nothing is sent before the window closes");
    assert.equal(timers.pending, 1, "one timer per window, not one per chunk");
    assert.equal(timers.scheduled[0]?.ms, TERMINAL_BATCH_MS);
    timers.run();
    assert.deepEqual(recorded.sends, [
      { id: "term-1", data: "line 1\r\nline 2\r\nline 3\r\n", bytes: 24 },
    ]);
    assert.equal(timers.pending, 0, "no timer left behind");
  });

  test("a burst that spans several windows is coalesced per window", () => {
    const { batcher, timers, recorded } = harness();
    batcher.push("term-1", "a");
    timers.run();
    batcher.push("term-1", "b");
    timers.run();
    assert.deepEqual(recorded.sends.map((send) => send.data), ["a", "b"]);
  });

  test("nothing is scheduled while idle (no background spin)", () => {
    const { timers } = harness();
    assert.equal(timers.pending, 0);
  });

  test("recording sees the same batches as the renderer", () => {
    const { batcher, timers, recorded } = harness();
    batcher.push("term-1", "one");
    batcher.push("term-1", "two");
    timers.run();
    assert.deepEqual(recorded.records, [{ id: "term-1", data: "onetwo" }]);
    assert.deepEqual(recorded.sends.map((send) => send.data), ["onetwo"]);
  });

  test("recorded output is the same byte stream the bare chunks would produce", () => {
    const { batcher, timers, recorded } = harness();
    const chunks = ["a", "€", "\r\n", "b", "世界"];
    for (const chunk of chunks) batcher.push("term-1", chunk);
    timers.run();
    batcher.push("term-1", "tail");
    timers.run();
    // Frame boundaries moved; the concatenated output did not.
    const recordedText = recorded.records.map((entry) => entry.data).join("");
    assert.equal(recordedText, [...chunks, "tail"].join(""));
    assert.equal(recorded.sends.reduce((sum, send) => sum + send.bytes, 0), Buffer.byteLength(recordedText, "utf8"));
  });

  test("sessions are batched independently", () => {
    const { batcher, timers, recorded } = harness();
    batcher.open("term-2");
    batcher.push("term-1", "first");
    batcher.push("term-2", "second");
    timers.run();
    assert.deepEqual(recorded.sends.map((send) => [send.id, send.data]), [
      ["term-1", "first"],
      ["term-2", "second"],
    ]);
  });
});

describe("terminal output batching: byte safety", () => {
  test("a UTF-8 code point split across chunks is reassembled", () => {
    const { batcher, timers, recorded } = harness();
    const euro = Buffer.from("€", "utf8"); // e2 82 ac
    assert.deepEqual([...euro], [0xe2, 0x82, 0xac]);
    batcher.push("term-1", euro.subarray(0, 1));
    timers.run();
    assert.equal(recorded.sends.length, 0, "half a code point is held, not mangled");
    batcher.push("term-1", euro.subarray(1, 2));
    timers.run();
    assert.equal(recorded.sends.length, 0, "still incomplete");
    batcher.push("term-1", euro.subarray(2));
    timers.run();
    assert.deepEqual(recorded.sends, [{ id: "term-1", data: "€", bytes: 3 }]);
    assert.equal(recorded.sends[0]?.data.includes("\uFFFD"), false, "no replacement characters");
  });

  test("text around a split code point survives unchanged", () => {
    const { batcher, timers, recorded } = harness();
    const bytes = Buffer.from("a€b", "utf8");
    batcher.push("term-1", bytes.subarray(0, 2)); // 'a' + first byte of €
    batcher.push("term-1", bytes.subarray(2, 3)); // second byte of €
    batcher.push("term-1", bytes.subarray(3)); // last byte of € + 'b'
    timers.run();
    assert.equal(recorded.sends.map((send) => send.data).join(""), "a€b");
    assert.equal(recorded.sends.reduce((sum, send) => sum + send.bytes, 0), bytes.length);
  });

  test("closing with a dangling partial code point delivers a replacement, not silence", () => {
    const { batcher, recorded } = harness();
    batcher.push("term-1", Buffer.from("€", "utf8").subarray(0, 1));
    batcher.close("term-1");
    assert.equal(recorded.sends.length, 1);
    assert.equal(recorded.sends[0]?.data, "\uFFFD", "the tail is surfaced instead of dropped");
  });
});

describe("terminal output batching: bounded buffer", () => {
  test("the hard cap forces a flush and keeps every byte", () => {
    const { batcher, timers, recorded } = harness({ hardCapBytes: 8 });
    batcher.push("term-1", "12345");
    assert.equal(recorded.sends.length, 0);
    batcher.push("term-1", "67890");
    assert.equal(recorded.caps.length, 1, "cap hit is diagnosable");
    assert.equal(recorded.sends.length, 1, "flushed immediately instead of buffering more");
    assert.equal(recorded.sends[0]?.data, "1234567890");
    assert.equal(batcher.stats("term-1")?.bufferedBytes, 0);
    assert.equal(timers.pending, 0, "the window timer was replaced by the immediate flush");
  });

  test("hitting the cap pauses the source and an ACK resumes it", () => {
    const { batcher, timers, recorded } = harness({
      flowControl: true,
      hardCapBytes: 8,
      highWaterBytes: 4,
      lowWaterBytes: 2,
    });
    batcher.push("term-1", "12345");
    batcher.push("term-1", "67890"); // 10 bytes: cap reached before the window closed
    assert.deepEqual(recorded.caps, [{ id: "term-1", bufferedBytes: 10 }]);
    assert.deepEqual(recorded.paused, [{ id: "term-1", paused: true }]);
    assert.equal(batcher.stats("term-1")?.bufferedBytes, 0, "flushed, not accumulated");
    batcher.acknowledge("term-1", 10);
    assert.deepEqual(recorded.paused, [
      { id: "term-1", paused: true },
      { id: "term-1", paused: false },
    ]);
    assert.equal(timers.pending, 0);
  });

  test("the default cap is 2 MiB per session", () => {
    const { batcher, recorded } = harness();
    const chunk = "x".repeat(64 * 1024);
    for (let index = 0; index < 32; index += 1) batcher.push("term-1", chunk);
    assert.ok(recorded.sends.length >= 1, "the cap flushes rather than dropping");
    assert.equal(TERMINAL_BUFFER_HARD_CAP_BYTES, 2 * 1024 * 1024);
    const delivered = recorded.sends.reduce((sum, send) => sum + send.bytes, 0);
    assert.equal(delivered, 32 * chunk.length, "every byte reached the sink");
  });
});

describe("terminal flow control", () => {
  test("pauses the source at the high watermark and resumes at the low one", () => {
    const { batcher, timers, recorded } = harness({ flowControl: true, highWaterBytes: 10, lowWaterBytes: 4 });
    batcher.push("term-1", "0123456789ab");
    timers.run();
    assert.deepEqual(recorded.paused, [{ id: "term-1", paused: true }]);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 12);
    assert.equal(batcher.stats("term-1")?.paused, true);

    // Partial credit below the high watermark but above the low one: stay paused.
    batcher.acknowledge("term-1", 4);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 8);
    assert.deepEqual(recorded.paused, [{ id: "term-1", paused: true }]);

    // Dropping to the low watermark resumes exactly once.
    batcher.acknowledge("term-1", 4);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 4);
    assert.deepEqual(recorded.paused, [
      { id: "term-1", paused: true },
      { id: "term-1", paused: false },
    ]);
  });

  test("ACKs are clamped to what is outstanding", () => {
    const { batcher, timers } = harness({ flowControl: true, highWaterBytes: 10, lowWaterBytes: 4 });
    batcher.push("term-1", "0123456789ab");
    timers.run();
    batcher.acknowledge("term-1", 1_000_000);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 0);
    batcher.acknowledge("term-1", -5);
    batcher.acknowledge("term-1", Number.NaN);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 0, "a bogus credit cannot go negative");
  });

  test("without the ACK handshake the batcher never pauses the source", () => {
    const { batcher, timers, recorded } = harness({ highWaterBytes: 4, lowWaterBytes: 2 });
    batcher.push("term-1", "0123456789");
    timers.run();
    batcher.push("term-1", "0123456789");
    timers.run();
    assert.deepEqual(recorded.paused, [], "old renderer: batched, never throttled");
    assert.equal(batcher.stats("term-1")?.flowControl, false);
    assert.equal(batcher.stats("term-1")?.unackedBytes, 0, "no ACK accounting without the handshake");
  });

  test("a paused session still flushes (no data is withheld while waiting for an ACK)", () => {
    const { batcher, timers, recorded } = harness({ flowControl: true, highWaterBytes: 4, lowWaterBytes: 2 });
    batcher.push("term-1", "aaaa");
    timers.run();
    assert.deepEqual(recorded.paused, [{ id: "term-1", paused: true }]);
    // The source may still hand over a chunk already in flight.
    batcher.push("term-1", "bb");
    timers.run();
    assert.equal(recorded.sends.map((send) => send.data).join(""), "aaaabb");
  });
});

describe("terminal flow control: lifecycle", () => {
  test("close flushes the buffered tail before releasing the session", () => {
    const { batcher, timers, recorded } = harness();
    batcher.push("term-1", "last line");
    batcher.close("term-1");
    assert.deepEqual(recorded.sends, [{ id: "term-1", data: "last line", bytes: 9 }]);
    assert.equal(timers.pending, 0, "the window timer is cancelled");
    assert.equal(batcher.stats("term-1"), undefined);
    assert.equal(batcher.openSessions, 0);
  });

  test("closing a paused session releases the source", () => {
    const { batcher, timers, recorded } = harness({ flowControl: true, highWaterBytes: 4, lowWaterBytes: 2 });
    batcher.push("term-1", "aaaa");
    timers.run();
    batcher.close("term-1");
    assert.deepEqual(recorded.paused.at(-1), { id: "term-1", paused: false });
  });

  test("push after close is ignored instead of resurrecting the session", () => {
    const { batcher, recorded } = harness();
    batcher.close("term-1");
    batcher.push("term-1", "ghost");
    assert.deepEqual(recorded.sends, []);
    assert.equal(batcher.openSessions, 0);
  });

  test("closeAll releases every session and flushes each tail", () => {
    const { batcher, recorded } = harness();
    batcher.open("term-2");
    batcher.push("term-1", "one");
    batcher.push("term-2", "two");
    batcher.closeAll();
    assert.deepEqual(recorded.sends.map((send) => send.data).sort(), ["one", "two"]);
    assert.equal(batcher.openSessions, 0);
  });

  test("flush() delivers a specific session or everything on demand", () => {
    const { batcher, recorded } = harness();
    batcher.open("term-2");
    batcher.push("term-1", "one");
    batcher.push("term-2", "two");
    batcher.flush("term-1");
    assert.deepEqual(recorded.sends.map((send) => send.data), ["one"]);
    batcher.flush();
    assert.deepEqual(recorded.sends.map((send) => send.data), ["one", "two"]);
  });

  test("a misconfigured watermark pair is rejected at construction", () => {
    assert.throws(
      () => new TerminalOutputBatcher({ sink: { send: () => {} }, highWaterBytes: 10, lowWaterBytes: 20 }),
      /low watermark/u,
    );
    assert.ok(TERMINAL_FLOW_HIGH_BYTES > TERMINAL_FLOW_LOW_BYTES);
  });
});
