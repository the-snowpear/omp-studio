import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import type { HostCatalogEntry, HostSessionCatalogProvider } from "@omp-studio/host-client-api";
import { threadIdFor } from "@omp-studio/host-client-api";
import { SessionDeleteServiceError, type StudioSessionArchiveService, type StudioSessionDeleteService } from "@omp-studio/studio-host";
import type { DesktopRuntimeSession, DesktopSessionSwitchIntent } from "../src/host-composition.js";
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


test("resume preparation registers execution cwd only, and failed restore retains the original Worker binding", async () => {
  const snapshot = { sessionId: "active", runtimeEpoch: 1, stateVersion: 1, isStreaming: false };
  const prepared = { targetSessionId: "saved", requestedSessionId: "source", recordedCwd: "C:/removed", cwd: "C:/removed", executionCwd: "C:/chosen", requiresWorkspaceSelection: false };
  const previous = { hello: () => ({}), controller: { publication: () => ({ snapshot }), invoke: async () => ({ status: "completed", result: prepared }) } } as unknown as DesktopRuntimeSession;
  const restored = { hello: () => ({}), controller: { publication: () => ({ snapshot: { ...snapshot, sessionId: "saved" } }) } } as unknown as DesktopRuntimeSession;
  const sessionRef = { current: previous as DesktopRuntimeSession | undefined };
  const registrations: string[] = [];
  const switches: DesktopSessionSwitchIntent[] = [];
  let fail = true;
  const commands = createDesktopSemanticCommands({
    ...baseOptions, sessionRef,
    registerImportedWorkspace: async cwd => { registrations.push(cwd); return "chosen"; },
    bindSession: session => { sessionRef.current = session; },
    switchSession: async intent => { switches.push(intent); if (fail) throw new Error("Native restore failed"); return restored; },
  });
  const result = await commands.invoke!({ kind: "worktrees.session.resume.prepare", sessionId: "active", targetSessionId: "source", scope: "repo" }, "prepare" as never);
  assert.deepEqual(registrations, ["C:/chosen"]);
  const preparedResult = (result as { result: { workspaceId: string; threadId: string } }).result;
  assert.equal(preparedResult.workspaceId, "chosen");
  assert.equal(preparedResult.threadId, threadIdFor("saved"));
  await assert.rejects(async () => commands.resume!({ threadId: preparedResult.threadId as ThreadId }), /Native restore failed/);
  assert.equal(sessionRef.current, previous);
  fail = false;
  await commands.resume!({ threadId: threadIdFor("source") as ThreadId });
  assert.equal(sessionRef.current, restored);
  assert.deepEqual(switches[0], { kind: "resume", sessionId: "saved", resumeWorkspace: { workspaceId: "chosen", cwd: "C:/chosen" }, allowRelocation: true });
});

test("missing execution cwd is an explicit selection requirement, never registered or used as a launch path", async () => {
  let registrations = 0;
  let switched = 0;
  const prepared = { targetSessionId: "missing", requestedSessionId: "missing", recordedCwd: "C:/removed", cwd: "C:/removed", requiresWorkspaceSelection: true };
  const session = { hello: () => ({}), controller: { publication: () => ({ snapshot: { sessionId: "active", runtimeEpoch: 1, stateVersion: 1 } }), invoke: async () => ({ status: "completed", result: prepared }) } } as unknown as DesktopRuntimeSession;
  const commands = createDesktopSemanticCommands({ ...baseOptions, sessionRef: { current: session },
    registerImportedWorkspace: async () => { registrations++; return "wrong"; }, switchSession: async () => { switched++; return undefined; } });
  const result = await commands.invoke!({ kind: "worktrees.session.resume.prepare", sessionId: "active", targetSessionId: "missing", scope: "repo" }, "prepare" as never);
  assert.equal((result as { result: { requiresWorkspaceSelection: boolean } }).result.requiresWorkspaceSelection, true);
  await assert.rejects(async () => commands.resume!({ threadId: threadIdFor("missing") as ThreadId }), { code: "INVALID_ARGUMENT" });
  assert.equal(registrations, 0);
  assert.equal(switched, 0);
});

