import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceProvider } from "../dock/SurfaceContext";
import { I18nProvider } from "../i18n";
import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import { ImageAnnotatorModal } from "./ImageAnnotatorModal";
import {
  annotationMetrics,
  compositeImageAnnotations,
  createArrowOp,
  createRectOp,
  renderAnnotations,
  type AnnotationOp,
} from "./imageAnnotation";
import type { PromptImage } from "./types";

function png(data: string): PromptImage {
  return { type: "image", mimeType: "image/png", data };
}

function makeFake2dContext() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    textBaseline: "alphabetic",
    textAlign: "start",
    save: vi.fn(() => calls.push({ fn: "save", args: [] })),
    restore: vi.fn(() => calls.push({ fn: "restore", args: [] })),
    setTransform: vi.fn((...args: unknown[]) => calls.push({ fn: "setTransform", args })),
    clearRect: vi.fn((...args: unknown[]) => calls.push({ fn: "clearRect", args })),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    beginPath: vi.fn(() => calls.push({ fn: "beginPath", args: [] })),
    moveTo: vi.fn((...args: unknown[]) => calls.push({ fn: "moveTo", args })),
    lineTo: vi.fn((...args: unknown[]) => calls.push({ fn: "lineTo", args })),
    quadraticCurveTo: vi.fn((...args: unknown[]) => calls.push({ fn: "quadraticCurveTo", args })),
    arc: vi.fn((...args: unknown[]) => calls.push({ fn: "arc", args })),
    closePath: vi.fn(() => calls.push({ fn: "closePath", args: [] })),
    stroke: vi.fn(() => calls.push({ fn: "stroke", args: [] })),
    fill: vi.fn(() => calls.push({ fn: "fill", args: [] })),
    strokeRect: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeRect", args })),
    strokeText: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeText", args })),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function stubCanvasEnvironment(encodedBase64 = "YW5ub3RhdGVk", options?: { naturalWidth?: number; naturalHeight?: number }) {
  const naturalWidth = options?.naturalWidth ?? 1200;
  const naturalHeight = options?.naturalHeight ?? 800;
  const contexts = new Map<HTMLCanvasElement, ReturnType<typeof makeFake2dContext>>();
  const exportSizes: Array<{ width: number; height: number }> = [];

  const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let entry = contexts.get(this);
    if (!entry) {
      entry = makeFake2dContext();
      contexts.set(this, entry);
    }
    return entry.ctx;
  });

  const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    exportSizes.push({ width: this.width, height: this.height });
    const binary = atob(encodedBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    callback(new Blob([bytes], { type: type ?? "image/png" }));
  });

  return {
    naturalWidth,
    naturalHeight,
    contexts,
    exportSizes,
    restore() {
      getContextSpy.mockRestore();
      toBlobSpy.mockRestore();
    },
  };
}

function loadDialogImage(width = 1200, height = 800) {
  const source = document.querySelector<HTMLImageElement>(".img-annotator-source");
  if (!source) throw new Error("source image missing");
  Object.defineProperties(source, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
    complete: { configurable: true, value: true },
  });
  fireEvent.load(source);
  return source;
}

