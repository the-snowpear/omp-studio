import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseConversationTranscriptPage } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { getPreviewConvoItems } from "../preview/conversationFixtures";
import { ConvoTranscript } from "./ConvoTranscript";
import { buildTimeline, emptyConversationState } from "./conversationViewModel";

afterEach(cleanup);

it("keeps advisor attribution, order and copy text when switching the mounted transcript language", () => {
  const note = "Check that A < B before continuing.";
  const items = parseConversationTranscriptPage({
    runtimeEpoch: 1, sessionId: "session", branchLeafId: "reply", headCursor: "h", hasMoreBefore: false,
    items: [
      { kind: "message", role: "assistant", itemId: "first", parentId: null, createdAt: "now", content: [{ type: "text", text: "First answer" }] },
      { kind: "message", role: "advisor", itemId: "review", parentId: "first", createdAt: "now",
        content: [{ type: "text", advisor: "release", severity: "concern", text: note }] },
      { kind: "message", role: "assistant", itemId: "reply", parentId: "review", createdAt: "now", content: [{ type: "text", text: "Correction" }] },
    ],
  }).items;
  const rows = buildTimeline({ ...emptyConversationState(), items });
  const transcript = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><ConvoTranscript rows={rows} /></I18nProvider>;
  const view = render(transcript("zh"));
  const card = view.getByRole("complementary", { name: "审阅顾问 · release · 需关注" });
  expect(view.getByText("First answer").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.compareDocumentPosition(view.getByText("Correction")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  view.rerender(transcript("en"));
  expect(view.getByRole("complementary", { name: "Advisor · release · Concern" })).toBe(card);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  try {
    fireEvent.click(within(card).getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith(`Advisor · release · Concern\n${note}`);
  } finally {
    vi.unstubAllGlobals();
  }
  view.rerender(transcript("zh"));
  expect(within(view.getByRole("complementary", { name: "审阅顾问 · release · 需关注" })).getByText(note)).toBeTruthy();
});

it("renders the preview advisor in the current language", () => {
  function preview(language: "zh" | "en") {
    const items = getPreviewConvoItems(language === "zh").filter(item => item.kind === "message" && item.role === "advisor");
    const rows = buildTimeline({ ...emptyConversationState(), items });
    return <I18nProvider forcedLanguage={language}><ConvoTranscript demo rows={rows} /></I18nProvider>;
  }
  const view = render(preview("zh"));
  for (const language of ["zh", "en", "zh"] as const) {
    view.rerender(preview(language));
    const zh = language === "zh";
    const card = view.getByRole("complementary", { name: zh ? "审阅顾问 · upstream-sync · 需关注" : "Advisor · upstream-sync · Concern" });
    expect(within(card).getByText(zh ? /请核对同步后的/ : /Check the Studio Bridge path/)).toBeTruthy();
  }
});
