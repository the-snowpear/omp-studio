import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFoundationStudioRequest, validateUpgradeResult, validateRuntimeSettingValue } from "../src/index.js";
const request=(operation:unknown)=>({type:"studio.request",requestId:"upgrade",runtimeEpoch:1,operation});
test("new settings reject malformed values and retain all native service tiers",()=>{
 for(const tier of ["inherit","none","auto","default","flex","scale","priority"]) assert.doesNotThrow(()=>validateRuntimeSettingValue("task.agentServiceTierOverrides",{explore:tier},"setting"));
 for(const value of [-1,NaN,Infinity,1.5,2147483648]) assert.throws(()=>validateRuntimeSettingValue("images.questionTimeoutMs",value,"setting"));
 assert.throws(()=>validateRuntimeSettingValue("task.agentServiceTierOverrides",JSON.parse('{"__proto__":"priority"}'),"setting"));
 assert.throws(()=>validateRuntimeSettingValue("tools.speculativeExecution.enabled","true","setting"));
});
test("new operation validation rejects unsupported input instead of forwarding arbitrary payloads",()=>{
 assert.doesNotThrow(()=>parseFoundationStudioRequest(request({kind:"btw.followUp",topicId:"topic",question:"continue"})));
 assert.throws(()=>parseFoundationStudioRequest(request({kind:"btw.followUp",topicId:"topic",question:""})));
 assert.throws(()=>parseFoundationStudioRequest(request({kind:"session.import.execute",source:"other",sourceId:"id"})));
 assert.throws(()=>parseFoundationStudioRequest(request({kind:"runtime.auth.set",provider:"typesafe",apiKey:"x",extra:"secret"})));
});
test("import and auth public results cannot expose filesystem paths or credentials",()=>{
 assert.doesNotThrow(()=>validateUpgradeResult("session.import.execute",{imported:true,sessionId:"id",workspaceId:"workspace"}));
 assert.throws(()=>validateUpgradeResult("session.import.execute",{imported:true,sessionId:"id",cwd:"C:/private"}));
 assert.throws(()=>validateUpgradeResult("runtime.auth.get",{provider:"typesafe",configured:true,apiKey:"secret"}));
});
