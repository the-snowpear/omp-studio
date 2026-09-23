import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Runtime's independently bundled numerical helper stays identical to the canonical module", async () => {
  const canonical = await readFile(new URL("../../src/performance-diagnostics.ts", import.meta.url), "utf8");
  const mirror = await readFile(new URL("../../../../omp-patch/overlay/packages/coding-agent/src/studio/performance-diagnostics.ts", import.meta.url), "utf8");
  assert.equal(mirror.replace(/\r\n/g, "\n"), canonical.replace(/\r\n/g, "\n"));
});
