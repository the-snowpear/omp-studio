import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalBrowserAddress, normalizeBrowserAddress } from "../src/managed-browser-address.js";

test("local development addresses default to HTTP and public sites to HTTPS", () => {
  assert.equal(normalizeBrowserAddress("localhost:5173/page"), "http://localhost:5173/page");
  assert.equal(normalizeBrowserAddress("app.localhost:3000"), "http://app.localhost:3000/");
  assert.equal(normalizeBrowserAddress("[::1]:8080"), "http://[::1]:8080/");
  assert.equal(normalizeBrowserAddress("0.0.0.0:5173"), "http://127.0.0.1:5173/");
  assert.equal(normalizeBrowserAddress("192.168.1.2:3000"), "http://192.168.1.2:3000/");
  assert.equal(normalizeBrowserAddress("example.com/docs"), "https://example.com/docs");
  assert.equal(isLocalBrowserAddress("https://127.evil.example"), false);
  assert.equal(isLocalBrowserAddress("http://192.168.evil.example:3000"), false);
});
