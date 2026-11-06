import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ContextEntrySummary, ContextViewIndex } from "@omp-studio/studio-protocol";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { ContextInspector } from "./ContextInspector";

const query = vi.fn();
const client = { query } as unknown as StudioClient;
const OPEN = { sessionId: "s" };

const entry = (id: string, extra: Partial<ContextEntrySummary> = {}): ContextEntrySummary => ({
  id,
  label: id,
  tokens: 100,
  bytes: 200,
  preview: `${id} preview`,
  ...extra,
});

const thinking = { id: "thinking/4", label: "Message 4", tokens: 8_000 };

const index = (over: Partial<ContextViewIndex> = {}): ContextViewIndex => ({
  sessionId: "s",
  snapshotId: "snap",
  capturedAt: "2026-11-01T10:00:00.000Z",
  contextWindow: 1_000,
  usedTokens: 400,
  freeTokens: 500,
  bufferTokens: 100,
  thresholdTokens: 800,
  savedTokens: 0,
  truncated: false,
  model: { id: "model-x" },
  categories: [
    { id: "system-prompt", label: "System Prompt", tokens: 300, entries: 2 },
    {
      id: "tool-output",
      label: "Tool Output",
      tokens: 100,
      entries: 2,
      children: [{ id: "tool-output", key: "tool-output/tool-0", label: "grep", tokens: 100, entries: 2 }],
    },
    { id: "assistant-thinking", label: "Assistant Thinking", tokens: 8_000, entries: 2 },
  ],
  ...over,
});

const ENTRIES: Record<string, ContextEntrySummary[]> = {
  "system-prompt": [entry("system-prompt/0", { label: "System Block 1" }), entry("system-prompt/1", { label: "System Block 2" })],
  "tool-output": [
    entry("tool-output/0", { label: "grep", childKey: "tool-output/tool-0" }),
    entry("tool-output/1", { label: "grep", childKey: "tool-output/tool-0" }),
  ],
  "assistant-thinking": [
    entry("assistant-thinking/0", { label: "Thinking 1/2 · message 4", tokens: 0, thinkingGroup: thinking }),
    entry("assistant-thinking/1", { label: "Thinking 2/2 · message 4", tokens: 0, thinkingGroup: thinking }),
  ],
};

function serve(): void {
  query.mockImplementation(async (kind: string, input: { category?: string; entryId?: string }) => {
    if (kind === "context.view.open") return index();
    if (kind === "context.view.list") {
      const entries = ENTRIES[input.category ?? "system-prompt"] ?? [];
      return { entries, total: entries.length };
    }
    if (kind === "context.view.entry")
      return { entryId: input.entryId, text: `body:${input.entryId}`, totalChars: 40, truncated: false };
    return { released: true };
  });
}

