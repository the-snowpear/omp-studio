import { AGENT_BTW_KINDS,isAgentBtwKind,validateAgentBtwOperation,validateAgentBtwState,type AgentBtwOperation,type AgentBtwResultMap } from "./agent-btw-protocol";
import { IDA_KINDS,isIdaKind,validateIdaOperation,validateIdaResult,type IdaOperation,type IdaResultMap } from "./ida-protocol";
import {validateResourceOperation,validateResourcePage,type ResourceOperation,type ResourcePage} from "./resources-protocol";
export type SessionTier = "standard" | "slow" | "priority" | "ultrafast";
export interface SessionTierState {
  selector: string; configured: string; effective: SessionTier;
  choices: Array<{ id: SessionTier; available: boolean; reason?: string }>;
  usageStatus?: string;
}
export interface SessionQueueItem { id: string; queue: "steering" | "followUp"; state: "pending" | "delivering" | "recovering"; text: string; imageCount: number }
export interface SessionQueueSnapshot { sessionId: string; items: SessionQueueItem[]; total: number; followUpMode: "all" | "one-at-a-time"; steeringMode: "all" | "one-at-a-time" }
export interface QueueImageAsset { artifactId: string; kind: "image"; name: string; mimeType: string; bytes: number; sha256: string }
export interface QueueTakeback { recoveryId?: string; removed: boolean; text?: string; images: QueueImageAsset[] }
export interface RuntimeSkillIdentity { id: string; name: string; description: string; namespace?: string; source: string; scope?: "workspace" | "global" | "builtin" | "runtime"; conflict: boolean }
export type SessionGuiOperation =
 | ResourceOperation
 | IdaOperation
 | AgentBtwOperation
 | {kind:"prediction.control";sessionId:string;action:PredictionControlAction}
 | { kind: "session.queue.list"; sessionId: string; offset?: number }
 | { kind: "session.queue.steer"; sessionId: string; id: string }
 | { kind: "session.queue.remove"; sessionId: string; id: string }
 | { kind: "session.queue.ack"; sessionId: string; id: string }
 | { kind: "session.queue.takeback"; sessionId: string; id: string }
 | { kind: "session.tier.get"; sessionId: string }
 | { kind: "session.tier.set"; sessionId: string; selector: string; tier: SessionTier }
 | { kind: "session.skills.list"; sessionId: string };
