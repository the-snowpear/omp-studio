import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { emptyStats } from "@omp-studio/studio-protocol";
import { NativeStatsWorker, supportsNativeStatsWorker } from "../src/stats-worker.js";

test("statistics refuses older or unknown Runtime selectors before launch",()=>{
 assert.equal(supportsNativeStatsWorker("18.4.4-studio.26"),true);
 assert.equal(supportsNativeStatsWorker("18.4.4-studio.27"),true);
 for(const version of ["18.4.4-studio.18","18.4.4-studio.25","18.4.4","18.5.0-studio.1","invalid"]){assert.equal(supportsNativeStatsWorker(version),false);}
});

test("statistics shows disk cache first, shares one private worker and synchronizes without analysis",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"studio-host-stats-"));const cacheFile=join(directory,"cache.json");const filter={range:"all" as const};
 const cached={...emptyStats(filter),available:true,updatedAt:1};await writeFile(cacheFile,JSON.stringify(cached));let spawns=0;const operations:string[]=[];
 const launch=((_executable:unknown,args:unknown,options:unknown)=>{
  spawns++;assert.deepEqual(args,["__omp_worker_studio_stats"]);assert.equal((options as {windowsHide:boolean}).windowsHide,true);
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit("exit",0));return true;}});
  child.stdin.on("data",chunk=>{for(const line of String(chunk).trim().split("\n")){const request=JSON.parse(line);operations.push(request.op);queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,ok:true,result:request.op==="hello"?{protocol:1,kind:"studio-stats"}:request.op==="read"?{...cached,updatedAt:2}: {started:true}})+"\n"));}});child.stdin.on("end",()=>child.emit("exit",0));return child;
 }) as unknown as typeof spawn;
 const worker=new NativeStatsWorker({executable:async()=>"managed-omp.exe",cacheFile,spawn:launch});
 try{const first=await worker.read({filter});assert.equal(first.updatedAt,1);assert.equal(first.cached,true);
  for(let i=0;i<100&&!operations.includes("sync");i++)await new Promise(resolve=>setTimeout(resolve,5));
  const next=await worker.read({filter});assert.equal(next.updatedAt,2);assert.equal(spawns,1);assert.ok(operations.includes("sync"));assert.ok(!operations.includes("frustration"));
 }finally{await worker.dispose();}
});
