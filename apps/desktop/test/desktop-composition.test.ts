/**
 * Desktop Host composition contract tests (FRONTEND_INTEGRATION.md §9.2).
 *
 * Fakes prove: initialization order, no-runtime read-only bootstrap,
 * trusted-resolution session creation, second-owner rejection, reload
 * preservation, and shutdown ordering with fail-closed error behavior.
 * Nothing here spawns a process or touches real user state; the profile
 * directory is a throwaway temp directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClientBootstrap, ClientError, CommandRequestId, EventCursor, IdempotencyKey, ResidentsReadModel, WorkspaceId } from "@omp-studio/client-contract";
import { privateEndpoint, type PlatformPort } from "@omp-studio/platform";
import { AuthorityAlreadyOwnedError } from "@omp-studio/platform-win32";
import {
  FULL_PARITY_REQUIRED_CAPABILITIES,
  type OperatorCommandManifest,
  type OperatorStateSnapshot,
  type RequestId,
  type RuntimeEpoch,
  type RuntimeId,
  type RuntimeInstanceId,
  type SessionId,
  type StateVersion,
  type StudioHelloResponse,
} from "@omp-studio/studio-protocol";
import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import type { RuntimeProbePort, StudioRuntimeSessionController } from "@omp-studio/studio-host";

import {
  createDesktopHostComposition,
  type DesktopAuthorityLock,
  type DesktopPrivateEndpoint,
  type DesktopRuntimeSession,
  type DesktopRuntimeSessionContext,
  type DesktopRuntimeSessionPort,
} from "../src/host-composition.js";
import type { DesktopHostComposition } from "../src/types.js";

const UPSTREAM_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const T0 = "2026-08-12T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function fakePlatform(profileDirectory: string): { port: PlatformPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      platform: "win32",
      appDataDirectory: async () => {
        calls.push("appDataDirectory");
        return profileDirectory;
      },
      runtimeExecutableName: () => "omp.exe",
      createPrivateEndpoint: async () => {
        throw new Error("unused in composition tests");
      },
      createProcessContainment: () => {
        throw new Error("unused in composition tests");
      },
      revealPath: async () => {},
      openExternal: async () => {},
    },
  };
}

function fakeAuthorityLock(acquireError?: Error): { port: DesktopAuthorityLock; calls: string[]; released: boolean } {
  const calls: string[] = [];
  let released = false;
  return {
    calls,
    get released() {
      return released;
    },
    port: {
      async acquire() {
        calls.push("acquire");
        if (acquireError !== undefined) {
          throw acquireError;
        }
        return {
          authorityId: "auth-0001",
          epoch: "epoch-0001",
          release: async () => {
            calls.push("lease.release");
            released = true;
          },
        };
      },
    },
  };
}

function fakePrivateEndpoint(options: { fail?: boolean; releaseError?: Error } = {}): {
  port: DesktopPrivateEndpoint;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async createCurrentUserOnly() {
        calls.push("endpoint.create");
        if (options.fail) {
          throw new Error("endpoint creation failed");
        }
        return {
          endpoint: privateEndpoint("in-memory", "authority-0001"),
          release: async () => {
            calls.push("endpoint.release");
            if (options.releaseError !== undefined) {
              throw options.releaseError;
            }
          },
        };
      },
    },
  };
}

function fakeSessionPort(options: {
  ready?: boolean;
  startError?: Error;
  stopError?: Error;
  snapshot?: OperatorStateSnapshot;
  listResidents?: () => ResidentsReadModel;
} = {}): {
  port: DesktopRuntimeSessionPort;
  calls: string[];
  contexts: DesktopRuntimeSessionContext[];
  beforeStop: (hook: () => void) => void;
} {
  const calls: string[] = [];
  const contexts: DesktopRuntimeSessionContext[] = [];
  let beforeStop: (() => void) | undefined;
  return {
    calls,
    contexts,
    beforeStop(hook) {
      beforeStop = hook;
    },
    port: {
      async start(context) {
        calls.push("session.start");
        if (options.startError !== undefined) {
          throw options.startError;
        }
        contexts.push(context);
        if (!options.ready) {
          return undefined;
        }
        const snapshot = options.snapshot ?? SNAPSHOT;
        const session: DesktopRuntimeSession = {
          controller: {
            refresh: async () => ({ commitSeq: 1, publishedAt: T0, snapshot, terminalOutcomes: [] }),
            invoke: async () => {
              throw new Error("unused in composition tests");
            },
            runtimeLost: () => [],
            publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot, terminalOutcomes: [] }),
            dispose: () => {},
          } as unknown as StudioRuntimeSessionController,
          hello: () => HELLO_VIEW,
          capabilityManifest: () => undefined,
          commandManifest: () => undefined,
          onPublication: () => () => {},
        };
        return session;
      },
      async stop() {
        calls.push("session.stop");
        if (beforeStop !== undefined) {
          await beforeStop();
        }
        if (options.stopError !== undefined) {
          throw options.stopError;
        }
      },
      ...(options.listResidents === undefined ? {} : { listResidents: options.listResidents }),
    },
  };
}

async function withTempProfile(run: (profileDirectory: string) => Promise<void>): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "omp-desktop-profile-"));
  try {
    await run(profileDirectory);
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

async function withTempExecutable(run: (executablePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-desktop-exe-"));
  const executablePath = join(directory, "omp-test.exe");
  await writeFile(executablePath, "fake runtime payload for fingerprinting");
  try {
    await run(executablePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertWithoutSnapshot(bootstrap: ClientBootstrap): void {
  assert.equal(bootstrap.runtime.status, "unavailable");
  assert.equal(bootstrap.runtime.classification, "unavailable");
  assert.equal("snapshot" in bootstrap, false);
  assert.equal("stateVersion" in bootstrap, false);
  assert.equal("cursor" in bootstrap, false);
}

function assertWithSnapshot(bootstrap: ClientBootstrap): asserts bootstrap is ClientBootstrap & { snapshot: OperatorStateSnapshot; stateVersion: StateVersion; cursor: EventCursor } {
  assert.ok("snapshot" in bootstrap);
}

/**
 * Assert a rejection matches the closed-facade contract: a structured
 * ClientError object with code "TRANSPORT_ERROR" and a message mentioning "closed".
 */
