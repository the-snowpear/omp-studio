import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaInputArtifacts, validateMediaOperation, validateMediaRequest, validateMediaResult } from "../src/contracts/media.js";
const id = "11111111-1111-4111-8111-111111111111";
test("media requests bound paid fanout and carry opaque artifacts only", () => {
  validateMediaRequest({ type: "image", prompt: "image", count: 4, inputArtifacts: [id] });
  for (const request of [
    { type: "image", prompt: "image", count: 5 },
    { type: "video", prompt: "video" },
    { type: "transcription", audioArtifact: "C:/private/audio.wav" },
    { type: "speech", text: "hello", format: "wav", token: "secret" },
    { type: "video", model: "mock/video", providerOptions: JSON.parse('{"__proto__":{"token":"secret"}}') },
  ]) assert.throws(() => validateMediaRequest(request));
  assert.deepEqual(mediaInputArtifacts({ type: "video", model: "mock/video", firstFrame: id, lastFrame: id, references: [{ type: "image", artifactId: id }] }), [id]);
  assert.throws(() => validateMediaOperation({ kind: "media.resume", sessionId: "s" }));
  assert.throws(() => validateMediaResult("media.list", { available: true, jobs: [], endpoint: "private" }));
});
