import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {StudioClient} from "@omp-studio/client-contract";
import {AgentBtwPane} from "./AgentBtwPane";
import {PreviewModeProvider} from "../preview/PreviewContext";
import {I18nProvider} from "../i18n";
import {agentBtwPreview} from "../preview/agentBtwPreview";
afterEach(()=>{cleanup();localStorage.clear();});
function mount(client:StudioClient,preview=false,available=true){localStorage.setItem("omp.previewMode",preview?"1":"0");return render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><AgentBtwPane client={client} sessionId="main" agentId="child-a" available={available}/></PreviewModeProvider></I18nProvider>);}
it("preview child BTW and composition keys never reach Host",()=>{
 const client={command:vi.fn()} as unknown as StudioClient;mount(client,true);
 const input=screen.getByRole("textbox");fireEvent.change(input,{target:{value:"子任务问题"}});fireEvent.keyDown(input,{key:"Enter",isComposing:true});expect(screen.queryByText(/演示：本话题/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"提问"}));expect(screen.getByText(/演示：本话题/)).toBeTruthy();expect(client.command).not.toHaveBeenCalled();
});
it("pins child commands to the returned binding and stops after an uncertain receipt without main fallback",async()=>{
 const command=vi.fn(async(kind:string)=>{if(kind==="agent.btw.ask")throw Error("outcome unknown");return {requestId:"read"};});
 const client={command,subscribe:(_filter:unknown,callback:(value:unknown)=>void)=>{queueMicrotask(()=>callback({kind:"command.receipt",receipt:{requestId:"read",status:"completed",result:{result:{...agentBtwPreview("child-a"),binding:"native-binding"}}}}));return ()=>{};}} as unknown as StudioClient;
 mount(client);await screen.findByText(/demo-child-session/);fireEvent.change(screen.getByRole("textbox"),{target:{value:"only a"}});fireEvent.click(screen.getByRole("button",{name:"提问"}));
 await screen.findByRole("alert");expect(command).toHaveBeenCalledWith("agent.btw.ask",{sessionId:"main",agentId:"child-a",binding:"native-binding",question:"only a"});
 expect((screen.getByRole("button",{name:"提问"}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("only a");
 const calls=command.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,600));expect(command).toHaveBeenCalledTimes(calls);expect(command.mock.calls.every(([kind])=>kind.startsWith("agent.btw."))).toBe(true);
});
it("unavailable Runtime disables child BTW with no request",()=>{
 const client={command:vi.fn()} as unknown as StudioClient;mount(client,false,false);expect(screen.getByRole("status").textContent).toContain("不支持");fireEvent.change(screen.getByRole("textbox"),{target:{value:"draft"}});expect((screen.getByRole("button",{name:"提问"}) as HTMLButtonElement).disabled).toBe(true);expect(client.command).not.toHaveBeenCalled();
});
