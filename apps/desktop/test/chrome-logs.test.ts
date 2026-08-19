/**
 * Desktop-chrome Host log IPC tests.
 *
 * Headless: fake ipcMain + injected filesystem. No Electron.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHROME_LOGS_CHANNELS,
  composeHostLogExport,
  isHostLogBasename,
  parseChromeLogsPayload,
} from "../src/chrome-logs-shared.js";
import {
  registerChromeLogsIpc,
  type ChromeLogsIpcMain,
  type ChromeLogsSender,
} from "../src/chrome-logs.js";

interface FakeSender extends ChromeLogsSender {
  destroyed: boolean;
  trusted: boolean;
}

function makeSender(trusted = true): FakeSender {
  return {
    destroyed: false,
    trusted,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "http://127.0.0.1:5173/";
    },
  };
}

interface FakeIpc extends ChromeLogsIpcMain {
  readonly handlers: Map<string, (event: { sender: ChromeLogsSender }, payload?: unknown) => unknown>;
}

function makeIpc(): FakeIpc {
  return {
    handlers: new Map(),
    handle(channel, listener) {
      this.handlers.set(channel, listener);
    },
    removeHandler(channel) {
      this.handlers.delete(channel);
    },
  };
}

describe("chrome logs contract", () => {
  test("accepts only dated Host log basenames", () => {
    assert.equal(isHostLogBasename("host-2026-08-19.log"), true);
    assert.equal(isHostLogBasename("host-2026-08-19.txt"), false);
    assert.equal(isHostLogBasename("../host-2026-08-19.log"), false);
    assert.equal(isHostLogBasename("C:\\secrets\\host-2026-08-19.log"), false);
  });

  test("rejects non-empty payloads", () => {
    assert.equal(parseChromeLogsPayload({}), true);
    assert.equal(parseChromeLogsPayload(undefined), true);
    assert.equal(parseChromeLogsPayload({ path: "C:\\logs" }), false);
    assert.equal(parseChromeLogsPayload("open"), false);
  });

  test("composeHostLogExport uses basenames and keeps the newest tail", () => {
    const text = composeHostLogExport(
      [
        { name: "host-2026-08-18.log", text: "old-day\n" },
        { name: "not-a-log.txt", text: "secret-path\n" },
        { name: "host-2026-08-19.log", text: "new-day\n" },
      ],
      80,
    );
    assert.equal(text.includes("host-2026-08-18.log"), true);
    assert.equal(text.includes("host-2026-08-19.log"), true);
    assert.equal(text.includes("not-a-log.txt"), false);
    assert.equal(text.includes("secret-path"), false);
    const truncated = composeHostLogExport([{ name: "host-2026-08-19.log", text: "abcdefghij" }], 6);
    assert.equal(truncated.length, 6);
  });
});

describe("registerChromeLogsIpc", () => {
  test("opens the injected directory without returning a path", async () => {
    const ipc = makeIpc();
    let opened = 0;
    const handle = registerChromeLogsIpc({
      ipcMain: ipc,
      isTrustedSender: (sender) => (sender as FakeSender).trusted !== false,
      actions: {
        logsDirectory: "/hidden/logs",
        mkdirLogs: async () => undefined,
        openDirectory: async () => {
          opened += 1;
          return "";
        },
        listBasenames: async () => [],
        readFile: async () => "",
        showSaveDialog: async () => ({ canceled: true }),
        writeFile: async () => undefined,
      },
    });
    const listener = ipc.handlers.get(CHROME_LOGS_CHANNELS.openDir);
    assert.ok(listener);
    const result = await listener({ sender: makeSender() }, {});
    assert.deepEqual(result, { ok: true });
    assert.equal(opened, 1);
    handle.dispose();
    assert.equal(ipc.handlers.has(CHROME_LOGS_CHANNELS.openDir), false);
  });

  test("exports concatenated logs through the save dialog", async () => {
    const ipc = makeIpc();
    const written: string[] = [];
    registerChromeLogsIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      actions: {
        logsDirectory: "/hidden/logs",
        mkdirLogs: async () => undefined,
        openDirectory: async () => "",
        listBasenames: async () => ["host-2026-08-19.log", "notes.txt"],
        readFile: async (name) => `body-of-${name}`,
        showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/out.txt" }),
        writeFile: async (_path, text) => {
          written.push(text);
        },
      },
    });
    const listener = ipc.handlers.get(CHROME_LOGS_CHANNELS.exportLogs);
    assert.ok(listener);
    const result = await listener({ sender: makeSender() }, {});
    assert.deepEqual(result, { ok: true });
    assert.equal(written.length, 1);
    assert.equal(written[0]?.includes("host-2026-08-19.log"), true);
    assert.equal(written[0]?.includes("notes.txt"), false);
    assert.equal(JSON.stringify(result).includes("/hidden"), false);
  });

  test("does not open when the sender is untrusted", async () => {
    const ipc = makeIpc();
    let opened = 0;
    registerChromeLogsIpc({
      ipcMain: ipc,
      isTrustedSender: (sender) => (sender as FakeSender).trusted !== false,
      actions: {
        logsDirectory: "/hidden/logs",
        mkdirLogs: async () => undefined,
        openDirectory: async () => {
          opened += 1;
          return "";
        },
        listBasenames: async () => [],
        readFile: async () => "",
        showSaveDialog: async () => ({ canceled: true }),
        writeFile: async () => undefined,
      },
    });
    const listener = ipc.handlers.get(CHROME_LOGS_CHANNELS.openDir);
    assert.ok(listener);
    const result = await listener({ sender: makeSender(false) }, {});
    assert.equal((result as { ok?: boolean }).ok, false);
    assert.equal(opened, 0);
  });
});
