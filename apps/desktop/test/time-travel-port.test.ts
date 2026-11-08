import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SessionId } from "@omp-studio/client-contract";
import { StudioSessionArchiveReader } from "@omp-studio/studio-host";
import { TimeTravelService } from "../src/time-travel-service.js";
import { createTimeTravelPort } from "../src/time-travel-port.js";

test("restores code in the selected session, preserves a visible backup, and reports a failed conversation restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-time-travel-port-"));
  const workspace = join(root, "workspace"),
    sessionsRoot = join(root, "sessions"),
    archiveRoot = join(root, "archive");
  await mkdir(workspace);
  await mkdir(sessionsRoot);
  await mkdir(archiveRoot);
  const sessionId = "session" as SessionId;
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    cwd: workspace,
    timestamp: "2026-11-09T10:00:00Z",
  };
  const first = {
    type: "message",
    id: "first",
    parentId: null,
    timestamp: "2026-11-09T10:00:00Z",
    message: { role: "user", content: "first request" },
  };
  const later = {
    ...first,
    id: "later",
    parentId: "first",
    message: { role: "user", content: "later request" },
  };
  await writeFile(
    join(sessionsRoot, `2026-11-09T10-00-00-000Z_${sessionId}.jsonl`),
    [header, first, later].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const service = new TimeTravelService(join(root, "profile"));
  const reader = new StudioSessionArchiveReader({
    allowedCwd: workspace,
    sessionsRoot,
    archiveRoot,
  });
  let busy = false;
  let failNavigation = false;
  let navigations = 0;
  let prepared = 0;
  const port = createTimeTravelPort({
    service,
    workspace: () => workspace,
    reader: () => reader,
    assertIdle: () => {
      if (busy) throw new Error("busy");
    },
    prepareSession: async () => {
      prepared++;
      return { leafId: "later", supportsExactRestore: true };
    },
    navigate: async () => {
      navigations++;
      if (failNavigation) throw new Error("Runtime disconnected");
      return {};
    },
  });
  await service.updateSettings({ enabled: true });
  await writeFile(join(workspace, "file"), "old");
  const checkpoint = (await service.capture({
    workspace,
    sessionId,
    leafId: "first",
    phase: "after",
  }))!;
  await writeFile(join(workspace, "file"), "current");
  const preview = await port.preview({ sessionId, snapshotId: checkpoint.id });
  busy = true;
  await assert.rejects(
    port.restore({
      sessionId,
      leafId: "first",
      mode: "code",
      snapshotId: checkpoint.id,
      expectedRevision: preview.revision,
    }),
    /busy/u,
  );
  busy = false;
  const code = await port.restore({
    sessionId,
    leafId: "first",
    mode: "code",
    snapshotId: checkpoint.id,
    expectedRevision: preview.revision,
  });
  assert.equal(code.codeRestored, true);
  assert.equal(code.conversationRestored, false);
  assert.equal(prepared, 0);
  assert.equal(navigations, 0);
  assert.equal(await readFile(join(workspace, "file"), "utf8"), "old");
  assert.ok(
    (await port.timeline({ sessionId, branchLeafId: "first" })).points.some(
      (point) => point.id === code.backupId,
    ),
  );
  await writeFile(join(workspace, "file"), "edited again");
  failNavigation = true;
  const secondPreview = await port.preview({
    sessionId,
    snapshotId: checkpoint.id,
  });
  const both = await port.restore({
    sessionId,
    leafId: "first",
    mode: "both",
    snapshotId: checkpoint.id,
    expectedRevision: secondPreview.revision,
  });
  assert.equal(both.codeRestored, true);
  assert.equal(both.conversationRestored, false);
  assert.ok(both.backupId);
  assert.equal(prepared, 1);
  assert.equal(navigations, 1);
  await service.updateSettings({ enabled: false });
  await assert.rejects(
    port.restore({ sessionId, leafId: "first", mode: "conversation" }),
    /disabled/u,
  );
});
