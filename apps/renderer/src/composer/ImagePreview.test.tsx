import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceProvider, surfaceWindow } from "../dock/SurfaceContext";
import { ImagePreview, type ImagePreviewSubject } from "./ImagePreview";

type Chrome = NonNullable<typeof globalThis.ompStudioChrome>;
const originalChrome = Object.getOwnPropertyDescriptor(window, "ompStudioChrome");
const frames: HTMLIFrameElement[] = [];
const image: ImagePreviewSubject = { url: "blob:screen", label: "屏幕.png", mimeType: "image/png" };
const bytes = new Uint8Array([1, 2, 3]);

function chromeMocks() {
  return {
    copyImage: vi.fn<Chrome["copyImage"]>().mockResolvedValue({ ok: true }),
    saveImage: vi.fn<Chrome["saveImage"]>().mockResolvedValue({ ok: true }),
  };
}

function installChrome(target: Window, chrome: ReturnType<typeof chromeMocks> | undefined) {
  Object.defineProperty(target, "ompStudioChrome", { configurable: true, writable: true, value: chrome });
}

function childSurface() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  if (!frame.contentDocument) throw new Error("missing surface document");
  return frame.contentDocument;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function setImageSize(width: number, height: number) {
  const img = screen.getByRole("img", { name: image.label }) as HTMLImageElement;
  Object.defineProperties(img, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
    complete: { configurable: true, value: true },
  });
  fireEvent.load(img);
  return img;
}

function setViewportSize(width: number, height: number) {
  const viewport = screen.getByRole("region", { name: "图片查看区域" });
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  fireEvent.resize(window);
  return viewport;
}

function pointer(target: Element, type: string, x: number, y: number) {
  // jsdom has no PointerEvent constructor; use a real bubbling event with pointer fields.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  fireEvent(target, event);
}

afterEach(() => {
  cleanup();
  frames.splice(0).forEach((frame) => frame.remove());
  vi.restoreAllMocks();
  if (originalChrome) Object.defineProperty(window, "ompStudioChrome", originalChrome);
  else Reflect.deleteProperty(window, "ompStudioChrome");
});

