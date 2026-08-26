import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicAuthorityIdentity, RuntimeInstallState } from "@omp-studio/client-contract";
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
  } finally {
    await facade.close();
  }
});
