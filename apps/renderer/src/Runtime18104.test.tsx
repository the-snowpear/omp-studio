import { setAskText } from "./test/askEditor";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { FeatureSettingsPane } from "./settings/FeatureSettingsPane";
import { SessionPortabilityPane } from "./history/SessionPortabilityPane";
import { SessionCompressionPane } from "./diagnostics/SessionCompressionPane";
import { SessionWorktreesPane } from "./workspaces/SessionWorktreesPane";
import { QueuedDeck } from "./deck/QueuedDeck";

const command = vi.fn(), query = vi.fn();
const client = { command, query } as unknown as StudioClient;
beforeEach(() => {
  localStorage.setItem("omp.previewMode", "1");
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  command.mockReset(); query.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function preview(node: React.ReactNode) { return render(<PreviewModeProvider switchEnabled>{node}</PreviewModeProvider>); }

it("makes billed message prediction an explicit opt-in and keeps demo changes local", async () => {
  preview(<FeatureSettingsPane client={client} group="interaction" visible />);
  const toggle = screen.getByRole("switch", { name: "下一条消息建议" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(command).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});

it("requires archive inspection before import and shows preservation of the local copy", async () => {
  preview(<SessionPortabilityPane client={client} visible entries={[]} />);
  expect(screen.queryByRole("button", { name: "确认导入" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /选择 OMP 会话包/ }));
  await screen.findByText(/本地已有同 ID 会话/);
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await screen.findByText("已创建分支，原会话保留。");
  expect(command).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});

it("separates compression scanning from applying the reviewed inventory", async () => {
  preview(<SessionCompressionPane client={client} visible />);
  expect(screen.queryByRole("button", { name: "压缩这些文件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描候选文件" }));
  await screen.findByText("sessions/omp-studio/queue.jsonl");
  fireEvent.click(screen.getByRole("button", { name: "压缩这些文件" }));
  await screen.findByText(/已压缩 3 \/ 3/);
  expect(command).not.toHaveBeenCalled();
});

it("protects dirty worktrees and requires an explicit removal review", async () => {
  preview(<SessionWorktreesPane client={client} visible />);
  fireEvent.click(screen.getByRole("button", { name: /wt\/browser-observation/ }));
  expect((screen.getByRole("button", { name: "检查移除" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /wt\/queue-recovery/ }));
  fireEvent.click(screen.getByRole("button", { name: "检查移除" }));
  const dialog = await screen.findByRole("alertdialog", { name: "确认移除 Worktree" });
  expect(within(dialog).getByText(/已有提交的分支会保留/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /wt\/queue-recovery/ })).toBeNull());
  expect(command).not.toHaveBeenCalled();
});

it("folds a pending Ask without submitting and preserves its draft on reopening", async () => {
  const submit = vi.fn(), cancel = vi.fn();
  preview(<QueuedDeck demo items={[{ kind: "ask", id: "question", question: { id: "question", question: "Which option?", options: [{ label: "A", description: "First" }], multi: false } }]} regionLabel="questions" onAskSubmit={submit} onAskCancel={cancel} />);
  setAskText(screen.getByRole("textbox", { name: "自定义回答" }), "Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "收起 / Hide" }));
  expect(screen.queryByRole("textbox", { name: "自定义回答" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开 / Show" }));
  expect(screen.getByRole("textbox", { name: "自定义回答" }).textContent).toBe("Keep this draft");
  expect(submit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it("recognizes macOS Option+H by physical key and ignores composition and key repeat", () => {
  const submit = vi.fn();
  preview(<QueuedDeck demo items={[{ kind: "ask", id: "option-h", question: { id: "option-h", question: "Keep this answer?", options: [], multi: false } }]} regionLabel="questions" onAskSubmit={submit} />);
  setAskText(screen.getByRole("textbox", { name: "自定义回答" }), "Unsaved answer");
  const optionH = { key: "˙", code: "KeyH", altKey: true };
  fireEvent.keyDown(window, { ...optionH, isComposing: true });
  expect(screen.queryByRole("button", { name: "展开 / Show" })).toBeNull();
  fireEvent.keyDown(window, optionH);
  expect(screen.getByRole("button", { name: "展开 / Show" })).toBeTruthy();
  fireEvent.keyDown(window, { ...optionH, repeat: true });
  expect(screen.getByRole("button", { name: "展开 / Show" })).toBeTruthy();
  fireEvent.keyDown(window, optionH);
  expect(screen.getByRole("textbox", { name: "自定义回答" }).textContent).toBe("Unsaved answer");
  expect(submit).not.toHaveBeenCalled();
});
