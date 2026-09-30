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