function assertClosedFacadeError(error: unknown): void {
  assert.equal(typeof error, "object");
  assert.notEqual(error, null);
  const clientError = error as ClientError;
  assert.equal(clientError.code, "TRANSPORT_ERROR");
  assert.match(clientError.message, /closed/u);
}

// ---------------------------------------------------------------------------
// Initialization order + no-runtime read-only bootstrap
// ---------------------------------------------------------------------------

test("composition follows the P1 initialization order and bootstraps read-only without a runtime", async () => {
  await withTempProfile(async (profileDirectory) => {
    const platform = fakePlatform(profileDirectory);
    const lock = fakeAuthorityLock();
    const endpoint = fakePrivateEndpoint();
    const session = fakeSessionPort();
    const composition = await createDesktopHostComposition({
      platform: platform.port,
      authorityLock: lock.port,
      privateEndpoint: endpoint.port,
      runtimeSession: session.port,
      resolver: { probe: fullParityProbe() },
    });

    // Managed preference with nothing installed resolves to rejected: the
    // session port must never be invoked and the composition is read-only.
    assert.deepEqual(session.calls, []);
    assert.equal(composition.status, "read-only");
    assert.deepEqual(platform.calls, ["appDataDirectory"]);
    assert.deepEqual(lock.calls, ["acquire"]);
    assert.deepEqual(endpoint.calls, ["endpoint.create"]);
    assert.deepEqual(session.contexts, []);

    const bootstrap = await composition.facade.bootstrap();
    assertWithoutSnapshot(bootstrap);
    assert.equal(bootstrap.runtime.unavailableCode, "resolution-rejected");
    assert.equal(bootstrap.authority.authorityId, "auth-0001");
    assert.equal(typeof bootstrap.authority.authorityEpoch, "number");
    assert.ok(bootstrap.authority.authorityEpoch >= 1);
    assert.equal(lock.released, false);
    assert.deepEqual(endpoint.calls, ["endpoint.create"]);
  });
});

// ---------------------------------------------------------------------------
// Trusted resolution -> ready composition
// ---------------------------------------------------------------------------

