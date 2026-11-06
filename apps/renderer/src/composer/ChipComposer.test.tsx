import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import { CHIP_SCROLL_FADE_PX, CHIP_SCROLL_PX_PER_SEC, chipScrollMotion, insertPlainText } from "./editorDom";
import { DICTATION_HOLD_DELAY_MS } from "./dictationKeyboard";
import type { ComposerDictationBinding } from "./dictationTypes";
import type { GitHubReferenceSnapshot } from "./githubReference";
import type { GitCommitReferenceSnapshot } from "./gitCommitReference";
import { splitChipLabel, type PromptImage } from "./types";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "ompStudioChrome");
});

it("restores a background draft without moving focus or the current selection", () => {
  const ref = createRef<ChipComposerHandle>();
  render(<><button type="button">Current control</button><ChipComposer ref={ref} /></>);
  const button = screen.getByRole("button", { name: "Current control" });
  button.focus();
  const range = document.createRange();
  range.selectNodeContents(button);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const anchor = window.getSelection()!.anchorNode;
  act(() => ref.current!.setSnapshot({ text: "saved draft", images: [], doc: { nodes: [{ type: "text", value: "saved draft" }] } }, { preserveFocus: true }));
  expect(document.activeElement).toBe(button);
  expect(window.getSelection()!.anchorNode).toBe(anchor);
  expect(ref.current!.getSnapshot().text).toBe("saved draft");
});

it("adds a GitHub reference at the saved caret without sending, and updates only the same repository reference", () => {
  const ref = createRef<ChipComposerHandle>();
  const send = vi.fn();
  render(<ChipComposer ref={ref} onSubmit={send} />);
  act(() => ref.current!.setSnapshot({ text: "before after", images: [], doc: { nodes: [{ type: "text", value: "before after" }] } }));
  const editor = screen.getByRole("textbox");
  const range = document.createRange(); range.setStart(editor.firstChild!, 7); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const reference: GitHubReferenceSnapshot = { key: "github.com/a/repo/issue/1", kind: "issue", number: 1, title: "Bug", url: "https://github.com/a/repo/issues/1", updatedAt: "2026-11-01", text: "original body" };
  act(() => ref.current!.insertChip({ kind: "github", label: "Issue #1 Bug", reference }));
  let snapshot = ref.current!.getSnapshot();
  expect(snapshot.doc.nodes[0]).toEqual({ type: "text", value: "before " });
  expect(snapshot.doc.nodes[1]).toMatchObject({ type: "chip", chip: { reference } });
  expect(snapshot.text).toContain("after");
  act(() => ref.current!.insertChip({ kind: "github", label: "Issue #1 Bug", reference: { ...reference, text: "updated body" } }));
  expect(ref.current!.getSnapshot().doc.nodes.filter(node => node.type === "chip")).toHaveLength(1);
  expect(ref.current!.getSnapshot().text).toContain("updated body");
  act(() => ref.current!.insertChip({ kind: "github", label: "Issue #1 Other", reference: { ...reference, key: "github.com/b/repo/issue/1" } }));
  snapshot = ref.current!.getSnapshot();
  expect(snapshot.doc.nodes.filter(node => node.type === "chip")).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
  act(() => ref.current!.setSnapshot(snapshot));
  expect(ref.current!.getSnapshot().text).toBe(snapshot.text);
});

