import { expect,test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { StudioAgentBtwService } from "../src/studio/services/agent-btw-service";
import type { StudioBtwSessionPort } from "../src/studio/services/btw-service";

function child(id:string,wait=false){
 const calls:Parameters<StudioBtwSessionPort["runEphemeralTurn"]>[0][]=[];const artifacts=mkdtempSync(join(tmpdir(),"studio-child-btw-"));
 const session:StudioBtwSessionPort={isStreaming:false,sessionManager:{getSessionId:()=>id,getLeafId:()=>"leaf-"+id,getArtifactsDir:()=>artifacts},branchFromBtw:async()=>{throw Error("unexpected branch");},runEphemeralTurn:async args=>{
  calls.push(args);if(wait)await new Promise<void>((_resolve,reject)=>args.signal!.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));
  const replyText="answer from "+id;args.onTextDelta?.(replyText);
  return {replyText,assistantMessage:{role:"assistant",content:[{type:"text",text:replyText}],api:"openai-responses",provider:"mock",model:id,stopReason:"stop",timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} as AssistantMessage};
 }};return {session,calls};
}
test("child BTW keeps context/history and cancellation targets isolated, with no main fallback",async()=>{
 const a=child("a"),b=child("b");const targets=new Map([["a",a.session],["b",b.session]]);const parent={sessionId:"main-session"};const pool=new StudioAgentBtwService(parent,id=>targets.get(id));
 const base={sessionId:parent.sessionId};
 try{
  const ar=await pool.execute({...base,kind:"agent.btw.read",agentId:"a"});const br=await pool.execute({...base,kind:"agent.btw.read",agentId:"b"});expect(ar.binding).not.toBe(br.binding);
  await pool.execute({...base,kind:"agent.btw.ask",agentId:"a",binding:ar.binding,question:"a only"});await Bun.sleep(20);
  let state=await pool.execute({...base,kind:"agent.btw.read",agentId:"a",binding:ar.binding});expect(state.snapshot?.text).toBe("answer from a");expect(a.calls).toHaveLength(1);expect(b.calls).toHaveLength(0);
  expect((await pool.execute({...base,kind:"agent.btw.read",agentId:"b",binding:br.binding})).topics).toHaveLength(0);
  await expect(pool.execute({...base,kind:"agent.btw.ask",agentId:"b",binding:ar.binding,question:"wrong"})).rejects.toThrow();
  const topicId=state.snapshot!.topicId!;await pool.execute({...base,kind:"agent.btw.ask",agentId:"a",binding:ar.binding,topicId,question:"follow a"});await Bun.sleep(20);
  state=await pool.execute({...base,kind:"agent.btw.read",agentId:"a",binding:ar.binding,topicId});expect(state.turns).toHaveLength(2);expect(a.calls[1]?.history?.[0]?.content).toBe("a only");
  targets.set("a",child("a-replaced").session);await expect(pool.execute({...base,kind:"agent.btw.ask",agentId:"a",binding:ar.binding,question:"stale"})).rejects.toThrow();expect(a.calls).toHaveLength(2);
  targets.delete("b");await expect(pool.execute({...base,kind:"agent.btw.read",agentId:"b",binding:br.binding})).rejects.toThrow();
 }finally{await pool.settle();pool.dispose();}
});
test("removing a target aborts its active ephemeral turn and invalidates the binding",async()=>{
 const a=child("a",true);let active:StudioBtwSessionPort|undefined=a.session;const pool=new StudioAgentBtwService({sessionId:"main"},()=>active);
 try{const state=await pool.execute({kind:"agent.btw.read",sessionId:"main",agentId:"a"});await pool.execute({kind:"agent.btw.ask",sessionId:"main",agentId:"a",binding:state.binding,question:"wait"});expect(pool.running).toBe(true);active=undefined;await Bun.sleep(300);expect(a.calls[0]?.signal?.aborted).toBe(true);expect(pool.running).toBe(false);await expect(pool.execute({kind:"agent.btw.ask",sessionId:"main",agentId:"a",binding:state.binding,question:"never"})).rejects.toThrow();}finally{await pool.settle();pool.dispose();}
});
