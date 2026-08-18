/**
 * Plan 01 production baseline: persisted workspace activation, Runtime
 * manifests on the Facade, a single publication forwarder, and a
 * Renderer-free core.prompt composition loop.
 *
 * Fakes only. No real OMP config, no user files, no spawned Runtime.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createInitialClientState, reduceClientState } from "@omp-studio/client";
import type { ClientEvent, CommandRequestId, IdempotencyKey } from "@omp-studio/client-contract";
import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import { privateEndpoint, type PlatformPort } from "@omp-studio/platform";
import type { RuntimeProbePort, RuntimePublication, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import {
  FULL_PARITY_REQUIRED_CAPABILITIES,
  type CommandId,
  type CommandLedgerEntry,
  type OperatorCommandManifest,
  type OperatorStateSnapshot,
  type RequestId,
  type RuntimeEpoch,
  type RuntimeId,
  type RuntimeInstanceId,
  type SessionId,
  type StateVersion,
  type StudioHelloResponse,
  type StudioReceipt,
  type StudioRequest,
} from "@omp-studio/studio-protocol";

import {
  createDesktopHostComposition,
  type DesktopAuthorityLock,
  type DesktopPrivateEndpoint,
  type DesktopRuntimeSession,
  type DesktopRuntimeSessionContext,
  type DesktopRuntimeSessionPort,
} from "../src/host-composition.js";

const UPSTREAM_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const T0 = "2026-08-12T00:00:00.000Z";

const SNAPSHOT: OperatorStateSnapshot = {
  runtimeId: "rt-0001" as RuntimeId,
  runtimeEpoch: 1 as RuntimeEpoch,
  stateVersion: 1 as StateVersion,
  sessionId: "sess-0001" as SessionId,
  isStreaming: false,
  isCompacting: false,
  activeMode: "normal", approvalMode: "yolo",
  pendingMessages: 0,
  activeCommandIds: [],
  agentsRevision: 0,
  jobsRevision: 0,
  agents: [],
  jobs: [],
};

const HELLO_VIEW: HostRuntimeHelloView = {
  runtimeId: "rt-0001",
  runtimeEpoch: 1,
  classification: "compatible-system",
  backend: "studio-host",
  runtimeVersion: "1.2.3",
  upstreamVersion: "0.9.0",
  upstreamCommit: UPSTREAM_COMMIT,
};

const HELLO: StudioHelloResponse = {
  type: "studio.hello.result",
  requestId: "probe-req-1" as RequestId,
  selectedProtocolVersion: 1,
  runtimeVersion: "1.2.3",
  upstreamVersion: "0.9.0",
  upstreamCommit: UPSTREAM_COMMIT,
  runtimeInstanceId: "rt-inst-0001" as RuntimeInstanceId,
  runtimeEpoch: 1 as RuntimeEpoch,
  capabilityManifest: {
    profile: "full-parity-v1",
    generatedAt: T0,
    hash: "cap-hash-0001",
    capabilities: FULL_PARITY_REQUIRED_CAPABILITIES.map((id) => ({
      id,
      grade: "stable" as const,
      version: 1,
      evidence: "probed",
    })),
  },
  commandManifestHash: "cmd-hash-0001",
  stateVersion: 1 as StateVersion,
  challengeProof: "proof-0001",
};

const COMMAND_MANIFEST: OperatorCommandManifest = {
  generatedAt: T0,
  upstreamCommit: UPSTREAM_COMMIT,
  hash: "cmd-hash-0001",
  commands: [],
  unclassifiedBuiltins: [],
};

function fullParityProbe(): RuntimeProbePort {
  return {
    async probe() {
      return {
        hello: HELLO,
        commandManifest: COMMAND_MANIFEST,
        smoke: "passed" as const,
        shutdown: "passed" as const,
      };
    },
  };
}

function fakePlatform(profileDirectory: string): PlatformPort {
  return {
    platform: "win32",
    appDataDirectory: async () => profileDirectory,
    runtimeExecutableName: () => "omp.exe",
    createPrivateEndpoint: async () => {
      throw new Error("unused in production baseline tests");
    },
    createProcessContainment: () => {
      throw new Error("unused in production baseline tests");
    },
    revealPath: async () => {},
    openExternal: async () => {},
  };
}

function fakeAuthorityLock(): DesktopAuthorityLock {
  return {
    async acquire() {
      return {
        authorityId: "auth-0001",
        epoch: "epoch-0001",
        release: async () => {},
      };
    },
  };
}

function fakePrivateEndpoint(): DesktopPrivateEndpoint {
  return {
    async createCurrentUserOnly() {
      return {
        endpoint: privateEndpoint("in-memory", "authority-0001"),
        release: async () => {},
      };
    },
  };
}

async function withTempProfile(run: (profileDirectory: string) => Promise<void>): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "omp-desktop-p01-"));
  try {
    await run(profileDirectory);
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

async function withTempExecutable(run: (executablePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-desktop-p01-exe-"));
  const executablePath = join(directory, "omp-test.exe");
  await writeFile(executablePath, "fake runtime payload for fingerprinting");
  try {
    await run(executablePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cloneSnapshot(snapshot: OperatorStateSnapshot): OperatorStateSnapshot {
  return structuredClone(snapshot);
}

interface LiveSessionHandle {
  readonly session: DesktopRuntimeSession;
  readonly epoch: number;
  subscribeCount: number;
  publish(snapshot: OperatorStateSnapshot, terminalOutcomes?: CommandLedgerEntry[]): void;
  emitToCurrentListeners(publication: RuntimePublication): void;
  setHello(hello: HostRuntimeHelloView | undefined): void;
  setCapability(manifest: typeof HELLO.capabilityManifest | undefined): void;
  setCommand(manifest: OperatorCommandManifest | undefined): void;
  setInvoke(
    impl: (request: StudioRequest) => Promise<StudioReceipt>,
  ): void;
}

function createLiveSession(options: { epoch?: number; snapshot?: OperatorStateSnapshot } = {}): LiveSessionHandle {
  const epoch = options.epoch ?? 1;
  const listeners = new Set<(publication: RuntimePublication) => void>();
  let snapshot = cloneSnapshot(options.snapshot ?? { ...SNAPSHOT, runtimeEpoch: epoch as RuntimeEpoch });
  let hello: HostRuntimeHelloView | undefined = { ...HELLO_VIEW, runtimeEpoch: epoch };
  let capability: typeof HELLO.capabilityManifest | undefined = HELLO.capabilityManifest;
  let command: OperatorCommandManifest | undefined = COMMAND_MANIFEST;
  let commitSeq = 1;
  let publication: RuntimePublication = {
    commitSeq,
    publishedAt: T0,
    snapshot: cloneSnapshot(snapshot),
    terminalOutcomes: [],
  };
  let invokeImpl: (request: StudioRequest) => Promise<StudioReceipt> = async (request) => ({
    type: "studio.receipt",
    requestId: request.requestId,
    runtimeEpoch: snapshot.runtimeEpoch,
    stateVersion: snapshot.stateVersion,
    status: "completed",
  });
  const handle: LiveSessionHandle = {
    epoch,
    subscribeCount: 0,
    session: {
      controller: {
        refresh: async () => publication,
        invoke: async (request: StudioRequest) => invokeImpl(request),
        runtimeLost: () => [],
        publication: () => structuredClone(publication),
        dispose: () => {},
      } as unknown as StudioRuntimeSessionController,
      hello: () => hello,
      capabilityManifest: () => capability,
      commandManifest: () => command,
      onPublication: (listener) => {
        handle.subscribeCount += 1;
        listeners.add(listener);
        return () => {
          handle.subscribeCount -= 1;
          listeners.delete(listener);
        };
      },
    },
    publish(next, terminalOutcomes = []) {
      snapshot = cloneSnapshot(next);
      commitSeq += 1;
      publication = {
        commitSeq,
        publishedAt: T0,
        snapshot: cloneSnapshot(snapshot),
        terminalOutcomes: terminalOutcomes.map((entry) => structuredClone(entry)),
      };
      handle.emitToCurrentListeners(publication);
    },
    emitToCurrentListeners(next) {
      for (const listener of [...listeners]) listener(next);
    },
    setHello(next) {
      hello = next;
    },
    setCapability(next) {
      capability = next;
    },
    setCommand(next) {
      command = next;
    },
    setInvoke(impl) {
      invokeImpl = impl;
    },
  };
  return handle;
}

function recordingPort(options: {
  readonly start?: (context: DesktopRuntimeSessionContext) => Promise<DesktopRuntimeSession | undefined>;
  readonly rebind?: (workspace: { workspaceId: string; cwd: string }) => Promise<DesktopRuntimeSession | undefined>;
}): {
  readonly port: DesktopRuntimeSessionPort;
  readonly starts: DesktopRuntimeSessionContext[];
  readonly rebinds: Array<{ workspaceId: string; cwd: string }>;
  readonly stops: number[];
} {
  const starts: DesktopRuntimeSessionContext[] = [];
  const rebinds: Array<{ workspaceId: string; cwd: string }> = [];
  const stops: number[] = [];
  return {
    starts,
    rebinds,
    stops,
    port: {
      async start(context) {
        starts.push(context);
        return options.start === undefined ? undefined : await options.start(context);
      },
      async stop() {
        stops.push(1);
      },
      async rebind(workspace) {
        rebinds.push({ ...workspace });
        return options.rebind === undefined ? undefined : await options.rebind(workspace);
      },
    },
  };
}

async function createReadyComposition(options: {
  readonly profileDirectory: string;
  readonly executablePath: string;
  readonly session: DesktopRuntimeSessionPort;
  readonly getActiveWorkspace?: () => { workspaceId: string; cwd: string } | undefined;
}): Promise<Awaited<ReturnType<typeof createDesktopHostComposition>>> {
  return createDesktopHostComposition({
    platform: fakePlatform(options.profileDirectory),
    authorityLock: fakeAuthorityLock(),
    privateEndpoint: fakePrivateEndpoint(),
    runtimeSession: options.session,
    resolver: { probe: fullParityProbe() },
    preference: { kind: "system", executable: options.executablePath, allowLimited: false },
    ...(options.getActiveWorkspace === undefined
      ? {}
      : { facade: { getActiveWorkspace: options.getActiveWorkspace } }),
  });
}

function promptCommand(requestId: string) {
  return {
    commandName: "core.prompt" as const,
    input: { text: "read package.json" },
    idempotencyKey: `idem-${requestId}` as IdempotencyKey,
    requestId: requestId as CommandRequestId,
  };
}

function assertOk<T>(response: { ok: boolean; result?: T; error?: unknown }): T {
  assert.equal(response.ok, true, `query failed: ${JSON.stringify(response)}`);
  assert.ok(response.result !== undefined);
  return response.result as T;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for composition event");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// P0-1 persisted workspace
// ---------------------------------------------------------------------------

test("P0-1 persisted active workspace is injected into Runtime start", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "omp-ws-active-"));
      try {
        const live = createLiveSession();
        const recorded = recordingPort({
          start: async (context) => {
            if (context.workspace === undefined) return undefined;
            return live.session;
          },
        });
        const composition = await createReadyComposition({
          profileDirectory,
          executablePath,
          session: recorded.port,
          getActiveWorkspace: () => ({ workspaceId: "ws-persisted", cwd: workspaceDir }),
        });
        assert.equal(composition.status, "ready");
        assert.equal(recorded.starts.length, 1);
        assert.deepEqual(recorded.starts[0]?.workspace, { workspaceId: "ws-persisted", cwd: workspaceDir });
        assert.notEqual(recorded.starts[0]?.workspace?.cwd, process.cwd());
        await composition.shutdown();
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});

test("P0-1 clean start without a workspace does not start Runtime and stays read-only", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const recorded = recordingPort({
        start: async (context) => {
          if (context.workspace === undefined) return undefined;
          return createLiveSession().session;
        },
      });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
      });
      assert.equal(composition.status, "read-only");
      assert.equal(recorded.starts.length, 1);
      assert.equal(recorded.starts[0]?.workspace, undefined);
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.runtime.status, "unavailable");
      assert.equal(bootstrap.runtime.unavailableCode, "no-workspace");
      assert.equal("snapshot" in bootstrap, false);
      const capabilities = assertOk(
        await composition.facade.query({ queryName: "capabilities.get", input: {} }),
      );
      assert.equal(capabilities.profile, "limited");
      assert.equal(
        capabilities.capabilities.some((entry) => entry.id === "core.prompt"),
        false,
      );
      await composition.shutdown();
    });
  });
});

test("P0-1 selecting the current workspace starts Runtime when it has not started yet", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "omp-ws-first-"));
      try {
        const live = createLiveSession();
        const recorded = recordingPort({
          start: async () => undefined,
          rebind: async () => live.session,
        });
        const composition = await createReadyComposition({
          profileDirectory,
          executablePath,
          session: recorded.port,
        });
        assert.equal(composition.status, "read-only");
        await composition.rebindWorkspace({ workspaceId: "ws-same", cwd: workspaceDir });
        assert.equal(recorded.rebinds.length, 1);
        assert.equal(recorded.rebinds[0]?.cwd, workspaceDir);
        assert.equal(composition.status, "ready");
        const bootstrap = await composition.facade.bootstrap();
        assert.equal(bootstrap.runtime.status, "connected");
        await composition.shutdown();
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});

test("P0-1 switching workspace A to B stops the old session and binds B", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const dirA = await mkdtemp(join(tmpdir(), "omp-ws-a-"));
      const dirB = await mkdtemp(join(tmpdir(), "omp-ws-b-"));
      try {
        const liveA = createLiveSession({ epoch: 1 });
        const liveB = createLiveSession({ epoch: 2, snapshot: { ...SNAPSHOT, runtimeEpoch: 2 as RuntimeEpoch } });
        const recorded = recordingPort({
          start: async () => liveA.session,
          rebind: async (workspace) => {
            if (workspace.cwd === dirB) return liveB.session;
            return liveA.session;
          },
        });
        const composition = await createReadyComposition({
          profileDirectory,
          executablePath,
          session: recorded.port,
          getActiveWorkspace: () => ({ workspaceId: "ws-a", cwd: dirA }),
        });
        const events: ClientEvent[] = [];
        composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
        await composition.rebindWorkspace({ workspaceId: "ws-b", cwd: dirB });
        assert.equal(recorded.rebinds.length, 1);
        assert.equal(recorded.rebinds[0]?.cwd, dirB);
        assert.equal(liveA.subscribeCount, 0, "old session publication listener must be cancelled");
        assert.equal(liveB.subscribeCount, 1);
        const bootstrap = await composition.facade.bootstrap();
        assert.equal(bootstrap.runtime.runtimeEpoch, 2);
        liveA.publish({ ...SNAPSHOT, stateVersion: 99 as StateVersion });
        assert.equal(
          events.some(
            (event) =>
              (event.kind === "snapshot" || event.kind === "state.changed") && event.stateVersion === 99,
          ),
          false,
          "late publication from workspace A must be ignored",
        );
        await composition.shutdown();
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    });
  });
});

test("P0-1 an unusable workspace path does not start Runtime on a wrong cwd", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const missing = join(profileDirectory, "does-not-exist-workspace");
      const recorded = recordingPort({
        start: async (context) => {
          if (context.workspace === undefined) return undefined;
          // Production port refuses missing directories; this fake mirrors that.
          const { access } = await import("node:fs/promises");
          try {
            await access(context.workspace.cwd);
          } catch {
            return undefined;
          }
          return createLiveSession().session;
        },
      });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-missing", cwd: missing }),
      });
      assert.equal(composition.status, "read-only");
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.runtime.status, "unavailable");
      const diagnostics = assertOk(
        await composition.facade.query({ queryName: "diagnostics.get", input: {} }),
      );
      assert.ok(diagnostics.entries.some((entry) => entry.level === "warning" || entry.level === "error"));
      await composition.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// P0-2 manifests
// ---------------------------------------------------------------------------

test("P0-2 connected Runtime bootstrap exposes core.prompt and matching command hash", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.runtime.status, "connected");
      assert.equal(bootstrap.capabilityManifest.hash, HELLO.capabilityManifest.hash);
      assert.ok(bootstrap.capabilityManifest.capabilities.some((entry) => entry.id === "core.prompt"));
      assert.equal(bootstrap.commandManifestHash, COMMAND_MANIFEST.hash);
      const commands = assertOk(
        await composition.facade.query({ queryName: "commands.getManifest", input: {} }),
      );
      assert.equal(commands.hash, HELLO.commandManifestHash);
      assert.equal(commands.upstreamCommit, HELLO.upstreamCommit);
      await composition.shutdown();
    });
  });
});

test("P0-2 Runtime unavailable keeps a limited neutral manifest", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const recorded = recordingPort({ start: async () => undefined });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
      });
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.capabilityManifest.profile, "limited");
      assert.deepEqual(bootstrap.capabilityManifest.capabilities, []);
      await composition.shutdown();
    });
  });
});

test("P0-2 rebind to a new epoch does not reuse the previous Runtime manifest", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const liveA = createLiveSession({ epoch: 1 });
      const liveB = createLiveSession({ epoch: 2, snapshot: { ...SNAPSHOT, runtimeEpoch: 2 as RuntimeEpoch } });
      liveB.setCapability({
        ...HELLO.capabilityManifest,
        hash: "cap-hash-epoch-2",
        generatedAt: "2026-08-15T00:00:00.000Z",
      });
      liveB.setCommand({ ...COMMAND_MANIFEST, hash: "cmd-hash-epoch-2" });
      const recorded = recordingPort({
        start: async () => liveA.session,
        rebind: async () => liveB.session,
      });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-a", cwd: profileDirectory }),
      });
      assert.equal((await composition.facade.bootstrap()).capabilityManifest.hash, "cap-hash-0001");
      await composition.rebindWorkspace({ workspaceId: "ws-b", cwd: profileDirectory });
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.capabilityManifest.hash, "cap-hash-epoch-2");
      assert.equal(bootstrap.commandManifestHash, "cmd-hash-epoch-2");
      await composition.shutdown();
    });
  });
});

test("P0-2 command manifest hash mismatch fails closed to limited commands", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      live.setCommand(undefined);
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const commands = assertOk(
        await composition.facade.query({ queryName: "commands.getManifest", input: {} }),
      );
      assert.notEqual(commands.hash, "cmd-hash-0001");
      assert.deepEqual(commands.commands, []);
      await composition.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// P0-3 publication forwarder
// ---------------------------------------------------------------------------

test("P0-3 stateVersion growth emits a full snapshot on the Facade", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const events: ClientEvent[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
      live.publish({ ...SNAPSHOT, stateVersion: 2 as StateVersion, isStreaming: true });
      assert.ok(
        events.some(
          (event) =>
            event.kind === "snapshot" && event.stateVersion === 2 && event.snapshot.isStreaming === true,
        ),
      );
      const state = assertOk(await composition.facade.query({ queryName: "session.state", input: {} }));
      assert.equal(state.isStreaming, true);
      live.publish({ ...SNAPSHOT, stateVersion: 3 as StateVersion, isStreaming: false });
      const ended = assertOk(await composition.facade.query({ queryName: "session.state", input: {} }));
      assert.equal(ended.isStreaming, false);
      await composition.shutdown();
    });
  });
});

test("P0-3 reload delivers the current publication once without a second Runtime change", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      assert.equal(live.subscribeCount, 1);
      live.publish({ ...SNAPSHOT, stateVersion: 4 as StateVersion, isStreaming: true });
      await composition.reload();
      assert.equal(live.subscribeCount, 1, "reload must not attach a second session listener");
      const bootstrap = await composition.facade.bootstrap();
      assert.equal("snapshot" in bootstrap, true);
      if ("snapshot" in bootstrap) {
        assert.equal(bootstrap.snapshot.isStreaming, true);
        assert.equal(bootstrap.stateVersion, 4);
      }
      const events: ClientEvent[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
      live.publish({ ...SNAPSHOT, stateVersion: 5 as StateVersion, isStreaming: false });
      const changed = events.filter((event) => event.kind === "snapshot" && event.stateVersion === 5);
      assert.equal(changed.length, 1);
      await composition.shutdown();
    });
  });
});

test("P0-3 a throwing publication subscriber does not block others or later publications", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      let remainingThrows = 1;
      composition.facade.subscribe({ scope: "all" }, (event) => {
        if (event.kind === "snapshot" && remainingThrows > 0) {
          remainingThrows -= 1;
          throw new Error("ui consumer failed");
        }
      });
      const later: number[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => {
        if (event.kind === "snapshot") later.push(Number(event.stateVersion));
      });
      live.publish({ ...SNAPSHOT, stateVersion: 8 as StateVersion });
      live.publish({ ...SNAPSHOT, stateVersion: 9 as StateVersion });
      const state = assertOk(await composition.facade.query({ queryName: "session.state", input: {} }));
      assert.equal(state.stateVersion, 9);
      assert.ok(later.includes(9), "a later publication must still reach a healthy subscriber");
      await composition.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// P0-4 receipts + end-to-end core.prompt
// ---------------------------------------------------------------------------

test("P0-4 core.prompt accepted is not terminal; completed reaches the reducer", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const streaming: boolean[] = [];
      let composition!: Awaited<ReturnType<typeof createDesktopHostComposition>>;
      live.setInvoke(async (request) => {
        live.publish({ ...SNAPSHOT, stateVersion: 2 as StateVersion, isStreaming: true });
        streaming.push(
          assertOk(await composition.facade.query({ queryName: "session.state", input: {} })).isStreaming,
        );
        live.publish({ ...SNAPSHOT, stateVersion: 3 as StateVersion, isStreaming: false });
        streaming.push(
          assertOk(await composition.facade.query({ queryName: "session.state", input: {} })).isStreaming,
        );
        return {
          type: "studio.receipt",
          requestId: request.requestId,
          commandId: "runtime-command-1" as CommandId,
          runtimeEpoch: 1 as RuntimeEpoch,
          stateVersion: 3 as StateVersion,
          status: "completed",
          result: { ok: true },
        };
      });
      const recorded = recordingPort({ start: async () => live.session });
      composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const bootstrap = await composition.facade.bootstrap();
      let state = reduceClientState(createInitialClientState(), {
        type: "bootstrap.set",
        bootstrap,
        occurredAt: T0,
      });
      composition.facade.subscribe({ scope: "all" }, (event) => {
        state = reduceClientState(state, { type: "event", event });
      });
      const accepted = await composition.facade.command(promptCommand("req-prompt-1"));
      assert.equal(accepted.status, "accepted");
      assert.notEqual(accepted.status, "completed");
      await waitUntil(() => state.commands["req-prompt-1" as CommandRequestId]?.status === "completed");
      assert.deepEqual(streaming, [true, false]);
      const command = state.commands["req-prompt-1" as CommandRequestId];
      assert.equal(command?.status, "completed");
      const receipts = Object.values(state.commands).filter((entry) => entry.status === "completed");
      assert.equal(receipts.length, 1, "terminal receipt must not be duplicated");
      await composition.shutdown();
    });
  });
});

test("P0-4 failed/rejected/outcome_unknown receipts reach the reducer", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      live.setInvoke(async () => {
        throw new Error("runtime rejected the prompt");
      });
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const bootstrap = await composition.facade.bootstrap();
      let state = reduceClientState(createInitialClientState(), {
        type: "bootstrap.set",
        bootstrap,
        occurredAt: T0,
      });
      composition.facade.subscribe({ scope: "all" }, (event) => {
        state = reduceClientState(state, { type: "event", event });
      });
      await composition.facade.command(promptCommand("req-fail-1"));
      await waitUntil(() => {
        const status = state.commands["req-fail-1" as CommandRequestId]?.status;
        return status === "failed" || status === "rejected" || status === "outcome_unknown";
      });
      const command = state.commands["req-fail-1" as CommandRequestId];
      assert.ok(command);
      assert.ok(
        command.status === "failed" || command.status === "rejected" || command.status === "outcome_unknown",
      );
      await composition.shutdown();
    });
  });
});

test("P0-4 runtime loss marks an in-flight prompt outcome_unknown without a fake completed", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      live.setInvoke(async () => {
        live.setHello(undefined);
        live.publish({ ...SNAPSHOT, stateVersion: 2 as StateVersion });
        throw new Error("bridge disconnected");
      });
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const bootstrap = await composition.facade.bootstrap();
      let state = reduceClientState(createInitialClientState(), {
        type: "bootstrap.set",
        bootstrap,
        occurredAt: T0,
      });
      composition.facade.subscribe({ scope: "all" }, (event) => {
        state = reduceClientState(state, { type: "event", event });
      });
      await composition.facade.command(promptCommand("req-loss-1"));
      await waitUntil(() => {
        const status = state.commands["req-loss-1" as CommandRequestId]?.status;
        return status === "outcome_unknown" || status === "failed";
      });
      const command = state.commands["req-loss-1" as CommandRequestId];
      assert.ok(command);
      assert.equal(command.status, "outcome_unknown");
      assert.notEqual(command.status, "completed");
      await composition.shutdown();
    });
  });
});

test("plan 01 integration: fake Runtime hello → bootstrap → core.prompt → accepted → streaming → completed", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const observedStreaming: boolean[] = [];
      let composition!: Awaited<ReturnType<typeof createDesktopHostComposition>>;
      live.setInvoke(async (request) => {
        live.publish({ ...SNAPSHOT, stateVersion: 2 as StateVersion, isStreaming: true });
        observedStreaming.push(
          assertOk(await composition.facade.query({ queryName: "session.state", input: {} })).isStreaming,
        );
        live.publish({ ...SNAPSHOT, stateVersion: 3 as StateVersion, isStreaming: false });
        observedStreaming.push(
          assertOk(await composition.facade.query({ queryName: "session.state", input: {} })).isStreaming,
        );
        return {
          type: "studio.receipt",
          requestId: request.requestId,
          commandId: "runtime-command-prompt" as CommandId,
          runtimeEpoch: 1 as RuntimeEpoch,
          stateVersion: 3 as StateVersion,
          status: "completed",
        };
      });
      const recorded = recordingPort({ start: async () => live.session });
      composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-demo", cwd: profileDirectory }),
      });
      const bootstrap = await composition.facade.bootstrap();
      assert.ok(bootstrap.capabilityManifest.capabilities.some((entry) => entry.id === "core.prompt"));
      assert.equal("snapshot" in bootstrap, true);
      let state = reduceClientState(createInitialClientState(), {
        type: "bootstrap.set",
        bootstrap,
        occurredAt: T0,
      });
      composition.facade.subscribe({ scope: "all" }, (event) => {
        state = reduceClientState(state, { type: "event", event });
      });
      const accepted = await composition.facade.command(promptCommand("req-e2e-1"));
      assert.equal(accepted.status, "accepted");
      await waitUntil(() => state.commands["req-e2e-1" as CommandRequestId]?.status === "completed");
      assert.deepEqual(observedStreaming, [true, false]);
      assert.equal(state.commands["req-e2e-1" as CommandRequestId]?.status, "completed");
      await composition.shutdown();
    });
  });
});

test("P1 runtime.install seam is not faked ready when unwired", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const live = createLiveSession();
      const recorded = recordingPort({ start: async () => live.session });
      const composition = await createReadyComposition({
        profileDirectory,
        executablePath,
        session: recorded.port,
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
      });
      const events: ClientEvent[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
      const accepted = await composition.facade.command({
        commandName: "runtime.install",
        input: {},
        idempotencyKey: "idem-install" as IdempotencyKey,
        requestId: "req-install-1" as CommandRequestId,
      });
      assert.equal(accepted.status, "accepted");
      await waitUntil(() => events.some((event) => event.kind === "command.receipt"));
      const receipt = events.find((event) => event.kind === "command.receipt");
      assert.equal(receipt?.kind, "command.receipt");
      if (receipt?.kind === "command.receipt") {
        assert.notEqual(receipt.receipt.status, "completed");
      }
      await composition.shutdown();
    });
  });
});