beforeEach(() => {
  localStorage.setItem("omp.previewMode", "0");
  query.mockReset();
  serve();
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("ContextInspector", () => {
  it("opens a snapshot, previews the first entry and releases on unmount", async () => {
    const view = render(
      <PreviewModeProvider switchEnabled={false}>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    await screen.findByRole("meter", { name: "上下文占用" });
    expect(query).toHaveBeenCalledWith("context.view.open", OPEN);
    expect(screen.getByRole("region", { name: "上下文查看器" })).toBeTruthy();
    // A category with entries opens its first entry, so the right column is never empty.
    await screen.findByText("body:system-prompt/0");
    fireEvent.click(screen.getByRole("button", { name: /System Block 2/ }));
    await screen.findByText("body:system-prompt/1");
    view.unmount();
    expect(query).toHaveBeenCalledWith("context.view.release", { sessionId: "s", snapshotId: "snap" });
  });

  it("narrows the list to a tool-output group, and widens it again while searching", async () => {
    render(
      <PreviewModeProvider switchEnabled={false}>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    await screen.findByRole("meter", { name: "上下文占用" });
    const legend = screen.getByLabelText("上下文类别");
    // Groups unfold only under the selected category.
    fireEvent.click(within(legend).getByRole("button", { name: /工具输出/ }));
    fireEvent.click(await within(legend).findByRole("button", { name: /grep/ }));
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith("context.view.list", {
        sessionId: "s",
        snapshotId: "snap",
        category: "tool-output",
        childKey: "tool-output/tool-0",
        search: "",
      }),
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选上下文" }), { target: { value: "grep" } });
    await waitFor(() => {
      const scoped = query.mock.calls.filter(
        ([kind, input]) => kind === "context.view.list" && (input as { search?: string }).search === "grep",
      );
      expect(scoped).toHaveLength(1);
      expect(scoped[0]![1]).not.toHaveProperty("childKey");
    });
    expect(screen.getByText("搜索范围：整个类别")).toBeTruthy();
  });

  it("shows the shared weight on the thinking group, never 0 tokens on its members", async () => {
    render(
      <PreviewModeProvider switchEnabled={false}>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    await screen.findByRole("meter", { name: "上下文占用" });
    fireEvent.click(within(screen.getByLabelText("上下文类别")).getByRole("button", { name: /助手推理/ }));
    await screen.findAllByText("8k tokens");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 tokens")).toBeNull();
  });

  it("never reads the Host in preview mode and hides the demo chip when marks are off", async () => {
    localStorage.setItem("omp.previewMode", "1");
    const first = render(
      <PreviewModeProvider switchEnabled>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    await screen.findByRole("meter", { name: "上下文占用" });
    expect(screen.getByText("演示")).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
    first.unmount();

    window.history.replaceState({}, "", "/?preview=1&marks=off");
    render(
      <PreviewModeProvider switchEnabled>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    await screen.findByRole("meter", { name: "上下文占用" });
    expect(screen.queryByText("演示")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("reloads the preview entries when the displayed conversation changes", async () => {
    localStorage.setItem("omp.previewMode", "1");
    const preview = render(<PreviewModeProvider switchEnabled><ContextInspector client={client} opened sourceKey="first" width={500} /></PreviewModeProvider>);
    await screen.findByRole("button", { name: /System Block 2/ });
    preview.rerender(<PreviewModeProvider switchEnabled><ContextInspector client={client} opened sourceKey="second" width={500} /></PreviewModeProvider>);
    await screen.findByRole("button", { name: /System Block 2/ });
    expect(query).not.toHaveBeenCalled();
  });

  it("releases the old snapshot and replaces it when the session changes", async () => {
    query.mockImplementation(async (kind: string, input: { sessionId?: string; category?: string; entryId?: string }) => {
      if (kind === "context.view.open") return index({ sessionId: input.sessionId!, snapshotId: `snap-${input.sessionId}` });
      if (kind === "context.view.list") return { entries: ENTRIES[input.category ?? "system-prompt"] ?? [], total: 2 };
      if (kind === "context.view.entry") return { entryId: input.entryId, text: `${input.sessionId}:${input.entryId}`, totalChars: 40, truncated: false };
      return { released: true };
    });
    const view = render(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened /></PreviewModeProvider>);
    await screen.findByText("s:system-prompt/0");
    view.rerender(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="other" opened /></PreviewModeProvider>);
    expect(screen.queryByText("s:system-prompt/0")).toBeNull();
    await screen.findByText("other:system-prompt/0");
    expect(query).toHaveBeenCalledWith("context.view.release", { sessionId: "s", snapshotId: "snap-s" });
  });

  it("reports an unavailable snapshot without inventing numbers", async () => {
    query.mockImplementation(async () => {
      throw new Error("budget exceeded");
    });
    render(
      <PreviewModeProvider switchEnabled={false}>
        <ContextInspector client={client} sessionId="s" opened />
      </PreviewModeProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("button", { name: "更多条目" })).toBeNull();
  });

  it("keeps the snapshot while resizing, then refreshes and releases it on close", async () => {
    const view = render(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened width={1100} /></PreviewModeProvider>);
    await screen.findByText("body:system-prompt/0");
    view.rerender(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened width={500} /></PreviewModeProvider>);
    expect(query.mock.calls.filter(([kind]) => kind === "context.view.open")).toHaveLength(1);
    expect(screen.getByText("body:system-prompt/0").closest("section")?.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /System Block 2/ }));
    await screen.findByText("body:system-prompt/1");
    const back = screen.getByRole("button", { name: "返回列表" });
    expect(back.textContent).toBe("");
    expect(back.querySelector("svg")).toBeTruthy();
    fireEvent.click(back);
    expect(screen.getByRole("button", { name: /System Block 2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /System Block 2/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: "返回列表" }), { key: "/" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "筛选上下文" })));
    expect(screen.getByRole("button", { name: /System Block 2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新快照" }));
    await waitFor(() => expect(query.mock.calls.filter(([kind]) => kind === "context.view.open")).toHaveLength(2));
    expect(query).toHaveBeenCalledWith("context.view.release", { sessionId: "s", snapshotId: "snap" });
    view.rerender(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened={false} width={500} /></PreviewModeProvider>);
    expect(query.mock.calls.filter(([kind]) => kind === "context.view.release")).toHaveLength(2);
  });

  it("releases a snapshot that finishes opening after the viewer has closed", async () => {
    let finish!: (value: ContextViewIndex) => void;
    query.mockImplementation((kind: string) => kind === "context.view.open" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ released: true }));
    const view = render(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened /></PreviewModeProvider>);
    view.rerender(<PreviewModeProvider switchEnabled={false}><ContextInspector client={client} sessionId="s" opened={false} /></PreviewModeProvider>);
    finish(index());
    await waitFor(() => expect(query).toHaveBeenCalledWith("context.view.release", { sessionId: "s", snapshotId: "snap" }));
    expect(screen.queryByRole("meter")).toBeNull();
  });
});
