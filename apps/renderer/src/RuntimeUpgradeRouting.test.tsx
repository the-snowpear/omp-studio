import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {BtwSnapshot, StudioClient} from "@omp-studio/client-contract";
import {invokeUpgrade} from "./runtimeUpgrade";
import {loadMentions} from "./composer/mentions";
import {useBtwSession} from "./btw/useBtwSession";
const upgradeState = vi.hoisted(() => ({ available: true }));
vi.mock("./runtimeUpgrade",()=>({useUpgradeAvailable:()=>upgradeState.available,invokeUpgrade:vi.fn()}));
vi.mock("./hostError", async importOriginal => ({ ...await importOriginal<typeof import("./hostError")>(), waitReceipt: vi.fn() }));
import { waitReceipt } from "./hostError";
afterEach(()=>{cleanup();vi.clearAllMocks();upgradeState.available = true;});
it("real model mentions request current Runtime candidates instead of the file/agent menus",async()=>{
 vi.mocked(invokeUpgrade).mockResolvedValue({sessionId:"parent",mentions:[],available:[{selector:"provider/model",name:"Model",image:true}],activeModelImage:true});
 const client={query:vi.fn()} as unknown as StudioClient;
 expect(await loadMentions(client,"^","model")).toEqual([{kind:"model",id:"provider/model",name:"provider/model",label:"Model",detail:"provider/model"}]);
 expect(invokeUpgrade).toHaveBeenCalledWith(client,"session.models.mentions",{});
 expect(client.query).not.toHaveBeenCalled();
});
it("a selected historical BTW topic dispatches a follow-up and does not overwrite it with a new ask",async()=>{
 vi.mocked(invokeUpgrade).mockImplementation(async (_client,kind) => {
  if(kind==="btw.history.list")return {sessionId:"parent",topics:[]};
  if(kind==="btw.history.read")return {sessionId:"parent",topicId:"topic",turns:[{question:"first",answer:"answer",status:"complete",createdAt:1,updatedAt:2}]};
  if(kind==="btw.followUp")return {ephemeralId:"next",status:"running"};
  throw new Error("Unexpected operation "+kind);
 });
 const client={command:vi.fn()} as unknown as StudioClient;
 const {result}=renderHook(()=>useBtwSession({snapshot:null,client,preview:false,sessionId:"parent",canCommand:true}));
 await act(async()=>{await result.current.selectTopic?.("topic");});
 await waitFor(()=>expect(result.current.snapshot?.status).toBe("completed"));
 await act(async()=>{expect(await result.current.ask("next question")).toBe(true);});
 expect(invokeUpgrade).toHaveBeenCalledWith(client,"btw.followUp",{topicId:"topic",question:"next question"});
 expect(client.command).not.toHaveBeenCalled();
});

it("keeps legacy BTW snapshots visible when the Runtime has no history capability", async () => {
 upgradeState.available = false;
 vi.mocked(waitReceipt).mockResolvedValue({ ephemeralId: "legacy", branchToken: "branch", status: "running" });
 const client = { command: vi.fn().mockResolvedValue({ requestId: "ask" }) } as unknown as StudioClient;
 const initial = { snapshot: { ephemeralId: "legacy", status: "completed" as const, text: "legacy answer" }, client, preview: false, sessionId: "parent", canCommand: true };
 const { result } = renderHook(() => useBtwSession(initial));
 await act(async () => { expect(await result.current.ask("question")).toBe(true); });
 expect(result.current.snapshot?.text).toBe("legacy answer");
 expect(result.current.canBranch).toBe(true);
});

it("retains the new branch token while its receipt is ahead of the first live snapshot", async () => {
 vi.mocked(invokeUpgrade).mockResolvedValue({ sessionId: "parent", topics: [] });
 vi.mocked(waitReceipt).mockResolvedValue({ ephemeralId: "next", branchToken: "next-token", status: "running" });
 const client = { command: vi.fn().mockResolvedValue({ requestId: "ask" }) } as unknown as StudioClient;
 const old: BtwSnapshot = { ephemeralId: "old", topicId: "old", sessionId: "parent", status: "completed", text: "previous answer" };
 const { result, rerender } = renderHook(({ snapshot }: { snapshot: BtwSnapshot }) => useBtwSession({ snapshot, client, preview: false, sessionId: "parent", canCommand: true }), { initialProps: { snapshot: old } });
 await act(async () => { expect(await result.current.ask("next question", true)).toBe(true); });
 expect(result.current.startedAt).not.toBeNull();
 rerender({ snapshot: { ephemeralId: "next", topicId: "next", sessionId: "parent", status: "completed", text: "next answer" } });
 expect(result.current.canBranch).toBe(true);
});

it("clears the previous session's topic list while the next history request is pending", async () => {
 vi.mocked(invokeUpgrade).mockResolvedValue({ sessionId: "parent", topics: [{ topicId: "old", question: "old question", status: "complete", updatedAt: 1, turnCount: 1 }] });
 const client = {} as StudioClient;
 const { result, rerender } = renderHook(({ sessionId }) => useBtwSession({ snapshot: null, client, preview: false, sessionId, canCommand: true }), { initialProps: { sessionId: "parent" } });
 await waitFor(() => expect(result.current.topics).toHaveLength(1));
 vi.mocked(invokeUpgrade).mockReturnValue(new Promise(() => {}) as never);
 rerender({ sessionId: "other" });
 expect(result.current.topics).toEqual([]);
});

for (const followUp of [false, true]) {
 it(`ignores a delayed ${followUp ? "follow-up" : "ask"} receipt after switching sessions`, async () => {
  let complete!: (value: unknown) => void;
  const delayed = new Promise(resolve => { complete = resolve; });
  vi.mocked(invokeUpgrade).mockImplementation(async (_client, kind) => {
   if (kind === "btw.history.list") return { sessionId: "parent", topics: [] };
   if (kind === "btw.history.read") return { sessionId: "parent", topicId: "topic", turns: [{ question: "first", answer: "answer", status: "complete", createdAt: 1, updatedAt: 2 }] };
   if (kind === "btw.followUp") return delayed as never;
   throw new Error("Unexpected operation");
  });
  vi.mocked(waitReceipt).mockReturnValue(delayed);
  const client = { command: vi.fn().mockResolvedValue({ requestId: "ask" }) } as unknown as StudioClient;
  const { result, rerender } = renderHook(({ sessionId }) => useBtwSession({ snapshot: null, client, preview: false, sessionId, canCommand: true }), { initialProps: { sessionId: "parent" } });
  if (followUp) await act(async () => { await result.current.selectTopic?.("topic"); });
  let sent!: Promise<boolean>;
  act(() => { sent = result.current.ask("late question"); });
  rerender({ sessionId: "other" });
  await act(async () => {
   complete({ ephemeralId: "late", branchToken: "old-token", status: "running" });
   expect(await sent).toBe(false);
  });
  expect(result.current.selectedTopicId).toBeNull();
  expect(result.current.turns).toEqual([]);
  expect(result.current.canBranch).toBe(false);
  expect(result.current.question).toBe("");
 });
}
