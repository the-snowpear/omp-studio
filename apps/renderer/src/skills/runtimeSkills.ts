import type { StudioClient } from "@omp-studio/client-contract";
import type { RuntimeSkillIdentity } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
const cache=new WeakMap<StudioClient,Map<string,{at:number;value:Promise<RuntimeSkillIdentity[]>}>>();
export function loadRuntimeSkills(client:StudioClient,sessionId:string):Promise<RuntimeSkillIdentity[]> {
 let entries=cache.get(client);if(!entries){entries=new Map();cache.set(client,entries);}
 const found=entries.get(sessionId);if(found&&Date.now()-found.at<15000)return found.value;
 const value=(async()=>{const handle=await client.command("session.skills.list",{sessionId});return (await waitReceipt<{result:{skills:RuntimeSkillIdentity[]}}>(client,handle.requestId)).result.skills;})();
 value.catch(()=>{});if(entries.size>20)entries.clear();entries.set(sessionId,{at:Date.now(),value});return value;
}
