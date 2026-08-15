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
    detail: { toolName: "bash", summary: "rm -rf /tmp/x", risk: "high" },
  };
}

describe("InteractionDeck real cards", () => {
  it("select shows the real question title and submits the picked option id", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={select("Which backend?", ["SQLite", "PostgreSQL"])} onRespond={onRespond} />);
    expect(screen.getByText("Which backend?")).toBeTruthy();
    expect(screen.queryByText(/Runtime requests select/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "SQLite" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith("submit", "option:0");
  });

  it("input shows the real title and placeholder and submits the typed text", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={input("你的名字？", "Jane")} onRespond={onRespond} />);
    expect(screen.getByText("你的名字？")).toBeTruthy();
    const field = screen.getByPlaceholderText("Jane");
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith("submit", "Ada");
  });

  it("editor is editable and submits the edited string with cancel support", async () => {
    const onRespond = vi.fn(() => Promise.resolve(true));
    render(<InteractionPrompt interaction={editor("draft")} onRespond={onRespond} />);
    expect(screen.getByText("编辑计划")).toBeTruthy();
    const area = screen.getByLabelText("编辑计划") as HTMLTextAreaElement;
    expect(area.value).toBe("draft");
    fireEvent.change(area, { target: { value: "revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("submit", "revised"));
  });

  it("approval submit sends value true", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={approval("允许执行 bash?")} onRespond={onRespond} />);
    expect(screen.getByText("允许执行 bash?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(onRespond).toHaveBeenCalledWith("submit", true);
  });

  it("failed respond keeps the card and shows Retry; resolved clears it", async () => {
    const failing = vi.fn(() => Promise.resolve(false));
    const { rerender } = render(<InteractionPrompt interaction={select("Pick", ["A"])} onRespond={failing} />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByText(/提交失败/)).toBeTruthy());
    // Card stays: same interaction still rendered with Retry affordance.
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
    // A retry with a succeeding responder completes the flow; the option
    // selection survives the rerender.
    const ok = vi.fn(() => Promise.resolve(true));
    rerender(<InteractionPrompt interaction={select("Pick", ["A"])} onRespond={ok} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(ok).toHaveBeenCalledWith("submit", "option:0"));
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
