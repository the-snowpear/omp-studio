import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { createProcessProbe, type RuntimeProbeContext } from "../src/index.js";

function unavailableBridge(directory: string) {
  return async () => ({
    endpoint: process.platform === "win32"
      ? `\\\\.\\pipe\\omp-probe-test-${randomUUID()}`
      : join(tmpdir(), `omp-probe-${randomUUID()}.sock`),
    token: "probe-test-token",
    tokenFile: join(directory, "unused-token"),
  });
}

function probeContext(directory: string): RuntimeProbeContext {
  return {
    executablePath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    workspaceDirectory: directory,
    supportedProtocolVersions: [1],
    probeTimeoutMs: 3_000,
  };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a timed-out Runtime probe reaps its worker before returning and preserves startup diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-probe-tree-"));
  const script = join(directory, "parent.mjs");
  const marker = join(directory, "worker.pid");
  await writeFile(script, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',stdio:'ignore',windowsHide:true});
writeFileSync(process.argv[2],String(worker.pid));
process.stdout.write('probe starting\\n');
process.stderr.write('Still starting — phase: 插件发现\\n');
setInterval(()=>{},1000);
`);
  const output = { stdout: "", stderr: "" };
  let parent: ChildProcess | undefined;
  let workerPid: number | undefined;
  try {
    const result = await createProcessProbe({
      createBootstrap: unavailableBridge(directory),
      spawnProcess: ((_exe: string, _args: readonly string[], options: SpawnOptions) => {
        parent = spawn(process.execPath, [script, marker], options);
        return parent;
      }) as typeof spawn,
      onOutput: (stream, text) => { output[stream] += text; },
    }).probe(probeContext(directory));
    workerPid = Number(await readFile(marker, "utf8"));
    assert.equal(result.failure, "PROBE_TIMEOUT");
    assert.ok(parent);
    assert.ok(parent.exitCode !== null || parent.signalCode !== null);
    for (let attempt = 0; attempt < 100 && isAlive(workerPid); attempt += 1) await delay(20);
    assert.equal(isAlive(workerPid), false, "the probe's worker must not survive the timeout");
    assert.match(output.stdout, /probe starting/u);
    assert.match(output.stderr, /phase: 插件发现/u);
  } finally {
    if (workerPid === undefined) workerPid = Number(await readFile(marker, "utf8").catch(() => "0"));
    if (workerPid && isAlive(workerPid)) process.kill(workerPid, "SIGKILL");
    if (parent?.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Runtime probe drains large output without a diagnostics listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-probe-output-"));
  const marker = join(directory, "drained");
  try {
    const result = await createProcessProbe({
      createBootstrap: unavailableBridge(directory),
      spawnProcess: ((_exe: string, _args: readonly string[], options: SpawnOptions) => spawn(process.execPath, ["-e",
        'process.stdout.write("o".repeat(1024*1024));process.stderr.write("e".repeat(1024*1024),()=>require("node:fs").writeFileSync(process.argv[1],"drained"));', marker], options)) as typeof spawn,
    }).probe(probeContext(directory));
    assert.equal(result.failure, "PROCESS_CRASHED");
    assert.equal(await readFile(marker, "utf8"), "drained");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an asynchronously missing probe executable reports SPAWN_FAILED", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-probe-missing-"));
  try {
    const result = await createProcessProbe({ createBootstrap: unavailableBridge(directory) })
      .probe({ ...probeContext(directory), executablePath: join(directory, "missing-runtime") });
    assert.equal(result.failure, "SPAWN_FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
