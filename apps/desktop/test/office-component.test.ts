import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OfficeComponent } from "../src/office-component.js";

for (const action of ["install", "check"] as const) test(`cancels Office ${action} while checking the component manifest`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-cancel-"));
  let started!: () => void, calls = 0;
  const checking = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (_input, options) => {
    calls++; started();
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
  };
  const component = new OfficeComponent(directory, {}, { fetcher });
  try {
    const operation = action === "install" ? component.install() : component.getState(true);
    await checking; component.cancel();
    const state = await operation;
    assert.equal(state.status, "not-installed"); assert.match(state.message!, /取消/); assert.equal(calls, 1);
    assert.equal((await component.getState()).installedVersion, undefined);
  } finally { component.dispose(); await rm(directory, { recursive: true, force: true }); }
});
