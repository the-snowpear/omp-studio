import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BtwSnapshot } from "@omp-studio/client-contract";
import { BtwPanel } from "./BtwPanel";
import type { BtwSessionApi } from "./useBtwSession";

afterEach(cleanup);

function session(partial: Partial<BtwSessionApi> = {}): BtwSessionApi {
  const snapshot: BtwSnapshot | null = partial.snapshot === undefined
    ? { ephemeralId: "e1", status: "completed", text: "the rename pair was dropped", copy: "copy" }
    : partial.snapshot;
  return {
    snapshot,
    question: "why the rename?",
    draft: "",
    setDraft: vi.fn(),
    startedAt: Date.now(),
    canAbort: false,
    canBranch: false,
    branchBlockedReason: "分支凭据已失效，重新问一次",
    pending: false,
    error: undefined,
    notice: undefined,
    ask: vi.fn(async () => true),
    abort: vi.fn(async () => undefined),
    branch: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    dismissNotice: vi.fn(),
    ...partial,
  };
}

function Harness({ ask = vi.fn(async () => true) }: { ask?: BtwSessionApi["ask"] }) {
  const [draft, setDraft] = useState("");
  return <BtwPanel session={session({ draft, setDraft, ask })} />;
}

describe("BtwPanel", () => {
  it("sends the compose field through ask and clears it on success", async () => {
    const ask = vi.fn(async () => true);
    render(<Harness ask={ask} />);
    const input = screen.getByLabelText("BTW 问题");
    fireEvent.change(input, { target: { value: "and the copy path?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ask).toHaveBeenCalledWith("and the copy path?");
    await vi.waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("does not send a blank compose field", () => {
    const ask = vi.fn(async () => true);
    render(<Harness ask={ask} />);
    fireEvent.keyDown(screen.getByLabelText("BTW 问题"), { key: "Enter" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps Shift+Enter as a newline", () => {
    const ask = vi.fn(async () => true);
    render(<Harness ask={ask} />);
    const input = screen.getByLabelText("BTW 问题");
    fireEvent.change(input, { target: { value: "line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(ask).not.toHaveBeenCalled();
  });
});
