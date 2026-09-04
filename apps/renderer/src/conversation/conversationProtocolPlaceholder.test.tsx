import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessageItem } from "@omp-studio/client-contract";

import { ConvoTranscript } from "./ConvoTranscript";
import { buildTimeline, emptyConversationState } from "./conversationViewModel";

const PLACEHOLDER = "[System: Empty message content sanitised to satisfy protocol]\n\n";

afterEach(cleanup);

function assistant(id: string, content: ConversationMessageItem["content"]): ConversationMessageItem {
  return { kind: "message", itemId: id, parentId: null, createdAt: id, role: "assistant", content };
}

describe("empty-message protocol placeholder", () => {
  it("removes the provider artifact so adjacent tool activity renders as one chain", () => {
    const first = assistant("a-1", [
      { type: "thinking", text: "inspect" },
      { type: "text", text: PLACEHOLDER },
      { type: "toolCall", toolCallId: "tool-1", toolName: "read" },
    ]);
    const second = assistant("a-2", [
      { type: "thinking", text: "verify" },
      { type: "text", text: PLACEHOLDER },
      { type: "toolCall", toolCallId: "tool-2", toolName: "bash" },
    ]);
    const summary = assistant("a-3", [{ type: "text", text: "Final summary" }]);
    const rows = buildTimeline({ ...emptyConversationState(), items: [first, second, summary] });

    const view = render(<ConvoTranscript rows={rows} />);

    expect(view.queryByText(/Empty message content sanitised/u)).toBeNull();
    expect(view.container.querySelectorAll(".batch-chain")).toHaveLength(1);
    expect(view.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
    expect(view.getByText("Final summary").closest(".ev-copy-host")).not.toBeNull();
  });

  it("keeps ordinary intermediate text visible but reserves copy for the concluding reply", () => {
    const process = assistant("a-1", [
      { type: "text", text: "Intermediate update" },
      { type: "toolCall", toolCallId: "tool-1", toolName: "bash" },
    ]);
    const summary = assistant("a-2", [{ type: "text", text: "Concluding reply" }]);
    const rows = buildTimeline({ ...emptyConversationState(), items: [process, summary] });

    const view = render(<ConvoTranscript rows={rows} />);

    expect(view.getByText("Intermediate update").closest(".ev-copy-host")).toBeNull();
    expect(view.getByText("Concluding reply").closest(".ev-copy-host")).not.toBeNull();
    expect(view.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
  });
});
