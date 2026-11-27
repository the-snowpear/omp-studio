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

it("shows the failed Host receipt, requests sync without resubmitting, and clears when the Host removes the approval", async () => {
  const interaction = { kind: "approval", interactionId: "stale-approval", sessionId: "s", leaseGeneration: 12, title: "Allow Bash?", approvalType: "bash", detail: { toolName: "bash", summary: "Command: git status", risk: "high" }, session: "Allow for this session" } as unknown as ClientInteraction;
  const bootstrap = vi.fn(async () => ({}));
  let submitted: unknown;
  const command = vi.fn(async (name: string, input: unknown) => {
    submitted = { name, input };
    return { requestId: "respond-1", commandName: name, status: "accepted", acceptedAt: new Date().toISOString() };
  });
  const client = { command, bootstrap, subscribe: vi.fn(() => () => undefined), getState: () => ({ commands: { "respond-1": { requestId: "respond-1", commandName: "interaction.respond", status: "failed", error: { code: "INVALID_ARGUMENT", message: "No matching interaction is pending" }, observedAt: new Date().toISOString() } } }) } as unknown as StudioClient;
  const view = (pending: ClientInteraction | null) => <I18nProvider forcedLanguage="zh"><SecondaryInteractionDeck client={client} interaction={pending} runtimeConnected resyncRequired={false} preview={false} /></I18nProvider>;
  const { rerender } = render(view(interaction));
  fireEvent.click(screen.getByRole("button", { name: "本会话允许" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No matching interaction is pending"));
  expect(screen.getByRole("alert").textContent).toContain("INVALID_ARGUMENT");
  fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
  await waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(command).toHaveBeenCalledOnce();
  expect(submitted).toEqual(expect.objectContaining({ name: "interaction.respond", input: expect.objectContaining({ interactionId: interaction.interactionId, leaseGeneration: 12, decision: "submit", value: "session" }) }));
  rerender(view(null));
  expect(screen.queryByRole("dialog")).toBeNull();
});