test("a new resume preparation that needs a workspace invalidates both aliases of the previous selection", async () => {
  const ready = { targetSessionId: "saved", requestedSessionId: "source", recordedCwd: "C:/removed", cwd: "C:/removed", executionCwd: "C:/chosen", requiresWorkspaceSelection: false };
  let prepared: Omit<typeof ready, "executionCwd"> & { executionCwd?: string } = ready;
  const session = { hello: () => ({}), controller: { publication: () => ({ snapshot: { sessionId: "active", runtimeEpoch: 1, stateVersion: 1 } }), invoke: async () => ({ status: "completed", result: prepared }) } } as unknown as DesktopRuntimeSession;
  let switches = 0;
  const commands = createDesktopSemanticCommands({ ...baseOptions, sessionRef: { current: session },
    catalog: { list: async () => [{ sessionId: "saved", modifiedAt: T0, messageCount: 2, status: "active" }] },
    registerImportedWorkspace: async () => "chosen", switchSession: async () => { switches++; return undefined; } });
  const operation = { kind: "worktrees.session.resume.prepare" as const, sessionId: "active", targetSessionId: "source", scope: "repo" as const };
  await commands.invoke!(operation, "prepare-ready" as never);
  const { executionCwd: _gone, ...missing } = ready;
  prepared = { ...missing, requiresWorkspaceSelection: true };
  await commands.invoke!(operation, "prepare-missing" as never);
  for (const id of ["source", "saved"]) {
    await assert.rejects(async () => commands.resume!({ threadId: threadIdFor(id) as ThreadId }), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(switches, 0);
});

test("delete reports native partial cleanup while still removing telemetry, bindings and leases", async () => {
  const cleaned: string[] = [];
  const commands = createDesktopSemanticCommands({ ...baseOptions,
    deleteService: () => ({ delete: async () => ({ sessionId: "session-a", deleted: true, nativeCleanup: { status: "partial", reason: "native-purge-partial" } }) }) as unknown as StudioSessionDeleteService,
    finishManagedArtifacts: async () => { cleaned.push("artifacts"); throw new Error("Artifact library unavailable"); },
    telemetryStore: () => ({ remove: () => { cleaned.push("telemetry"); } }),
    bindings: { unbind: () => { cleaned.push("binding"); } },
    leaseStore: { removeForSession: () => { cleaned.push("lease"); } },
  });
  const result = await commands.delete!({ threadId: threadIdFor("session-a") as ThreadId });
  assert.equal(result.applied, true);
  assert.match(result.message ?? "", /partial.*native-purge-partial/);
  assert.match(result.message ?? "", /Managed artifact cleanup failed/);
  assert.deepEqual(cleaned, ["artifacts", "telemetry", "binding", "lease"]);
});

test("direct deletion evacuates the target writer before touching its transcript", async () => {
  const calls: string[] = [];
  const commands = createDesktopSemanticCommands({
    ...baseOptions,
    evacuateResident: async id => { calls.push(`stop:${id}`); return { found: true }; },
    deleteService: () => ({
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        return { nativeCleanup: { status: "complete" } };
      },
    }) as unknown as StudioSessionDeleteService,
  });
  await commands.delete!({ threadId: threadIdFor("session-a") });
  assert.deepEqual(calls, ["stop:session-a", "delete:session-a"]);
});

test("an archive-only delete waits for a restore in another context and skips the restored session", async () => {
  const sessionFileOperations = new Map<ThreadId, Promise<unknown>>();
  const threadId = threadIdFor("session-a") as ThreadId;
  let markRestoreStarted!: () => void;
  const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
  let finishRestore!: () => void;
  const pendingRestore = new Promise<void>(resolve => { finishRestore = resolve; });
  let restored = false;
  let deleted = false;
  const first = createDesktopSemanticCommands({ ...baseOptions, sessionFileOperations,
    archive: () => ({
      unarchive: async () => {
        markRestoreStarted();
        await pendingRestore;
        restored = true;
      },
    }) as unknown as StudioSessionArchiveService,
  });
  const second = createDesktopSemanticCommands({ ...baseOptions, sessionFileOperations,
    deleteService: () => ({
      delete: async (_id: string, { archivedOnly }: { archivedOnly: boolean }) => {
        if (restored && archivedOnly) throw new SessionDeleteServiceError("SESSION_NOT_ARCHIVED", "unarchived");
        deleted = true;
        return { nativeCleanup: { status: "complete" } };
      },
    }) as unknown as StudioSessionDeleteService,
    evacuateResident: async () => { throw new Error("Archive-only deletion cannot stop a resident"); },
  });
  const restore = first.unarchive!({ threadId });
  await restoreStarted;
  const deletion = assert.rejects(async () => second.deleteArchived!({ threadId }), { code: "INVALID_ARGUMENT", message: /unarchived/ });
  finishRestore();
  await restore;
  await deletion;
  assert.equal(deleted, false);
});

test("queue takeback retries a failed attachment promotion before acknowledging recovery", async () => {
  const asset = {artifactId:"11111111-1111-1111-1111-111111111111",kind:"image",name:"a.png",mimeType:"image/png",bytes:1,sha256:"a".repeat(64)};
  const id="22222222-2222-2222-2222-222222222222";
  const snapshot={sessionId:"session-a",runtimeEpoch:"epoch",stateVersion:1};
  const kinds:string[]=[];let promotions=0;
  const session={hello:()=>({}),mediaDirectory:()=>"private",controller:{publication:()=>({snapshot}),invoke:async(request:{operation:{kind:string}})=>{kinds.push(request.operation.kind);return {status:"completed",result:{removed:true,recoveryId:id,text:"restore me",images:[asset]}};}}};
  const options={...baseOptions,sessionRef:{current:session},mediaFiles:{promote:async()=>{if(++promotions===1)throw Error("Disk full");return {...asset,artifactId:"33333333-3333-3333-3333-333333333333"};}}};
  const commands=createDesktopSemanticCommands(options as unknown as Parameters<typeof createDesktopSemanticCommands>[0]);
  const operation={kind:"session.queue.takeback" as const,sessionId:"session-a",id};
  await assert.rejects(async()=>commands.invoke!(operation,"first" as never),/Disk full/);
  const restored=await commands.invoke!(operation,"retry" as never) as {result:{recoveryId:string;text:string;images:Array<{artifactId:string}>}};
  assert.equal(restored.result.text,"restore me");assert.equal(restored.result.recoveryId,id);
  assert.equal(restored.result.images[0]?.artifactId,"33333333-3333-3333-3333-333333333333");
  assert.deepEqual(kinds,["session.queue.takeback","session.queue.takeback"]);
  // Only the renderer acknowledges after actually loading the recovered draft.
});

test("deleteWorkspaceSessions sweeps active and archived sessions under a cwd, cleans residue, and counts per-session failures", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-sweep-"));
  const agentDir = join(profile, "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const archiveRoot = join(agentDir, "archive", "sessions");
  const projectCwd = join(profile, "project");
  const previousAgentDir = process.env.OMP_AGENT_DIR;
  const attempted: string[] = [];
  const artifacts: string[] = [];
  const telemetry: string[] = [];
  const unbound: ThreadId[] = [];
  const leased: string[] = [];
  try {
    await Promise.all([sessionsRoot, archiveRoot, projectCwd].map(dir => mkdir(dir, { recursive: true })));
    const sessionLine = (id: string) => JSON.stringify({ type: "session", id, timestamp: T0, studioOrigin: "studio-host", cwd: projectCwd });
    // One active session (plain .jsonl) and one cold-archived session (.jsonl.gz).
    await writeFile(join(sessionsRoot, "session-a.jsonl"), sessionLine("session-a") + "\n" + JSON.stringify({ type: "message" }) + "\n");
    await writeFile(join(archiveRoot, "session-b.jsonl.gz"), gzipSync(Buffer.from(sessionLine("session-b") + "\n" + JSON.stringify({ type: "message" }) + "\n")));
    process.env.OMP_AGENT_DIR = agentDir;

    const commands = createDesktopSemanticCommands({
      ...baseOptions,
      sessionRef: { current: undefined },
      makeDeleteService: (cwd) => {
        assert.equal(cwd, projectCwd);
        return {
          delete: async (sessionId: string) => {
            attempted.push(sessionId);
            // session-b vanishes between scan and delete: a per-session failure
            // that must not fail the sweep.
            if (sessionId === "session-b") throw new SessionDeleteServiceError("SESSION_NOT_FOUND", "gone");
            return { sessionId, deleted: true, nativeCleanup: { status: "complete" } };
          },
        } as unknown as StudioSessionDeleteService;
      },
      finishManagedArtifacts: async (sessionId) => { artifacts.push(sessionId); },
      telemetryStore: () => ({ remove: async (sessionId) => { telemetry.push(sessionId); } }),
      bindings: { unbind: (threadId) => { unbound.push(threadId); } },
      leaseStore: { removeForSession: (sessionId) => { leased.push(sessionId); } },
      agentDir: () => agentDir,
    });

    const result = await commands.deleteWorkspaceSessions!(projectCwd);
    // Both sessions were enumerated (active + archived) and attempted.
    assert.deepEqual([...attempted].sort(), ["session-a", "session-b"]);
    assert.equal(result.deleted, 1);
    assert.equal(result.warnings, 1);
    // Residue cleanup ran only for the session that actually deleted.
    assert.deepEqual(artifacts, ["session-a"]);
    assert.deepEqual(telemetry, ["session-a"]);
    assert.deepEqual(unbound, [threadIdFor("session-a")]);
    assert.deepEqual(leased, ["session-a"]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
    else process.env.OMP_AGENT_DIR = previousAgentDir;
    await rm(profile, { recursive: true, force: true });
  }
});

test("deleteWorkspaceSessions reports CAPABILITY_UNAVAILABLE when no delete factory is wired", async () => {
  const commands = createDesktopSemanticCommands({ ...baseOptions, sessionRef: { current: undefined } });
  await assert.rejects(
    () => commands.deleteWorkspaceSessions!("/tmp/never"),
    { code: "CAPABILITY_UNAVAILABLE" },
  );
});