function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  fireEvent(target, event);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("imageAnnotation engine", () => {
  it("scales stroke and font sizes reasonably for small and large resolutions", () => {
    const smallImg = annotationMetrics("medium", 600, 400);
    const largeImg = annotationMetrics("medium", 2400, 1600);
    expect(largeImg.strokeWidth).toBeGreaterThan(smallImg.strokeWidth);
    expect(largeImg.fontSize).toBeGreaterThan(smallImg.fontSize);

    const thin = annotationMetrics("small", 1000, 1000);
    const thick = annotationMetrics("large", 1000, 1000);
    expect(thick.strokeWidth).toBeGreaterThan(thin.strokeWidth);
    expect(thick.fontSize).toBeGreaterThan(thin.fontSize);
  });

  it("ignores micro-drags and normalizes reversed rectangles", () => {
    expect(createRectOp("#ef4444", 4, { x: 10, y: 10 }, { x: 11, y: 10.5 })).toBeNull();
    expect(createArrowOp("#ef4444", 4, { x: 10, y: 10 }, { x: 10.5, y: 10.5 })).toBeNull();
    expect(createRectOp("#ef4444", 4, { x: 120, y: 90 }, { x: 20, y: 30 })).toEqual({
      kind: "rect",
      color: "#ef4444",
      strokeWidth: 4,
      x: 20,
      y: 30,
      width: 100,
      height: 60,
    });
  });

  it("renders pen, rect, arrow, and multiline text and composites at original resolution", async () => {
    const stub = stubCanvasEnvironment("Y29tcG9zaXRlZA==");
    const { ctx, calls } = makeFake2dContext();
    const ops: AnnotationOp[] = [
      { kind: "pen", color: "#ef4444", strokeWidth: 5, points: [{ x: 10, y: 10 }, { x: 40, y: 30 }, { x: 90, y: 60 }] },
      { kind: "rect", color: "#3b82f6", strokeWidth: 4, x: 50, y: 60, width: 140, height: 80 },
      { kind: "arrow", color: "#22c55e", strokeWidth: 5, startX: 20, startY: 20, endX: 160, endY: 120 },
      { kind: "text", color: "#111827", fontSize: 24, x: 100, y: 120, text: "Line 1\nLine 2" },
    ];
    renderAnnotations(ctx, ops);
    expect(calls.some((c) => c.fn === "strokeRect")).toBe(true);
    expect(calls.some((c) => c.fn === "fill")).toBe(true);
    expect(calls.filter((c) => c.fn === "fillText")).toHaveLength(2);

    const imgEl = document.createElement("img");
    const result = await compositeImageAnnotations({
      source: imgEl,
      naturalWidth: 1920,
      naturalHeight: 1080,
      mimeType: "image/png",
      ops,
    });
    expect(stub.exportSizes).toEqual([{ width: 1920, height: 1080 }]);
    expect(result).toEqual({ type: "image", mimeType: "image/png", data: "Y29tcG9zaXRlZA==" });

    const jpegResult = await compositeImageAnnotations({
      source: imgEl,
      naturalWidth: 1920,
      naturalHeight: 1080,
      mimeType: "image/jpeg",
      ops,
    });
    expect(jpegResult.mimeType).toBe("image/jpeg");
  });
});

