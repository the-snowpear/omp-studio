import { randomUUID } from "node:crypto";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { StudioBtwService, StudioBtwError, type StudioBtwSessionPort, type StudioBtwSnapshot } from "./btw-service";
import { validateAgentBtwOperation, validateAgentBtwState, type AgentBtwOperation, type AgentBtwState } from "../agent-btw-protocol";

interface Entry {binding:string;agentId:string;parentId:string;sessionId:string;session:StudioBtwSessionPort;service:StudioBtwService;snapshot:StudioBtwSnapshot|null;valid:boolean;usedAt:number}

/** Services use the real child AgentSession; no additional session and no main-slot events. */
export class StudioAgentBtwService {
 #entries=new Map<string,Entry>();
 #timer:ReturnType<typeof setInterval>|undefined;
 #disposed=false;
 constructor(readonly parent:{readonly sessionId:string},private readonly resolveChild:(agentId:string)=>StudioBtwSessionPort|undefined=(agentId)=>{
  const registry=AgentRegistry.global();const root=registry.get(MAIN_AGENT_ID);
  if(root?.session!==parent||agentId===MAIN_AGENT_ID)return;
  const target=registry.get(agentId);let ancestor=target?.parentId;
  for(let hops=0;ancestor&&hops<64;hops++){if(ancestor===MAIN_AGENT_ID)return target?.session as AgentSession|undefined;ancestor=registry.get(ancestor)?.parentId;}
 }){}
 get running():boolean{return [...this.#entries.values()].some(entry=>entry.snapshot?.status==="running");}
 #matches(entry:Entry):boolean{return !this.#disposed&&entry.valid&&this.parent.sessionId===entry.parentId&&this.resolveChild(entry.agentId)===entry.session&&entry.session.sessionManager.getSessionId()===entry.sessionId;}
 #assert(entry:Entry):void{if(!this.#matches(entry)){entry.valid=false;entry.service.dispose();throw new StudioBtwError("INTERACTION_STALE","The child agent changed or stopped; reopen its BTW panel");}}
 #entry(operation:AgentBtwOperation):Entry{
  if(this.#disposed||operation.sessionId!==this.parent.sessionId)throw new StudioBtwError("INTERACTION_STALE","Parent session changed");
  const existing=this.#entries.get(operation.agentId);
  if(operation.binding){if(!existing||existing.binding!==operation.binding)throw new StudioBtwError("INTERACTION_STALE","Child BTW binding expired");this.#assert(existing);existing.usedAt=Date.now();return existing;}
  if(operation.kind!=="agent.btw.read")throw new StudioBtwError("INTERACTION_STALE","Read the child BTW binding first");
  if(existing&&this.#matches(existing))return existing;
  existing?.service.dispose();this.#entries.delete(operation.agentId);
  const session=this.resolveChild(operation.agentId);if(!session)throw new StudioBtwError("INTERACTION_STALE","No live child session is available for BTW");
  if(this.#entries.size>=32){const idle=[...this.#entries.values()].filter(entry=>entry.snapshot?.status!=="running").sort((a,b)=>a.usedAt-b.usedAt)[0];if(!idle)throw new StudioBtwError("COMMAND_BLOCKED","Too many active child BTW targets");idle.service.dispose();this.#entries.delete(idle.agentId);}
  const sessionId=session.sessionManager.getSessionId();const artifacts=session.sessionManager.getArtifactsDir?.()??null;
  let entry:Entry;
  const service=new StudioBtwService({
   get isStreaming(){return session.isStreaming;},
   sessionManager:{getSessionId:()=>sessionId,getArtifactsDir:()=>artifacts,getLeafId:()=>{this.#assert(entry);return session.sessionManager.getLeafId();}},
   runEphemeralTurn:args=>{this.#assert(entry);return session.runEphemeralTurn(args);},
   branchFromBtw:async()=>{throw new StudioBtwError("COMMAND_BLOCKED","Branch from the child conversation explicitly");},
  });
  entry={binding:randomUUID(),agentId:operation.agentId,parentId:operation.sessionId,sessionId,session,service,snapshot:null,valid:true,usedAt:Date.now()};
  service.onChange(snapshot=>{entry.snapshot=snapshot;});this.#entries.set(operation.agentId,entry);
  this.#timer??=setInterval(()=>{for(const item of this.#entries.values())if(item.valid&&!this.#matches(item)){item.valid=false;item.service.dispose();}},250);this.#timer.unref?.();
  return entry;
 }
 async execute(operation:AgentBtwOperation):Promise<AgentBtwState>{
  validateAgentBtwOperation(operation);const entry=this.#entry(operation);
  if(operation.kind==="agent.btw.ask"){
   if(operation.topicId)await entry.service.followUp(operation.topicId,operation.question);
   else entry.service.ask(operation.question);
  }else if(operation.kind==="agent.btw.abort")entry.service.abort(operation.ephemeralId);
  const history=await entry.service.historyList();
  const topicId=operation.kind!=="agent.btw.abort"?operation.topicId:undefined;
  const turns=topicId?(await entry.service.historyRead(topicId)).turns:[];
  this.#assert(entry);
  const snapshot=entry.snapshot;
  const result:AgentBtwState={binding:entry.binding,agentId:entry.agentId,targetSessionId:entry.sessionId,topics:history.topics,turns,snapshot:snapshot?{ephemeralId:snapshot.ephemeralId,status:snapshot.status,text:snapshot.text,...(snapshot.topicId?{topicId:snapshot.topicId}:{}),...(snapshot.question?{question:snapshot.question}:{}),...(snapshot.error?{error:snapshot.error}:{})}:null};
  validateAgentBtwState(result);return result;
 }
 async settle():Promise<void>{await Promise.all([...this.#entries.values()].map(entry=>entry.service.settle()));}
 dispose():void{this.#disposed=true;clearInterval(this.#timer);for(const entry of this.#entries.values())entry.service.dispose();this.#entries.clear();}
}
