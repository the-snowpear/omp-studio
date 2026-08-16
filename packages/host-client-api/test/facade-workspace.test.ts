/**
 * Facade workspace-seam tests: `projects.list` query and the
 * `workspace.open` / `workspace.pick` command lifecycle over injected
 * workspace services.
 *
 * Path discipline: whatever a service returns, the facade never invents or
 * forwards workspace paths; the adapter test additionally proves the
 * serialized command result of a real registry pick contains no absolute
 * path (the temp directory itself must never appear).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientEvent,
  ClientTransport,
  CommandRequestId,
  IdempotencyKey,
  WorkspaceId,
  WorkspaceListReadModel,
} from "@omp-studio/client-contract";
import type { HostWorkspaceService } from "../src/services.js";
import { HostBackend, WorkspaceRegistry } from "@omp-studio/studio-host";

import {
  StudioHostClientFacade,
  createDefaultHostDiagnosticsFactory,
} from "../src/index.js";
import { createOmpWorkspaceService } from "../src/omp-workspace-adapter.js";

const T0 = "2026-08-14T00:00:00.000Z";

interface FacadeHarness {
  facade: ClientTransport;
  close(): Promise<void>;
}

async function withFacade(
  workspaces: HostWorkspaceService | undefined,
  run: (harness: FacadeHarness) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-ws-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-ws-test" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: createDefaultHostDiagnosticsFactory(),
      install: async () => {
        throw new Error("runtime.install is not wired in facade workspace tests");
      },
      ...(workspaces === undefined ? {} : { workspaces }),
    });
    try {
      await run({ facade, close: async () => facade.close() });
    } finally {
      await facade.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

function waitReceipt(transport: ClientTransport, requestId: string): Promise<ClientEvent> {
  return new Promise((resolve) => {
    const unsub = transport.subscribe(
      { scope: "command", requestId: requestId as CommandRequestId },
      (event) => {
        if (event.kind === "command.receipt" && event.receipt.requestId === requestId) {
          unsub();
          resolve(event);
        }
      },
    );
  });
}

async function runWorkspaceCommand(
  transport: ClientTransport,
  name: "workspace.open" | "workspace.pick",
  input: unknown,
  key: string,
): Promise<ClientEvent> {
  const requestId = `req-${key}` as CommandRequestId;
  // Subscribe before issuing: a synchronous failure path can emit the
  // terminal receipt within the same microtask batch as the acceptance.
  const receiptPromise = waitReceipt(transport, requestId);
  const accepted = await transport.command({
    commandName: name,
    input: input as never,
    idempotencyKey: key as IdempotencyKey,
    requestId,
  });
  assert.equal(accepted.status, "accepted");
  return await receiptPromise;
}

test("projects.list with no workspaces seam returns an empty list", async () => {
  await withFacade(undefined, async ({ facade }) => {
    const response = await facade.query({ queryName: "projects.list", input: {} });
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.deepEqual(response.result, { workspaces: [] });
    }
  });
});

test("projects.list with a fake seam returns the fixture list; JSON stays path-free", async () => {
  const fake: HostWorkspaceService = {
    list: async () => ({
      workspaces: [
        { workspaceId: "ws-fixture" as WorkspaceId, name: "fixture-demo", lastOpenedAt: T0, active: true },
      ],
      activeWorkspaceId: "ws-fixture" as WorkspaceId,
    }),
    open: async () => ({ workspaces: [] }),
    pick: async () => {
      throw new Error("not used");
    },
  };
  await withFacade(fake, async ({ facade }) => {
    const response = await facade.query({ queryName: "projects.list", input: {} });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.result.workspaces.length, 1);
    assert.equal(response.result.workspaces[0]!.name, "fixture-demo");
    const json = JSON.stringify(response);
    assert.ok(!json.includes("C:\\"), "fixture JSON must not contain a Windows drive path");
    assert.ok(!json.includes("/Users"), "fixture JSON must not contain a POSIX home path");
  });
});

test("workspace.pick through the real adapter completes and never serializes the picked path", async () => {
  const picked = await mkdtemp(join(tmpdir(), "omp-facade-picked-"));
  try {
    await withFacade(undefined, async ({ facade }) => {
      // A dedicated facade wired with the real adapter + registry.
      const profile = await mkdtemp(join(tmpdir(), "omp-facade-ws2-"));
      try {
        const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
        await registry.load();
        const service = createOmpWorkspaceService({
          registry,
          pickDirectory: async () => picked,
          now: () => T0,
        });
        const backend = new HostBackend({ stateDirectory: profile });
        await backend.initialize();
        const realFacade = new StudioHostClientFacade({
          authority: { authorityId: "auth-ws-real" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
          platform: "win32",
          arch: "x64",
          backend,
          capabilityManifest: () => undefined,
          commandManifest: () => undefined,
          catalog: { list: async () => [] },
          diagnostics: createDefaultHostDiagnosticsFactory(),
          install: async () => {
            throw new Error("not wired");
          },
          workspaces: service,
        });
        try {
          const event = await runWorkspaceCommand(realFacade, "workspace.pick", { name: "Studio Sandbox" }, "pick-1");
          assert.equal(event.kind, "command.receipt");
          if (event.kind !== "command.receipt") return;
          assert.equal(event.receipt.status, "completed");
          const result = event.receipt.result as WorkspaceListReadModel;
          assert.equal(result.workspaces.length, 1);
          assert.equal(result.workspaces[0]!.name, "Studio Sandbox");
          assert.equal(result.workspaces[0]!.active, true);
          const json = JSON.stringify(event);
          assert.ok(!json.includes("C:\\"), "completed pick receipt must not leak a drive path");
          assert.ok(!json.includes("/Users"), "completed pick receipt must not leak a home path");
          assert.ok(!json.includes(picked), "completed pick receipt must not contain the picked directory");
        } finally {
          await realFacade.close();
        }
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
  } finally {
    await rm(picked, { recursive: true, force: true });
  }
});

test("workspace.open with an unknown id fails; the receipt is not completed", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-ws3-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
      now: () => T0,
    });
    await withFacade(service, async ({ facade }) => {
      const event = await runWorkspaceCommand(facade, "workspace.open", { workspaceId: "ws-unknown" }, "open-1");
      assert.equal(event.kind, "command.receipt");
      if (event.kind !== "command.receipt") return;
      assert.notEqual(event.receipt.status, "completed");
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("workspace.pick cancelled by the user is not reported as completed", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-ws4-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
      now: () => T0,
    });
    await withFacade(service, async ({ facade }) => {
      const event = await runWorkspaceCommand(facade, "workspace.pick", {}, "pick-cancel");
      assert.equal(event.kind, "command.receipt");
      if (event.kind !== "command.receipt") return;
      assert.notEqual(event.receipt.status, "completed");
      if (event.receipt.status === "failed") {
        assert.match(event.receipt.error.message, /cancel/u);
      }
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