it("adds and updates a commit reference without losing existing text or sending", () => {
  const ref = createRef<ChipComposerHandle>();
  const send = vi.fn();
  render(<ChipComposer ref={ref} onSubmit={send} />);
  act(() => ref.current!.setSnapshot({ text: "before after", images: [], doc: { nodes: [{ type: "text", value: "before after" }] } }));
  const editor = screen.getByRole("textbox");
  const range = document.createRange(); range.setStart(editor.firstChild!, 7); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const reference: GitCommitReferenceSnapshot = { kind: "commit", key: "repo/abc123", oid: "abc1234", title: "Fix theme", text: "Files: src/app.ts" };
  act(() => ref.current!.insertChip({ kind: "git-commit", label: "Commit abc1234 Fix theme", reference }));
  let snapshot = ref.current!.getSnapshot();
  expect(snapshot.doc.nodes[0]).toEqual({ type: "text", value: "before " });
  expect(snapshot.doc.nodes[1]).toMatchObject({ type: "chip", chip: { kind: "git-commit", reference } });
  expect(snapshot.text).toContain("after");
  act(() => ref.current!.insertChip({ kind: "git-commit", label: "Commit abc1234 Fix theme", reference: { ...reference, text: "Updated files" } }));
  snapshot = ref.current!.getSnapshot();
  expect(snapshot.doc.nodes.filter(node => node.type === "chip")).toHaveLength(1);
  expect(snapshot.text).toContain("Updated files");
  expect(send).not.toHaveBeenCalled();
  act(() => ref.current!.setSnapshot(snapshot));
  expect(ref.current!.getSnapshot().text).toBe(snapshot.text);
});

function png(data: string): PromptImage {
  return { type: "image", mimeType: "image/png", data };
}

function editorOf(): HTMLElement {
  const editor = document.querySelector<HTMLElement>(".chip-composer-editor");
  if (!editor) throw new Error("editor missing");
  return editor;
}

function selectText(node: Node, start: number, end = start): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function stubNativeEditing(editor: HTMLElement): void {
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn((_command: string, _ui: boolean, text: string) => {
    insertPlainText(editor, text);
    fireEvent.input(editor, { inputType: "insertText", data: text });
    return true;
  }) });
}

function binding(): ComposerDictationBinding {
  return { enabled: true, active: false, toggleShortcut: "", onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn(), onInterrupt: vi.fn() };
}

function pasteText(editor: HTMLElement, text: string): void {
  fireEvent.paste(editor, { clipboardData: { files: [], getData: (type: string) => type === "text/plain" ? text : "" } });
}

