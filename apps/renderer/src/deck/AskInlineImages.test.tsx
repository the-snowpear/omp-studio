import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AskBody } from "./AskCard";
import { patchAskAnswer, submitAskValue } from "./askContent";
import type { DeckAskAnswer } from "./types";
import { setAskCaret, setAskText } from "../test/askEditor";

afterEach(cleanup);
const question = { id: "q", question: "Choose", options: [], acceptImages: true };
const nativeQuestions = [{ id: "q", question: "Choose", options: [], multiple: false }];
function imageFile(byte: number): File {
  const file = new File(["x"], `${byte}.png`, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([byte]).buffer });
  return file;
}
function Fields({ revision = 0, submitted }: { revision?: number; submitted: (value: unknown) => void }) {
  const [answer, setAnswer] = useState<DeckAskAnswer>({ picked: [], custom: "before after" });
  return <AskBody key={revision} question={question} answer={answer} onPick={() => {}}
    onCustom={custom => setAnswer(current => patchAskAnswer(question, current, { custom }))}
    onPatch={patch => setAnswer(current => patchAskAnswer(question, current, patch))}
    onSubmit={() => submitted(submitAskValue(nativeQuestions, { q: answer }))} />;
}

it("inserts image capsules at the caret, keeps thumbnails, and submits their original text positions after remount", async () => {
  const submitted = vi.fn();
  const view = render(<Fields submitted={submitted} />);
  let editor = screen.getByRole("textbox", { name: "自定义回答" });
  setAskCaret(editor.firstChild!, 7);
  fireEvent.paste(editor, { clipboardData: { files: [imageFile(1), imageFile(2)] } });
  const group = within(screen.getByRole("group", { name: "回答 / Answer" }));
  await group.findByRole("button", { name: "预览图2" });
  await waitFor(() => expect(editor.getAttribute("contenteditable")).toBe("true"));
  expect(group.getAllByRole("button", { name: /^预览图/ })).toHaveLength(2);
  setAskCaret(editor.firstChild!, 0);
  fireEvent.paste(editor, { clipboardData: { files: [], getData: () => "intro " } });
  const end = editor.lastChild!;
  setAskCaret(end, end.textContent!.length);
  fireEvent.paste(editor, { clipboardData: { files: [], getData: () => " end" } });
  view.rerender(<Fields revision={1} submitted={submitted} />);
  editor = screen.getByRole("textbox", { name: "自定义回答" });
  expect(within(screen.getByRole("group", { name: "回答 / Answer" })).getAllByRole("button", { name: /^预览图/ })).toHaveLength(2);
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(submitted).toHaveBeenCalledWith({ results: [{
    id: "q", selectedOptions: [], customInput: "intro before [Image #1] [Image #2] after end",
    customInputImages: [
      { type: "image", mimeType: "image/png", data: "AQ==" },
      { type: "image", mimeType: "image/png", data: "Ag==" },
    ],
  }] });
});

it("keeps a note image between note text and removes it from both preview and payload", async () => {
  const submitted = vi.fn();
  render(<Fields submitted={submitted} />);
  const note = screen.getByRole("textbox", { name: "备注 / Note" });
  setAskText(note, "note tail");
  setAskCaret(note.firstChild!, 5);
  fireEvent.paste(note, { clipboardData: { files: [imageFile(3)] } });
  const group = within(screen.getByRole("group", { name: "备注 / Note" }));
  await group.findByRole("button", { name: "预览图1" });
  await waitFor(() => expect(note.getAttribute("contenteditable")).toBe("true"));
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  note.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(submitted).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "自定义回答" }), { key: "Enter" });
  expect(submitted).toHaveBeenLastCalledWith({ results: [{
    id: "q", selectedOptions: [], customInput: "before after", note: "note [Image #1] tail",
    noteImages: [{ type: "image", mimeType: "image/png", data: "Aw==" }],
  }] });
  fireEvent.click(group.getByRole("button", { name: "移除图1" }));
  expect(group.queryByRole("button", { name: "预览图1" })).toBeNull();
  expect(note.querySelector(".cm-chip-image")).toBeNull();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "自定义回答" }), { key: "Enter" });
  const final = submitted.mock.lastCall?.[0] as { results: Array<{ note: string; noteImages?: unknown }> };
  expect(final.results[0]?.note).not.toContain("[Image #");
  expect(final.results[0]?.noteImages).toBeUndefined();
});