describe("ImageAnnotatorModal", () => {
  it("supports tools, colors, size presets, Esc text cancel, Ctrl+Z undo, Reset, and original-resolution confirm", async () => {
    const stub = stubCanvasEnvironment("bmV3LWJ5dGVz");
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <I18nProvider forcedLanguage="zh">
        <ImageAnnotatorModal
          image={{ id: "img-1", url: "data:image/png;base64,b2xk", label: "图1", mimeType: "image/png" }}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "批注 图1" });
    expect(dialog.querySelectorAll("[title]")).toHaveLength(0);
    expect(dialog.querySelectorAll("select")).toHaveLength(0);

    loadDialogImage(1600, 900);
    expect(screen.getByText("1600 × 900")).toBeDefined();

    const canvas = screen.getByRole("img", { name: "图片批注画布" });
    const undoBtn = screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement;
    const resetBtn = screen.getByRole("button", { name: "重置" }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    expect(resetBtn.disabled).toBe(true);

    // 1. Freehand pen
    pointer(canvas, "pointerdown", 10, 10);
    pointer(canvas, "pointermove", 50, 40);
    pointer(canvas, "pointerup", 50, 40);
    expect(undoBtn.disabled).toBe(false);
    expect(resetBtn.disabled).toBe(false);

    // 2. Rectangle with blue + thick preset
    fireEvent.click(screen.getByRole("button", { name: "矩形框" }));
    fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
    fireEvent.click(screen.getByRole("button", { name: "粗" }));
    pointer(canvas, "pointerdown", 20, 20);
    pointer(canvas, "pointermove", 120, 90);
    pointer(canvas, "pointerup", 120, 90);

    // 3. Arrow
    fireEvent.click(screen.getByRole("button", { name: "箭头" }));
    pointer(canvas, "pointerdown", 30, 30);
    pointer(canvas, "pointermove", 140, 100);
    pointer(canvas, "pointerup", 140, 100);

    // 4. Text tool: Esc cancels text input without closing modal
    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    pointer(canvas, "pointerdown", 40, 40);
    const input = screen.getByRole("textbox", { name: "文字标注内容" });
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "文字标注内容" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "批注 图1" })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    // Open text input again and confirm via Enter
    pointer(canvas, "pointerdown", 40, 40);
    const input2 = screen.getByRole("textbox", { name: "文字标注内容" });
    fireEvent.change(input2, { target: { value: "Look here" } });
    // Ctrl+Z inside text input should NOT undo canvas ops
    fireEvent.keyDown(input2, { key: "z", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "文字标注内容" })).toBeDefined();
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(screen.queryByRole("textbox", { name: "文字标注内容" })).toBeNull();

    // Undo via Ctrl+Z removes text op (3 ops remain), Reset clears all
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(undoBtn.disabled).toBe(false);
    fireEvent.click(resetBtn);
    expect(undoBtn.disabled).toBe(true);
    expect(resetBtn.disabled).toBe(true);

    // Draw one rectangle again and Confirm
    fireEvent.click(screen.getByRole("button", { name: "矩形框" }));
    pointer(canvas, "pointerdown", 20, 20);
    pointer(canvas, "pointermove", 100, 80);
    pointer(canvas, "pointerup", 100, 80);

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(stub.exportSizes).toEqual([{ width: 1600, height: 900 }]);
    expect(onConfirm).toHaveBeenCalledWith({
      type: "image",
      mimeType: "image/png",
      data: "bmV3LWJ5dGVz",
    });
  });

  it("commits pending text input on Confirm, applies custom color, and closes on Escape/backdrop", async () => {
    const stub = stubCanvasEnvironment("dGV4dC1pbWc=");
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <I18nProvider forcedLanguage="en">
        <ImageAnnotatorModal
          image={{ id: "img-1", url: "data:image/png;base64,b2xk", label: "Img1", mimeType: "image/png" }}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      </I18nProvider>,
    );
    loadDialogImage(1000, 600);

    fireEvent.change(screen.getByLabelText("Custom color"), { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    const canvas = screen.getByRole("img", { name: "Image annotation canvas" });
    pointer(canvas, "pointerdown", 30, 40);
    const input = screen.getByRole("textbox", { name: "Text annotation input" });
    fireEvent.change(input, { target: { value: "Pending text" } });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(stub.exportSizes).toEqual([{ width: 1000, height: 600 }]);

    rerender(
      <I18nProvider forcedLanguage="en">
        <ImageAnnotatorModal
          image={{ id: "img-2", url: "data:image/png;base64,b2xkMg==", label: "Img2", mimeType: "image/png" }}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      </I18nProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".img-annotator-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows localized load failure state and still allows closing with Escape", () => {
    render(
      <I18nProvider forcedLanguage="en">
        <ImageAnnotatorModal
          image={{ id: "img-1", url: "data:image/png;base64,bad", label: "Img1", mimeType: "image/png" }}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    const source = document.querySelector<HTMLImageElement>(".img-annotator-source")!;
    fireEvent.error(source);
    expect(screen.getByRole("alert").textContent).toContain("Unable to load this image");
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("mounts inside the owning SurfaceProvider document", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const childDoc = iframe.contentDocument!;
    const view = render(
      <SurfaceProvider document={childDoc}>
        <I18nProvider forcedLanguage="en">
          <ImageAnnotatorModal
            image={{ id: "img-1", url: "data:image/png;base64,aaa", label: "Img1", mimeType: "image/png" }}
            onConfirm={vi.fn()}
            onClose={vi.fn()}
          />
        </I18nProvider>
      </SurfaceProvider>,
    );
    try {
      expect(within(childDoc.body).getByRole("dialog", { name: "Annotate Img1" })).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      view.unmount();
      iframe.remove();
    }
  });
});

describe("ChipComposer image annotation integration", () => {
  it("replaces annotated attachment bytes while strictly preserving chip identity and [图N] serialization", async () => {
    stubCanvasEnvironment("YW5ub3RhdGVkMg==");
    const ref = createRef<ChipComposerHandle>();
    const onSubmit = vi.fn();
    render(
      <I18nProvider forcedLanguage="zh">
        <ChipComposer ref={ref} onSubmit={onSubmit} />
      </I18nProvider>,
    );

    const img1 = png("b2xkMQ==");
    const img2 = png("b2xkMg==");
    act(() => {
      ref.current!.setSnapshot({
        text: "before [图1] mid [图2] after",
        images: [img1, img2],
        doc: {
          nodes: [
            { type: "text", value: "before " },
            { type: "chip", chip: { id: "chip-img-1", kind: "image", label: "图1", image: img1 } },
            { type: "text", value: " mid " },
            { type: "chip", chip: { id: "chip-img-2", kind: "image", label: "图2", image: img2 } },
            { type: "text", value: " after" },
          ],
        },
      });
    });

    const before = ref.current!.getSnapshot();
    expect(before.text).toBe("before [图1] mid [图2] after");

    // Thumbnail bar must not leak visible 图N text and uses data-tip instead of title
    expect(document.querySelector(".cm-thumbs")?.textContent).not.toMatch(/图\d/);
    const annotateBtn2 = screen.getByRole("button", { name: "批注 图2" });
    expect(annotateBtn2.getAttribute("data-tip")).toBe("批注");
    expect(annotateBtn2.getAttribute("title")).toBeNull();

    fireEvent.click(annotateBtn2);
    expect(screen.getByRole("dialog", { name: "批注 图2" })).toBeDefined();
    loadDialogImage(800, 600);

    const canvas = screen.getByRole("img", { name: "图片批注画布" });
    pointer(canvas, "pointerdown", 10, 10);
    pointer(canvas, "pointermove", 60, 60);
    pointer(canvas, "pointerup", 60, 60);

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const after = ref.current!.getSnapshot();
    expect(after.text).toBe(before.text);
    expect(after.text).toContain("[图1]");
    expect(after.text).toContain("[图2]");
    expect(after.images).toEqual([img1, { type: "image", mimeType: "image/png", data: "YW5ub3RhdGVkMg==" }]);
    const chipIds = after.doc.nodes.flatMap((n) => (n.type === "chip" ? [n.chip.id] : []));
    expect(chipIds).toEqual(["chip-img-1", "chip-img-2"]);
    expect(onSubmit).not.toHaveBeenCalled();

    const thumbImgs = document.querySelectorAll<HTMLImageElement>(".cm-thumbs img");
    expect(thumbImgs[0]?.src).toContain("data:image/png;base64,b2xkMQ==");
    expect(thumbImgs[1]?.src).toContain("data:image/png;base64,YW5ub3RhdGVkMg==");
  });

  it("preserves draft text, image identity, [图N] markers, and open annotation modal across zh -> en -> zh switches", async () => {
    stubCanvasEnvironment("c3dpdGNoZWQ=");
    const ref = createRef<ChipComposerHandle>();
    const ui = (language: "zh" | "en") => (
      <I18nProvider forcedLanguage={language}>
        <ChipComposer ref={ref} />
      </I18nProvider>
    );

    const { rerender } = render(ui("zh"));
    const img1 = png("aW1nMQ==");
    act(() => {
      ref.current!.setSnapshot({
        text: "check [图1]",
        images: [img1],
        doc: {
          nodes: [
            { type: "text", value: "check " },
            { type: "chip", chip: { id: "keep-id-1", kind: "image", label: "图1", image: img1 } },
          ],
        },
      });
    });

    // Open annotation modal in zh and draw a stroke
    fireEvent.click(screen.getByRole("button", { name: "批注 图1" }));
    loadDialogImage(1000, 500);
    const canvas = screen.getByRole("img", { name: "图片批注画布" });
    pointer(canvas, "pointerdown", 20, 20);
    pointer(canvas, "pointermove", 90, 70);
    pointer(canvas, "pointerup", 90, 70);

    // Switch zh -> en while modal is open
    rerender(ui("en"));
    expect(screen.getByRole("dialog", { name: "Annotate Img1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Annotate Img1" }).getAttribute("data-tip")).toBe("Annotate");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);

    // Switch en -> zh while modal is still open
    rerender(ui("zh"));
    expect(screen.getByRole("dialog", { name: "批注 图1" })).toBeDefined();
    expect((screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement).disabled).toBe(false);

    // Confirm and verify [图1] + ID + draft text + composited bytes are preserved, then switch zh -> en -> zh again
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const afterConfirm = ref.current!.getSnapshot();
    expect(afterConfirm.text).toBe("check [图1] ");
    expect(afterConfirm.images).toEqual([{ type: "image", mimeType: "image/png", data: "c3dpdGNoZWQ=" }]);
    expect(afterConfirm.doc.nodes[1]).toMatchObject({ type: "chip", chip: { id: "keep-id-1", label: "图1" } });

    rerender(ui("en"));
    expect(screen.getByRole("button", { name: "Annotate Img1" })).toBeDefined();
    expect(ref.current!.getSnapshot().text).toBe("check [图1] ");
    expect(ref.current!.getSnapshot().images).toEqual(afterConfirm.images);

    rerender(ui("zh"));
    expect(screen.getByRole("button", { name: "批注 图1" })).toBeDefined();
    expect(ref.current!.getSnapshot().text).toBe("check [图1] ");
    expect(ref.current!.getSnapshot().images).toEqual(afterConfirm.images);
  });

  it("disables annotation trigger when ChipComposer is disabled", () => {
    const ref = createRef<ChipComposerHandle>();
    render(
      <I18nProvider forcedLanguage="en">
        <ChipComposer ref={ref} disabled />
      </I18nProvider>,
    );
    act(() => {
      ref.current!.insertChip({ kind: "image", label: "Img", image: png("aaa") });
    });
    const btn = screen.getByRole("button", { name: "Annotate Img1" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
