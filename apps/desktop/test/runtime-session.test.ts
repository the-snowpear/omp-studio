/**
 * Production Desktop Runtime session port contracts used by plan 01:
 * workspace activation, honest read-only without process.cwd(), and
 * command-manifest hash fail-closed.
 *
 * Does not spawn a real OMP process or read the user's OMP config.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { privateEndpoint } from "@omp-studio/platform";
import type { RuntimeResolution } from "@omp-studio/studio-host";
import type { OperatorCommandManifest, StudioHelloResponse } from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSessionContext } from "../src/host-composition.js";
import {
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

function context(profileDirectory: string): DesktopRuntimeSessionContext {
  return {
    resolution: { classification: "compatible-system" } as RuntimeResolution,
    endpoint: privateEndpoint("in-memory", "authority-test"),
    profileDirectory,
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
