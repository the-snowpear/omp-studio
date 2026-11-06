import { test } from "node:test";
import assert from "node:assert/strict";
import { createOmpStudioChromeApi, type IpcRendererLike } from "../src/chrome-api.js";
import { DICTATION_AUDIO_CHANNELS, type DictationDesktopEvent, type DictationAudioAttach } from "../src/dictation-audio-shared.js";

test("dictation preload methods preserve Main faults, use fixed private channels, and unsubscribe exactly", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const result = { ok: false, code: "runtime-disconnected", message: "Retry retained audio explicitly." };
  const ipc: IpcRendererLike = {
    async invoke(channel, ...args) { calls.push({ channel, args }); return result; },
    on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(listener); },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
  };
  const api = createOmpStudioChromeApi(ipc);
  const audioId = "audio", attach = { channel: { audioId }, owner: { sessionId: "session", draftId: "draft" } } as DictationAudioAttach;
  const control = { audioId, input: { kind: "cancel" as const } };
  const chunk = { audioId, sequence: 0, bytes: new Float32Array([1]).buffer };
  assert.equal(await api.attachDictationAudio(attach), result);
  assert.equal(await api.controlDictationAudio(control), result);
  assert.equal(await api.appendDictationAudio(chunk), result);
  assert.equal(await api.drainDictationAudio({ audioId }), result);
  assert.equal(await api.getDictationRecovery(), result);
  assert.equal(await api.replayDictationAudio({ audioId }), result);
  assert.equal(await api.retainDictationAudio({ audioId }), result);
  assert.equal(await api.releaseDictationAudio({ audioId }), result);
  assert.deepEqual(calls, [
    { channel: DICTATION_AUDIO_CHANNELS.attach, args: [attach] },
    { channel: DICTATION_AUDIO_CHANNELS.input, args: [control] },
    { channel: DICTATION_AUDIO_CHANNELS.chunk, args: [chunk] },
    { channel: DICTATION_AUDIO_CHANNELS.drain, args: [{ audioId }] },
    { channel: DICTATION_AUDIO_CHANNELS.recovery, args: [] },
    { channel: DICTATION_AUDIO_CHANNELS.replay, args: [{ audioId }] },
    { channel: DICTATION_AUDIO_CHANNELS.retain, args: [{ audioId }] },
    { channel: DICTATION_AUDIO_CHANNELS.release, args: [{ audioId }] },
  ]);
  assert.ok(Object.isFrozen(api)); assert.equal("invoke" in api, false);
  const a: DictationDesktopEvent[] = [], b: DictationDesktopEvent[] = [];
  const off = api.onDictationAudio(event => a.push(event));
  api.onDictationAudio(event => b.push(event));
  const event: DictationDesktopEvent = { kind: "released", audioId };
  for (const listener of listeners.get(DICTATION_AUDIO_CHANNELS.event)!) listener({ sender: "not exposed" }, event);
  off();
  for (const listener of listeners.get(DICTATION_AUDIO_CHANNELS.event)!) listener({}, event);
  assert.deepEqual(a, [event]); assert.deepEqual(b, [event, event]);
});
