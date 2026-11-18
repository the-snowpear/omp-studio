import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { ConversationMessageItem } from "@omp-studio/client-contract";
import { ConvoTranscript } from "../conversation/ConvoTranscript";
import { buildTimeline, emptyConversationState } from "../conversation/conversationViewModel";
import { I18nProvider } from "../i18n";
import { PlanReviewDeck, PlanViewDialog } from "./PlanCard";
import { PlanExecutionPicker } from "./PlanExecutionPicker";
import { QueuedDeck } from "./QueuedDeck";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function planView(props: ComponentProps<typeof PlanReviewDeck>) {
  return render(
    <I18nProvider forcedLanguage="zh">
      <PlanReviewDeck {...props} />
    </I18nProvider>,
  );
}

describe("Plan Save & Quit", () => {
  it("renders on the small card head and triggers the no-arg callback", () => {
    const onSaveAndQuit = vi.fn();
    planView({ title: "Plan", body: "## Goal", onAction: vi.fn(), onSaveAndQuit });

    const compactCard = screen.getByRole("region", { name: "待审核的计划" });
    const saveButton = within(compactCard).getByRole("button", { name: "保存并退出" });
    expect(saveButton.closest(".approval-head")).not.toBeNull();
    const footer = compactCard.querySelector<HTMLElement>(".dk-actions");
    expect(footer ? within(footer).queryByRole("button", { name: "保存并退出" }) : null).toBeNull();
    fireEvent.click(saveButton);

    expect(onSaveAndQuit).toHaveBeenCalledTimes(1);
    expect(onSaveAndQuit).toHaveBeenCalledWith();
  });

  it("keeps the button wired in the large review dialog head", () => {
    const onSaveAndQuit = vi.fn();
    planView({ title: "Plan", body: "## Goal", expanded: true, onAction: vi.fn(), onSaveAndQuit });
    const dialog = screen.getByRole("dialog", { name: "Plan Review · Plan" });
    const dialogButton = within(dialog).getByRole("button", { name: "保存并退出" });
    expect(dialogButton.closest(".plan-review-dialog-head")).not.toBeNull();
    const footer = dialog.querySelector<HTMLElement>(".dk-actions");
    expect(footer ? within(footer).queryByRole("button", { name: "保存并退出" }) : null).toBeNull();

    fireEvent.click(dialogButton);
    expect(onSaveAndQuit).toHaveBeenCalledTimes(1);
  });

  it("does not render a fake action without the callback and QueuedDeck forwards the item", () => {
    planView({ title: "Preview", body: "## Goal", onAction: vi.fn() });
    expect(screen.queryByRole("button", { name: "保存并退出" })).toBeNull();
    cleanup();

    const item = { kind: "plan" as const, id: "plan-1", title: "Queued", body: "## Goal" };
    const onSaveAndQuit = vi.fn();
    render(
      <I18nProvider forcedLanguage="zh">
        <QueuedDeck
          items={[item]}
          regionLabel="Queued"
          onPlanSaveAndQuit={onSaveAndQuit}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存并退出" }));
    expect(onSaveAndQuit).toHaveBeenCalledWith(item);
  });
});

describe("PlanExecutionPicker & PlanViewDialog", () => {
  it("portals the execution tier menu to document.body, switches roles, and closes only the menu on Escape", () => {
    const onChange = vi.fn();
    const onExpandedChange = vi.fn();
    const details = {
      available: true,
      reviewId: "rev-1",
      selectedRole: "default",
      tiers: [
        { role: "smol", provider: "anthropic", model: "claude-haiku-4.5", name: "Claude Haiku 4.5", thinkingLevel: "low" },
        { role: "default", provider: "magpie", model: "auto/gemini-4-carbon", name: "Gemini 4 Carbon", thinkingLevel: "high" },
      ],
    };

    const { rerender } = render(
      <I18nProvider forcedLanguage="zh">
        <PlanReviewDeck
          title="tool-card-plan"
          body={"## Context\n\nDetailed steps"}
          expanded
          onExpandedChange={onExpandedChange}
          onAction={vi.fn()}
          executionControl={<PlanExecutionPicker details={details} role="default" onChange={onChange} />}
        />
      </I18nProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "Plan Review · tool-card-plan" });
    const trigger = within(dialog).getByRole("combobox", { name: "执行模型" });
    expect(trigger.textContent).toContain("Gemini 4 Carbon");
    expect(trigger.textContent).toContain("默认");
    expect(trigger.textContent).toContain("magpie/auto/gemini-4-carbon");

    rerender(
      <I18nProvider forcedLanguage="en">
        <PlanReviewDeck
          title="tool-card-plan"
          body={"## Context\n\nDetailed steps"}
          expanded
          onExpandedChange={onExpandedChange}
          onAction={vi.fn()}
          executionControl={<PlanExecutionPicker details={details} role="default" onChange={onChange} />}
        />
      </I18nProvider>,
    );
    expect(within(dialog).getByRole("combobox", { name: "Execution model" }).textContent).toContain("Default");

    rerender(
      <I18nProvider forcedLanguage="zh">
        <PlanReviewDeck
          title="tool-card-plan"
          body={"## Context\n\nDetailed steps"}
          expanded
          onExpandedChange={onExpandedChange}
          onAction={vi.fn()}
          executionControl={<PlanExecutionPicker details={details} role="default" onChange={onChange} />}
        />
      </I18nProvider>,
    );

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "计划执行模型" });
    expect(dialog.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    // Escape closes the tier popover without closing the parent PlanReviewDialog.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "计划执行模型" })).toBeNull();
    expect(onExpandedChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("listbox", { name: "计划执行模型" })).getByRole("option", { name: /Claude Haiku 4\.5/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("smol");
  });

  it("renders the full approved plan document in PlanViewDialog without the collapsed preview clamp", () => {
    const origin = document.createElement("button");
    const longBody = [
      "# 工具链文件类型图标与工具卡代码语法高亮实施规格",
      "",
      "## Context",
      "",
      ...Array.from({ length: 24 }, (_, idx) => `${idx + 1}. 实施步骤说明第 ${idx + 1} 行，确保长计划完整可滚动阅读。`),
    ].join("\n");

    render(
      <I18nProvider forcedLanguage="zh">
        <PlanViewDialog
          title="tool-card-file-icons-and-highlight"
          body={longBody}
          originRef={{ current: origin }}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "计划详情 · tool-card-file-icons-and-highlight" });
    expect(within(dialog).getByText("已批准")).not.toBeNull();
    expect(dialog.querySelector(".plan-md-preview")).toBeNull();
    expect(dialog.querySelector(".plan-view-doc")).not.toBeNull();
    expect(within(dialog).getByText(/实施步骤说明第 24 行/)).not.toBeNull();
  });

  it("ignores read xd://propose doc lookups and pins a single PlanCreatedCard inline above post-approval execution chains", () => {
    const onOpen = vi.fn();
    const a1: ConversationMessageItem = {
      kind: "message",
      itemId: "a-1",
      parentId: null,
      createdAt: "2026-11-18T00:00:01.000Z",
      role: "assistant",
      content: [
        { type: "thinking", text: "Checking how xd://propose works" },
        { type: "toolCall", toolCallId: "read-propose-doc", toolName: "read", arguments: { path: "xd://propose" } },
        {
          type: "toolResult",
          toolCallId: "read-propose-doc",
          toolName: "read",
          isError: false,
          output: "Write your plan slug to xd://propose.",
        },
      ],
    };
    const a2: ConversationMessageItem = {
      kind: "message",
      itemId: "a-2",
      parentId: "a-1",
      createdAt: "2026-11-18T00:00:02.000Z",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "write-plan-file",
          toolName: "write",
          arguments: { path: "local://tool-card-file-icons-and-highlight-plan.md", content: "# Spec\n\nDetailed steps" },
        },
        {
          type: "toolResult",
          toolCallId: "write-plan-file",
          toolName: "write",
          isError: false,
          output: "Wrote plan",
        },
        {
          type: "toolCall",
          toolCallId: "submit-propose",
          toolName: "write",
          arguments: { path: "xd://propose", content: "tool-card-file-icons-and-highlight" },
        },
        {
          type: "toolResult",
          toolCallId: "submit-propose",
          toolName: "write",
          isError: false,
          output: "Plan ready for review.",
          data: {
            xdev: {
              tool: "propose",
              mode: "execute",
              args: { title: "tool-card-file-icons-and-highlight" },
              inner: {
                planFilePath: "local://tool-card-file-icons-and-highlight-plan.md",
                title: "tool-card-file-icons-and-highlight",
                planExists: true,
                planContent: "# Spec\n\nDetailed steps",
              },
            },
          },
        },
      ],
    };
    const a3Execution: ConversationMessageItem = {
      kind: "message",
      itemId: "a-3",
      parentId: "a-2",
      createdAt: "2026-11-18T00:00:05.000Z",
      role: "assistant",
      content: [
        { type: "thinking", text: "Now executing the approved plan" },
        {
          type: "toolCall",
          toolCallId: "exec-read-1",
          toolName: "read",
          arguments: { path: "apps/renderer/src/conversation/toolMeta.ts" },
        },
      ],
    };
    const rows = buildTimeline({
      ...emptyConversationState(),
      items: [a1, a2, a3Execution],
      openTurnItems: { "a-3": "turn-exec" },
    });

    const { container } = render(
      <I18nProvider forcedLanguage="zh">
        <ConvoTranscript rows={rows} planLink={{ onOpen }} />
      </I18nProvider>,
    );

    // Only ONE PlanCreatedCard is rendered (no phantom "Plan" card from `read xd://propose`).
    const planCards = container.querySelectorAll(".plan-created");
    expect(planCards).toHaveLength(1);
    const planButton = screen.getByRole("button", { name: "打开计划：tool-card-file-icons-and-highlight" });
    expect(screen.queryByRole("button", { name: "打开计划：Plan" })).toBeNull();

    // Order inside `.ev-assistant`: planning `.ev-batch` -> `.plan-created` -> execution `.ev-batch` (live open tail).
    const runRoot = container.querySelector(".ev-assistant")!;
    const children = [...runRoot.children].filter((el) => !el.classList.contains("ev-head"));
    expect(children.map((el) => (el.classList.contains("plan-created") ? "plan" : el.classList.contains("ev-batch") ? "batch" : el.className))).toEqual([
      "batch",
      "plan",
      "batch",
    ]);
    expect(children[0]!.classList.contains("open")).toBe(false);
    expect(children[2]!.classList.contains("open")).toBe(true);

    fireEvent.click(planButton);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(planButton, {
      title: "tool-card-file-icons-and-highlight",
      body: "# Spec\n\nDetailed steps",
    });
  });
});

