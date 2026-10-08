import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStats } from "@omp-studio/studio-protocol";
import type { ClientCommandRequest, PublicAuthorityIdentity } from "@omp-studio/client-contract";
import type { HostBackend } from "@omp-studio/studio-host";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory } from "../src/index.js";
test("statistics reads never submit analysis and Frustration commands are idempotent",async()=>{
 let analyses=0;const facade=new StudioHostClientFacade({authority:{authorityId:"test" as PublicAuthorityIdentity["authorityId"],authorityEpoch:1 as PublicAuthorityIdentity["authorityEpoch"]},platform:"win32",arch:"x64",backend:{} as HostBackend,capabilityManifest:()=>undefined,commandManifest:()=>undefined,catalog:{list:async()=>[]},diagnostics:createDefaultHostDiagnosticsFactory(),install:async()=>({status:"installed",signature:"unknown"}),stats:{read:async input=>emptyStats(input.filter),frustration:async()=>{analyses++;return {available:true};}}});
 try{await facade.query({queryName:"stats.read",input:{filter:{range:"all"}}});assert.equal(analyses,0);
  const request={commandName:"stats.frustration",requestId:"request-1",idempotencyKey:"key-1",input:{action:"start",filter:{range:"all"},quoteId:"reviewed"}} as ClientCommandRequest<"stats.frustration">;
  await facade.command(request);await facade.command(request);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(analyses,1);
 }finally{await facade.close();}
});
