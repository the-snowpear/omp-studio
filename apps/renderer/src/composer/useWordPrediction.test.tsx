import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ChipComposer } from "./ChipComposer";
import { predictionDraft } from "./useWordPrediction";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function caret(editor: HTMLElement) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
it("keeps hidden chip content out of prediction and skips oversized drafts", () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.append(document.createTextNode("please "));
  const chip = document.createElement("span");
  chip.className = "cm-chip";
  chip.contentEditable = "false";
  chip.textContent = "private-attachment-name";
  editor.append(chip, document.createTextNode(" re"));
  document.body.append(editor);
  try {
    caret(editor);
    const result = predictionDraft(editor)!;
    expect(result.text).not.toContain("private-attachment-name");
    expect(result.text.slice(0, result.caret)).toContain(" re");
    editor.textContent = "x".repeat(4097);
    caret(editor);
    expect(predictionDraft(editor)).toBeUndefined();
  } finally {
    editor.remove();
  }
});
it("accepts preview ghost text with Tab without sending a request or losing typed text", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const original = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 40, 0, 20),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 200),
  );
  const client = { command: vi.fn() } as unknown as StudioClient;
  try {
    const mounted = render(
      <I18nProvider forcedLanguage="en">
        <PreviewModeProvider switchEnabled>
          <ChipComposer
            prediction={{ client, sessionId: "s", available: true }}
          />
        </PreviewModeProvider>
      </I18nProvider>,
    );
    const editor = screen.getByRole("textbox");
    editor.textContent = "please revi";
    caret(editor);
    fireEvent.input(editor);
    await waitFor(() =>
      expect(
        mounted.container.querySelector(".cm-prediction")?.textContent,
      ).toBe("ewTab"),
    );
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.textContent).toBe("please review ");
    expect(client.command).not.toHaveBeenCalled();
  } finally {
    if (original)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});
