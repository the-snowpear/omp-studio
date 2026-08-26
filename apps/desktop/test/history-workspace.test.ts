import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StudioHostError } from "@omp-studio/studio-host";
import type { WorkspaceId } from "@omp-studio/client-contract";

import { createWorkspaceSessionCatalog } from "../src/session-commands.js";

async function writeSession(directory: string, name: string, sessionId: string, cwd: string): Promise<void> {
  await writeFile(
    join(directory, `${name}.jsonl`),
    `${JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: "2026-08-23T00:00:00.000Z",
      cwd,
      studioOrigin: "studio-host",
    })}\n${JSON.stringify({
      type: "message",
      id: "m-1",
      parentId: null,
      timestamp: "2026-08-23T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    })}\n`,
    "utf8",
  );
}

test("workspace-scoped history stays isolated and rejects unknown workspace ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-history-workspaces-"));
  const previousAgentDir = process.env.OMP_AGENT_DIR;
  const agentDirectory = join(root, "agent");
  const sessionsDirectory = join(agentDirectory, "sessions", "project");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  await writeSession(sessionsDirectory, "a", "session-a", workspaceA);
  await writeSession(sessionsDirectory, "b", "session-b", workspaceB);
  process.env.OMP_AGENT_DIR = agentDirectory;

  try {
    const catalog = createWorkspaceSessionCatalog(
      () => workspaceA,
      async (workspaceId) => ({
        "workspace-a": workspaceA,
        "workspace-b": workspaceB,
      } as Record<string, string | undefined>)[workspaceId],
    );
    const scopedA = await catalog.list({ workspaceId: "workspace-a" as WorkspaceId });
    const scopedB = await catalog.list({ workspaceId: "workspace-b" as WorkspaceId });
    const activeCompatibility = await catalog.list();
    assert.deepEqual(scopedA.map((entry) => entry.sessionId), ["session-a"]);
    assert.deepEqual(scopedB.map((entry) => entry.sessionId), ["session-b"]);
    assert.deepEqual(activeCompatibility.map((entry) => entry.sessionId), ["session-a"]);
    await assert.rejects(
      () => Promise.resolve(catalog.list({ workspaceId: "missing" as WorkspaceId })),
      (error: unknown) => error instanceof StudioHostError && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
    else process.env.OMP_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
