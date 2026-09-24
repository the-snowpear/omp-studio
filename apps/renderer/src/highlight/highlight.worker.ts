import { computeHighlight } from "./compute";
import { validHighlightRequest, type HighlightResponse } from "./protocol";

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!validHighlightRequest(event.data)) return;
  const { jobId, language, code } = event.data;
  let response: HighlightResponse;
  try { response = { version: 1, jobId, ok: true, tokens: computeHighlight(language, code) }; }
  catch { response = { version: 1, jobId, ok: false, reason: "unsupported-or-budget" }; }
  self.postMessage(response);
};
