import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  CommandRequestId,
  IdempotencyKey,
  RuntimeEpoch,
  RuntimeId,
  RuntimeInstallState,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import { HostBackend } from "@omp-studio/studio-host";

import { StudioHostClientFacade, type HostRuntimeAccess, type HostRuntimeHelloView } from "../src/index.js";

const HELLO: HostRuntimeHelloView = { runtimeId: "rt-1", runtimeEpoch: 1, classification: "managed" };

function snapshot() {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId: "sess-1" as SessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal" as const,
    approvalMode: "yolo" as const,
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

const T0 = "2026-08-18T04:00:00.000Z";

async function withFacade(
  options: {
    readonly installProbe?: () => RuntimeInstallState | Promise<RuntimeInstallState>;
    readonly install?: () => RuntimeInstallState | Promise<RuntimeInstallState>;
    readonly runtime?: HostRuntimeAccess;
  },
  run: (facade: StudioHostClientFacade) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-env-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-env" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-env" as never,
      },
      install: options.install ?? (async () => {
        throw new Error("runtime.install is not wired in environment tests");
      }),
      ...(options.installProbe === undefined ? {} : { installProbe: options.installProbe }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    });
    try {
      await run(facade);
    } finally {
      await facade.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

test("environment.get without a probe reports not-installed", async () => {
  await withFacade({}, async (facade) => {
    const response = await facade.query({ queryName: "environment.get", input: {} });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.result.installer.status, "not-installed");
    assert.equal(response.result.installer.availableVersion, undefined);
  });
});

test("environment.get surfaces update-available from the install probe", async () => {
  await withFacade(
    {
      installProbe: async () => ({
        status: "update-available",
        version: "1.0.0-studio.1",
        availableVersion: "1.0.1-studio.1",
        signature: "verified",
      }),
    },
    async (facade) => {
      const response = await facade.query({ queryName: "environment.get", input: {} });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.installer.status, "update-available");
      assert.equal(response.result.installer.version, "1.0.0-studio.1");
      assert.equal(response.result.installer.availableVersion, "1.0.1-studio.1");
    },
  );
});

test("diagnostics.get warns when a newer local artifact is available", async () => {
  await withFacade(
    {
      installProbe: async () => ({
        status: "update-available",
        version: "1.0.0-studio.1",
        availableVersion: "1.0.1-studio.1",
        signature: "verified",
      }),
    },
    async (facade) => {
      const response = await facade.query({ queryName: "diagnostics.get", input: {} });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.ok(
        response.result.entries.some(
          (entry) => entry.scope === "installer" && entry.level === "warning" && /newer trusted Runtime artifact/u.test(entry.message),
        ),
      );
    },
  );
});

test("environment.get keeps using the probe after runtime.install completes", async () => {
  await withFacade(
    {
      install: async () => ({ status: "installed", version: "1.0.0-studio.1", signature: "verified" }),
      installProbe: async () => ({
        status: "update-available",
        version: "1.0.0-studio.1",
        availableVersion: "1.0.2-studio.1",
        signature: "verified",
      }),
    },
    async (facade) => {
      const requestId = "req-install-probe" as CommandRequestId;
      const receipt = new Promise<void>((resolve) => {
        const unsub = facade.subscribe({ scope: "command", requestId }, (event) => {
          if (event.kind === "command.receipt") {
            unsub();
            resolve();
          }
        });
      });
      const accepted = await facade.command({
        commandName: "runtime.install",
        input: {},
        idempotencyKey: "install-probe" as IdempotencyKey,
        requestId,
      });
      assert.equal(accepted.status, "accepted");
      await receipt;
      const response = await facade.query({ queryName: "environment.get", input: {} });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.installer.status, "update-available");
      assert.equal(response.result.installer.availableVersion, "1.0.2-studio.1");
    },
  );
});

test("diagnostics.get keeps the generic unavailable sentence without an accessor", async () => {
  await withFacade({}, async (facade) => {
    const bootstrap = await facade.bootstrap();
    assert.equal(bootstrap.runtime.status, "unavailable");
    assert.equal(bootstrap.runtime.unavailableCode, undefined);
    const response = await facade.query({ queryName: "diagnostics.get", input: {} });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.ok(response.result.entries.some((entry) => entry.message === "Runtime is not available"));
  });
});

