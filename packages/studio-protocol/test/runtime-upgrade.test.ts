import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRuntimeSettingValue } from "../src/index.js";
test("new settings reject malformed values and retain all native service tiers",()=>{
 for(const tier of ["inherit","none","auto","default","flex","scale","priority","ultrafast"]) assert.doesNotThrow(()=>validateRuntimeSettingValue("task.agentServiceTierOverrides",{explore:tier},"setting"));
 for(const value of [-1,NaN,Infinity,1.5,2147483648]) assert.throws(()=>validateRuntimeSettingValue("images.questionTimeoutMs",value,"setting"));
 assert.throws(()=>validateRuntimeSettingValue("task.agentServiceTierOverrides",JSON.parse('{"__proto__":"priority"}'),"setting"));
 assert.throws(()=>validateRuntimeSettingValue("tools.speculativeExecution.enabled","true","setting"));
});
