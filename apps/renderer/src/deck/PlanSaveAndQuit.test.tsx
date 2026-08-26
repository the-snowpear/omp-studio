import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { I18nProvider } from "../i18n";
import { PlanReviewDeck } from "./PlanCard";
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
