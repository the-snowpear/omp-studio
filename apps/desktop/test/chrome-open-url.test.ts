/**
 * Desktop-chrome openUrl IPC tests.
 *
 * Headless: fake ipcMain + injected openExternal. No Electron.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CHROME_OPEN_URL_CHANNEL, parseChromeOpenUrlInput } from "../src/chrome-open-url-shared.js";
import {
  registerChromeOpenUrlIpc,
  type ChromeOpenUrlIpcMain,
  type ChromeOpenUrlSender,
} from "../src/chrome-open-url.js";

interface FakeSender extends ChromeOpenUrlSender {
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

interface FakeIpc extends ChromeOpenUrlIpcMain {
  readonly handlers: Map<string, (event: { sender: ChromeOpenUrlSender }, payload?: unknown) => unknown>;
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

describe("parseChromeOpenUrlInput", () => {
  test("accepts a canonical https URL", () => {
    const parsed = parseChromeOpenUrlInput({ url: "https://github.com/the-snowpear/omp-studio" });
    assert.deepEqual(parsed, { url: "https://github.com/the-snowpear/omp-studio" });
  });

  test("rejects non-https schemes, credentials, control characters, and junk", () => {
    const rejected = [
      { url: "http://github.com/the-snowpear/omp-studio" },
      { url: "file:///C:/Windows/notepad.exe" },
      { url: "javascript:alert(1)" },
      { url: "data:text/html,hi" },
      { url: "https://user:pass@github.com/the-snowpear/omp-studio" },
      { url: "https://github.com/the-snowpear/omp-studio\n--upload-pack=evil" },
      { url: "ftp://example.com" },
      { url: "//github.com/the-snowpear/omp-studio" },
      { url: "" },
      { url: "not a url" },
      "https://github.com/the-snowpear/omp-studio",
      { href: "https://github.com/the-snowpear/omp-studio" },
    ];
    for (const value of rejected) {
      assert.equal(parseChromeOpenUrlInput(value), undefined);
    }
  });
});

describe("registerChromeOpenUrlIpc", () => {
  test("opens a trusted https URL through the injected handler", async () => {
    const ipc = makeIpc();
    const opened: string[] = [];
    const handle = registerChromeOpenUrlIpc({
      ipcMain: ipc,
      isTrustedSender: (sender) => !(sender as FakeSender).destroyed && (sender as FakeSender).trusted !== false,
      openExternal: (url) => {
        opened.push(url);
      },
    });
    const listener = ipc.handlers.get(CHROME_OPEN_URL_CHANNEL);
    assert.ok(listener);
    await listener({ sender: makeSender() }, { url: "https://github.com/the-snowpear/omp-studio" });
    assert.deepEqual(opened, ["https://github.com/the-snowpear/omp-studio"]);
    handle.dispose();
    assert.equal(ipc.handlers.has(CHROME_OPEN_URL_CHANNEL), false);
  });

  test("does not open when the sender is untrusted or the URL is rejected", async () => {
    const ipc = makeIpc();
    const opened: string[] = [];
    registerChromeOpenUrlIpc({
      ipcMain: ipc,
      isTrustedSender: (sender) => (sender as FakeSender).trusted !== false,
      openExternal: (url) => {
        opened.push(url);
      },
    });
    const listener = ipc.handlers.get(CHROME_OPEN_URL_CHANNEL);
    assert.ok(listener);
    await listener({ sender: makeSender(false) }, { url: "https://github.com/the-snowpear/omp-studio" });
    await listener({ sender: makeSender() }, { url: "file:///C:/secret" });
    assert.deepEqual(opened, []);
  });
});
