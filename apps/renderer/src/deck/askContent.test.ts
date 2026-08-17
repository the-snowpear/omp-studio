import { describe, expect, it } from "vitest";
import type { ClientInteraction, InteractionId, SessionId } from "@omp-studio/client-contract";
import { NO_ASK_ANSWER, askToDeckView, selectToAskView, submitAskValue, submitSelectValue } from "./askContent";

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

describe("askToDeckView", () => {
  it("turns a multi-question Host ask into preview cards with chips, preview, and recommended", () => {
    const view = askToDeckView({
      kind: "ask",
      interactionId: "int-ask" as InteractionId,
      sessionId: SESSION,
      leaseGeneration: 1,
      title: "Agent 提问",
      questions: [
        {
          id: "inertia",
          question: "Need inertia?",
          header: "惯性",
          options: [
            { id: "option:0", label: "Yes (Recommended)", description: "coast", preview: "v *= 0.92" },
            { id: "option:1", label: "No" },
          ],
          multiple: false,
          recommended: 0,
        },
        {
          id: "default",
          question: "Default?",
          options: [{ id: "option:0", label: "On" }],
          multiple: false,
        },
      ],
    });
    expect(view.items.map((item) => item.question.header)).toEqual(["惯性", "default"]);
    expect(view.items[0]?.question.options[0]).toEqual({
      label: "Yes",
      description: "coast",
      preview: "v *= 0.92",
    });
    expect(view.items[0]?.question.recommended).toBe(0);
    expect(submitAskValue(
      [
        { id: "inertia", question: "Need inertia?", options: [], multiple: false },
        { id: "default", question: "Default?", options: [], multiple: false },
      ],
      { inertia: { picked: ["Yes"], custom: "" }, default: { picked: [], custom: "off" } },
    )).toEqual({
      results: [
        { id: "inertia", selectedOptions: ["Yes"] },
        { id: "default", selectedOptions: [], customInput: "off" },
      ],
    });
  });
});
