import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphicAssetResponse } from "../src/graphic-protocol.js";

test("the isolated viewer loads bundled modules and WASM without exposing app data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-graphics-"));
  try {
    await mkdir(join(directory, "assets"));
    await mkdir(join(directory, "graphics-xite", "assets", "lib"), { recursive: true });
    await writeFile(join(directory, "graphic-preview.html"), "<html>viewer</html>");
    await writeFile(join(directory, "assets", "graphic-test.js"), "export const ready = true;");
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await writeFile(join(directory, "graphics-xite", "assets", "lib", "tangents.wasm"), wasm);
    await writeFile(join(directory, "private.json"), "secret");
    const get = (path: string) => graphicAssetResponse(new Request(`omp-graphics://viewer/${path}`), directory);
    const viewer = await get("graphic-preview.html");
    assert.equal(viewer.status, 200);
    assert.match(viewer.headers.get("content-type")!, /text\/html/u);
    assert.equal(viewer.headers.get("access-control-allow-origin"), "null");
    assert.equal(await (await get("assets/graphic-test.js")).text(), "export const ready = true;");
    const module = await get("graphics-xite/assets/lib/tangents.wasm");
    assert.equal(module.headers.get("content-type"), "application/wasm");
    assert.deepEqual(new Uint8Array(await module.arrayBuffer()), wasm);
    assert.equal((await get("private.json")).status, 404);
    assert.equal((await get("index.html")).status, 404);
    assert.equal((await get("graphics-xite/%2e%2e%2fprivate.json")).status, 404);
    assert.equal((await get("graphic-preview.html?path=private.json")).status, 400);
    const policy = await readFile(new URL("../../../renderer/graphic-preview.html", import.meta.url), "utf8");
    assert.match(policy, /script-src 'self' 'wasm-unsafe-eval';/u);
    assert.ok(!policy.includes("'unsafe-eval'"));
    assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
