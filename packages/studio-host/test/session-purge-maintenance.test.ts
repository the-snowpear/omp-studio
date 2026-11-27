import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";
import { createNodeSessionPurgeMaintenance, supportsSessionPurgeMaintenance } from "../src/session-purge-maintenance.js";

const input = { sessionId: "source", sessionFile: "private-session.jsonl", agentDir: "private-profile" };

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "studio-purge-process-"));
  const script = join(directory, "worker.mjs");
  await writeFile(script, source);
  const roots = Object.fromEntries(["home", "agent", "roaming", "local", "config", "cache", "data", "state", "temp"].map(name => [name, join(directory, name)]));
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.roaming, LOCALAPPDATA: roots.local,
    PI_CODING_AGENT_DIR: roots.agent, OMP_AGENT_DIR: roots.agent, PI_CONFIG_DIR: ".omp", PI_CONFIG_FILES: "",
    PI_PROFILE: "", OMP_PROFILE: "", XDG_CONFIG_HOME: roots.config, XDG_CACHE_HOME: roots.cache,
    XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, TMP: roots.temp, TEMP: roots.temp, TMPDIR: roots.temp,
    DO_NOT_TRACK: "1",
  });
  return { directory, script, env };
}

test("private maintenance preserves native partial evidence without treating void cleanup as atomic success", async () => {
  const files = await fixture(`
    if (process.argv[2] !== '__omp_worker_session_purge' || process.argv.length !== 3) process.exit(44);
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify({schemaVersion:1,requestId:input.requestId,result:{status:'partial',reason:'native-purge-partial',diagnostic:{history:{status:'failed',reason:'store-unavailable'},stats:{status:'absent'}}}}));
  `);
  const maintenance = createNodeSessionPurgeMaintenance({ executablePath: async () => process.execPath, args: [files.script], workingDirectory: files.directory, env: files.env });
  try {
    assert.deepEqual(await maintenance.run(input), { status: "partial", reason: "native-purge-partial", diagnostic: { history: { status: "failed", reason: "store-unavailable" }, stats: { status: "absent" } } });
  } finally { maintenance.dispose(); await rm(files.directory, { recursive: true, force: true }); }
});

test("a stalled maintenance child times out and is reaped before the delete can continue", async () => {
  const files = await fixture("process.stdin.resume(); setInterval(() => {}, 1000);");
  let closed = false;
  const launch = ((...args: unknown[]) => {
    const child = Reflect.apply(execFile, undefined, args);
    child.once("close", () => { closed = true; });
    return child;
  }) as typeof execFile;
  const maintenance = createNodeSessionPurgeMaintenance({ executablePath: async () => process.execPath, args: [files.script], workingDirectory: files.directory, env: files.env, timeoutMs: 100, execFile: launch });
  try {
    assert.deepEqual(await maintenance.run(input), { status: "partial", reason: "timeout" });
    assert.equal(closed, true);
  } finally { maintenance.dispose(); await rm(files.directory, { recursive: true, force: true }); }
});

test("cancellation does not release deletion while execFile has reported an error but its child remains open", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: (_signal?: string) => { killed++; return true; } });
  let killed = 0;
  let finish!: (error: ExecFileException | null, stdout: string, stderr: string) => void;
  let opened!: () => void;
  const started = new Promise<void>(resolve => { opened = resolve; });
  const maintenance = createNodeSessionPurgeMaintenance({
    executablePath: async () => "internal-test-executable", workingDirectory: tmpdir(),
    execFile: ((_file: unknown, _args: unknown, _options: unknown, callback: typeof finish) => { finish = callback; queueMicrotask(opened); return child; }) as unknown as typeof execFile,
  });
  let settled = false;
  const result = maintenance.run(input).then(value => { settled = true; return value; });
  await started;
  maintenance.dispose();
  finish(new Error("cancelled") as ExecFileException, "", "");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, 1);
  assert.equal(settled, false);
  child.emit("close");
  assert.deepEqual(await result, { status: "partial", reason: "cancelled" });
});

test("an older or different pinned Runtime is never launched with the private purge selector", async () => {
  const supported = { upstreamVersion: "18.20.2", upstreamCommit: "7c49c11aa5bbaf3f418406583096168ad5b8c6dc", patchsetVersion: "studio.1" } as RuntimeInstallationManifest;
  assert.equal(supportsSessionPurgeMaintenance(supported), true);
  assert.equal(supportsSessionPurgeMaintenance({ ...supported, upstreamVersion: "19.2.1", upstreamCommit: "b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac" }), true);
  let launches = 0;
  for (const manifest of [
    { ...supported, upstreamVersion: "18.19.0" },
    { ...supported, upstreamCommit: "unreviewed-pin" },
    { ...supported, patchsetVersion: "studio.0" },
  ]) {
    const maintenance = createNodeSessionPurgeMaintenance({
      executablePath: async () => supportsSessionPurgeMaintenance(manifest) ? "must-not-launch" : undefined,
      workingDirectory: tmpdir(),
      execFile: (() => { launches++; throw new Error("must not launch"); }) as unknown as typeof execFile,
    });
    assert.deepEqual(await maintenance.run(input), { status: "partial", reason: "runtime-unavailable" });
    maintenance.dispose();
  }
  assert.equal(launches, 0);
});
