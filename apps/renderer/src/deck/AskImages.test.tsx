import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { DeckAskAnswer } from "./types";
import { afterEach, expect, it, vi } from "vitest";
import { AskBody } from "./AskCard";
import { submitAskValue } from "./askContent";
import { validateAskAnswerPayload } from "@omp-studio/studio-protocol";
import { setAskText } from "../test/askEditor";
afterEach(cleanup);

it("keeps uploads, pasted images, thumbnail previews and removal in their owning field", async () => {
  function Fields({ disabled = false }: { disabled?: boolean }) {
    const [answer, setAnswer] = useState<DeckAskAnswer>({ picked: [], custom: "text" });
    return <AskBody question={{ id: "a", question: "A", options: [], acceptImages: true }} answer={answer} disabled={disabled} onPick={() => {}} onCustom={custom => setAnswer(value => ({ ...value, custom }))} onPatch={patch => setAnswer(value => ({ ...value, ...patch }))} onSubmit={() => {}} />;
  }
  const view = render(<Fields />);
  const answer = within(screen.getByRole("group", { name: "回答 / Answer" }));
  const note = within(screen.getByRole("group", { name: "备注 / Note" }));
  expect(screen.getByRole("button", { name: "回答 / Answer + 图片 / Image" }).textContent).toBe("");
  expect(screen.getByRole("button", { name: "备注 / Note + 图片 / Image" }).textContent).toBe("");
  const file = new File(["x"], "x.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([0]).buffer });
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const answerPicker = vi.fn(), notePicker = vi.fn();
  inputs[0]!.addEventListener("click", answerPicker);
  inputs[1]!.addEventListener("click", notePicker);
  fireEvent.click(screen.getByRole("button", { name: "回答 / Answer + 图片 / Image" }));
  expect(answerPicker).toHaveBeenCalledTimes(1);
  expect(notePicker).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "备注 / Note + 图片 / Image" }));
  expect(notePicker).toHaveBeenCalledTimes(1);
  fireEvent.change(inputs[0]!, { target: { files: [file] } });
  await answer.findByRole("button", { name: "预览图1" });
  expect(note.queryByRole("button", { name: "预览图1" })).toBeNull();
  fireEvent.paste(screen.getByRole("textbox", { name: "备注 / Note" }), { clipboardData: { files: [file] } });
  await note.findByRole("button", { name: "预览图1" });
  await waitFor(() => expect(screen.getByRole("group", { name: "备注 / Note" }).getAttribute("aria-busy")).toBe("false"));
  fireEvent.click(note.getByRole("button", { name: "预览图1" }));
  expect(screen.getByRole("dialog", { name: "预览图1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(answer.getByRole("button", { name: "移除图1" }));
  expect(answer.queryByRole("button", { name: "预览图1" })).toBeNull();
  expect(note.getByRole("button", { name: "预览图1" })).toBeTruthy();
  view.rerender(<Fields disabled />);
  expect((screen.getByRole("button", { name: "回答 / Answer + 图片 / Image" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "备注 / Note + 图片 / Image" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(note.getByRole("button", { name: "移除图1" }));
  expect(note.getByRole("button", { name: "预览图1" })).toBeTruthy();
});

it("preserves text-only questions and Enter submission without attachment controls", () => {
  const props = { answer: { picked: [], custom: "text" }, onPick: vi.fn(), onCustom: vi.fn(), onSubmit: vi.fn(), onPatch: vi.fn() };
  const view = render(<AskBody question={{ id: "a", question: "A", options: [], acceptImages: false }} {...props} />);
  expect(screen.getByRole("textbox", { name: "备注 / Note" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /图片 \/ Image/ })).toBeNull();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "自定义回答" }), { key: "Enter" });
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
  view.rerender(<AskBody question={{ id: "a", question: "A", options: [] }} {...props} />);
  expect(screen.queryByRole("textbox", { name: "备注 / Note" })).toBeNull();
});

it("answer and note images serialize under their owning question and separate native fields", () => {
  const image = { type: "image" as const, mimeType: "image/png" as const, data: "AA==" };
  const questions = [{ id: "a", question: "A", options: [], multiple: false }, { id: "b", question: "B", options: [], multiple: false }];
  const payload = submitAskValue(questions, { a: { picked: [], custom: "", customInputImages: [image] }, b: { picked: ["B"], custom: "", note: "note", noteImages: [image] } });
  validateAskAnswerPayload(payload);
  expect(payload.results[0]).toMatchObject({ id: "a", customInput: "[Image #1]", customInputImages: [image] });
  expect(payload.results[1]).toMatchObject({ id: "b", note: "note\n[Image #1]", noteImages: [image] });
  expect(() => validateAskAnswerPayload({ results: [{ ...payload.results[0], customInputImages: [{ ...image, data: "A".repeat(300000) }] }] })).toThrow();
});

it("closing or changing a question discards a late image load", async () => {
  let resolve!: (buffer: ArrayBuffer) => void;
  const file = new File(["x"], "x.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(r => { resolve = r; }) });
  const onPatch = vi.fn();
  const props = { answer: { picked: [], custom: "text" }, onPick: vi.fn(), onCustom: vi.fn(), onSubmit: vi.fn(), onPatch };
  const view = render(<AskBody key="a" question={{ id: "a", question: "A", options: [], acceptImages: true }} {...props} />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(resolve).toBeTruthy());
  view.rerender(<AskBody key="b" question={{ id: "b", question: "B", options: [], acceptImages: true }} {...props} />);
  resolve(new Uint8Array([0]).buffer);
  await new Promise(r => setTimeout(r, 10));
  expect(onPatch).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "备注 / Note" })).toBeTruthy();
});

it("accepts clipboard image items without duplicates and still pastes ordinary text", async () => {
  function Fields() {
    const [answer, setAnswer] = useState<DeckAskAnswer>({ picked: [], custom: "answer" });
    return <AskBody question={{ id: "a", question: "A", options: [], acceptImages: true }} answer={answer} onPick={() => {}} onCustom={() => {}} onSubmit={() => {}} onPatch={patch => setAnswer(value => ({ ...value, ...patch }))} />;
  }
  render(<Fields />);
  const file = new File(["x"], "clipboard.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([0]).buffer });
  const item = { kind: "file", type: "image/png", getAsFile: () => file };
  fireEvent.paste(screen.getByRole("textbox", { name: "自定义回答" }), { clipboardData: { files: [], items: [item] } });
  await within(screen.getByRole("group", { name: "回答 / Answer" })).findByRole("button", { name: "预览图1" });
  fireEvent.paste(screen.getByRole("textbox", { name: "备注 / Note" }), { clipboardData: { files: [file], items: [item] } });
  const note = within(screen.getByRole("group", { name: "备注 / Note" }));
  await note.findByRole("button", { name: "预览图1" });
  expect(note.queryByRole("button", { name: "预览图2" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("group", { name: "备注 / Note" }).getAttribute("aria-busy")).toBe("false"));
  setAskText(screen.getByRole("textbox", { name: "备注 / Note" }), "plain text");
  expect(screen.getByRole("textbox", { name: "备注 / Note" }).textContent).toBe("plain text");
});
