import { computeHighlight, computeHighlightBatch } from "./compute";
import { validHighlightRequest, type HighlightResponse } from "./protocol";

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!validHighlightRequest(event.data)) return;
  const { jobId, language, code, batch } = event.data;
  let response: HighlightResponse;
  try {
    const tokens = batch === true ? computeHighlightBatch(language, code) : computeHighlight(language, code);
    response = { version: 1, jobId, ok: true, tokens };
  } catch {
    response = { version: 1, jobId, ok: false, reason: "unsupported-or-budget" };
  }
  self.postMessage(response);
};
