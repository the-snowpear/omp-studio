/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { RemoveProjectDialog } from "./RemoveProjectDialog";

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

const keep = () => screen.getByRole<HTMLInputElement>("radio", { name: "Keep sessions" });
const remove = () => screen.getByRole<HTMLInputElement>("radio", { name: "Permanently delete sessions" });

describe("RemoveProjectDialog", () => {
  it("defaults to keeping session records", () => {
    const { onConfirm } = renderDialog();
    expect(keep().checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("makes the permanent deletion choice and its confirm action explicit", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(remove());
    expect(remove().checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove project and delete sessions" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("blocks closing while the removal is in flight", () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });
    const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "Removing…" });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