test("a trusted resolution creates the runtime session and bootstraps ready", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const platform = fakePlatform(profileDirectory);
      const lock = fakeAuthorityLock();
      const endpoint = fakePrivateEndpoint();
      const session = fakeSessionPort({ ready: true });
      const composition = await createDesktopHostComposition({
        platform: platform.port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });

      assert.equal(composition.status, "ready");
      // Order: profile directory -> lock -> endpoint -> session.
      assert.deepEqual(platform.calls, ["appDataDirectory"]);
      assert.deepEqual(lock.calls, ["acquire"]);
      assert.deepEqual(endpoint.calls, ["endpoint.create"]);
      assert.deepEqual(session.calls, ["session.start"]);
      assert.equal(session.contexts.length, 1);
      const context = session.contexts[0];
      assert.ok(context);
      assert.equal(context.resolution.classification, "compatible-system");
      assert.equal(context.endpoint.kind, "in-memory");
      assert.equal(context.profileDirectory, profileDirectory);
      assert.equal(context.runtimeInstallDirectory, join(profileDirectory, "runtimes"));

      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.runtime.status, "connected");
      assert.equal(bootstrap.runtime.classification, "compatible-system");
      assert.equal(bootstrap.runtime.runtimeId, "rt-0001");
      assertWithSnapshot(bootstrap);
      assert.equal(bootstrap.stateVersion, 1);
      assert.equal(lock.released, false);
      assert.deepEqual(endpoint.calls, ["endpoint.create"]);
    });
  });
});

test("isBusy reports streaming residents first and falls back to the current snapshot", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const baseOptions = () => ({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: fakeAuthorityLock().port,
        privateEndpoint: fakePrivateEndpoint().port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system" as const, executable: executablePath, allowLimited: false },
      });

      const residentsWith = (phase: "running" | "compacting" | "waiting" | "idle"): ResidentsReadModel => ({
        residents: [
          {
            sessionId: "sess-0002" as SessionId,
            workspaceId: "ws-0001" as WorkspaceId,
            phase,
            pendingMessages: 0,
            lastActivityAt: T0,
          },
        ],
        activeSessionId: "sess-0002" as SessionId,
        generatedAt: T0,
      });

      const withResidents = async (phase: "running" | "compacting" | "waiting" | "idle"): Promise<DesktopHostComposition> =>
        createDesktopHostComposition({
          ...baseOptions(),
          runtimeSession: fakeSessionPort({ ready: true, listResidents: () => residentsWith(phase) }).port,
        });

      // Residents read model is authoritative when the port exposes one.
      assert.equal((await withResidents("running")).isBusy(), true);
      assert.equal((await withResidents("compacting")).isBusy(), true);
      assert.equal((await withResidents("waiting")).isBusy(), false);
      assert.equal((await withResidents("idle")).isBusy(), false);

      // Without a broker view the current session snapshot decides.
      const withSnapshot = async (snapshot: OperatorStateSnapshot): Promise<DesktopHostComposition> =>
        createDesktopHostComposition({
          ...baseOptions(),
          runtimeSession: fakeSessionPort({ ready: true, snapshot }).port,
        });
      assert.equal((await withSnapshot({ ...SNAPSHOT, isStreaming: true })).isBusy(), true);
      assert.equal((await withSnapshot({ ...SNAPSHOT, isCompacting: true })).isBusy(), true);
      assert.equal((await withSnapshot(SNAPSHOT)).isBusy(), false);
    });
  });
});

test("managedInstall.installDirectory is handed to the runtime session as the live tree", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const installDirectory = await mkdtemp(join(tmpdir(), "omp-live-runtime-"));
      try {
        const session = fakeSessionPort({ ready: true });
        const composition = await createDesktopHostComposition({
          platform: fakePlatform(profileDirectory).port,
          authorityLock: fakeAuthorityLock().port,
          privateEndpoint: fakePrivateEndpoint().port,
          runtimeSession: session.port,
          resolver: { probe: fullParityProbe() },
          preference: { kind: "system", executable: executablePath, allowLimited: false },
          managedInstall: { installDirectory },
        });
        assert.equal(session.contexts[0]?.runtimeInstallDirectory, installDirectory);
        await composition.shutdown();
      } finally {
        await rm(installDirectory, { recursive: true, force: true });
      }
    });
  });
});

test("a not-ready session port yields a read-only composition without a fake snapshot", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const session = fakeSessionPort({ ready: false });
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: fakeAuthorityLock().port,
        privateEndpoint: fakePrivateEndpoint().port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });
      assert.equal(composition.status, "read-only");
      assert.deepEqual(session.calls, ["session.start"]);
      const bootstrap = await composition.facade.bootstrap();
      assertWithoutSnapshot(bootstrap);
      assert.equal(bootstrap.runtime.unavailableCode, "no-workspace");
    });
  });
});

test("without a runtime session port the composition stays read-only even with a trusted resolution", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: fakeAuthorityLock().port,
        privateEndpoint: fakePrivateEndpoint().port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });
      assert.equal(composition.status, "read-only");
      const bootstrap = await composition.facade.bootstrap();
      assertWithoutSnapshot(bootstrap);
      assert.equal(bootstrap.runtime.unavailableCode, "not-wired");
    });
  });
});

