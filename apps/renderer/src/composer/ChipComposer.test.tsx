import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import { CHIP_SCROLL_FADE_PX, CHIP_SCROLL_PX_PER_SEC, chipScrollMotion } from "./editorDom";
import { splitChipLabel, type PromptImage } from "./types";

afterEach(cleanup);

function png(data: string): PromptImage {
  return { type: "image", mimeType: "image/png", data };
}

function editorOf(): HTMLElement {
  const editor = document.querySelector<HTMLElement>(".chip-composer-editor");
  if (!editor) throw new Error("editor missing");
  return editor;
}

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

  it("renumbers image capsules and drops the bytes when one is removed", () => {
    const ref = createRef<ChipComposerHandle>();
    render(<ChipComposer ref={ref} placeholder="msg" />);
    act(() => {
      ref.current?.insertChip({ kind: "image", label: "图", image: png("aaa") });
      ref.current?.insertChip({ kind: "image", label: "图", image: png("bbb") });
      ref.current?.insertChip({ kind: "image", label: "图", image: png("ccc") });
    });
    expect(screen.getByLabelText("移除图2")).toBeDefined();

    fireEvent.click(screen.getByLabelText("移除图1"));

    const snapshot = ref.current?.getSnapshot();
    expect(snapshot?.images).toEqual([png("bbb"), png("ccc")]);
    expect(snapshot?.text).toContain("[图1]");
    expect(snapshot?.text).toContain("[图2]");
    expect(snapshot?.text).not.toContain("[图3]");
    const labels = [...editorOf().querySelectorAll(".cm-chip-image .cm-chip-clip")].map((el) => el.textContent);
    expect(labels).toEqual(["图1", "图2"]);
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
});
