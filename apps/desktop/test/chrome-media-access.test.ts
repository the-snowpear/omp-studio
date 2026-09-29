import assert from "node:assert/strict";
import { test } from "node:test";

import { MICROPHONE_SETTINGS_URL, microphoneAccess, registerMediaAccessIpc, type MediaAccessPreferences } from "../src/chrome-media-access.js";
import { CHROME_MEDIA_ACCESS_CHANNELS } from "../src/chrome-media-access-shared.js";

function preferences(status: ReturnType<MediaAccessPreferences["getMediaAccessStatus"]>, answer = true) {
  const asked: string[] = [];
  return {
    asked,
    value: {
      getMediaAccessStatus: () => status,
      askForMediaAccess: async (type: "microphone") => { asked.push(type); return answer; },
    } satisfies MediaAccessPreferences,
  };
}

test("macOS asks while undetermined and reports a denial that only System Settings can lift", async () => {
  const undetermined = preferences("not-determined", true);
  assert.equal(await microphoneAccess("darwin", undetermined.value), "granted");
  assert.deepEqual(undetermined.asked, ["microphone"]);
  assert.equal(await microphoneAccess("darwin", preferences("not-determined", false).value), "denied");
  const granted = preferences("granted");
  assert.equal(await microphoneAccess("darwin", granted.value), "granted");
  assert.deepEqual(granted.asked, []);
  const denied = preferences("denied");
  assert.equal(await microphoneAccess("darwin", denied.value), "denied");
  assert.deepEqual(denied.asked, [], "a denied app gets no second system prompt");
  assert.equal(await microphoneAccess("darwin", preferences("restricted").value), "denied");
});

test("Windows leaves the microphone to Chromium", async () => {
  const windows = preferences("denied");
  assert.equal(await microphoneAccess("win32", windows.value), "granted");
  assert.deepEqual(windows.asked, []);
});

test("the IPC serves the trusted renderer only and opens a fixed settings URL", async () => {
  const handlers = new Map<string, (event: { sender: { isDestroyed(): boolean; getURL(): string } }) => unknown>();
  const opened: string[] = [];
  const trusted = { isDestroyed: () => false, getURL: () => "file:///app/index.html" };
  const foreign = { isDestroyed: () => false, getURL: () => "https://evil.example/" };
  const registration = registerMediaAccessIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener), removeHandler: (channel) => handlers.delete(channel) },
    isTrustedSender: (sender) => sender === trusted,
    platform: "darwin",
    preferences: preferences("denied").value,
    openExternal: async (url) => { opened.push(url); },
  });
  assert.equal(await handlers.get(CHROME_MEDIA_ACCESS_CHANNELS.microphone)?.({ sender: trusted }), "denied");
  await assert.rejects(async () => await handlers.get(CHROME_MEDIA_ACCESS_CHANNELS.microphone)?.({ sender: foreign }), /Untrusted/u);
  assert.equal(await handlers.get(CHROME_MEDIA_ACCESS_CHANNELS.openMicrophoneSettings)?.({ sender: trusted }), true);
  assert.deepEqual(opened, [MICROPHONE_SETTINGS_URL]);
  registration.dispose();
  assert.equal(handlers.size, 0);
});
