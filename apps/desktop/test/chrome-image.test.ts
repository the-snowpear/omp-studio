/**
 * Desktop-chrome image copy / save IPC tests.
 *
 * Headless: fake ipcMain + injected clipboard / dialog / writeFile. No Electron.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHROME_IMAGE_CHANNELS,
  parseChromeImageInput,
  sanitizeSuggestedName,
} from "../src/chrome-image-shared.js";
import {
  registerChromeImageIpc,
  type ChromeImageIpcMain,
  type ChromeImageSender,
} from "../src/chrome-image.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

interface FakeSender extends ChromeImageSender {
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

interface FakeIpc extends ChromeImageIpcMain {
  readonly handlers: Map<string, (event: { sender: ChromeImageSender }, payload?: unknown) => unknown>;
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

function register(actions: {
  copyImageToClipboard?: (bytes: Uint8Array) => boolean;
  showSaveDialog?: () => Promise<{ canceled: boolean; filePath?: string }>;
  writeFile?: (filePath: string, bytes: Uint8Array) => Promise<void>;
  isTrustedSender?: (sender: ChromeImageSender) => boolean;
}) {
  const ipc = makeIpc();
  const copied: Uint8Array[] = [];
  const written: Array<{ filePath: string; bytes: Uint8Array }> = [];
  const handle = registerChromeImageIpc({
    ipcMain: ipc,
    isTrustedSender: actions.isTrustedSender ?? ((sender) => !(sender as FakeSender).destroyed && (sender as FakeSender).trusted !== false),
    actions: {
      copyImageToClipboard: actions.copyImageToClipboard ?? ((bytes) => {
        copied.push(bytes);
        return true;
      }),
      showSaveDialog: actions.showSaveDialog ?? (async () => ({ canceled: true })),
      writeFile: actions.writeFile ?? (async (filePath, bytes) => {
        written.push({ filePath, bytes });
      }),
    },
  });
  return { ipc, copied, written, handle };
}

describe("parseChromeImageInput", () => {
  test("accepts a png buffer with a valid signature", () => {
    const parsed = parseChromeImageInput({ mime: "image/png", bytes: PNG, suggestedName: "图1" });
    assert.ok(parsed);
    assert.equal(parsed.mime, "image/png");
    assert.equal(parsed.suggestedName, "图1.png");
    assert.equal(parsed.bytes.byteLength, PNG.byteLength);
  });

  test("rejects a bad mime, tiny payload, and mismatched magic", () => {
    assert.equal(parseChromeImageInput({ mime: "image/svg+xml", bytes: PNG }), undefined);
    assert.equal(parseChromeImageInput({ mime: "image/png", bytes: PNG.slice(0, 8) }), undefined);
    assert.equal(parseChromeImageInput({ mime: "image/png", bytes: JPEG }), undefined);
  });

  test("accepts a payload over 8MB", () => {
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    huge.set(PNG.subarray(0, 8));
    const parsed = parseChromeImageInput({ mime: "image/png", bytes: huge, suggestedName: "图1" });
    assert.ok(parsed);
    assert.equal(parsed.bytes.byteLength, 8 * 1024 * 1024 + 1);
  });
});

describe("sanitizeSuggestedName", () => {
  test("keeps a leaf name, strips directories, and pins the mime extension", () => {
    assert.equal(sanitizeSuggestedName("图1", "image/png"), "图1.png");
    assert.equal(sanitizeSuggestedName("..\\..\\secret.png", "image/jpeg"), "secret.jpg");
    assert.equal(sanitizeSuggestedName("", "image/webp"), "image.webp");
  });
});

describe("registerChromeImageIpc", () => {
  test("copy writes the injected clipboard and save cancelled does not write", async () => {
    const { ipc, copied, written } = register({});
    const sender = makeSender();
    const copy = ipc.handlers.get(CHROME_IMAGE_CHANNELS.copyImage);
    const save = ipc.handlers.get(CHROME_IMAGE_CHANNELS.saveImage);
    assert.ok(copy);
    assert.ok(save);

    const copiedResult = await copy({ sender }, { mime: "image/png", bytes: PNG });
    assert.deepEqual(copiedResult, { ok: true });
    assert.equal(copied.length, 1);
    assert.equal(copied[0]?.byteLength, PNG.byteLength);

    const cancelled = await save({ sender }, { mime: "image/png", bytes: PNG, suggestedName: "图1" });
    assert.deepEqual(cancelled, { ok: false, cancelled: true });
    assert.equal(written.length, 0);
  });

  test("save writes the chosen path and does not return it", async () => {
    const { ipc, written } = register({
      showSaveDialog: async () => ({ canceled: false, filePath: "C:/tmp/shot.png" }),
    });
    const save = ipc.handlers.get(CHROME_IMAGE_CHANNELS.saveImage);
    assert.ok(save);
    const result = await save({ sender: makeSender() }, { mime: "image/png", bytes: PNG, suggestedName: "图1" });
    assert.deepEqual(result, { ok: true });
    assert.equal(written.length, 1);
    assert.equal(written[0]?.filePath, "C:/tmp/shot.png");
    assert.equal(written[0]?.bytes.byteLength, PNG.byteLength);
    assert.equal(JSON.stringify(result).includes("C:/tmp"), false);
  });

  test("rejects an untrusted sender and an invalid payload", async () => {
    const { ipc, copied } = register({
      isTrustedSender: () => false,
    });
    const copy = ipc.handlers.get(CHROME_IMAGE_CHANNELS.copyImage);
    assert.ok(copy);
    const denied = await copy({ sender: makeSender(false) }, { mime: "image/png", bytes: PNG });
    assert.deepEqual(denied, { ok: false, message: "不受信任的调用方。" });
    assert.equal(copied.length, 0);

    const trusted = register({});
    const trustedCopy = trusted.ipc.handlers.get(CHROME_IMAGE_CHANNELS.copyImage);
    assert.ok(trustedCopy);
    const invalid = await trustedCopy({ sender: makeSender() }, { mime: "image/png", bytes: JPEG });
    assert.deepEqual(invalid, { ok: false, message: "图片数据无效。" });
  });
});
