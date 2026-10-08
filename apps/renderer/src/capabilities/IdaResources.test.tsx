import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {StudioClient} from "@omp-studio/client-contract";
import {I18nProvider} from "../i18n";
import {PreviewModeProvider} from "../preview/PreviewContext";
import {IdaDatabaseTools as IdaPane} from "./IdaDatabaseTools";
import {ResourcesPane} from "./ResourcesPane";
import {PREVIEW_IDA} from "../preview/idaDatabaseToolsPreview";
vi.mock("../hostError",()=>({waitReceipt:async(client:{results:Record<string,unknown>},id:string)=>client.results[id],hostErrorMessage:(error:Error)=>error.message}));
afterEach(()=>{cleanup();localStorage.clear();});
it("IDA preview requires exact operation review and never reaches Host",async()=>{
 localStorage.setItem("omp.previewMode","1");const client={command:vi.fn(),query:vi.fn()} as unknown as StudioClient;render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} sessionId="s" available/></PreviewModeProvider></I18nProvider>);
 fireEvent.change(screen.getByRole("combobox",{name:"IDA 数据库"}),{target:{value:"demo-db"}});fireEvent.change(screen.getByRole("combobox",{name:"IDA 操作"}),{target:{value:"save"}});fireEvent.click(screen.getByRole("button",{name:"检查操作"}));expect(await screen.findByRole("alertdialog")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"确认执行"}));expect(await screen.findByText("演示操作已完成")).toBeTruthy();expect(client.command).not.toHaveBeenCalled();expect(client.query).not.toHaveBeenCalled();
});
it("resource preview reads local fixtures without Host calls",async()=>{
 localStorage.setItem("omp.previewMode","1");const client={command:vi.fn(),query:vi.fn()} as unknown as StudioClient;render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ResourcesPane client={client} sessionId="s" available/></PreviewModeProvider></I18nProvider>);fireEvent.click(screen.getByRole("button",{name:"读取"}));expect(screen.getByText(/This is a local preview/)).toBeTruthy();expect(client.command).not.toHaveBeenCalled();
});

it.each(["resources", "ida"])("%s releases busy state after a late response from the previous session",async(kind)=>{
 let complete!:(value:unknown)=>void;
 const pending=new Promise(resolve=>{complete=resolve;});
 const results:Record<string,unknown>={status:{result:PREVIEW_IDA},read:pending};
 const client={results,query:vi.fn(async()=>({capabilities:[{id:kind==="ida"?"ida.status":"resource.read",grade:"native"}]})),command:vi.fn(async(name:string)=>({requestId:name==="ida.status"?"status":"read"}))} as unknown as StudioClient;
 const surface=(sessionId:string)=><I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled>{kind==="ida"?<IdaPane client={client} sessionId={sessionId} available/>:<ResourcesPane client={client} sessionId={sessionId} available/>}</PreviewModeProvider></I18nProvider>;
 const {rerender}=render(surface("first"));
 if(kind==="ida"){
  await screen.findByRole("option",{name:/sample.exe/});
  fireEvent.change(screen.getByRole("combobox",{name:"IDA 数据库"}),{target:{value:"demo-db"}});
 }
 await waitFor(()=>expect((screen.getByRole("button",{name:"读取"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"读取"}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"读取"}) as HTMLButtonElement).disabled).toBe(true));
 rerender(surface("second"));
 await act(async()=>{complete({result:{text:"stale first session",offset:0,total:1,truncated:false}});await pending;});
 if(kind==="ida"){
  await screen.findByRole("option",{name:/sample.exe/});
  fireEvent.change(screen.getByRole("combobox",{name:"IDA 数据库"}),{target:{value:"demo-db"}});
 }
 await waitFor(()=>expect((screen.getByRole("button",{name:"读取"}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.queryByText("stale first session")).toBeNull();
});
