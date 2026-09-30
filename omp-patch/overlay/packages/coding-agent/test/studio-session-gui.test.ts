import { expect, test } from "bun:test";
import { Agent, type CustomMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioSessionGuiService } from "../src/studio/services/session-gui-service";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

test("identical queue text has independent stable IDs and removes all skill companions", async()=>{
 const auth=createInMemoryAuthStorage();const agent=new Agent({initialState:{model:getBundledModel("anthropic","claude-sonnet-4-5")!,tools:[],systemPrompt:["Test"]},streamFn:(()=>{throw Error("No paid calls");}) as never});
 const session=new AgentSession({agent,sessionManager:SessionManager.inMemory(),settings:Settings.isolated(),modelRegistry:new ModelRegistry(auth)});
 agent.state.isStreaming=true;
 try {
  const prelude=(content:string):CustomMessage=>({role:"custom",customType:"skill-prompt",content,display:true,attribution:"user",timestamp:Date.now()});
  await session.followUp("same",undefined,{prependMessages:[prelude("first")]});
  await session.followUp("same",undefined,{prependMessages:[prelude("second")]});
  const first=session.getStudioQueueSnapshot();expect(first).toHaveLength(2);expect(first[0]!.id).not.toBe(first[1]!.id);
  expect(session.getStudioQueueSnapshot()).toEqual(first);
  expect(session.steerStudioQueuedMessage(first[1]!.id)).toBe(true);
  expect(session.getStudioQueueSnapshot().find(row=>row.id===first[1]!.id)?.queue).toBe("steering");
  expect(agent.peekSteeringQueue()).toHaveLength(2);
  expect(session.removeStudioQueuedMessage(first[1]!.id)).toBe(true);
  expect(session.getStudioQueueSnapshot().map(row=>row.id)).toEqual([first[0]!.id]);
  expect(agent.peekFollowUpQueue()).toHaveLength(2);
  expect(session.removeStudioQueuedMessage(first[1]!.id)).toBe(false);
  const service=new StudioSessionGuiService(session);
  expect(await service.execute({kind:"session.queue.takeback",sessionId:session.sessionId,id:first[0]!.id})).toEqual({removed:true,recoveryId:first[0]!.id,text:"same",images:[]});
  expect(agent.peekFollowUpQueue()).toHaveLength(0);
  // A failed Host transfer can retry the same ID without re-enqueuing anything.
  expect(await service.execute({kind:"session.queue.takeback",sessionId:session.sessionId,id:first[0]!.id})).toEqual({removed:true,recoveryId:first[0]!.id,text:"same",images:[]});
  const recoveryList=await service.execute({kind:"session.queue.list",sessionId:session.sessionId}) as {items:Array<{state:string}>};
  expect(recoveryList.items[0]!.state).toBe("recovering");
  expect(await service.execute({kind:"session.queue.ack",sessionId:session.sessionId,id:first[0]!.id})).toEqual({removed:true});
  expect(await service.execute({kind:"session.queue.takeback",sessionId:session.sessionId,id:first[0]!.id})).toEqual({removed:false,images:[]});
  expect(await service.execute({kind:"session.queue.list",sessionId:"stale"}).catch(error=>error.code)).toBe("INVALID_ARGUMENT");
 }finally{agent.state.isStreaming=false;await session.dispose();auth.close();}
});
