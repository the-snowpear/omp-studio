import assert from "node:assert/strict";
import { test } from "node:test";
import { FAVICON_DATA_LIMIT, FAVICON_FETCH_LIMIT, faviconDataUrl, loadFavicon } from "../src/managed-browser-favicon.js";

const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const response = (body: Uint8Array, headers: Record<string, string> = {}) => new Response(body, { headers });

test("tab icons accept small images and drop pages, oversized files and failed requests", async () => {
  assert.match(faviconDataUrl(svg) ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(faviconDataUrl(png, () => new Uint8Array([9, 9])), "data:image/png;base64,CQk=");
  assert.equal(faviconDataUrl(new TextEncoder().encode("<!doctype html><title>Not found</title>")), undefined);
  assert.equal(faviconDataUrl(new Uint8Array([0, 0, 1, 0, ...new Uint8Array(FAVICON_DATA_LIMIT)])), undefined);

  const signal = new AbortController().signal;
  assert.deepEqual(await loadFavicon("https://example.com/icon.svg", async () => response(svg), signal), svg);
  assert.equal(await loadFavicon("https://example.com/huge.ico", async () => response(new Uint8Array(8), { "content-length": String(FAVICON_FETCH_LIMIT + 1) }), signal), undefined);
  assert.equal(await loadFavicon("https://example.com/missing.ico", async () => new Response("", { status: 404 }), signal), undefined);
  assert.deepEqual(await loadFavicon(`data:image/svg+xml,${encodeURIComponent(new TextDecoder().decode(svg))}`, async () => { throw new Error("data URLs need no request"); }, signal), svg);
});
