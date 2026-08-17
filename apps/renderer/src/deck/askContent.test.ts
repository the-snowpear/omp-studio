import { describe, expect, it } from "vitest";
import type { ClientInteraction, InteractionId, SessionId } from "@omp-studio/client-contract";
import { NO_ASK_ANSWER, selectToAskView, submitSelectValue } from "./askContent";

const SESSION = "session-1" as SessionId;

function select(overrides: Partial<Extract<ClientInteraction, { kind: "select" }>> = {}): Extract<ClientInteraction, { kind: "select" }> {
  return {
    kind: "select",
    interactionId: "int-select" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title: "Which backend?",
    options: [
      { id: "option:0", label: "SQLite (Recommended)", description: "推荐" },
      { id: "option:1", label: "PostgreSQL" },
      { id: "custom-input", label: "Other (type your own)" },
      { id: "option:3", label: "Chat about this" },
    ],
    multiple: false,
    ...overrides,
  };
}

describe("selectToAskView", () => {
  it("filters reserved TUI options and turns Recommended into an index", () => {
    const view = selectToAskView(select());
    expect(view.question.question).toBe("Which backend?");
    expect(view.question.options.map((option) => option.label)).toEqual(["SQLite", "PostgreSQL"]);
    expect(view.question.recommended).toBe(0);
    expect(view.question.options[0]?.description).toBeUndefined();
    expect(view.idByLabel.SQLite).toBe("option:0");
  });

  it("submits a picked option id, or the typed custom answer as plain text", () => {
    const view = selectToAskView(select());
    expect(submitSelectValue(view, { picked: ["SQLite"], custom: "" }, false)).toBe("option:0");
    expect(submitSelectValue(view, { picked: ["SQLite"], custom: "  neither  " }, false)).toBe("neither");
    expect(submitSelectValue(view, NO_ASK_ANSWER, false)).toBeUndefined();
  });
});
