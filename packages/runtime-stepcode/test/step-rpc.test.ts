import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStepCommand } from "../src/step-rpc.js";

// npm's Windows bin shim is `step.cmd`, and Node's spawn cannot CreateProcess a
// `.cmd` without a shell. These are the cases the Windows launch hits.
test("resolveStepCommand keeps POSIX commands untouched", () => {
  assert.equal(resolveStepCommand("step", "linux"), "step");
  assert.equal(resolveStepCommand("/usr/local/bin/step", "darwin"), "/usr/local/bin/step");
  assert.equal(resolveStepCommand("node", "linux"), "node");
});

test("resolveStepCommand names the Windows shim for a bare command", () => {
  assert.equal(resolveStepCommand("step", "win32"), "step.cmd");
});

test("resolveStepCommand leaves explicit Windows executables and paths alone", () => {
  assert.equal(resolveStepCommand("step.exe", "win32"), "step.exe");
  assert.equal(resolveStepCommand("step.CMD", "win32"), "step.CMD");
  assert.equal(resolveStepCommand("C:\\tools\\bin\\step", "win32"), "C:\\tools\\bin\\step");
  assert.equal(resolveStepCommand("C:\\Program Files\\step\\step.cmd", "win32"), "C:\\Program Files\\step\\step.cmd");
});
