import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { SessionBudgetPane } from "./models/SessionBudgetPane";
import { LocalFilesPane } from "./capabilities/LocalFilesPane";
import { DictationControl } from "./composer/DictationControl";
import { ContextInspector } from "./conversation/ContextInspector";
import { AskBody } from "./deck/AskCard";
import { ApprovalCard } from "./deck/ApprovalCard";
import { approvalFromInteraction } from "./deck/approvalContent";
import { submitAskValue } from "./deck/askContent";
import type { DeckAskAnswer } from "./deck/types";
import { selectOption } from "./test/selectOption";

const command = vi.fn(), query = vi.fn();
const client = { command, query } as unknown as StudioClient;
beforeEach(() => {
  localStorage.setItem("omp.previewMode", "1");
  command.mockReset(); query.mockReset();
});
afterEach(() => cleanup());

it("keeps budget and local-file demo edits off the Host", async () => {
  render(<PreviewModeProvider switchEnabled><SessionBudgetPane client={client} available={false} /><LocalFilesPane client={client} available={false} /></PreviewModeProvider>);
  fireEvent.change(screen.getByRole("spinbutton", { name: "费用上限（USD）" }), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存预算" }));
  await screen.findByText(/已到上限/);
  selectOption(screen.getByRole("combobox", { name: "选择本地文件" }), /PLAN.md/);
  fireEvent.change(await screen.findByRole("textbox", { name: "本地文件正文" }), { target: { value: "changed draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存到原文件" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "保存到原文件" }) as HTMLButtonElement).disabled).toBe(true));
  expect(command).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});

it("preserves the selected note target in the submitted multi-choice answer", () => {
  function Ask() {
    const [answer, setAnswer] = useState<DeckAskAnswer>({ picked: ["Keep", "Compress"], custom: "", note: "Older logs", noteOption: "Compress" });
    return <><AskBody question={{ id: "q", question: "Choose", options: [{ label: "Keep" }, { label: "Compress" }], multi: true, acceptImages: false }} answer={answer} onPick={() => {}} onCustom={() => {}} onPatch={patch => setAnswer(current => ({ ...current, ...patch }))} onSubmit={() => {}} /><output aria-label="answer">{JSON.stringify(submitAskValue([{ id: "q", question: "Choose", options: [], multiple: true }], { q: answer }))}</output></>;
  }
  render(<Ask />);
  selectOption(screen.getByRole("combobox", { name: "备注对象 / Note on" }), "Keep");
  expect(JSON.parse(screen.getByLabelText("answer").textContent!).results[0]).toMatchObject({ selectedOptions: ["Keep", "Compress"], note: "Older logs", noteOption: "Keep" });
});

it("offers only once or deny for restricted-folder approvals even with remembered grants", () => {
  const view = approvalFromInteraction({ kind: "approval", interactionId: "restricted", sessionId: "s", leaseGeneration: 1, title: "Restricted file", approvalType: "read", detail: { source: "restriction", path: "private/file" }, session: "Allow session", grants: [{ scope: "folder", label: "Folder", alwaysLabel: "Always folder" }] } as never);
  render(<ApprovalCard view={view} onAllow={() => {}} onAlways={() => {}} onDeny={() => {}} onGrant={() => {}} />);
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["拒绝", "允许一次"]);
});

it("draft dictation merges text only after stop and never requests microphone access in demo", async () => {
  const onText = vi.fn();
  render(<PreviewModeProvider switchEnabled><DictationControl client={client} available={false} onText={onText} /></PreviewModeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "听写" }));
  fireEvent.click(screen.getByRole("button", { name: "确认打开麦克风" }));
  expect(onText).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "停止并填入草稿" }));
  expect(onText).toHaveBeenCalledWith("请检查会话恢复后附件是否保留。");
  expect(command).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});

it("releases a real context snapshot when the viewer closes", async () => {
  query.mockImplementation(async kind => kind === "context.view.open" ? { sessionId: "s", snapshotId: "snapshot", usedTokens: 0, contextWindow: 1000, freeTokens: 1000, savedTokens: 0, thresholdTokens: null, categories: [] } : kind === "context.view.list" ? { entries: [], total: 0 } : { released: true });
  const view = render(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" visible onClose={() => {}} /></PreviewModeProvider>);
  await waitFor(() => expect(query).toHaveBeenCalledWith("context.view.open", { sessionId: "s" }));
  await screen.findByText(/上下文 0/);
  view.unmount();
  expect(query).toHaveBeenCalledWith("context.view.release", { sessionId: "s", snapshotId: "snapshot" });
});
