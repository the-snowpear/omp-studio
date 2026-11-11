import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DictationKeyboard, DICTATION_HOLD_DELAY_MS, isValidDictationShortcut } from "./dictationKeyboard";
import type { ComposerDictationBinding } from "./dictationTypes";

let editor: HTMLDivElement;
let keyboard: DictationKeyboard;
let binding: ComposerDictationBinding;
let blocked = false;
let composing = false;
let insertSpace: Mock<(text: string) => void>;

function down(key = " ", options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, ...(key === " " ? { code: "Space" } : {}), bubbles: true, cancelable: true, ...options });
  editor.dispatchEvent(event);
  return event;
}
function up(target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true }));
}
function hold(): void {
  down();
  vi.advanceTimersByTime(DICTATION_HOLD_DELAY_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  blocked = false;
  composing = false;
  binding = { enabled: true, active: false, toggleShortcut: "", onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn(), onInterrupt: vi.fn() };
  insertSpace = vi.fn<(text: string) => void>();
  editor = document.createElement("div");
  editor.tabIndex = 0;
  document.body.append(editor);
  editor.focus();
  keyboard = new DictationKeyboard(editor, { binding: () => binding, blocked: () => blocked, composing: () => composing, insertText: insertSpace });
  editor.addEventListener("keydown", (event) => keyboard.keydown(event));
  editor.addEventListener("blur", () => keyboard.editorBlur());
  document.addEventListener("keyup", keyboard.keyup, true);
  document.addEventListener("visibilitychange", keyboard.visibilityChange);
  window.addEventListener("blur", keyboard.interrupt);
});
afterEach(() => {
  keyboard.dispose();
  document.removeEventListener("keyup", keyboard.keyup, true);
  document.removeEventListener("visibilitychange", keyboard.visibilityChange);
  window.removeEventListener("blur", keyboard.interrupt);
  editor.remove();
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

describe("dictation keyboard interactions", () => {
  it("respects native remapped hold keys and releases even after the modifier is lifted", () => {
    binding.holdKeys = ["ctrl+space"];
    expect(down().defaultPrevented).toBe(false);
    expect(down(" ", { ctrlKey: true }).defaultPrevented).toBe(true);
    vi.advanceTimersByTime(DICTATION_HOLD_DELAY_MS);
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("hold");
    up();
    expect(binding.onStop).toHaveBeenCalledTimes(1);
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("leaves ordinary typing alone when the native hold action is unbound", () => {
    binding.holdKeys = [];
    expect(down().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    up();
    expect(binding.onStart).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("uses native toggle keys alongside the optional GUI shortcut", () => {
    binding.toggleKeys = ["f4"];
    expect(down("F4").defaultPrevented).toBe(true);
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("toggle");
  });

  it("retains a short printable remapped hold key as draft text", () => {
    binding.holdKeys = ["v"];
    down("v", { code: "KeyV" });
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "v", code: "KeyV" }));
    expect(insertSpace).toHaveBeenCalledExactlyOnceWith("v");
    expect(binding.onStart).not.toHaveBeenCalled();
  });

  it("a short press inserts exactly one normal space without starting capture", () => {
    expect(down().defaultPrevented).toBe(true);
    vi.advanceTimersByTime(100);
    up();
    vi.advanceTimersByTime(500);
    expect(insertSpace).toHaveBeenCalledTimes(1);
    expect(binding.onStart).not.toHaveBeenCalled();
  });

  it("starts once at the hold threshold, ignores repeats, stops on actual document keyup", () => {
    down();
    vi.advanceTimersByTime(DICTATION_HOLD_DELAY_MS - 1);
    expect(binding.onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("hold");
    for (let index = 0; index < 4; index++) expect(down(" ", { repeat: true }).defaultPrevented).toBe(true);
    up(document.body);
    up();
    expect(binding.onStop).toHaveBeenCalledTimes(1);
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("flushes a short space before the next typed letter instead of reversing their order", () => {
    down();
    vi.advanceTimersByTime(50);
    expect(down("a").defaultPrevented).toBe(false);
    expect(insertSpace).toHaveBeenCalledTimes(1);
    expect(down(" ", { repeat: true }).defaultPrevented).toBe(true);
    up();
    expect(insertSpace).toHaveBeenCalledTimes(1);
    expect(binding.onStart).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("does not intercept an IME candidate Space (%o)", (options) => {
    expect(down(" ", options).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    up();
    expect(binding.onStart).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("does not start after compositionend's candidate-confirmation space or repeats", () => {
    keyboard.compositionStart();
    composing = true;
    expect(down().defaultPrevented).toBe(false);
    composing = false;
    keyboard.compositionEnd();
    expect(down().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(down(" ", { repeat: true }).defaultPrevented).toBe(false);
    expect(binding.onStart).not.toHaveBeenCalled();
    up();
    hold();
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("hold");
  });

  it("composition arriving during the pending hold cancels without injecting a space", () => {
    down();
    keyboard.compositionStart();
    vi.advanceTimersByTime(1000);
    up();
    expect(binding.onStart).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("never steals Space from an open menu or outside the editor", () => {
    blocked = true;
    expect(down().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    blocked = false;
    editor.blur();
    expect(down().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(binding.onStart).not.toHaveBeenCalled();
  });

  it("editor blur interrupts hold once and late release cannot stop/insert again", () => {
    hold();
    editor.blur();
    window.dispatchEvent(new Event("blur"));
    up();
    expect(binding.onInterrupt).toHaveBeenCalledTimes(1);
    expect(binding.onStop).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("toolbar blur does not terminate click/toggle mode but window blur does", () => {
    binding.active = true;
    editor.blur();
    expect(binding.onInterrupt).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("blur"));
    expect(binding.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("hidden visibility interrupts active capture even with no keyup", () => {
    hold();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(binding.onInterrupt).toHaveBeenCalledTimes(1);
    expect(binding.onStop).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it("Escape cancels and Space repeats remain suppressed until physical release", () => {
    hold();
    expect(down("Escape").defaultPrevented).toBe(true);
    expect(binding.onCancel).toHaveBeenCalledTimes(1);
    expect(down(" ", { repeat: true }).defaultPrevented).toBe(true);
    up();
    expect(binding.onStop).not.toHaveBeenCalled();
    expect(insertSpace).not.toHaveBeenCalled();
  });

  it.each([{}, { ctrlKey: true }, { metaKey: true }])("Enter safely stops active recording (%o)", (options) => {
    binding.active = true;
    expect(down("Enter", options).defaultPrevented).toBe(true);
    expect(binding.onStop).toHaveBeenCalledTimes(1);
    expect(down("Enter", { ...options, repeat: true }).defaultPrevented).toBe(true);
    expect(binding.onStop).toHaveBeenCalledTimes(1);
  });

  it("blocks late Enter repeats after stop even when the binding has already become inactive", () => {
    binding.active = true;
    expect(down("Enter").defaultPrevented).toBe(true);
    binding.active = false;
    keyboard.bindingChanged();
    expect(down("Enter", { repeat: true }).defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    expect(down("Enter").defaultPrevented).toBe(false);
  });

  it("toggle uses the latest binding and one safe combination, not repeat or primary shortcuts", () => {
    binding.toggleShortcut = "Alt+H";
    expect(down("h", { altKey: true }).defaultPrevented).toBe(true);
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("toggle");
    down("h", { altKey: true, repeat: true });
    expect(binding.onStart).toHaveBeenCalledTimes(1);
    binding = { ...binding, active: true };
    keyboard.bindingChanged();
    down("h", { altKey: true });
    expect(binding.onStop).toHaveBeenCalledTimes(1);
    expect(down("z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(down("h", { altKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("allows configured Ctrl+Shift+Space but never captures unconfigured modifier Space", () => {
    expect(down(" ", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    binding.toggleShortcut = "Ctrl+Shift+Space";
    expect(down(" ", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(binding.onStart).toHaveBeenCalledExactlyOnceWith("toggle");
    expect(isValidDictationShortcut("Alt+H")).toBe(true);
    expect(isValidDictationShortcut("Ctrl+Shift+Space")).toBe(true);
    for (const value of ["Space", "Ctrl+Z", "Meta+V", "Alt+Space", "Alt+Ctrl+H"]) expect(isValidDictationShortcut(value)).toBe(false);
  });
});