describe("ChipComposer dictation", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
    vi.useRealTimers();
  });

  it("keeps streamed text out of draft notifications and publishes the final doc synchronously once", () => {
    const ref = createRef<ChipComposerHandle>();
    const onChange = vi.fn();
    render(<ChipComposer ref={ref} onChange={onChange} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "before after");
    selectText(editor.firstChild!, 7);
    stubNativeEditing(editor);
    onChange.mockClear();
    act(() => {
      expect(ref.current!.beginDictation("a")).toBe(true);
      ref.current!.updateDictation("a", "你好", " API");
    });
    expect(ref.current!.getSnapshot().text).toBe("before after");
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.querySelector("[data-composer-dictation]")?.textContent).toBe("你好 API");
    act(() => {
      expect(ref.current!.commitDictation("a", "你好 API ")).toEqual({ applied: true, unchanged: true });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.lastCall![0].text).toBe("before 你好 API after");
    });
    expect(ref.current!.getSnapshot()).toEqual(onChange.mock.lastCall![0]);
  });

  it("does not make a partial-only composer nonempty or invoke a persistent change", () => {
    const ref = createRef<ChipComposerHandle>();
    const onChange = vi.fn();
    render(<ChipComposer ref={ref} onChange={onChange} />);
    const editor = editorOf();
    editor.focus();
    selectText(editor, 0);
    act(() => {
      expect(ref.current!.beginDictation("a")).toBe(true);
      ref.current!.updateDictation("a", "", "partial");
    });
    expect(ref.current!.isEmpty()).toBe(true);
    expect(ref.current!.getSnapshot().text).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves simultaneous typing at the captured caret and closes automatic-send gate", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "left right");
    selectText(editor.firstChild!, 5);
    stubNativeEditing(editor);
    act(() => ref.current!.beginDictation("a"));
    pasteText(editor, "typed ");
    act(() => {
      ref.current!.updateDictation("a", "voice ", "partial");
      expect(ref.current!.commitDictation("a", "voice ")).toEqual({ applied: true, unchanged: false });
    });
    expect(ref.current!.getSnapshot().text).toBe("left voice typed right");
  });

  it("preserves human typing inside the reserved selection by invalidating its async result", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "left selected right");
    selectText(editor.firstChild!, 5, 13);
    stubNativeEditing(editor);
    act(() => ref.current!.beginDictation("a"));
    const selected = [...editor.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent === "selected")!;
    selectText(selected, 3);
    act(() => {
      editor.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "typed", bubbles: true, cancelable: true }));
      insertPlainText(editor, "typed");
      fireEvent.input(editor, { inputType: "insertText", data: "typed" });
      expect(ref.current!.commitDictation("a", "voice")).toEqual({ applied: false, unchanged: false });
    });
    expect(ref.current!.getSnapshot().text).toBe("left seltypedected right");
  });

  it.each(["clear", "setSnapshot"] as const)("invalidates late results after external %s without guessing end", (action) => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "original");
    selectText(editor.firstChild!, 2);
    stubNativeEditing(editor);
    act(() => {
      ref.current!.beginDictation("a");
      if (action === "clear") ref.current!.clear();
      else ref.current!.setSnapshot({ text: "new target", images: [], doc: { nodes: [{ type: "text", value: "new target" }] } });
      ref.current!.updateDictation("a", "late", "result");
      expect(ref.current!.commitDictation("a", "late result")).toEqual({ applied: false, unchanged: false });
    });
    expect(ref.current!.getSnapshot().text).toBe(action === "clear" ? "" : "new target");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("keeps normal short Space and native hold/keyup through an imperative binding", () => {
    vi.useFakeTimers();
    const ref = createRef<ChipComposerHandle>();
    const dictation = binding();
    render(<ChipComposer ref={ref} />);
    const editor = editorOf();
    editor.focus();
    selectText(editor, 0);
    stubNativeEditing(editor);
    act(() => ref.current!.setDictationBinding(dictation));
    fireEvent.keyDown(editor, { key: " ", code: "Space" });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.keyUp(document, { key: " ", code: "Space" });
    expect(ref.current!.getSnapshot().text).toBe(" ");
    expect(dictation.onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: " ", code: "Space" });
    act(() => vi.advanceTimersByTime(DICTATION_HOLD_DELAY_MS));
    fireEvent.keyDown(editor, { key: " ", code: "Space", repeat: true });
    fireEvent.keyUp(document, { key: " ", code: "Space" });
    expect(dictation.onStart).toHaveBeenCalledExactlyOnceWith("hold");
    expect(dictation.onStop).toHaveBeenCalledTimes(1);
    expect(ref.current!.getSnapshot().text).toBe(" ");
  });

  it("active dictation stops on Enter/Ctrl+Enter rather than sending or accepting unfinished commands", () => {
    const dictation = { ...binding(), active: true };
    const onSubmit = vi.fn(), onFollowUp = vi.fn(), onRunCommand = vi.fn();
    render(<ChipComposer dictation={dictation} onSubmit={onSubmit} onFollowUp={onFollowUp} onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "/model");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "Enter", repeat: true });
    expect(dictation.onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(onRunCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(dictation.onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves slash menu and IME candidate Space priority unchanged", () => {
    vi.useFakeTimers();
    const dictation = binding();
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} dictation={dictation} />);
    const editor = editorOf();
    editor.focus();
    pasteText(editor, "/model");
    fireEvent.keyDown(editor, { key: " ", code: "Space" });
    act(() => vi.advanceTimersByTime(1000));
    expect(dictation.onStart).not.toHaveBeenCalled();
    act(() => ref.current!.clear());
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: " ", code: "Space", keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: " ", code: "Space" });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.keyUp(document, { key: " ", code: "Space" });
    expect(dictation.onStart).not.toHaveBeenCalled();
    expect(ref.current!.getSnapshot().text).toBe("");
  });
});

