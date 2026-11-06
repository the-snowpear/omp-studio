import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {StudioClient} from "@omp-studio/client-contract";
import {AgentBtwPane} from "./AgentBtwPane";
import {PreviewModeProvider} from "../preview/PreviewContext";
import {I18nProvider} from "../i18n";
import {agentBtwPreview} from "../preview/agentBtwPreview";
import {createSubagentViewState} from "../conversation/subagentViewState";
afterEach(()=>{cleanup();localStorage.clear();});
function mount(client:StudioClient,preview=false,available=true){localStorage.setItem("omp.previewMode",preview?"1":"0");return render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><AgentBtwPane client={client} sessionId="main" agentId="child-a" available={available}/></PreviewModeProvider></I18nProvider>);}
function typeDraft(text:string){const input=screen.getByRole("textbox");input.textContent=text;fireEvent.input(input);return input;}
it("retains an agent's BTW draft after its detail view closes",async()=>{
 localStorage.setItem("omp.previewMode","1");
 const viewState=createSubagentViewState().btw;
 const pane=()=><I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><AgentBtwPane client={undefined} sessionId="main" agentId="child-a" available={false} viewState={viewState}/></PreviewModeProvider></I18nProvider>;
 const view=render(pane());typeDraft("未发送的旁路问题");view.unmount();render(pane());
 await waitFor(()=>expect(screen.getByRole("textbox").textContent).toBe("未发送的旁路问题"));
});
it("preview child BTW and composition keys never reach Host",async()=>{
 const client={command:vi.fn()} as unknown as StudioClient;mount(client,true,false);
 const input=typeDraft("子任务问题");fireEvent.keyDown(input,{key:"Enter",isComposing:true});expect(screen.queryByText(/演示：本话题/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"发送"}));expect(await screen.findByText(/演示：本话题/)).toBeTruthy();expect(client.command).not.toHaveBeenCalled();
});
it("pins child commands to the returned binding and stops after an uncertain receipt without main fallback",async()=>{
 const command=vi.fn(async(kind:string)=>{if(kind==="agent.btw.ask")throw Error("outcome unknown");return {requestId:"read"};});
 const client={command,subscribe:(_filter:unknown,callback:(value:unknown)=>void)=>{queueMicrotask(()=>callback({kind:"command.receipt",receipt:{requestId:"read",status:"completed",result:{result:{...agentBtwPreview("child-a"),binding:"native-binding"}}}}));return ()=>{};}} as unknown as StudioClient;
 mount(client);await screen.findByText(/demo-child-session/);typeDraft("only a");fireEvent.click(screen.getByRole("button",{name:"发送"}));
 await screen.findByRole("alert");expect(command).toHaveBeenCalledWith("agent.btw.ask",{sessionId:"main",agentId:"child-a",binding:"native-binding",question:"only a"});
 expect((screen.getByRole("button",{name:"发送"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("textbox").textContent).toBe("only a");
 const calls=command.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,600));expect(command).toHaveBeenCalledTimes(calls);expect(command.mock.calls.some(([kind])=>kind==="btw.ask"||kind==="core.prompt")).toBe(false);
});
it("unavailable Runtime disables child BTW with no request",()=>{
 const client={command:vi.fn()} as unknown as StudioClient;mount(client,false,false);expect(screen.getByText("当前 Runtime 或目标不支持子代理 BTW")).toBeTruthy();typeDraft("draft");expect((screen.getByRole("button",{name:"发送"}) as HTMLButtonElement).disabled).toBe(true);expect(client.command).not.toHaveBeenCalled();
});
