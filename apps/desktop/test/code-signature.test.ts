import assert from "node:assert/strict";
import { test } from "node:test";

import { withCodeSignatureCheck } from "../src/platform/code-signature.js";

test("other platforms keep the smoke test exactly as it was", () => {
  const runner = { run: async () => {} };
  assert.equal(withCodeSignatureCheck(runner, { platform: "win32" }), runner);
});

test("macOS verifies the Runtime's signature before running its smoke test", async () => {
  const calls: string[] = [];
  const runner = { run: async (path: string) => { calls.push(`smoke ${path}`); } };
  const checked = withCodeSignatureCheck(runner, { platform: "darwin", run: async (file, args) => { calls.push(`${file} ${args.join(" ")}`); } });
  await checked.run("/rt/omp");
  assert.deepEqual(calls, ["/usr/bin/codesign --verify --strict /rt/omp", "smoke /rt/omp"]);

  const broken = withCodeSignatureCheck(runner, { platform: "darwin", run: async () => { throw new Error("code object is not signed at all"); } });
  await assert.rejects(() => broken.run("/rt/omp"), /代码签名无效.*not signed/u);
  assert.equal(calls.length, 2, "an unsigned Runtime is never executed");
});
