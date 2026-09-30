import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStats, validateStatsSnapshot, validateStatsFilter, validateFrustrationInput, validateFrustrationResult } from "../src/contracts/stats.js";

test("statistics boundaries reject internal scope, extra fields and malformed pricing",()=>{
 const snapshot=emptyStats({range:"all"});validateStatsSnapshot(snapshot);
 assert.throws(()=>validateStatsFilter({range:"all",proseHashes:["private"]}));
 assert.throws(()=>validateStatsSnapshot({...snapshot,privatePath:"hidden"}));
 assert.throws(()=>validateStatsSnapshot({...snapshot,overall:{...snapshot.overall,costEstimate:NaN}}));
 assert.throws(()=>validateStatsSnapshot({...snapshot,overall:{...snapshot.overall,body:"private"}}));
 assert.throws(()=>validateStatsSnapshot({...snapshot,reason:42}));
 assert.throws(()=>validateStatsSnapshot({...snapshot,sync:{...snapshot.sync,current:-1}}));
 assert.throws(()=>validateFrustrationInput({action:"estimate",filter:{},quoteId:42}));
 assert.throws(()=>validateFrustrationInput({action:"start",filter:{}}));
 const result={available:true,quote:{id:"reviewed",filter:{range:"all"},messages:1,cost:null,judge:"demo/judge",expiresAt:Date.now()+1000}};
 validateFrustrationResult(result);
 assert.throws(()=>validateFrustrationResult({...result,quote:{...result.quote,prose:["private"]}}));
 assert.throws(()=>validateFrustrationResult({...result,job:null}));
});
