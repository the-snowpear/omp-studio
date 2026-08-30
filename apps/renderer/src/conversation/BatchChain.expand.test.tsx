import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchChain, type ChainItem } from "./BatchChain";
import type { ToolView } from "./conversationViewModel";

afterEach(cleanup);

function bash(id: string, output: string): ToolView {
  return { toolCallId: id, toolName: "bash", arguments: { command: "ls" }, status: "succeeded", output };
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe("BatchChain expand", () => {
  it("mounts a tool body on first open and only then starts the transition", async () => {
    const items: ChainItem[] = [{ kind: "tool", tool: bash("b1", "first output") }, { kind: "tool", tool: bash("b2", "second output") }];
    const { container } = render(<BatchChain items={items} batchKey="chain" />);
    const item = container.querySelector<HTMLElement>('[data-tool-call-id="b1"]')!;
    // Collapsed cards are hidden by CSS rather than unmounted, so a body that is
    // rendered eagerly costs a full payload per card in the viewport.
    expect(item.querySelector(".tc-body")!.childElementCount).toBe(0);
    expect(item.className).not.toContain("open");

    act(() => {
      fireEvent.click(item.querySelector(".tl-row")!);
    });
    // The body lands first; the `open` class waits one frame so the 250ms
    // transition is not spent laying the body out.
    expect(item.querySelector(".tc-body")!.textContent).toContain("first output");
    expect(item.className).not.toContain("open");

    await nextFrame();
    expect(item.className).toContain("open");
  });

  it("keeps the body mounted through a collapse so the animation has content", async () => {
    const items: ChainItem[] = [{ kind: "tool", tool: bash("b1", "first output") }, { kind: "tool", tool: bash("b2", "second output") }];
    const { container } = render(<BatchChain items={items} batchKey="chain" />);
    const item = container.querySelector<HTMLElement>('[data-tool-call-id="b1"]')!;
    act(() => {
      fireEvent.click(item.querySelector(".tl-row")!);
    });
    await nextFrame();
    act(() => {
      fireEvent.click(item.querySelector(".tl-row")!);
    });
    expect(item.className).not.toContain("open");
    expect(item.querySelector(".tc-body")!.textContent).toContain("first output");
  });

  it("drops the body once the collapse transition has finished", async () => {
    // A collapsed card is invisible, so keeping its body mounted means a running
    // tool keeps re-rendering thousands of output rows behind a closed card on
    // every published frame.
    vi.useFakeTimers();
    try {
      const items: ChainItem[] = [{ kind: "tool", tool: bash("b1", "first output") }, { kind: "tool", tool: bash("b2", "second output") }];
      const { container } = render(<BatchChain items={items} batchKey="chain" />);
      const item = container.querySelector<HTMLElement>('[data-tool-call-id="b1"]')!;
      act(() => { fireEvent.click(item.querySelector(".tl-row")!); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(item.className).toContain("open");
      act(() => { fireEvent.click(item.querySelector(".tl-row")!); });
      expect(item.querySelector(".tc-body")!.textContent).toContain("first output");
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(item.querySelector(".tc-body")!.childElementCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounts a running tool immediately when its card is collapsed", () => {
    const running: ToolView = {
      toolCallId: "live",
      toolName: "bash",
      arguments: { command: "npm test" },
      status: "running",
      output: "live output",
    };
    const items: ChainItem[] = [{ kind: "tool", tool: running }, { kind: "tool", tool: bash("done", "done") }];
    const { container } = render(<BatchChain items={items} batchKey="live-chain" liveTail />);
    const item = container.querySelector<HTMLElement>('[data-tool-call-id="live"]')!;
    expect(item.querySelector(".tc-body")?.textContent).toContain("live output");
    act(() => { fireEvent.click(item.querySelector(".tl-row")!); });
    expect(item.querySelector(".tc-body")?.childElementCount).toBe(0);
  });

  it("keeps a completed card mounted through its collapse inside a live chain", async () => {
    // 流式期间已完成的卡片正文已冻结：收起走完整过渡，不再随链级 instant 硬切卸载。
    vi.useFakeTimers();
    try {
      const running: ToolView = {
        toolCallId: "live",
        toolName: "bash",
        arguments: { command: "npm test" },
        status: "running",
        output: "live output",
      };
      const items: ChainItem[] = [{ kind: "tool", tool: bash("b1", "first output") }, { kind: "tool", tool: running }];
      const { container } = render(<BatchChain items={items} batchKey="live-chain" liveTail />);
      const item = container.querySelector<HTMLElement>('[data-tool-call-id="b1"]')!;
      act(() => { fireEvent.click(item.querySelector(".tl-row")!); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(item.className).toContain("open");
      act(() => { fireEvent.click(item.querySelector(".tl-row")!); });
      expect(item.className).not.toContain("open");
      expect(item.querySelector(".tc-body")!.textContent).toContain("first output");
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(item.querySelector(".tc-body")!.childElementCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps completed cards mounted when a live tail chain without running tools collapses", () => {
    // 尾链只剩思考/正文在流式、工具都已结束时，整链收起同样走过渡：卡片留在 DOM 里，
    // 由链条自己的 0fr 收起；不再像链级 instant 那样同步卸载整链卡片。
    const items: ChainItem[] = [{ kind: "tool", tool: bash("b1", "first output") }, { kind: "tool", tool: bash("b2", "second output") }];
    const { container } = render(<BatchChain items={items} batchKey="tail-chain" liveTail />);
    const tail = container.querySelector<HTMLElement>('[data-tool-call-id="b2"]')!;
    expect(tail.className).toContain("open");
    act(() => { fireEvent.click(container.querySelector(".batch-sum")!); });
    expect(container.querySelector(".batch-chain-inner")?.childElementCount).toBeGreaterThan(0);
    expect(tail.querySelector(".tc-body")?.textContent).toContain("second output");
  });

  it("unmounts the whole running chain immediately when its summary is collapsed", () => {
    const running: ToolView = {
      toolCallId: "live",
      toolName: "bash",
      arguments: { command: "npm test" },
      status: "running",
      output: "live output",
    };
    const items: ChainItem[] = [{ kind: "tool", tool: running }, { kind: "tool", tool: bash("done", "done") }];
    const { container } = render(<BatchChain items={items} batchKey="live-chain" liveTail />);
    expect(container.querySelector(".batch-chain-inner")?.childElementCount).toBeGreaterThan(0);
    act(() => { fireEvent.click(container.querySelector(".batch-sum")!); });
    expect(container.querySelector(".batch-chain-inner")?.childElementCount).toBe(0);
  });

  it("renders reasoning as one pre-wrap text node instead of a node per line", () => {
    const text = "line one\nline two\nline three";
    const { container } = render(
      <BatchChain items={[{ kind: "think", think: { key: "t1", text } }]} batchKey="chain" expandAll />,
    );
    const scroll = container.querySelector<HTMLElement>(".think-scroll")!;
    expect(scroll.textContent).toBe(text);
    expect(scroll.querySelectorAll("br")).toHaveLength(0);
    expect(scroll.querySelectorAll("span")).toHaveLength(0);
  });
});
