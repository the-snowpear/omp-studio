import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClientInteraction, InteractionId, SessionId } from "@omp-studio/client-contract";
import { InteractionDeck, InteractionPrompt } from "./InteractionDeck";

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no ResizeObserver; the deck's width-tracking effect needs a stub.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
});

const SESSION = "session-1" as SessionId;

function select(title: string, options: string[]): ClientInteraction {
  return {
    kind: "select",
    interactionId: "int-select" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title,
    options: options.map((label, index) => ({ id: `option:${index}`, label })),
    multiple: false,
  };
}

function input(title: string, placeholder?: string): ClientInteraction {
  return {
    kind: "input",
    interactionId: "int-input" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title,
    ...(placeholder === undefined ? {} : { placeholder }),
    secret: false,
  };
}

function editor(content: string): ClientInteraction {
  return {
    kind: "editor",
    interactionId: "int-editor" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title: "编辑计划",
    content,
    language: "markdown",
  };
}

function approval(title: string): ClientInteraction {
  return {
    kind: "approval",
    interactionId: "int-approval" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title,
    approvalType: "bash",
    detail: {
      toolName: "bash",
      summary: "Command: git status\nReason: inspect workspace",
      risk: "high",
    },
  };
}

describe("InteractionDeck real cards", () => {
  it("select uses the preview Ask layout and submits the picked option id", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={select("Which backend?", ["SQLite", "PostgreSQL"])} onRespond={onRespond} />);
    expect(screen.getByText("Agent 提问")).toBeTruthy();
    expect(screen.getByText("Which backend?")).toBeTruthy();
    expect(screen.queryByText(/Runtime requests select/)).toBeNull();
    expect(document.querySelector(".dk-opt")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledWith("submit", "option:0");
  });

  it("select custom answer submits the typed text", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={select("Which backend?", ["SQLite"])} onRespond={onRespond} />);
    fireEvent.change(screen.getByLabelText("自定义回答"), { target: { value: "neither" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledWith("submit", "neither");
  });

  it("input shows the real title and placeholder and submits the typed text", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={input("你的名字？", "Jane")} onRespond={onRespond} />);
    expect(screen.getByText("你的名字？")).toBeTruthy();
    const field = screen.getByPlaceholderText("Jane");
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledWith("submit", "Ada");
  });

  it("editor is editable and submits the edited string with cancel support", async () => {
    const onRespond = vi.fn(() => Promise.resolve(true));
    render(<InteractionPrompt interaction={editor("draft")} onRespond={onRespond} />);
    expect(screen.getByText("编辑计划")).toBeTruthy();
    const area = screen.getByLabelText("编辑计划") as HTMLTextAreaElement;
    expect(area.value).toBe("draft");
    fireEvent.change(area, { target: { value: "revised" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("submit", "revised"));
  });

  it("approval uses the ver1 layout and submit sends value true", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={approval("允许执行 bash?")} onRespond={onRespond} />);
    expect(screen.getByText("审批请求")).toBeTruthy();
    expect(screen.getByText("OMP 想要执行 Bash 命令")).toBeTruthy();
    expect(screen.getByText("高风险")).toBeTruthy();
    expect(screen.getByText(/git status/)).toBeTruthy();
    expect(screen.getByText("inspect workspace")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(onRespond).toHaveBeenCalledWith("submit", true);
  });

  it("approval 拒绝 cancels the interaction", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={approval("Allow?")} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onRespond).toHaveBeenCalledWith("cancel");
  });

  it("approval 始终允许 still submits true for this call", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={approval("Allow?")} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "始终允许" }));
    expect(onRespond).toHaveBeenCalledWith("submit", true);
  });

  it("failed respond keeps the card and shows Retry; resolved clears it", async () => {
    const failing = vi.fn(() => Promise.resolve(false));
    const { rerender } = render(<InteractionPrompt interaction={select("Pick", ["A"])} onRespond={failing} />);
    fireEvent.click(screen.getByRole("radio", { name: /^A$/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(screen.getByText(/提交失败/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    const ok = vi.fn(() => Promise.resolve(true));
    rerender(<InteractionPrompt interaction={select("Pick", ["A"])} onRespond={ok} />);
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(ok).toHaveBeenCalledWith("submit", "option:0"));
  });

  it("failed cancel keeps the card and exposes Retry", async () => {
    const failing = vi.fn(() => Promise.resolve(false));
    render(<InteractionPrompt interaction={select("Pick", ["A"])} onRespond={failing} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(failing).toHaveBeenCalledWith("cancel"));
    expect(screen.getByText(/提交失败/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("deck identity includes leaseGeneration: same id with a higher generation replaces the card", () => {
    const onRespond = vi.fn();
    const first = select("Q1", ["A"]);
    const second: ClientInteraction = { ...first, leaseGeneration: 2, title: "Q2" };
    const { rerender } = render(<InteractionDeck interaction={first} onRespond={onRespond} disabled={false} />);
    expect(screen.getByText("Q1")).toBeTruthy();
    rerender(<InteractionDeck interaction={second} onRespond={onRespond} disabled={false} />);
    expect(screen.getByText("Q2")).toBeTruthy();
  });
});
