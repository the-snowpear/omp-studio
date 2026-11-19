import assert from "node:assert/strict";
import { test } from "node:test";
import { wslUncPath, wslLinuxPath } from "../src/remote/wsl-paths.js";

test("Ubuntu paths round-trip through Explorer and retain their Linux form for copying", () => {
  const unc = wslUncPath("Ubuntu", "/home/dev/./test/../中文 project/file.md");
  assert.equal(unc, "\\\\wsl.localhost\\Ubuntu\\home\\dev\\中文 project\\file.md");
  assert.equal(wslLinuxPath("Ubuntu", unc), "/home/dev/中文 project/file.md");
  for (const bad of ["relative", "/home/\0file", "/home/..\\other"]) assert.throws(() => wslUncPath("Ubuntu", bad));
});
