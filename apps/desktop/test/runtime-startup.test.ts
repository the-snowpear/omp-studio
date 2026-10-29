import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopRuntimeStartup } from "../src/runtime-startup.js";

test("a new workspace does not share a previous Runtime ensure", async () => {
  const startup = new DesktopRuntimeStartup(() => {});
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = startup.ensure(async () => { entered(); await gate; return "first"; }, () => undefined);
  await started;
  startup.changeWorkspace();
  const second = startup.ensure(async () => "second", () => undefined);
  assert.notEqual(first, second);
  const rejected = assert.rejects(first, /Workspace changed/);
  release();
  assert.equal(await second, "second");
  await rejected;
  await startup.close();
});

test("a queued ensure for an old workspace never starts", async () => {
  const startup = new DesktopRuntimeStartup(() => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  startup.start(() => gate);
  let called = false;
  const pending = startup.ensure(async () => { called = true; return undefined; }, () => undefined);
  const rejected = assert.rejects(pending, /Workspace changed/);
  startup.changeWorkspace();
  release();
  await rejected;
  assert.equal(called, false);
  await startup.close();
});