describe("chipScrollMotion", () => {
  it("does not move a name that already fits", () => {
    expect(chipScrollMotion(80, 90)).toEqual({ distance: 0, durationSec: 0 });
  });

  it("scales duration with overflow so a longer name still reaches the end", () => {
    const short = chipScrollMotion(120, 80);
    const long = chipScrollMotion(200, 80);
    expect(short.distance).toBe(40 + CHIP_SCROLL_FADE_PX);
    expect(long.distance).toBe(120 + CHIP_SCROLL_FADE_PX);
    expect(short.durationSec).toBe(short.distance / CHIP_SCROLL_PX_PER_SEC);
    expect(long.durationSec).toBeCloseTo(short.durationSec * (long.distance / short.distance));
    expect(long.durationSec).toBeGreaterThan(short.durationSec);
  });
});

describe("splitChipLabel", () => {
  it("pins the last real extension and leaves dotfiles whole", () => {
    expect(splitChipLabel("conversationViewModel.ts")).toEqual({ stem: "conversationViewModel", ext: ".ts" });
    expect(splitChipLabel("foo.d.ts")).toEqual({ stem: "foo.d", ext: ".ts" });
    expect(splitChipLabel(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitChipLabel("src")).toEqual({ stem: "src", ext: "" });
    expect(splitChipLabel("图1")).toEqual({ stem: "图1", ext: "" });
  });
});

describe("ChipComposer", () => {
  it("opens the command menu from a leading slash and does not insert a skill chip", async () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    act(() => {
      ref.current?.openCommandMenu();
    });
    expect(screen.getByRole("listbox", { name: "指令" })).toBeDefined();
    const modelOption = screen.getByRole("option", { name: /\/model/ });
    expect(modelOption.textContent?.startsWith("/model")).toBe(true);
    expect(modelOption.textContent?.startsWith("//")).toBe(false);
    fireEvent.mouseDown(modelOption);
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "model" }), "");
    expect(ref.current?.getSnapshot().text).toBe("");
  });

  it("keeps an existing draft when /model runs from the overlay menu", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "keep this draft" : ""),
      },
    });
    act(() => {
      ref.current?.openCommandMenu();
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/model/ }));
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "model" }), "");
    expect(ref.current?.getSnapshot().text).toBe("keep this draft");
  });

  it("inserts a mode capsule from the overlay menu and keeps the draft", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "keep this draft" : ""),
      },
    });
    act(() => {
      ref.current?.openCommandMenu();
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/fast/ }));
    expect(onRunCommand).not.toHaveBeenCalled();
    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).toBe("keep this draft");
    expect(snapshot?.doc.nodes.some((node) => node.type === "chip" && node.chip.kind === "mode" && node.chip.name === "fast")).toBe(true);
    expect(editorOf().querySelector(".cm-chip-mode .cm-chip-clip")?.textContent).toBe("fast");
    expect(editorOf().querySelector(".cm-chip-mode > .icon")).toBeNull();
  });

  it("replaces a conflicting plan capsule with vibe", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "mode", label: "plan", name: "plan" });
      ref.current?.insertChip({ kind: "mode", label: "vibe", name: "vibe" });
    });
    const modes = (ref.current?.getSnapshot().doc.nodes ?? [])
      .filter((node) => node.type === "chip" && node.chip.kind === "mode")
      .map((node) => (node.type === "chip" ? node.chip.name : undefined));
    expect(modes).toEqual(["vibe"]);
  });

  it("writes /compact into the composer from the overlay menu", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "keep this draft" : ""),
      },
    });
    act(() => {
      ref.current?.openCommandMenu();
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/compact/ }));
    expect(ref.current?.getSnapshot().text).toBe("/compact ");
  });

  it("keeps the instruction after a typed /fast when the menu inserts a capsule", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "/fast 帮我加速" : ""),
      },
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/fast/ }));
    expect(onRunCommand).not.toHaveBeenCalled();
    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).toBe("帮我加速");
    expect(snapshot?.doc.nodes.some((node) => node.type === "chip" && node.chip.kind === "mode" && node.chip.name === "fast")).toBe(true);
  });

  it("runs /fresh from the overlay menu and keeps the draft", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "keep this draft" : ""),
      },
    });
    act(() => {
      ref.current?.openCommandMenu();
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/fresh/ }));
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "fresh" }), "");
    expect(ref.current?.getSnapshot().text).toBe("keep this draft");
  });

  it("still consumes a typed /model line after it runs", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onRunCommand={onRunCommand} />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "/model" : ""),
      },
    });
    fireEvent.mouseDown(screen.getByRole("option", { name: /\/model/ }));
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "model" }), "");
    expect(ref.current?.getSnapshot().text).toBe("");
  });

  it("keeps a mid-sentence slash as text instead of a command menu", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "see src/app" : ""),
      },
    });
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
    expect(ref.current?.getSnapshot().text).toBe("see src/app");
  });

  it("does not open the command menu when slash is not the first character", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "a/model" : ""),
      },
    });
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
    act(() => {
      ref.current?.openCommandMenu();
    });
    expect(screen.getByRole("listbox", { name: "指令" })).toBeDefined();
    expect(ref.current?.getSnapshot().text).toBe("a/model");
  });

  it("closes the command menu when clicking outside the editor and popup", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "/model" : ""),
      },
    });
    expect(screen.getByRole("listbox", { name: "指令" })).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
    expect(ref.current?.getSnapshot().text).toBe("/model");
    act(() => {
      ref.current?.openCommandMenu();
    });
    expect(screen.getByRole("listbox", { name: "指令" })).toBeDefined();
  });

  it("serializes file, folder and skill capsules as Runtime tokens", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    ref.current?.insertChip({ kind: "file", label: "App.tsx", path: "apps/renderer/src/App.tsx" });
    ref.current?.insertChip({ kind: "dir", label: "src", path: "apps/renderer/src" });
    ref.current?.insertChip({ kind: "skill", label: "commit-msg", name: "commit-msg" });
    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).toContain("@apps/renderer/src/App.tsx");
    expect(snapshot?.text).toContain("@apps/renderer/src/");
    expect(snapshot?.text).toContain("/skill:commit-msg");
  });

  it("does not open the command menu when a skill capsule is inserted", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "skill", label: "commit-msg", name: "commit-msg" });
    });
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
    expect(ref.current?.getSnapshot().text).toContain("/skill:commit-msg");
    fireEvent.focus(editorOf());
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
  });

  it("opens a detached command menu over a skill capsule without inserting another slash", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "skill", label: "commit-msg", name: "commit-msg" });
      ref.current?.openCommandMenu();
    });
    expect(screen.getByRole("listbox", { name: "指令" })).toBeDefined();
    expect(ref.current?.getSnapshot().text.trim()).toBe("/skill:commit-msg");
  });

  it("numbers clipboard images as 图N and keeps bytes on the snapshot", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    ref.current?.insertChip({
      kind: "image",
      label: "图1",
      image: { type: "image", mimeType: "image/png", data: "aaa" },
    });
    ref.current?.insertChip({
      kind: "image",
      label: "图2",
      image: { type: "image", mimeType: "image/jpeg", data: "bbb" },
    });
    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).toContain("[图1]");
    expect(snapshot?.text).toContain("[图2]");
    expect(snapshot?.images).toEqual([
      { type: "image", mimeType: "image/png", data: "aaa" },
      { type: "image", mimeType: "image/jpeg", data: "bbb" },
    ]);
  });

  it("adds a clipboard image larger than 8MB as a capsule", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([bytes], "clip.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 8 * 1024 * 1024 + 1 });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => Uint8Array.from(bytes).buffer,
    });
    const onError = vi.fn();
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" onError={onError} />);
    fireEvent.paste(editorOf(), {
      clipboardData: {
        files: [file],
        getData: () => "",
      },
    });
    await waitFor(() => {
      expect(ref.current?.getSnapshot().images).toEqual([
        { type: "image", mimeType: "image/png", data: btoa(String.fromCharCode(1, 2, 3, 4)) },
      ]);
    });
    expect(ref.current?.getSnapshot().text).toContain("[图1]");
    expect(onError).not.toHaveBeenCalled();
  });

  it("adds a disk image as a path capsule when preview bytes cannot be read", async () => {
    const file = new File(["x"], "shot.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error("unreadable")),
    });
    Object.assign(globalThis, {
      ompStudioChrome: {
        getPathForFile: () => "C:/shots/shot.png",
        resolveDroppedPaths: async () => [
          { ok: true, kind: "image" as const, scope: "absolute" as const, path: "C:/shots/shot.png", name: "shot.png" },
        ],
      },
    });
    const onError = vi.fn();
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" workspaceId="ws-1" onError={onError} />);
    fireEvent.paste(editorOf(), {
      clipboardData: {
        files: [file],
        getData: () => "",
      },
    });
    await waitFor(() => {
      expect(ref.current?.getSnapshot().text).toContain("@C:/shots/shot.png");
    });
    expect(ref.current?.getSnapshot().images).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("serializes a workspace image as @path and does not put preview bytes on the wire", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    ref.current?.insertChip({
      kind: "image",
      label: "logo.png",
      path: "assets/logo.png",
      image: png("aaa"),
    });
    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).toContain("@assets/logo.png");
    expect(snapshot?.text).not.toContain("[图");
    expect(snapshot?.images).toEqual([]);
  });

  it("renumbers image capsules and drops the bytes when one is removed", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
      ref.current?.insertChip({ kind: "image", label: "图", image: png("bbb") });
      ref.current?.insertChip({ kind: "image", label: "图", image: png("ccc") });
    });
    expect(screen.getByLabelText("移除图2")).toBeDefined();
    expect(document.querySelectorAll(".cm-thumbs img")).toHaveLength(3);
    expect(document.querySelector(".cm-thumbs")?.textContent).not.toMatch(/图\d/);

    fireEvent.click(screen.getByLabelText("移除图1"));

    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.images).toEqual([png("bbb"), png("ccc")]);
    expect(snapshot?.text).toContain("[图1]");
    expect(snapshot?.text).toContain("[图2]");
    expect(snapshot?.text).not.toContain("[图3]");
    const labels = [...editorOf().querySelectorAll(".cm-chip-image .cm-chip-clip")].map((el) => el.textContent);
    expect(labels).toEqual(["图1", "图2"]);
    expect(document.querySelectorAll(".cm-thumbs img")).toHaveLength(2);
    expect(document.querySelector(".cm-thumbs")?.textContent).not.toMatch(/图\d/);
  });

  it("keeps the file extension outside the faded stem", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({
        kind: "file",
        label: "conversationViewModel.ts",
        path: "src/conversation/conversationViewModel.ts",
      });
    });
    const chip = editorOf().querySelector(".cm-chip-file");
    expect(chip?.querySelector(".cm-chip-clip .cm-chip-stem")?.textContent).toBe("conversationViewModel");
    expect(chip?.querySelector(".cm-chip-clip .cm-chip-ext")?.textContent).toBe(".ts");
  });

  it("drops a capsule from its inline × and leaves the surrounding text alone", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "file", label: "a.ts", path: "src/a.ts" });
      ref.current?.insertChip({ kind: "file", label: "b.ts", path: "src/b.ts" });
    });

    fireEvent.click(screen.getByLabelText("移除胶囊 a.ts"));

    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.text).not.toContain("@src/a.ts");
    expect(snapshot?.text).toContain("@src/b.ts");
    expect(editorOf().querySelectorAll(".cm-chip")).toHaveLength(1);
  });

  it("removes every skill capsule with the given name", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "skill", label: "alpha", name: "alpha" });
      ref.current?.insertChip({ kind: "skill", label: "beta", name: "beta" });
      ref.current?.insertChip({ kind: "skill", label: "alpha", name: "alpha" });
    });
    act(() => {
      ref.current?.removeSkillChip("alpha");
    });
    expect(ref.current?.getSnapshot().text).not.toContain("/skill:alpha");
    expect(ref.current?.getSnapshot().text).toContain("/skill:beta");
  });

  it("pastes a path as plain text instead of a capsule", () => {
    const ref = createRef<ChipComposerHandle>();
    const onChange = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onChange={onChange} />);
    const editor = editorOf();
    editor.focus();

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "apps/renderer/src/App.tsx" : ""),
      },
    });

    expect(ref.current?.getSnapshot().text).toBe("apps/renderer/src/App.tsx");
    expect(editor.querySelector(".cm-chip")).toBeNull();
  });

  it("strips markup from a rich-text paste", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    const editor = editorOf();
    editor.focus();

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "hello" : "<b onclick=\"x\">hello</b>"),
      },
    });

    expect(editor.querySelector("b")).toBeNull();
    expect(ref.current?.getSnapshot().text).toBe("hello");
  });

  it("folds the toolbar @ into an agent capsule and does not show @", async () => {
    const ref = createRef<ChipComposerHandle>();
    render(
      <ChipComposer
        ref={ref}
        placeholder="msg"
        loadMentions={async () => [
          { kind: "agent", id: "agent:explore", label: "explore", name: "explore", detail: "通用子代理" },
        ]}
      />,
    );

    await act(async () => {
      ref.current?.openMention("@");
    });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /explore/ }));

    const editor = editorOf();
    expect(editor.querySelector(".cm-chip-agent .cm-chip-clip")?.textContent).toBe("explore");
    expect(ref.current?.getSnapshot().text.trim()).toBe("@explore");
    const leftoverAt = [...editor.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes("@"),
    );
    expect(leftoverAt).toBe(false);
  });

  it("opens a preview from a thumbnail and closes it without deleting the chip", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
    });
    fireEvent.click(screen.getByLabelText("预览图1"));
    expect(screen.getByRole("dialog", { name: "预览图1" })).toBeDefined();

    fireEvent.click(screen.getByLabelText("关闭预览"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("预览图1")).toBeDefined();
  });

  it("does not open the preview when the thumbnail remove control is clicked", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
    });
    fireEvent.click(screen.getByLabelText("移除图1"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("预览图1")).toBeNull();
  });

  it("closes the preview on Escape and on the dimmed backdrop", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
    });
    fireEvent.click(screen.getByLabelText("预览图1"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByLabelText("预览图1"));
    const backdrop = document.querySelector(".img-preview-backdrop");
    if (!(backdrop instanceof HTMLElement)) throw new Error("backdrop missing");
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copies and saves from the preview context menu through desktop chrome", async () => {
    const copyImage = vi.fn(async (_input: { mime: string; bytes: Uint8Array }) => ({ ok: true as const }));
    const saveImage = vi.fn(async (_input: { mime: string; bytes: Uint8Array; suggestedName: string }) => ({ ok: true as const }));
    globalThis.ompStudioChrome = { copyImage, saveImage } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;

    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
    });
    fireEvent.click(screen.getByLabelText("预览图1"));
    fireEvent.contextMenu(screen.getByRole("img", { name: "图1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    await waitFor(() => {
      expect(copyImage).toHaveBeenCalledTimes(1);
    });
    expect(copyImage.mock.calls[0]?.[0]?.mime).toBe("image/png");
    expect(copyImage.mock.calls[0]?.[0]?.bytes).toBeInstanceOf(Uint8Array);

    fireEvent.contextMenu(screen.getByRole("img", { name: "图1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "保存" }));
    await waitFor(() => {
      expect(saveImage).toHaveBeenCalledTimes(1);
    });
    expect(saveImage.mock.calls[0]?.[0]?.mime).toBe("image/png");
    expect(saveImage.mock.calls[0]?.[0]?.suggestedName).toBe("图1");
  });

  it("Ctrl+Enter follow-up does not submit or queue, and keeps image bytes on the snapshot", () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn();
    const onFollowUp = vi.fn();
    const ref = createRef<ChipComposerHandle>();
    render(
      <ChipComposer
        ref={ref}
        placeholder="msg"
        running
        onSubmit={onSubmit}
        onQueue={onQueue}
        onFollowUp={onFollowUp}
      />,
    );
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
    });
    fireEvent.keyDown(editorOf(), { key: "Enter", ctrlKey: true });
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect(ref.current?.getSnapshot().images).toEqual([png("aaa")]);
  });

  it("plain Enter while running queues instead of follow-up", () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn();
    const onFollowUp = vi.fn();
    render(
      <ChipComposer
        placeholder="msg"
        running
        onSubmit={onSubmit}
        onQueue={onQueue}
        onFollowUp={onFollowUp}
      />,
    );
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "later" : ""),
      },
    });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits /btw while running instead of parking it in the queue", () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn();
    render(
      <ChipComposer
        placeholder="msg"
        running
        onSubmit={onSubmit}
        onQueue={onQueue}
      />,
    );
    const editor = editorOf();
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "/btw why the rename?" : ""),
      },
    });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onQueue).not.toHaveBeenCalled();
  });
  it("restores a normalized image draft with one change publication", () => {
    const ref = createRef<ChipComposerHandle>();
    const onChange = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" onChange={onChange} />);
    act(() => ref.current?.setSnapshot({
      text: "stale serialized text",
      images: [],
      doc: { nodes: [
        { type: "text", value: "restored " },
        { type: "chip", chip: { id: "image-a", kind: "image", label: "图99", image: png("YQ==") } },
        { type: "chip", chip: { id: "image-b", kind: "image", label: "图99", image: png("Yg==") } },
      ] },
    }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const restored = onChange.mock.lastCall![0];
    expect(restored.text).toBe("restored [图1] [图2] ");
    expect(restored.images).toEqual([png("YQ=="), png("Yg==")]);
    expect(ref.current?.getSnapshot()).toEqual(restored);
  });

  it("coalesces capsule and width changes into one settled measurement and cancels it on unmount", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    let resize!: ResizeObserverCallback;
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {} disconnect() {}
    });
    const ref = createRef<ChipComposerHandle>();
    const { unmount } = render(<ChipComposer ref={ref} placeholder="msg" />);
    try {
      act(() => {
        ref.current?.insertChip({ kind: "file", label: "first-long-file.ts", path: "first-long-file.ts" });
        ref.current?.insertChip({ kind: "file", label: "second-long-file.ts", path: "second-long-file.ts" });
        resize([{ contentRect: { width: 320 } }] as ResizeObserverEntry[], {} as ResizeObserver);
      });
      expect(frames.size).toBe(1);
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
      expect(editorOf().querySelectorAll(".cm-chip")).toHaveLength(2);
      expect(frames.size).toBe(0);
      act(() => ref.current?.insertChip({ kind: "image", label: "图", image: png("YQ==") }));
      expect(editorOf().querySelector(".cm-chip-image .cm-chip-clip")?.textContent).toBe("图1");
      expect(frames.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
    } finally {
      unmount();
      request.mockRestore();
      cancel.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not re-measure capsules for every typed character", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => { ref.current?.insertChip({ kind: "mode", label: "plan", name: "plan" }); });
    const editor = editorOf();
    // Truncation measurement reads scrollWidth/clientWidth, which forces layout.
    const layoutReads = { box: 0 };
    const descriptors = ["clientWidth", "scrollWidth"].map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)!] as const);
    for (const [name, original] of descriptors) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        get(this: Element) {
          layoutReads.box += 1;
          return original.get!.call(this);
        },
      });
    }
    try {
      editor.innerHTML = `${editor.innerHTML}a`;
      fireEvent.input(editor);
      layoutReads.box = 0;
      editor.innerHTML = `${editor.innerHTML}b`;
      fireEvent.input(editor);
      expect(layoutReads.box).toBe(0);
    } finally {
      for (const [name, original] of descriptors) Object.defineProperty(Element.prototype, name, original);
    }
  });
});
