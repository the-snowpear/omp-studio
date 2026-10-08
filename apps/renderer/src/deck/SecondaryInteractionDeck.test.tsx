import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientInteraction, StudioClient } from "@omp-studio/client-contract";
import { SecondaryInteractionDeck } from "./SecondaryInteractionDeck";
import { I18nProvider } from "../i18n";
afterEach(()=>cleanup());
it("a native approval can be answered from a secondary workspace using its original lease, and preview cannot answer it",async()=>{
 const interaction={kind:"input",interactionId:"native-review",sessionId:"s",leaseGeneration:12,title:"Native review feedback",secret:false} as ClientInteraction;
 const command=vi.fn(async()=>({requestId:"r"}));
 const client={command,getState:()=>({commands:{r:{status:"completed",result:{}}}})} as unknown as StudioClient;
 const view=(preview:boolean)=><I18nProvider forcedLanguage="zh"><SecondaryInteractionDeck client={client} interaction={interaction} runtimeConnected resyncRequired={false} preview={preview}/></I18nProvider>;
 const {rerender}=render(view(true));expect(screen.queryByRole("dialog")).toBeNull();
 rerender(view(false));fireEvent.change(screen.getByRole("textbox"),{target:{value:"Approve this material"}});fireEvent.click(screen.getByRole("button",{name:"提交"}));
 await waitFor(()=>expect(command).toHaveBeenCalledWith("interaction.respond",{interactionId:"native-review",leaseGeneration:12,decision:"submit",value:"Approve this material"}));
 expect(screen.getByRole("dialog")).toBeTruthy();
});
