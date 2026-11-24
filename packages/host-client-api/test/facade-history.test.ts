import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicAuthorityIdentity, RuntimeInstallState, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory } from "../src/index.js";
import type { HostBackend } from "@omp-studio/studio-host";

test("history.list stably puts pinned sessions first before applying the limit", async () => {
  const facade = new StudioHostClientFacade({
    authority: {
      authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"],
      authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"],
    },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    catalog: {
      list: async () => [
        { sessionId: "recent-unpinned", modifiedAt: "2026-08-23T03:00:00.000Z", messageCount: 1, status: "active" as const, pinned: false },
        { sessionId: "older-pinned", modifiedAt: "2026-08-23T02:00:00.000Z", messageCount: 1, status: "active" as const, pinned: true },
        { sessionId: "newest-pinned", title: "Persisted title", modifiedAt: "2026-08-23T01:00:00.000Z", messageCount: 1, status: "active" as const, pinned: true },
      ],
    },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });

  try {
    const response = await facade.query({ queryName: "history.list", input: { limit: 2 } });
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.deepEqual(response.result.entries.map((entry) => [entry.sessionId, entry.pinned]), [
        ["older-pinned", true],
        ["newest-pinned", true],
      ]);
      assert.equal(response.result.entries[0]?.title, undefined);
      assert.equal(response.result.entries[1]?.title, "Persisted title");
      assert.equal(response.result.total, 3);
    }
    const next = await facade.query({ queryName: "history.list", input: { limit: 2, offset: 2 } });
    assert.ok(next.ok);
    assert.deepEqual(next.result.entries.map(entry => entry.sessionId), ["recent-unpinned"]);
    assert.equal(next.result.total, 3);

    const sessionId = next.result.entries[0]?.sessionId;
    assert.ok(sessionId);
    const selected = await facade.query({ queryName: "history.list", input: { limit: 1, sessionId } });
    assert.ok(selected.ok);
    assert.deepEqual(selected.result.entries.map(entry => entry.sessionId), [sessionId]);
    assert.equal(selected.result.total, 1);
  } finally {
    await facade.close();
  }
});

test("history.list single-session query reaches a never-sent session through the catalog locate", async () => {
  // The list view only returns sessions with a conversation message; the Host's
  // single-session lookup can additionally reach a fresh session that the
  // renderer resolves for resume, archive and delete of an unsent row.
  const facade = new StudioHostClientFacade({
    authority: {
      authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"],
      authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"],
    },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    catalog: {
      list: async () => [
        { sessionId: "with-message", modifiedAt: "2026-08-23T03:00:00.000Z", messageCount: 1, status: "active" as const },
      ],
      locate: async (sessionId: string) =>
        sessionId === "never-sent"
          ? [{
              workspaceId: "ws-1" as WorkspaceId,
              workspaceName: "Project",
              entry: { sessionId: "never-sent", modifiedAt: "2026-08-23T04:00:00.000Z", messageCount: 0, status: "active" as const },
            }]
          : [],
    },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });

  try {
    const listed = await facade.query({ queryName: "history.list", input: { limit: 10 } });
    assert.ok(listed.ok);
    assert.deepEqual(listed.result.entries.map(entry => entry.sessionId), ["with-message"]);

    const hidden = await facade.query({ queryName: "history.list", input: { limit: 1, sessionId: "never-sent" as SessionId } });
    assert.ok(hidden.ok);
    assert.deepEqual(hidden.result.entries.map(entry => entry.sessionId), ["never-sent"]);
    assert.ok(hidden.result.entries[0]?.threadId?.startsWith("thread-"));
    assert.equal(hidden.result.total, 1);

    const scoped = await facade.query({ queryName: "history.list", input: { limit: 1, sessionId: "never-sent" as SessionId, workspaceId: "ws-other" as WorkspaceId } });
    assert.ok(scoped.ok);
    assert.deepEqual(scoped.result.entries, []);
  } finally {
    await facade.close();
  }
});
