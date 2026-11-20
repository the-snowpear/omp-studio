import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ResourceTextView } from "./ResourceTextView";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the draft, caret and undo history when previewing a session Markdown file", async () => {
  const original = "# Original title\n";
  const draft = "# Updated title\n\nProgress is **tracked**.\n";
  function Surface({ language }: { language: "zh" | "en" }) {
    const [text, setText] = useState(original);
    return <I18nProvider forcedLanguage={language}>
      <ResourceTextView uri="local://notes.md" text={text} onChange={setText} label={language === "zh" ? "本地文件正文" : "Local file content"} readOnly={false} />
    </I18nProvider>;
  }
  const view = render(<Surface language="zh" />);
  const editor = () => EditorView.findFromDOM(screen.getByRole("textbox", { name: /本地文件正文|Local file content/ }))!;
  const initial = editor();
  act(() => initial.dispatch({ changes: { from: 0, to: original.length, insert: draft }, selection: { anchor: 5 } }));
  fireEvent.click(screen.getByRole("radio", { name: "预览" }));
  await screen.findByRole("heading", { name: "Updated title" }, { timeout: 5_000 });
  expect(screen.getByText("tracked").tagName).toBe("STRONG");

  view.rerender(<Surface language="en" />);
  fireEvent.click(screen.getByRole("radio", { name: "Source" }));
  expect(editor()).toBe(initial);
  expect(editor().state.selection.main.head).toBe(5);
  expect(editor().state.doc.toString()).toBe(draft);
  view.rerender(<Surface language="zh" />);
  act(() => { undo(editor()); });
  expect(editor().state.doc.toString()).toBe(original);
});
