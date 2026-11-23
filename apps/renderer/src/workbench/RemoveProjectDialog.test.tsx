/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { RemoveProjectDialog } from "./AppShell";

afterEach(() => {
  cleanup();
});

function renderDialog(props: Partial<Parameters<typeof RemoveProjectDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <I18nProvider forcedLanguage="en">
      <RemoveProjectDialog
        name="omp-web"
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    </I18nProvider>,
  );
  return { view, onConfirm, onCancel };
}

const checkbox = (): HTMLInputElement => screen.getByRole("checkbox") as HTMLInputElement;
// The confirm control is the dialog's danger button; its label flips to the
// in-flight "Removing…" copy while busy, so select by role + class, not text.
const confirmButton = (): HTMLButtonElement =>
  document.querySelector("section[aria-labelledby='projectRemoveTitle'] .btn.danger") as HTMLButtonElement;

describe("RemoveProjectDialog session-records checkbox", () => {
  it("defaults to keeping session records (unchecked)", () => {
    const { onConfirm } = renderDialog();
    expect(checkbox().checked).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("passes the checkbox state through on confirm", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenLastCalledWith(true);
  });

  it("disables the checkbox and confirm while the removal is in flight", () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });
    expect(checkbox().disabled).toBe(true);
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(checkbox());
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
