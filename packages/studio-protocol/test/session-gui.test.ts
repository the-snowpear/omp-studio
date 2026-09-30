import { test } from "node:test";
import { strict as assert } from "node:assert";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/contracts/workbench.js";

test("session GUI rejects unfenced writes, paths and invalid pagination",()=>{
 assert.throws(()=>validateWorkbenchOperation({kind:"session.queue.remove",id:"item"}));
 assert.throws(()=>validateWorkbenchOperation({kind:"session.queue.takeback",sessionId:"s",id:"item",path:"C:/secret"}));
 assert.throws(()=>validateWorkbenchOperation({kind:"session.queue.list",sessionId:"s",offset:-1}));
 assert.throws(()=>validateWorkbenchOperation({kind:"session.tier.set",sessionId:"s",selector:"model",tier:"unlimited"}));
 assert.doesNotThrow(()=>validateWorkbenchOperation({kind:"session.queue.remove",sessionId:"s",id:"item"}));
});
test("queue results preserve identity and reject private payloads",()=>{
 const row={id:"one",queue:"followUp",state:"pending",text:"same",imageCount:0};
 assert.doesNotThrow(()=>validateWorkbenchResult("session.queue.list",{sessionId:"s",items:[row,{...row,id:"two"}],total:2,followUpMode:"one-at-a-time",steeringMode:"all"}));
 assert.throws(()=>validateWorkbenchResult("session.queue.takeback",{removed:true,text:"same",images:[],path:"C:/private"}));
});