test("unavailable accessor reaches bootstrap, environment.get and diagnostics.get", async () => {
  const runtime: HostRuntimeAccess = {
    hello: () => undefined,
    unavailable: () => ({ code: "no-workspace", reason: "no workspace is selected" }),
  };
  await withFacade({ runtime }, async (facade) => {
    const bootstrap = await facade.bootstrap();
    assert.equal(bootstrap.runtime.status, "unavailable");
    assert.equal(bootstrap.runtime.unavailableCode, "no-workspace");
    assert.equal(bootstrap.runtime.unavailableReason, "no workspace is selected");
    const environment = await facade.query({ queryName: "environment.get", input: {} });
    assert.equal(environment.ok, true);
    if (!environment.ok) return;
    assert.equal(environment.result.runtime.unavailableCode, "no-workspace");
    const diagnostics = await facade.query({ queryName: "diagnostics.get", input: {} });
    assert.equal(diagnostics.ok, true);
    if (!diagnostics.ok) return;
    const entry = diagnostics.result.entries.find((item) => item.scope === "host");
    assert.equal(entry?.message, "Runtime is not available: no workspace is selected");
    assert.equal(entry?.detail?.code, "no-workspace");
  });
});

test("disconnect accessor reaches bootstrap, environment.get and diagnostics.get", async () => {
  let hello: HostRuntimeHelloView | undefined = HELLO;
  const runtime: HostRuntimeAccess = {
    hello: () => hello,
    snapshot: () => (hello === undefined ? undefined : snapshot()),
    disconnect: () =>
      hello === undefined ? { code: "process-exit", reason: "Runtime process exited (code=1)" } : undefined,
  };
  await withFacade({ runtime }, async (facade) => {
    const connected = await facade.bootstrap();
    assert.equal(connected.runtime.status, "connected");
    hello = undefined;
    const environment = await facade.query({ queryName: "environment.get", input: {} });
    assert.equal(environment.ok, true);
    if (!environment.ok) return;
    assert.equal(environment.result.runtime.status, "disconnected");
    assert.equal(environment.result.runtime.disconnectCode, "process-exit");
    assert.equal(environment.result.runtime.disconnectReason, "Runtime process exited (code=1)");
    const diagnostics = await facade.query({ queryName: "diagnostics.get", input: {} });
    assert.equal(diagnostics.ok, true);
    if (!diagnostics.ok) return;
    const entry = diagnostics.result.entries.find((item) => item.scope === "host");
    assert.equal(entry?.level, "error");
    assert.equal(entry?.message, "Runtime process exited: Runtime process exited (code=1)");
    assert.equal(entry?.detail?.code, "process-exit");
  });
});

test("runtime.ensure completes with the current connection", async () => {
  let hello: HostRuntimeHelloView | undefined;
  const runtime: HostRuntimeAccess = {
    hello: () => hello,
    snapshot: () => (hello === undefined ? undefined : snapshot()),
    ensure: async () => {
      hello = HELLO;
    },
  };
  await withFacade({ runtime }, async (facade) => {
    const requestId = "req-ensure" as CommandRequestId;
    const receipt = new Promise<void>((resolve) => {
      const unsub = facade.subscribe({ scope: "command", requestId }, (event) => {
        if (event.kind === "command.receipt") {
          assert.equal(event.receipt.status, "completed");
          if (event.receipt.status === "completed") {
            const connection = event.receipt.result as { status?: string; runtimeId?: string };
            assert.equal(connection.status, "connected");
            assert.equal(connection.runtimeId, "rt-1");
          }
          unsub();
          resolve();
        }
      });
    });
    const accepted = await facade.command({
      commandName: "runtime.ensure",
      input: {},
      idempotencyKey: "ensure-ok" as IdempotencyKey,
      requestId,
    });
    assert.equal(accepted.status, "accepted");
    await receipt;
  });
});

test("runtime.ensure fails closed when no ensure seam is wired", async () => {
  const runtime: HostRuntimeAccess = {
    hello: () => undefined,
  };
  await withFacade({ runtime }, async (facade) => {
    await assert.rejects(
      () =>
        facade.command({
          commandName: "runtime.ensure",
          input: {},
          idempotencyKey: "ensure-missing" as IdempotencyKey,
          requestId: "req-ensure-missing" as CommandRequestId,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CAPABILITY_UNAVAILABLE");
        assert.match(String((error as { message?: unknown }).message), /runtime\.ensure is not available/u);
        return true;
      },
    );
  });
});
