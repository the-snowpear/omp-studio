/**
 * Production Desktop Runtime session port contracts used by plan 01:
 * workspace activation, honest read-only without process.cwd(), and
 * command-manifest hash fail-closed.
 *
 * Does not spawn a real OMP process or read the user's OMP config.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { privateEndpoint } from "@omp-studio/platform";
import { createChallengeProof, StudioBridgeHandshakeError, type RuntimeResolution } from "@omp-studio/studio-host";
import {
  encodeFrame,
  FrameDecoder,
  type OperatorCommandManifest,
  type RuntimeEpoch,
  type RuntimeInstanceId,
  type StudioHelloResponse,
} from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSessionContext } from "../src/host-composition.js";
import {
  classifyLaunchFailure,
  createDesktopRuntimeSessionPort,
  isUsableWorkspaceDirectory,
  selectVerifiedCommandManifest,
} from "../src/runtime-session.js";

const UPSTREAM = "0123456789abcdef0123456789abcdef01234567";

// A managed installation is only resolvable when its metadata still verifies
// against a trusted key, so the fixtures below sign what they write and the
// launch context carries the matching public key.
const RUNTIME_KEY_ID = "runtime-session-test";
const RUNTIME_KEYS = generateKeyPairSync("ed25519");
const TRUSTED_KEYS = {
  [RUNTIME_KEY_ID]: RUNTIME_KEYS.publicKey.export({ type: "spki", format: "pem" }) as string,
};

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
    installer: { trustedKeys: TRUSTED_KEYS },
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
  const manifestText = `${JSON.stringify({
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
  })}\n`;
  const checksumsText = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "omp.exe": createHash("sha256").update("omp").digest("hex"),
      "runtime-manifest.json": createHash("sha256").update(manifestText).digest("hex"),
    },
  })}\n`;
  const signedPayload = Buffer.concat([
    Buffer.from(manifestText),
    Buffer.from("\0"),
    Buffer.from(checksumsText),
  ]);
  await writeFile(join(versionDirectory, "runtime-manifest.json"), manifestText);
  await writeFile(join(versionDirectory, "checksums.json"), checksumsText);
  await writeFile(
    join(versionDirectory, "runtime-signature.json"),
    `${JSON.stringify({
      algorithm: "ed25519",
      keyId: RUNTIME_KEY_ID,
      payloadSha256: createHash("sha256").update(signedPayload).digest("hex"),
      signature: sign(null, signedPayload, RUNTIME_KEYS.privateKey).toString("base64url"),
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

for (const manifestOutcome of ["disconnect", "process-exit", "rejected"] as const) {
  test(`startup command manifest ${manifestOutcome} reports the actual Runtime availability`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-rs-startup-"));
    const lines: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    const exit = (): void => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit("exit", 0, null);
    };
    let token = "";
    const epoch = 1 as RuntimeEpoch;
    class StartupSocket extends EventEmitter {
      readonly decoder = new FrameDecoder();
      destroyed = false;
      write(buffer: Buffer): boolean {
        for (const frame of this.decoder.push(buffer)) {
          const request = frame.body as { type: string; requestId: string; challenge: string; operation?: { kind: string } };
          let response: unknown;
          if (request.type === "studio.hello") {
            const runtimeId = "runtime-startup" as RuntimeInstanceId;
            response = {
              type: "studio.hello.result",
              requestId: request.requestId,
              selectedProtocolVersion: 1,
              runtimeVersion: "7.0.0-studio.1",
              upstreamVersion: "0.0.0",
              upstreamCommit: UPSTREAM,
              runtimeInstanceId: runtimeId,
              runtimeEpoch: epoch,
              stateVersion: 0,
              capabilityManifest: {
                profile: "limited", generatedAt: "2026-10-29T00:00:00.000Z",
                hash: "capability-fixture", capabilities: [],
              },
              commandManifestHash: "command-fixture",
              challengeProof: createChallengeProof(token, request.challenge, runtimeId),
            };
          } else if (request.operation?.kind === "runtime.snapshot") {
            response = {
              type: "studio.snapshot",
              requestId: request.requestId,
              snapshot: {
                runtimeId: "runtime-startup", runtimeEpoch: epoch, stateVersion: 0, sessionId: "session-startup",
                isStreaming: false, isCompacting: false, activeMode: "normal", approvalMode: "yolo",
                pendingMessages: 0, activeCommandIds: [], agentsRevision: 0, jobsRevision: 0, agents: [], jobs: [],
              },
              commandManifestHash: "command-fixture",
              capabilityHash: "capability-fixture",
              lastEventSeq: 0,
              terminalReceipts: [],
            };
          } else if (request.operation?.kind === "operator.manifest.get" && manifestOutcome !== "rejected") {
            queueMicrotask(() => {
              if (manifestOutcome === "process-exit") exit();
              this.destroy();
            });
            continue;
          } else {
            response = {
              type: "studio.receipt", requestId: request.requestId, runtimeEpoch: epoch, stateVersion: 0,
              status: request.operation?.kind === "runtime.shutdown" ? "completed" : "rejected",
            };
          }
          queueMicrotask(() => {
            this.emit("data", encodeFrame(`response:${request.requestId}`, epoch, response));
            if (request.operation?.kind === "runtime.shutdown") {
              this.emit("data", encodeFrame("shutdown-complete", epoch, {
                type: "studio.event", runtimeEpoch: epoch, stateVersion: 0, eventSeq: 1,
                occurredAt: "2026-10-29T00:00:00.000Z", event: { kind: "runtime.shutdownComplete" },
              }));
              exit();
            }
          });
        }
        return true;
      }
      destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        queueMicrotask(() => this.emit("close"));
      }
    }
    const port = createDesktopRuntimeSessionPort({
      windowsAcl: {
        secureDirectory: async () => undefined,
        createSecureTokenFile: async (path, value) => { await writeFile(path, value); },
      },
      containment: { requestStop: exit, forceStop: exit },
      spawnProcess: ((_command: string, args: string[]) => {
        token = readFileSync(args[args.indexOf("--bridge-token-file") + 1]!, "utf8").trim();
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as unknown as typeof spawn,
      connectSocket: () => {
        const socket = new StartupSocket();
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      log: { write: (_level, event, detail) => { lines.push(`${event} ${detail ?? ""}`); } },
    });
    try {
      const install = join(directory, "runtime");
      await writeLiveRuntime(install, "7.0.0-studio.1");
      const start = () => port.start({ ...context(directory, install), workspace: { workspaceId: "ws-startup", cwd: directory } });
      if (manifestOutcome === "rejected") {
        const session = await start();
        assert.ok(session);
        assert.ok(session.hello(), "a rejected optional manifest must preserve the live connection");
        assert.equal(session.commandManifest(), undefined);
      } else {
        await assert.rejects(start, /Studio Bridge.*(disconnected|exited)/u);
        assert.equal(port.listResidents?.().residents.length, 0);
        assert.equal(port.lastUnavailable?.()?.code, "launch-failed");
        assert.equal(lines.some(line => line.startsWith("runtime.launch.ready")), false);
        assert.equal(lines.some(line => line.startsWith("runtime.respawn.schedule")), false);
      }
    } finally {
      await port.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
