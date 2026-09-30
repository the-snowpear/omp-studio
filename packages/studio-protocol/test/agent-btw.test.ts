import {test} from "node:test";
import assert from "node:assert/strict";
import {validateAgentBtwOperation,validateAgentBtwState} from "../src/contracts/agent-btw.js";
test("child BTW requires binding for every mutation and accepts only bounded typed output",()=>{
 validateAgentBtwOperation({kind:"agent.btw.read",sessionId:"s",agentId:"a"});
 assert.throws(()=>validateAgentBtwOperation({kind:"agent.btw.ask",sessionId:"s",agentId:"a",question:"q"}));
 assert.throws(()=>validateAgentBtwOperation({kind:"agent.btw.ask",sessionId:"s",agentId:"a",binding:"b",question:"q",path:"secret"}));
 assert.throws(()=>validateAgentBtwOperation({kind:"agent.btw.abort",sessionId:"s",agentId:"a",binding:"b"}));
 const state={binding:"b",agentId:"a",targetSessionId:"child",snapshot:null,topics:[],turns:[]};validateAgentBtwState(state);
 assert.throws(()=>validateAgentBtwState({...state,branchToken:"private"}));
 assert.throws(()=>validateAgentBtwState({...state,snapshot:{ephemeralId:"x",status:"completed",text:"x".repeat(262145)}}));
});