test("managedInstall without trusted keys fails closed instead of reporting installed", async () => {
  await withTempProfile(async (profileDirectory) => {
    const composition = await createDesktopHostComposition({
      platform: fakePlatform(profileDirectory).port,
      authorityLock: fakeAuthorityLock().port,
      privateEndpoint: fakePrivateEndpoint().port,
      managedInstall: {},
      installer: {},
    });
    const events: Array<{ kind: string; receipt?: { status: string; error?: { message: string } } }> = [];
    composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
    const accepted = await composition.facade.command({
      commandName: "runtime.install",
      input: {},
      idempotencyKey: "idem-install-keys" as IdempotencyKey,
      requestId: "req-install-keys" as CommandRequestId,
    });
    assert.equal(accepted.status, "accepted");
    const started = Date.now();
    while (!events.some((event) => event.kind === "command.receipt") && Date.now() - started < 2000) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const receipt = events.find((event) => event.kind === "command.receipt");
    assert.equal(receipt?.receipt?.status, "failed");
    assert.match(receipt?.receipt?.error?.message ?? "", /OMP_RUNTIME_TRUSTED_PUBLIC_KEY/u);
    await composition.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Second owner fails closed
// ---------------------------------------------------------------------------

test("a second owner rejects without creating an endpoint or releasing anything", async () => {
  await withTempProfile(async (profileDirectory) => {
    const lock = fakeAuthorityLock(new AuthorityAlreadyOwnedError("desktop", T0));
    const endpoint = fakePrivateEndpoint();
    const session = fakeSessionPort();
    await assert.rejects(
      createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
      }),
      (error: unknown) => error instanceof AuthorityAlreadyOwnedError,
    );
    assert.deepEqual(lock.calls, ["acquire"]);
    assert.deepEqual(endpoint.calls, []);
    assert.deepEqual(session.calls, []);
    assert.equal(lock.released, false);
  });
});

// ---------------------------------------------------------------------------
// Reload preservation
// ---------------------------------------------------------------------------

test("reload returns the same composition, swaps the facade and leaves Host/Runtime alive", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const lock = fakeAuthorityLock();
      const endpoint = fakePrivateEndpoint();
      const session = fakeSessionPort({ ready: true });
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });
      const oldFacade = composition.facade;

      const reloaded: DesktopHostComposition = await composition.reload();

      assert.equal(reloaded, composition);
      assert.notEqual(composition.facade, oldFacade);
      assert.deepEqual(session.calls, ["session.start"]);
      assert.deepEqual(endpoint.calls, ["endpoint.create"]);
      assert.deepEqual(lock.calls, ["acquire"]);
      assert.equal(lock.released, false);

      // The old client session is closed; the new one serves a fresh bootstrap.
      await assert.rejects(
        () => oldFacade.bootstrap(),
        (error: unknown) => {
          assertClosedFacadeError(error);
          return true;
        },
      );
      const bootstrap = await composition.facade.bootstrap();
      assert.equal(bootstrap.runtime.status, "connected");
      assert.equal("snapshot" in bootstrap, true);
    });
  });
});

// ---------------------------------------------------------------------------
// Shutdown ordering and fail-closed behavior
// ---------------------------------------------------------------------------

test("shutdown orders facade close, runtime stop, endpoint release, lease release", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const lock = fakeAuthorityLock();
      const endpoint = fakePrivateEndpoint();
      const session = fakeSessionPort({ ready: true });
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });
      // The facade client session must be closed before the runtime stops.
      session.beforeStop(async () => {
        await assert.rejects(
          () => composition.facade.bootstrap(),
          (error: unknown) => {
            assertClosedFacadeError(error);
            return true;
          },
        );
      });

      await composition.shutdown();

      assert.deepEqual(session.calls, ["session.start", "session.stop"]);
      assert.deepEqual(endpoint.calls, ["endpoint.create", "endpoint.release"]);
      assert.deepEqual(lock.calls, ["acquire", "lease.release"]);
      assert.equal(lock.released, true);
      await assert.rejects(
        () => composition.facade.bootstrap(),
        (error: unknown) => {
          assertClosedFacadeError(error);
          return true;
        },
      );
      // A second shutdown is a no-op.
      await composition.shutdown();
      assert.deepEqual(lock.calls, ["acquire", "lease.release"]);
    });
  });
});

