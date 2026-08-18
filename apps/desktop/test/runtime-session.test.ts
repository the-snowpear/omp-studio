/**
 * Production Desktop Runtime session port contracts used by plan 01:
 * workspace activation, honest read-only without process.cwd(), and
 * command-manifest hash fail-closed.
 *
 * Does not spawn a real OMP process or read the user's OMP config.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { privateEndpoint } from "@omp-studio/platform";
import { StudioBridgeHandshakeError, type RuntimeResolution } from "@omp-studio/studio-host";
import type { OperatorCommandManifest, StudioHelloResponse } from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSessionContext } from "../src/host-composition.js";
import {
  classifyLaunchFailure,
  createDesktopRuntimeSessionPort,
  isUsableWorkspaceDirectory,
  selectVerifiedCommandManifest,
} from "../src/runtime-session.js";

const UPSTREAM = "0123456789abcdef0123456789abcdef01234567";

function trappingSpawn(onSpawn: (cwd: string | undefined) => void): typeof spawn {
  return ((...args: unknown[]) => {
    const options = args[2] as { cwd?: string } | undefined;
    onSpawn(options?.cwd);
    throw new Error("spawn must not run in runtime-session unit tests");
  }) as unknown as typeof spawn;
}

function context(profileDirectory: string, runtimeInstallDirectory = join(profileDirectory, "runtimes")): DesktopRuntimeSessionContext {
  return {
    resolution: { classification: "compatible-system" } as RuntimeResolution,
    endpoint: privateEndpoint("in-memory", "authority-test"),
    profileDirectory,
    runtimeInstallDirectory,
  };
}

test("isUsableWorkspaceDirectory accepts a real directory and rejects missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-ws-usable-"));
  const missing = join(dir, "nope");
  try {
    assert.equal(await isUsableWorkspaceDirectory(dir), true);
    assert.equal(await isUsableWorkspaceDirectory(missing), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selectVerifiedCommandManifest fail-closes on hash or upstream mismatch", () => {
  const hello = {
    commandManifestHash: "cmd-hash-0001",
    upstreamCommit: UPSTREAM,
  } as Pick<StudioHelloResponse, "commandManifestHash" | "upstreamCommit">;
  const matching: OperatorCommandManifest = {
    generatedAt: "2026-08-15T00:00:00.000Z",
    upstreamCommit: UPSTREAM,
    hash: "cmd-hash-0001",
    commands: [],
    unclassifiedBuiltins: [],
  };
  assert.equal(selectVerifiedCommandManifest(hello, matching), matching);
  assert.equal(
    selectVerifiedCommandManifest(hello, { ...matching, hash: "other-hash" }),
    undefined,
  );
  assert.equal(
    selectVerifiedCommandManifest(hello, { ...matching, upstreamCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    undefined,
  );
});

test("start without a workspace stays read-only, never spawns using process.cwd(), and logs the skip", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-rs-profile-"));
  const spawned: Array<string | undefined> = [];
  const lines: string[] = [];
  try {
    const port = createDesktopRuntimeSessionPort({
      spawnProcess: trappingSpawn((cwd) => spawned.push(cwd)),
      log: {
        write(_level, event, detail) {
          lines.push(`${event} ${detail ?? ""}`.trim());
        },
      },
    });
    const session = await port.start(context(profile));
    assert.equal(session, undefined);
    assert.deepEqual(spawned, []);
    assert.ok(lines.some((line) => line.startsWith("runtime.start.skip")));
    assert.equal(port.lastUnavailable?.()?.code, "no-workspace");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("start with an unusable workspace cwd does not spawn", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-rs-missing-"));
  const spawned: Array<string | undefined> = [];
  try {
    const port = createDesktopRuntimeSessionPort({
      spawnProcess: trappingSpawn((cwd) => spawned.push(cwd)),
    });
    const session = await port.start({
      ...context(profile),
      workspace: { workspaceId: "ws-missing", cwd: join(profile, "missing-project") },
    });
    assert.equal(session, undefined);
    assert.deepEqual(spawned, []);
    assert.equal(port.lastUnavailable?.()?.code, "workspace-unusable");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("rebind of a missing directory does not spawn into process.cwd()", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-rs-rebind-"));
  const spawned: Array<string | undefined> = [];
  try {
    const port = createDesktopRuntimeSessionPort({
      spawnProcess: trappingSpawn((cwd) => spawned.push(cwd)),
    });
    await port.start(context(profile));
    assert.ok(port.rebind);
    const session = await port.rebind({
      workspaceId: "ws-gone",
      cwd: join(profile, "gone"),
    });
    assert.equal(session, undefined);
    assert.equal(spawned.includes(process.cwd()), false);
    assert.deepEqual(spawned, []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a file path is not treated as a workspace cwd", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-rs-file-"));
  const filePath = join(profile, "not-a-dir.txt");
  await writeFile(filePath, "nope");
  try {
    assert.equal(await isUsableWorkspaceDirectory(filePath), false);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

async function writeLiveRuntime(root: string, version: string): Promise<string> {
  const versionDirectory = join(root, "versions", version);
  await mkdir(versionDirectory, { recursive: true });
  const entrypoint = join(versionDirectory, "omp.exe");
  await writeFile(entrypoint, "omp");
  await writeFile(
    join(versionDirectory, "runtime-manifest.json"),
    `${JSON.stringify({
      runtimeVersion: version,
      upstreamVersion: "0.0.0",
      upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
      patchsetVersion: "0.1.0",
      studioProtocol: { min: 1, max: 1 },
      profile: "limited",
      capabilityHash: "capability-fixture",
      commandManifestHash: "command-fixture",
      platform: "win32-x64",
      entrypoint: "omp.exe",
      channel: "stable",
    })}\n`,
  );
  await writeFile(
    join(root, "current.json"),
    `${JSON.stringify({ runtimeVersion: version, activatedAt: "2026-08-18T00:00:00.000Z" })}\n`,
  );
  return entrypoint;
}

test("launch spawns omp.exe from runtimeInstallDirectory, not the profile runtimes tree", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-rs-profile-"));
  const install = await mkdtemp(join(tmpdir(), "omp-rs-install-"));
  const workspace = await mkdtemp(join(tmpdir(), "omp-rs-ws-"));
  const spawned: string[] = [];
  try {
    const expected = await writeLiveRuntime(install, "7.0.0-studio.1");
    await writeLiveRuntime(join(profile, "runtimes"), "1.0.0-studio.1");
    const port = createDesktopRuntimeSessionPort({
      windowsAcl: {
        secureDirectory: async () => undefined,
        createSecureTokenFile: async (path, token) => {
          await writeFile(path, token);
        },
      },
      spawnProcess: ((command: string) => {
        spawned.push(command);
        throw new Error("spawn must not run in runtime-session unit tests");
      }) as unknown as typeof spawn,
    });
    await assert.rejects(
      () =>
        port.start({
          ...context(profile, install),
          workspace: { workspaceId: "ws-live", cwd: workspace },
        }),
      /spawn must not run/u,
    );
    assert.deepEqual(spawned, [expected]);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(install, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("classifyLaunchFailure maps handshake timeout, spawn, and early exit", () => {
  const timeout = classifyLaunchFailure(new StudioBridgeHandshakeError("HANDSHAKE_TIMEOUT"));
  assert.equal(timeout.code, "handshake-timeout");
  assert.match(timeout.reason, /handshake timed out/iu);

  const earlyExit = classifyLaunchFailure(new Error("Runtime process exited before ready"));
  assert.equal(earlyExit.code, "exited-before-ready");

  const spawn = classifyLaunchFailure(Object.assign(new Error("spawn omp.exe ENOENT"), { code: "ENOENT" }));
  assert.equal(spawn.code, "spawn-failed");

  const generic = classifyLaunchFailure(new Error("bridge refused the handshake"));
  assert.equal(generic.code, "launch-failed");
});
