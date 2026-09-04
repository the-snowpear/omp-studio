import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostCatalogEntry, HostSessionCatalogProvider } from "@omp-studio/host-client-api";
import { threadIdFor } from "@omp-studio/host-client-api";
import type { StudioSessionArchiveService } from "@omp-studio/studio-host";
import type { ThreadId } from "@omp-studio/studio-protocol";

import type { DesktopInteractionHost } from "../src/interaction-host.js";
import { createDesktopSemanticCommands } from "../src/session-commands.js";

const T0 = "2026-08-31T03:00:00.000Z";

interface ArchiveCall {
  readonly sessionId: string;
  readonly skipWriteGrace: boolean | undefined;
}

function archiveStub(calls: ArchiveCall[]): () => StudioSessionArchiveService {
  return () =>
    ({
      archive: async (sessionId: string, options?: { readonly skipWriteGrace?: boolean }) => {
        calls.push({ sessionId, skipWriteGrace: options?.skipWriteGrace });
        return { sessionId, archived: true };
      },
      unarchive: async (sessionId: string) => ({ sessionId, archived: false }),
    }) as unknown as StudioSessionArchiveService;
}

const catalog: HostSessionCatalogProvider = {
  async list(): Promise<HostCatalogEntry[]> {
    return [
      {
        sessionId: "session-a",
        modifiedAt: T0,
        messageCount: 2,
        status: "active",
      },
    ];
  },
};

const baseOptions = {
  sessionRef: { current: undefined },
  catalog,
  bindSession: () => {},
  interaction: {} as DesktopInteractionHost,
};

test("session.archive keeps the crash-tail grace armed for a dormant session", async () => {
  const calls: ArchiveCall[] = [];
  const commands = createDesktopSemanticCommands({ ...baseOptions, archive: archiveStub(calls) });
  await commands.archive!({ threadId: threadIdFor("session-a") as ThreadId });
  assert.deepEqual(calls, [{ sessionId: "session-a", skipWriteGrace: false }]);
});

test("session.archive skips the crash-tail grace when the Host just evacuated the writer", async () => {
  const calls: ArchiveCall[] = [];
  const commands = createDesktopSemanticCommands({
    ...baseOptions,
    archive: archiveStub(calls),
    evacuateResident: async () => ({ found: true }),
  });
  await commands.archive!({ threadId: threadIdFor("session-a") as ThreadId });
  assert.deepEqual(calls, [{ sessionId: "session-a", skipWriteGrace: true }]);
});

test("session.archive keeps the grace armed when evacuation finds no resident writer", async () => {
  const calls: ArchiveCall[] = [];
  const commands = createDesktopSemanticCommands({
    ...baseOptions,
    archive: archiveStub(calls),
    evacuateResident: async () => ({ found: false }),
  });
  await commands.archive!({ threadId: threadIdFor("session-a") as ThreadId });
  assert.deepEqual(calls, [{ sessionId: "session-a", skipWriteGrace: false }]);
});

test("session.archive skips the grace for a dormant Studio-origin session", async () => {
  const calls: ArchiveCall[] = [];
  const studioCatalog: HostSessionCatalogProvider = {
    async list() {
      return [{ ...(await catalog.list())[0]!, origin: "studio" }];
    },
  };
  const commands = createDesktopSemanticCommands({
    ...baseOptions,
    catalog: studioCatalog,
    archive: archiveStub(calls),
    evacuateResident: async () => ({ found: false }),
  });
  await commands.archive!({ threadId: threadIdFor("session-a") as ThreadId });
  assert.deepEqual(calls, [{ sessionId: "session-a", skipWriteGrace: true }]);
});
