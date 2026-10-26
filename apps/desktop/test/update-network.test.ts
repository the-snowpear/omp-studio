import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateSigningBytes, type SignedUpdateManifest, type UpdateManifest } from "@omp-studio/runtime-installer";
import { discoverUpdates } from "../src/update-discovery.js";
import { withUpdateRequest } from "../src/update-request.js";

const pair = generateKeyPairSync("ed25519");
const keys = { test: pair.publicKey.export({ type: "spki", format: "pem" }) };
const manifestUrl = "https://github.com/owner/repo/releases/download/v2/updates-win32-x64.json";
const mirror = "https://mirror.example/";
const requestPolicy = { retryDelaysMs: [0, 0] as const };
function signed(version = "2.0.0", sequence = 2): SignedUpdateManifest {
  const bytes = Buffer.from("update");
  const file = (asset: string) => ({ asset, url: `https://github.com/owner/repo/releases/download/v2/${asset}`, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") });
  const component = { version, sequence, channel: "stable" as const, file: file("setup.exe"), blockmap: file("setup.exe.blockmap"), minAppVersion: "1.0.0", studioProtocol: { min: 1, max: 1 } };
  const manifest: UpdateManifest = { schema: 2, repo: "owner/repo", platform: "win32-x64", generatedAt: "2026-10-25T00:00:00Z",
    releaseNotesUrl: "https://github.com/owner/repo/releases/tag/v2", app: component };
  return { manifest, signature: { algorithm: "ed25519", keyId: "test", value: sign(null, updateSigningBytes(manifest), pair.privateKey).toString("base64url") } };
}
function rows(id = 1, stamp = "2026-10-25T00:00:00Z") {
  return [{ assets: [{ id, updated_at: stamp, name: "updates-win32-x64.json", browser_download_url: manifestUrl }] }];
}
function options(fetcher: typeof fetch) {
  return { repo: "owner/repo", platform: "win32-x64", channel: "stable" as const, mirror, keys,
    signal: new AbortController().signal, watermarks: {}, fetcher, requestPolicy };
}

test("mirror API 403 falls back to the official catalog and still discovers a verified update", async () => {
  const requests: string[] = [];
  const result = await discoverUpdates(options(async url => {
    const value = String(url); requests.push(value);
    if (value.includes("api.github.com")) return value.startsWith(mirror) ? new Response(null, { status: 403 }) : Response.json(rows());
    return Response.json(signed());
  }));
  assert.equal(result.app?.manifest.app?.version, "2.0.0");
  assert.ok(requests[0]?.startsWith(mirror));
  assert.ok(requests[1]?.startsWith("https://api.github.com/"));
  assert.equal(requests.length, 3);
});

test("failed manifest transport reports a failed check rather than an empty update catalog", async () => {
  const requests: string[] = [];
  await assert.rejects(discoverUpdates(options(async url => {
    const value = String(url); requests.push(value);
    return value.includes("api.github.com") ? Response.json(rows()) : new Response(null, { status: 403 });
  })), /HTTP 403/);
  assert.deepEqual(requests.slice(1), [mirror + manifestUrl, manifestUrl]);
});

test("an HTTP 200 mirror error page or invalid signature falls back to the verified official manifest", async () => {
  for (const invalid of ["<html>mirror unavailable</html>", JSON.stringify({ ...signed(), signature: { algorithm: "ed25519", keyId: "test", value: "invalid" } })]) {
    const requests: string[] = [];
    const result = await discoverUpdates(options(async url => {
      const value = String(url); requests.push(value);
      if (value.includes("api.github.com")) return Response.json(rows());
      return value.startsWith(mirror) ? new Response(invalid) : Response.json(signed());
    }));
    assert.equal(result.app?.manifest.app?.version, "2.0.0");
    assert.deepEqual(requests.slice(1), [mirror + manifestUrl, manifestUrl]);
  }
});

test("discovery reuses ETag and verified manifests, then refetches a replaced release asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-update-discovery-cache-"));
  let replaced = false, catalogRequests = 0, manifestRequests = 0;
  const headers: Array<string | null> = [];
  const input = { ...options(async (url, init) => {
    if (String(url).includes("api.github.com")) {
      catalogRequests++;
      headers.push(new Headers(init?.headers).get("if-none-match"));
      if (catalogRequests === 2) return new Response(null, { status: 304 });
      return Response.json(replaced ? rows(2, "2026-10-25T01:00:00Z") : rows(), { headers: { ETag: replaced ? '"catalog-2"' : '"catalog-1"' } });
    }
    manifestRequests++;
    return Response.json(replaced ? signed("2.1.0", 3) : signed());
  }), cacheDirectory: root };
  try {
    await discoverUpdates(input);
    const second = await discoverUpdates(input);
    assert.equal(second.app?.manifest.app?.version, "2.0.0");
    assert.equal(manifestRequests, 1);
    assert.equal(headers[1], '"catalog-1"');
    replaced = true;
    const third = await discoverUpdates(input);
    assert.equal(third.app?.manifest.app?.version, "2.1.0");
    assert.equal(manifestRequests, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary official 403 and a long rate-limit wait stop without repeated requests", async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 429, headers: { "Retry-After": "120" } })]) {
    let requests = 0;
    await assert.rejects(withUpdateRequest({ url: manifestUrl, signal: new AbortController().signal, stage: "manifest", requestPolicy,
      fetcher: async () => { requests++; return response; } }, async attempt => attempt.request()), /HTTP (403|429)/);
    assert.equal(requests, 1);
  }
});

test("transient failures retry but a request never exceeds three attempts", async () => {
  for (const succeeds of [true, false]) {
    let requests = 0;
    const request = withUpdateRequest({ url: manifestUrl, signal: new AbortController().signal, stage: "manifest", requestPolicy,
      fetcher: async () => new Response(null, { status: ++requests === 2 && succeeds ? 200 : 503 }) }, async attempt => (await attempt.request()).status);
    if (succeeds) assert.equal(await request, 200);
    else await assert.rejects(request, /HTTP 503/);
    assert.equal(requests, succeeds ? 2 : 3);
  }
});

test("a request with no first response times out and cancellation prevents retry", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return new Promise(() => {}); };
  await assert.rejects(withUpdateRequest({ url: manifestUrl, signal: new AbortController().signal, stage: "manifest", fetcher,
    requestPolicy: { ...requestPolicy, responseTimeoutMs: 5 } }, attempt => attempt.request()), /首响应超时/);
  assert.equal(requests, 3);
  const controller = new AbortController();
  requests = 0;
  const request = withUpdateRequest({ url: manifestUrl, signal: controller.signal, stage: "manifest", fetcher }, attempt => attempt.request());
  setTimeout(() => controller.abort(new Error("user cancelled")), 5);
  await assert.rejects(request, /user cancelled/);
  assert.equal(requests, 1);
});
