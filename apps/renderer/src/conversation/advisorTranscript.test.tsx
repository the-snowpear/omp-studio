import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseConversationTranscriptPage } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { getPreviewConvoItems } from "../preview/conversationFixtures";
import { ConvoTranscript } from "./ConvoTranscript";
import { buildTimeline, emptyConversationState, type TimelineRow } from "./conversationViewModel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type AdvisorRow = Extract<TimelineRow, { type: "advisor" }>;
const concernBatch: AdvisorRow = {
  type: "advisor", itemId: "batch", createdAt: "2026-11-21T05:40:00Z",
  notes: [
    { type: "text", advisor: "release", severity: "concern", text: "Keep the first concern first." },
    { type: "text", advisor: "docs", severity: "nit", text: "Keep the nit between the concerns." },
    { type: "text", advisor: "release", severity: "concern", text: "Keep the second concern last.", truncated: true },
    { type: "text", text: "An older ungraded note." },
  ],
};
const blockerBatch: AdvisorRow = { ...concernBatch, itemId: "blocker-batch", notes: [
  { type: "text", advisor: "release", severity: "blocker", text: "Fix the blocker before publishing." },
  { type: "text", advisor: "release", severity: "concern", text: "Run the relevant checks again." },
] };

function transcript(rows: readonly TimelineRow[], language: "zh" | "en" = "en", scope = "session", demo = false) {
  return <I18nProvider forcedLanguage={language}><ConvoTranscript rows={rows} stateScopeKey={scope} demo={demo} /></I18nProvider>;
}

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
    expect(view.getByRole("button", { name: zh ? /^展开审阅意见：审阅顾问 · 2 条需关注/ : /^Expand advisor notes: Advisor · 2 concerns/ }).getAttribute("aria-expanded")).toBe("false");
    expect(view.getByRole("button", { name: zh ? /^收起审阅意见：.*1 条阻断问题/ : /^Collapse advisor notes:.*1 blocker/ }).getAttribute("aria-expanded")).toBe("true");
  }
});

it("collapses one original batch, keeps mixed notes in order and copies complete text even while folded", async () => {
  const view = render(transcript([concernBatch]));
  const card = view.getByRole("complementary", { name: "Advisor · 2 concerns · 1 nit · 1 ungraded note" });
  const toggle = within(card).getByRole("button", { name: /^Expand advisor notes/ });
  const bodyId = toggle.getAttribute("aria-controls")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText(concernBatch.notes[0]!.text)).toBeNull();
  expect(document.getElementById(bodyId)?.hidden).toBe(true);

  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Copy advisor batch" })); });
  expect(writeText).toHaveBeenCalledWith([
    "Advisor · release · Concern\nKeep the first concern first.",
    "Advisor · docs · Nit\nKeep the nit between the concerns.",
    "Advisor · release · Concern\nKeep the second concern last.",
    "Advisor\nAn older ungraded note.",
  ].join("\n\n"));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(bodyId)?.hidden).toBe(false);
  const notes = within(card).getAllByRole("listitem");
  expect(notes).toHaveLength(4);
  concernBatch.notes.forEach((note, index) => expect(notes[index]?.textContent).toContain(note.text));
  expect(within(card).getAllByText(new Date(concernBatch.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))).toHaveLength(1);
  await act(async () => { fireEvent.click(within(notes[1]!).getByRole("button", { name: "Copy message" })); });
  expect(writeText).toHaveBeenLastCalledWith("Advisor · docs · Nit\nKeep the nit between the concerns.");
  fireEvent.click(toggle);
  expect(within(card).queryByRole("list")).toBeNull();
  expect(view.queryByText(concernBatch.notes[0]!.text)).toBeNull();
});

it("starts blockers open, respects manual choices through appends and prepends, and keeps batches separate", () => {
  const view = render(transcript([blockerBatch, concernBatch]));
  const blocker = view.getByRole("button", { name: /^Collapse advisor notes: Advisor · release · 1 blocker/ });
  const ordinary = view.getByRole("button", { name: /^Expand advisor notes: Advisor · 2 concerns/ });
  fireEvent.click(blocker);
  fireEvent.click(ordinary);
  const nextBatch: AdvisorRow = { ...concernBatch, itemId: "next-batch" };
  const user: TimelineRow = { type: "user", itemId: "user", createdAt: "", text: "Continue after the review." };
  view.rerender(transcript([user, { ...blockerBatch }, { ...concernBatch }, nextBatch]));
  expect(blocker.getAttribute("aria-expanded")).toBe("false");
  expect(ordinary.getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelectorAll(".ev-advisor-batch")).toHaveLength(3);
  expect(view.getByRole("button", { name: /^Expand advisor notes: Advisor · 2 concerns/ }).getAttribute("aria-expanded")).toBe("false");
  expect(view.getByText(user.text).compareDocumentPosition(blocker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("keeps expanded content and controls mounted through zh to en to zh without rewriting notes", () => {
  const view = render(transcript([concernBatch], "zh"));
  const toggle = view.getByRole("button", { name: /^展开审阅意见/ });
  fireEvent.click(toggle);
  const note = view.getByText(concernBatch.notes[0]!.text);
  for (const language of ["en", "zh"] as const) {
    view.rerender(transcript([{ ...concernBatch }], language));
    expect(view.getByRole("button", { name: language === "zh" ? /^收起审阅意见/ : /^Collapse advisor notes/ })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText(concernBatch.notes[0]!.text)).toBe(note);
    expect(view.getByRole("button", { name: language === "zh" ? "复制整组审阅意见" : "Copy advisor batch" })).toBeTruthy();
  }
});

it("isolates conversation and preview scopes and releases overrides for evicted messages", () => {
  const view = render(transcript([concernBatch]));
  fireEvent.click(view.getByRole("button", { name: /^Expand advisor notes/ }));
  view.rerender(transcript([concernBatch], "en", "other-session"));
  expect(view.getByRole("button", { name: /^Expand advisor notes/ }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: /^Expand advisor notes/ }));
  view.rerender(transcript([concernBatch], "en", "other-session", true));
  expect(view.getByRole("button", { name: /^Expand advisor notes/ }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: /^Expand advisor notes/ }));
  view.rerender(transcript([], "en", "other-session", true));
  view.rerender(transcript([concernBatch], "en", "other-session", true));
  expect(view.getByRole("button", { name: /^Expand advisor notes/ }).getAttribute("aria-expanded")).toBe("false");
});

it("summarizes a 28-note batch in one folded heading with accurate severity counts", () => {
  const notes: AdvisorRow["notes"] = [
    ...Array.from({ length: 22 }, (_, index) => ({ type: "text" as const, severity: "concern" as const, text: `Concern ${index + 1}` })),
    { type: "text", severity: "nit", text: "One small suggestion." },
    ...Array.from({ length: 5 }, (_, index) => ({ type: "text" as const, text: `Ungraded ${index + 1}` })),
  ];
  const view = render(transcript([{ ...concernBatch, notes }]));
  expect(view.getByRole("button", { name: "Expand advisor notes: Advisor · 22 concerns · 1 nit · 5 ungraded notes" })).toBeTruthy();
  expect(view.queryByRole("listitem")).toBeNull();
});
