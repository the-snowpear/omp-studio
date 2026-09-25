import { parsePlaybackRecording } from "./format";
self.onmessage = (event: MessageEvent<{ text: string }>) => {
  try { self.postMessage({ recording: parsePlaybackRecording(event.data.text) }); }
  catch (cause) { self.postMessage({ error: cause instanceof Error ? cause.message : "Cannot parse recording" }); }
};