export interface SessionGuiResultMap extends AgentBtwResultMap, IdaResultMap {
 "resource.read":ResourcePage;
 "prediction.control":PredictionControlState;
 "session.queue.list": SessionQueueSnapshot;
 "session.queue.remove": { removed: boolean };
 "session.queue.steer": { removed: boolean };
 "session.queue.ack": { removed: boolean };
 "session.queue.takeback": QueueTakeback;
 "session.tier.get": SessionTierState;
 "session.tier.set": SessionTierState;
 "session.skills.list": { skills: RuntimeSkillIdentity[]; warnings: string[] };
}
export const SESSION_GUI_KINDS = ["resource.read",...IDA_KINDS,...AGENT_BTW_KINDS,"prediction.control","session.queue.list", "session.queue.ack", "session.queue.remove", "session.queue.steer", "session.queue.takeback", "session.tier.get", "session.tier.set", "session.skills.list"] as const;
export const SESSION_GUI_READ_KINDS = ["resource.read","ida.status","ida.view","ida.prepare","ida.cancel","agent.btw.read","session.queue.list", "session.tier.get", "session.skills.list"] as const;
export function isSessionGuiKind(kind: string): kind is SessionGuiOperation["kind"] { return (SESSION_GUI_KINDS as readonly string[]).includes(kind); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid session GUI object"); if (Object.keys(value).some(k=>!keys.includes(k))) throw Error("Unknown session GUI field"); return value as Record<string, unknown>; }
function text(value: unknown, max=4096, empty=false): void { if(typeof value!=="string" || !empty&&!value.length || value.length>max || value.includes("\0")) throw Error("Invalid session GUI text"); }
function number(value: unknown): void { if(typeof value!=="number" || !Number.isSafeInteger(value) || value<0)throw Error("Invalid session GUI count"); }
function bool(value:unknown):void {if(typeof value!=="boolean")throw Error("Invalid session GUI flag");}
function tier(value:unknown):void {if(!["standard","slow","priority","ultrafast"].includes(value as string))throw Error("Invalid session tier");}
function list(value:unknown,max:number,check:(v:unknown)=>void):void {if(!Array.isArray(value)||value.length>max)throw Error("Invalid session GUI list");value.forEach(check);}
export function validateSessionGuiOperation(value: unknown): asserts value is SessionGuiOperation {
 if((value as {kind?:string})?.kind==="resource.read"){validateResourceOperation(value);return;}
 if(isIdaKind((value as {kind?:string})?.kind??"")){validateIdaOperation(value);return;}
 if(isAgentBtwKind((value as {kind?:string})?.kind??"")){validateAgentBtwOperation(value);return;}
 if((value as {kind?:string})?.kind==="prediction.control"){const row=object(value,["kind","sessionId","action"]);text(row.sessionId,512);if(!["status","clear","import","download","cancel"].includes(row.action as string))throw Error("Invalid prediction action");return;}
 const kind=(value as {kind?:unknown})?.kind;if(typeof kind!=="string"||!isSessionGuiKind(kind))throw Error("Invalid session GUI operation");
 const row=object(value,["kind","sessionId",...(kind==="session.tier.set"?["selector","tier"]:kind==="session.queue.list"?["offset"]:kind==="session.queue.ack"||kind==="session.queue.steer"||kind==="session.queue.remove"||kind==="session.queue.takeback"?["id"]:[])]);text(row.sessionId,512);
 if(kind==="session.tier.set"){text(row.selector);tier(row.tier);}if(kind==="session.queue.ack"||kind==="session.queue.steer"||kind==="session.queue.remove"||kind==="session.queue.takeback")text(row.id,128);
 if(row.offset!==undefined){number(row.offset);if((row.offset as number)>100000)throw Error("Queue offset exceeds budget");}
}
export function validateSessionGuiResult(kind: SessionGuiOperation["kind"], value: unknown): void {
 if(kind==="resource.read"){validateResourcePage(value);return;}
 if(isIdaKind(kind)){validateIdaResult(kind,value);return;}
 if(isAgentBtwKind(kind)){validateAgentBtwState(value);return;}
 if(kind==="prediction.control"){const row=object(value,["corpusCount","modelReady","download"]);number(row.corpusCount);bool(row.modelReady);const d=object(row.download,["state","loaded","total","error"]);number(d.loaded);number(d.total);if(!["idle","running","completed","cancelled","failed"].includes(d.state as string))throw Error("Invalid download state");if(d.error!==undefined)text(d.error);return;}
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>1048576)throw Error("Session GUI result exceeds budget");
 if(kind==="session.queue.ack"||kind==="session.queue.steer"||kind==="session.queue.remove"){bool(object(value,["removed"]).removed);return;}
 if(kind==="session.queue.takeback") {const row=object(value,["removed","text","images","recoveryId"]);bool(row.removed);if(row.recoveryId!==undefined)text(row.recoveryId,128);if(row.text!==undefined)text(row.text,65536,true);list(row.images,20,item=>{const a=object(item,["artifactId","kind","name","mimeType","bytes","sha256"]);for(const k of ["artifactId","name","mimeType","sha256"])text(a[k]);if(a.kind!=="image")throw Error("Expected image");number(a.bytes);});return;}
 if(kind==="session.queue.list"){const row=object(value,["sessionId","items","total","followUpMode","steeringMode"]);text(row.sessionId);number(row.total);for(const key of ["followUpMode","steeringMode"])if(!["all","one-at-a-time"].includes(row[key] as string))throw Error("Invalid queue mode");list(row.items,100,item=>{const r=object(item,["id","queue","state","text","imageCount"]);text(r.id,128);text(r.text,65536,true);number(r.imageCount);if(!["steering","followUp"].includes(r.queue as string)||!["pending","delivering","recovering"].includes(r.state as string))throw Error("Invalid queue state");});return;}
 if(kind==="session.skills.list"){const row=object(value,["skills","warnings"]);list(row.warnings,200,v=>text(v));list(row.skills,5000,item=>{const r=object(item,["id","name","description","namespace","source","scope","conflict"]);for(const key of ["id","name","description","source"])text(r[key],4096,true);if(r.scope!==undefined&&! ["workspace","global","builtin","runtime"].includes(r.scope as string))throw Error("Invalid skill scope");if(r.namespace!==undefined)text(r.namespace);bool(r.conflict);});return;}
 const row=object(value,["selector","configured","effective","choices","usageStatus"]);text(row.selector,4096,true);text(row.configured,128,true);tier(row.effective);if(row.usageStatus!==undefined)text(row.usageStatus);
 list(row.choices,4,item=>{const r=object(item,["id","available","reason"]);tier(r.id);bool(r.available);if(r.reason!==undefined)text(r.reason);});
}
import type { PredictionControlAction, PredictionControlState } from "./prediction-protocol";
