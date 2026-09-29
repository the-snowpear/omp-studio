import assert from "node:assert/strict";
import { test } from "node:test";

import { clearQuarantine, type RunFile } from "../src/platform/quarantine.js";

function failing(stderr: string, message = "Command failed"): RunFile {
  return async () => {
    throw Object.assign(new Error(message), { stderr });
  };
}

test("clears the quarantine flag recursively on the staged copy", async () => {
  const calls: string[][] = [];
  await clearQuarantine("/Users/u/Library/Application Support/omp-studio/runtimes/versions/.staging-x", {
    run: async (file, args) => { calls.push([file, ...args]); },
  });
  assert.deepEqual(calls, [["/usr/bin/xattr", "-dr", "com.apple.quarantine", "/Users/u/Library/Application Support/omp-studio/runtimes/versions/.staging-x"]]);
});

test("files that never had the flag are not a problem", async () => {
  const warnings: string[] = [];
  await clearQuarantine("/tmp/staging", {
    run: failing("xattr: /tmp/staging/checksums.json: No such xattr: com.apple.quarantine\n"),
    warn: (detail) => warnings.push(detail),
  });
  assert.deepEqual(warnings, []);
});

test("other failures are reported and never thrown", async () => {
  const warnings: string[] = [];
  await clearQuarantine("/tmp/staging", {
    run: failing("xattr: /tmp/staging/omp: No such xattr: com.apple.quarantine\nxattr: [Errno 1] Operation not permitted: '/tmp/staging/omp'\n"),
    warn: (detail) => warnings.push(detail),
  });
  assert.deepEqual(warnings, ["xattr: [Errno 1] Operation not permitted: '/tmp/staging/omp'"]);

  await clearQuarantine("/tmp/staging", { run: failing("", "spawn /usr/bin/xattr ENOENT"), warn: (detail) => warnings.push(detail) });
  assert.equal(warnings.at(-1), "spawn /usr/bin/xattr ENOENT");
});