test("shutdown failure fails closed and never releases a lease it owns", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const lock = fakeAuthorityLock();
      const endpoint = fakePrivateEndpoint({ releaseError: new Error("endpoint release failed") });
      const session = fakeSessionPort({ ready: true });
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });

      await assert.rejects(() => composition.shutdown(), /endpoint release failed/u);

      // Runtime was stopped but the authority lease stays held (fail closed).
      assert.deepEqual(session.calls, ["session.start", "session.stop"]);
      assert.deepEqual(endpoint.calls, ["endpoint.create", "endpoint.release"]);
      assert.deepEqual(lock.calls, ["acquire"]);
      assert.equal(lock.released, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Creation failure cleanup
// ---------------------------------------------------------------------------

test("creation failure releases every acquired resource without masking the original error", async () => {
  await withTempProfile(async (profileDirectory) => {
    const lock = fakeAuthorityLock();
    const endpoint = fakePrivateEndpoint({ fail: true });
    await assert.rejects(
      createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
      }),
      /endpoint creation failed/u,
    );
    assert.deepEqual(lock.calls, ["acquire", "lease.release"]);
    assert.equal(lock.released, true);
    assert.deepEqual(endpoint.calls, ["endpoint.create"]);
  });
});

test("a session start failure keeps a read-only Host facade", async () => {
  await withTempProfile(async (profileDirectory) => {
    await withTempExecutable(async (executablePath) => {
      const lock = fakeAuthorityLock();
      const endpoint = fakePrivateEndpoint();
      const session = fakeSessionPort({ startError: new Error("runtime failed to start") });
      const composition = await createDesktopHostComposition({
        platform: fakePlatform(profileDirectory).port,
        authorityLock: lock.port,
        privateEndpoint: endpoint.port,
        runtimeSession: session.port,
        resolver: { probe: fullParityProbe() },
        preference: { kind: "system", executable: executablePath, allowLimited: false },
      });
      assert.equal(composition.status, "read-only");
      const bootstrap = await composition.facade.bootstrap();
      assertWithoutSnapshot(bootstrap);
      assert.equal(bootstrap.runtime.unavailableCode, "launch-failed");
      assert.match(bootstrap.runtime.unavailableReason ?? "", /runtime failed to start/u);
      assert.deepEqual(session.calls, ["session.start", "session.stop"]);
      assert.deepEqual(endpoint.calls, ["endpoint.create"]);
      assert.deepEqual(lock.calls, ["acquire"]);
      assert.equal(lock.released, false);
      await composition.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// Authority identity stability
// ---------------------------------------------------------------------------

test("the authority identity is stable across reloads for one lease", async () => {
  await withTempProfile(async (profileDirectory) => {
    const lock = fakeAuthorityLock();
    const composition = await createDesktopHostComposition({
      platform: fakePlatform(profileDirectory).port,
      authorityLock: lock.port,
      privateEndpoint: fakePrivateEndpoint().port,
    });
    const first = await composition.facade.bootstrap();
    await composition.reload();
    const second = await composition.facade.bootstrap();
    assert.deepEqual(first.authority, second.authority);
    assert.ok(first.authority.authorityEpoch >= 1);
  });
});

test("Runtime maintenance rejects missing rollback targets and active residents", async () => {
  await withTempProfile(async (profileDirectory) => {
    let busy = false;
    const composition = await createDesktopHostComposition({
      platform: fakePlatform(profileDirectory).port,
      authorityLock: fakeAuthorityLock().port,
      privateEndpoint: fakePrivateEndpoint().port,
      runtimeSession: fakeSessionPort({
        listResidents: () => ({
          residents: busy ? [{ phase: "running", sessionId: "session-test" as ResidentsReadModel["residents"][number]["sessionId"], workspaceId: "workspace-test" as WorkspaceId, pendingMessages: 0, lastActivityAt: T0 }] : [],
          generatedAt: T0,
        } as ResidentsReadModel),
      }).port,
    });
    try {
      assert.ok(composition.rollbackRuntime);
      assert.ok(composition.pruneRuntimes);
      await assert.rejects(() => composition.rollbackRuntime!(), /No previous Runtime/);
      await composition.pruneRuntimes();
      busy = true;
      await assert.rejects(() => composition.rollbackRuntime!(), /Finish active sessions/);
      await assert.rejects(() => composition.pruneRuntimes!(), /Finish active sessions/);
    } finally {
      await composition.shutdown();
    }
  });
});