describe("ImagePreview", () => {
  it("keeps legacy base64 subjects and the copy/save context menu working", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const decode = vi.spyOn(window, "atob");
    render(<ImagePreview image={{ ...image, data: "AQID" }} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: `预览${image.label}` })).toBeDefined();
    expect(screen.getByRole("img", { name: image.label }).getAttribute("src")).toBe(image.url);
    expect(decode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByText("已复制图片");
    expect(chrome.copyImage).toHaveBeenCalledWith({ mime: "image/png", bytes });
    fireEvent.contextMenu(screen.getByRole("img", { name: image.label }));
    fireEvent.click(screen.getByRole("menuitem", { name: "保存" }));
    await screen.findByText("已保存图片");
    expect(chrome.saveImage).toHaveBeenCalledWith({ mime: "image/png", bytes, suggestedName: image.label });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("loads byte-backed subjects only on demand and reuses the bytes for copy and save", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const loadBytes = vi.fn(async () => bytes);
    render(<ImagePreview image={{ ...image, loadBytes }} onClose={vi.fn()} />);
    expect(loadBytes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByText("已复制图片");
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    await screen.findByText("已保存图片");
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(chrome.copyImage.mock.calls[0]?.[0].bytes).toBe(bytes);
    expect(chrome.saveImage.mock.calls[0]?.[0].bytes).toBe(bytes);
  });

  it("passes supplied bytes through without fetching or decoding a redundant base64 copy", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const loadBytes = vi.fn(async () => new Uint8Array());
    const decode = vi.spyOn(window, "atob");
    render(<ImagePreview image={{ ...image, bytes, loadBytes, data: "not-base64" }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    await screen.findByText("已保存图片");
    expect(chrome.saveImage.mock.calls[0]?.[0].bytes).toBe(bytes);
    expect(loadBytes).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("treats a cancelled save as cancellation rather than an error and remains usable", async () => {
    const chrome = chromeMocks();
    chrome.saveImage.mockResolvedValue({ ok: false, cancelled: true });
    installChrome(window, chrome);
    const onError = vi.fn();
    render(<ImagePreview image={{ ...image, loadBytes: async () => bytes }} onClose={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    await screen.findByText("已取消保存");
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByText("已复制图片");
    expect(chrome.copyImage).toHaveBeenCalledTimes(1);
  });

  it("shows byte-loading and desktop errors inline and allows a retry", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const loadBytes = vi.fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error("图片已过期"))
      .mockResolvedValue(bytes);
    chrome.copyImage.mockResolvedValueOnce({ ok: false, message: "剪贴板暂时不可用" });
    const onError = vi.fn();
    render(<ImagePreview image={{ ...image, loadBytes }} onClose={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect((await screen.findByRole("alert")).textContent).toContain("图片已过期");
    expect(chrome.copyImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByText("剪贴板暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByText("已复制图片");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(loadBytes).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("fits the received image, offers 100% and zoom, and pans only the local scrollbox", () => {
    installChrome(window, undefined);
    const onClose = vi.fn();
    render(<ImagePreview image={image} onClose={onClose} />);
    const viewport = setViewportSize(800, 500);
    const img = setImageSize(1600, 900);
    const ratio = screen.getByLabelText("缩放比例");
    expect(ratio.textContent).toBe("50%");
    expect(img.style.width).toBe("800px");
    expect(screen.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(img.style.width).toBe("1600px");
    expect(img.style.height).toBe("900px");
    expect(ratio.textContent).toBe("100%");
    expect(screen.getByText(/100% 表示收到的图片原始尺寸（1600 × 900）/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(ratio.textContent).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(ratio.textContent).toBe("100%");

    viewport.scrollLeft = 200;
    viewport.scrollTop = 100;
    pointer(img, "pointerdown", 300, 250);
    pointer(viewport, "pointermove", 240, 200);
    pointer(viewport, "pointerup", 240, 200);
    expect(viewport.scrollLeft).toBe(260);
    expect(viewport.scrollTop).toBe(150);
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
    expect(ratio.textContent).toBe("50%");
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    setViewportSize(400, 300);
    expect(ratio.textContent).toBe("25%");
    expect(img.style.width).toBe("400px");
  });

  it("contains focus, supports the keyboard menu and Escape, and returns focus to the opener", () => {
    installChrome(window, chromeMocks());
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开图片</button>
        <button type="button">其他操作</button>
        {open ? <ImagePreview image={{ ...image, bytes }} onClose={() => setOpen(false)} /> : null}
      </>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开图片" });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole("button", { name: "关闭预览" });
    const viewport = screen.getByRole("region", { name: "图片查看区域" });
    expect(document.activeElement).toBe(close);
    screen.getByRole("button", { name: "其他操作" }).focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(viewport);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "复制" }));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(viewport);

    fireEvent.keyDown(viewport, { key: "F10", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "复制" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "保存" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(document.activeElement).toBe(viewport);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the close button and backdrop available while bytes are loading", () => {
    installChrome(window, chromeMocks());
    const onClose = vi.fn();
    render(<ImagePreview image={{ ...image, loadBytes: () => new Promise(() => {}) }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    const close = screen.getByRole("button", { name: "关闭预览" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".img-preview-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not copy an old lazy result or clear the next image's pending operation", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const oldLoad = deferred<Uint8Array>();
    const nextLoad = deferred<Uint8Array>();
    const nextBytes = new Uint8Array([4, 5, 6]);
    const view = render(<ImagePreview image={{ ...image, loadBytes: () => oldLoad.promise }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    // The same URL can be reused by a caller; byte source identity still isolates results.
    view.rerender(<ImagePreview image={{ ...image, loadBytes: () => nextLoad.promise }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await act(async () => { oldLoad.resolve(bytes); });
    expect(chrome.copyImage).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "复制中…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { nextLoad.resolve(nextBytes); });
    await screen.findByText("已复制图片");
    expect(chrome.copyImage).toHaveBeenCalledTimes(1);
    expect(chrome.copyImage.mock.calls[0]?.[0].bytes).toBe(nextBytes);
  });

  it.each(["replace", "unmount"] as const)("ignores late desktop failures after %s", async (change) => {
    const chrome = chromeMocks();
    const result = deferred<Awaited<ReturnType<Chrome["saveImage"]>>>();
    chrome.saveImage.mockReturnValue(result.promise);
    installChrome(window, chrome);
    const onError = vi.fn();
    const view = render(<ImagePreview image={{ ...image, bytes }} onClose={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    await waitFor(() => expect(chrome.saveImage).toHaveBeenCalledTimes(1));
    if (change === "unmount") view.unmount();
    else view.rerender(<ImagePreview image={{ ...image, url: "blob:next", bytes }} onClose={vi.fn()} onError={onError} />);
    await act(async () => { result.resolve({ ok: false, message: "旧窗口保存失败" }); });
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("旧窗口保存失败")).toBeNull();
  });

  it("does not start desktop work after the viewer is unmounted during a lazy read", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const load = deferred<Uint8Array>();
    const view = render(<ImagePreview image={{ ...image, loadBytes: () => load.promise }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    view.unmount();
    await act(async () => { load.resolve(bytes); });
    expect(chrome.copyImage).not.toHaveBeenCalled();
  });

  it("uses the owning surface for the dialog, keyboard, clipboard, save and focus return", async () => {
    const mainChrome = chromeMocks();
    installChrome(window, mainChrome);
    const document = childSurface();
    const childWindow = surfaceWindow(document);
    const chrome = chromeMocks();
    installChrome(childWindow, chrome);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(<SurfaceProvider document={document}>
      <ImagePreview image={{ ...image, data: "AQID" }} onClose={onClose} />
    </SurfaceProvider>);
    const ui = within(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ui.getByRole("dialog").ownerDocument).toBe(document);
    expect(document.activeElement).toBe(ui.getByRole("button", { name: "关闭预览" }));
    fireEvent.click(ui.getByRole("button", { name: "复制" }));
    await ui.findByText("已复制图片");
    fireEvent.click(ui.getByRole("button", { name: "另存为" }));
    await ui.findByText("已保存图片");
    expect(chrome.copyImage).toHaveBeenCalledWith({ mime: "image/png", bytes });
    expect(chrome.saveImage).toHaveBeenCalledWith({ mime: "image/png", bytes, suggestedName: image.label });
    expect(mainChrome.copyImage).not.toHaveBeenCalled();
    expect(mainChrome.saveImage).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(childWindow, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
  });

  it("honestly disables unavailable surface actions without borrowing the main window's chrome", () => {
    const mainChrome = chromeMocks();
    installChrome(window, mainChrome);
    const document = childSurface();
    installChrome(surfaceWindow(document), undefined);
    const loadBytes = vi.fn(async () => bytes);
    render(<SurfaceProvider document={document}>
      <ImagePreview image={{ ...image, loadBytes }} onClose={vi.fn()} />
    </SurfaceProvider>);
    const ui = within(document.body);
    expect(ui.getByText("当前环境不支持复制和另存为图片，请在桌面应用中使用。")).toBeDefined();
    const copy = ui.getByRole("button", { name: "复制" }) as HTMLButtonElement;
    const save = ui.getByRole("button", { name: "另存为" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    fireEvent.click(copy);
    fireEvent.click(save);
    fireEvent.contextMenu(ui.getByRole("img", { name: image.label }));
    expect((ui.getByRole("menuitem", { name: "复制" }) as HTMLButtonElement).disabled).toBe(true);
    expect((ui.getByRole("menuitem", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(loadBytes).not.toHaveBeenCalled();
    expect(mainChrome.copyImage).not.toHaveBeenCalled();
    expect(mainChrome.saveImage).not.toHaveBeenCalled();
  });

  it("lets read-only callers disable actions, including an in-flight lazy read", async () => {
    const chrome = chromeMocks();
    installChrome(window, chrome);
    const load = deferred<Uint8Array>();
    const subject = { ...image, loadBytes: () => load.promise };
    const view = render(<ImagePreview image={subject} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    view.rerender(<ImagePreview image={subject} actionsEnabled={false} onClose={vi.fn()} />);
    await act(async () => { load.resolve(bytes); });
    expect((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "另存为" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.contextMenu(screen.getByRole("img", { name: image.label }));
    expect((screen.getByRole("menuitem", { name: "复制" }) as HTMLButtonElement).disabled).toBe(true);
    expect(chrome.copyImage).not.toHaveBeenCalled();
    expect(chrome.saveImage).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "关闭预览" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows image display failures even when no error callback was supplied", () => {
    installChrome(window, undefined);
    render(<ImagePreview image={image} onClose={vi.fn()} />);
    fireEvent.error(screen.getByRole("img", { name: image.label }));
    expect(screen.getByRole("alert").textContent).toContain("无法显示这张图片");
    expect((screen.getByRole("button", { name: "100%" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
