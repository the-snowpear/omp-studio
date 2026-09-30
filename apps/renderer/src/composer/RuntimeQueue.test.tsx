import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { RuntimeQueue, queueTakebackSnapshot } from "./RuntimeQueue";
vi.mock("../hostError",()=>({waitReceipt:async(client:{results:Record<string,unknown>},id:string)=>client.results[id],hostErrorMessage:(error:Error)=>error.message}));
afterEach(cleanup);
function fake(){let seq=0;const results:Record<string,unknown>={};const command=vi.fn(async(kind:string,input:{id?:string})=>{const requestId=String(++seq);results[requestId]={result:kind==="session.queue.list"?{sessionId:"s",total:2,followUpMode:"one-at-a-time",steeringMode:"all",items:[{id:"first",queue:"followUp",state:"pending",text:"same",imageCount:0},{id:"second",queue:"followUp",state:"pending",text:"same",imageCount:0}]}:{removed:false,images:[]}};return {requestId};});return {client:{command,results} as unknown as StudioClient,command};}
it("sends the selected identity for duplicate text and never restores consumed messages",async()=>{
 const {client,command}=fake();const recover=vi.fn();render(<I18nProvider forcedLanguage="zh"><RuntimeQueue client={client} sessionId="s" available hasDraft={()=>false} onRecover={recover}/></I18nProvider>);
 fireEvent.click((await screen.findAllByRole("button",{name:"取回编辑"}))[1]!);
 await screen.findByText("消息已被消费，无法取回");expect(command).toHaveBeenCalledWith("session.queue.takeback",{sessionId:"s",id:"second"});expect(recover).not.toHaveBeenCalled();expect(command.mock.calls.every(([kind])=>!kind.startsWith("core."))).toBe(true);
});
it("requires an explicit merge decision before removing a message",async()=>{
 const {client,command}=fake();render(<I18nProvider forcedLanguage="zh"><RuntimeQueue client={client} sessionId="s" available hasDraft={()=>true} onRecover={vi.fn()}/></I18nProvider>);
 fireEvent.click((await screen.findAllByRole("button",{name:"取回编辑"}))[0]!);await screen.findByRole("dialog");expect(command).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole("button",{name:"取回并合并"}));await waitFor(()=>expect(command).toHaveBeenCalledTimes(2));
});
it("restores namespaced skill identities without dropping their disambiguation suffix",async()=>{
 const result=await queueTakebackSnapshot({removed:true,text:"Use /skill:plugin/review~2",images:[]});expect(result.text).toBe("Use /skill:plugin/review~2");expect(result.doc.nodes).toContainEqual(expect.objectContaining({type:"chip",chip:expect.objectContaining({kind:"skill",name:"plugin/review~2"})}));
});

it("retries recovery acknowledgement without inserting the draft twice",async()=>{
 let seq=0,acks=0;const results:Record<string,unknown>={};
 const command=vi.fn(async(kind:string)=>{if(kind==="session.queue.ack"&&++acks===1)throw Error("ack disconnected");const requestId=String(++seq);results[requestId]={result:kind==="session.queue.list"?{sessionId:"s",total:1,followUpMode:"all",steeringMode:"all",items:[{id:"recover",queue:"followUp",state:"recovering",text:"draft",imageCount:0}]}:kind==="session.queue.takeback"?{removed:true,recoveryId:"recover",text:"draft",images:[]}:{removed:true}};return {requestId};});
 const recover=vi.fn();render(<I18nProvider forcedLanguage="zh"><RuntimeQueue client={{command,results} as unknown as StudioClient} sessionId="s" available hasDraft={()=>false} onRecover={recover}/></I18nProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"取回编辑"}));await screen.findByText("ack disconnected");expect(recover).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole("button",{name:/恢复草稿 \/ 确认已恢复/}));await waitFor(()=>expect(acks).toBe(2));expect(recover).toHaveBeenCalledTimes(1);expect(command.mock.calls.some(([kind])=>kind.startsWith("core."))).toBe(false);
});
