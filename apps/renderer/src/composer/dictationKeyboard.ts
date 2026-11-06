import type { ComposerDictationBinding } from "./dictationTypes";

export const DICTATION_HOLD_DELAY_MS = 350;

type Shortcut = { key: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };

/** One explicit combination, never a bare key, primary edit command, or AltGr. */
export function parseDictationShortcut(value: string): Shortcut | null {
  const parts = value.trim().toLowerCase().split("+").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part) || new Set(parts).size !== parts.length) return null;
  const last = parts.pop()!;
  const key = last === "space" ? " " : /^[a-z]$/.test(last) ? last : "";
  if (!key || parts.some((part) => !["alt", "ctrl", "meta", "shift"].includes(part))) return null;
  const alt = parts.includes("alt"), ctrl = parts.includes("ctrl"), meta = parts.includes("meta"), shift = parts.includes("shift");
  // Alt+letter or primary+Shift+Space only: never primary editing/menu commands,
  // AltGr, function keys, Space candidate confirmation, or OS navigation keys.
  if (!(alt && !ctrl && !meta && !shift && key !== " " || !alt && shift && ctrl !== meta && key === " ")) return null;
  return { key, alt, ctrl, meta, shift };
}

export function isValidDictationShortcut(value: string): boolean {
  return value.trim() === "" || parseDictationShortcut(value) !== null;
}

/** Match the Runtime's native KeyId names against browser keyboard events. */
export function matchesDictationKey(event: KeyboardEvent, value: string): boolean {
  const modifiers = new Set<string>();
  let key = value.toLowerCase();
  key = key.replace(/^(?:(?:ctrl|alt|shift|super)\+)+/, prefix => {
    prefix.split("+").filter(Boolean).forEach(modifier => modifiers.add(modifier));
    return "";
  });
  const aliases: Record<string, string> = { space: " ", esc: "escape", return: "enter", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright" };
  return event.key.toLowerCase() === (aliases[key] ?? key)
    && event.ctrlKey === modifiers.has("ctrl") && event.altKey === modifiers.has("alt")
    && event.shiftKey === modifiers.has("shift") && event.metaKey === modifiers.has("super");
}

export type DictationKeyboardContext = {
  binding(): ComposerDictationBinding | undefined;
  blocked(): boolean;
  composing(): boolean;
  insertText(text: string): void;
};

/** Editor owns keydown; keyup/lost-focus must be observed even outside its DOM. */
export class DictationKeyboard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heldKey: string | null = null;
  private pendingText = "";
  private pendingHold = false;
  private hold = false;
  private stopping = false;
  private suppressedKeys = new Set<string>();
  private compositionEndedAt = -Infinity;

  constructor(private readonly editor: HTMLElement, private readonly context: DictationKeyboardContext) {}

  keydown(event: globalThis.KeyboardEvent): boolean {
    const binding = this.context.binding();
    if (event.defaultPrevented || this.editor.ownerDocument.activeElement !== this.editor) return false;
    if (this.suppressedKeys.has(event.key)) {
      if (event.repeat) { event.preventDefault(); return true; }
      this.suppressedKeys.delete(event.key); // A fresh press recovers missing keyup.
    }
    if (this.context.composing() || event.isComposing || event.keyCode === 229) {
      if (this.hold) this.interrupt();
      this.clearPending();
      return false;
    }
    const key = event.code || event.key;
    const sameKey = key === this.heldKey;
    if (sameKey && this.heldKey !== null && !event.repeat) {
      // A new physical press also recovers a lost keyup (window switched away).
      if (this.hold) this.interrupt();
      this.heldKey = null;
      this.clearPending();
    }
    if (sameKey && this.heldKey !== null) {
      // Suppress repeats even after Enter/Escape stopped capture but before the
      // physical Space release. Repeats must never turn into a stream of spaces.
      event.preventDefault();
      return true;
    }
    if (this.pendingHold && !sameKey) {
      const text = this.pendingText;
      this.clearPending();
      if (text) this.context.insertText(text);
    }
    const active = binding?.active || this.hold;
    if (event.key === "Escape" && active) {
      event.preventDefault();
      this.suppressedKeys.add(event.key);
      if (!event.repeat) this.cancel();
      return true;
    }
    if (event.key === "Enter" && active) {
      event.preventDefault();
      this.suppressedKeys.add(event.key);
      if (!event.repeat) this.stop();
      return true;
    }
    if (!binding?.enabled || this.context.blocked()) return false;
    const shortcut = parseDictationShortcut(binding.toggleShortcut);
    if ((shortcut && event.key.toLowerCase() === shortcut.key && event.altKey === shortcut.alt
      && event.ctrlKey === shortcut.ctrl && event.metaKey === shortcut.meta && event.shiftKey === shortcut.shift)
      || binding.toggleKeys?.some(value => matchesDictationKey(event, value))) {
      event.preventDefault();
      this.suppressedKeys.add(event.key);
      if (!event.repeat) {
        if (active) this.stop();
        else { this.stopping = false; binding.onStart("toggle"); }
      }
      return true;
    }
    if (!(binding.holdKeys ?? ["space"]).some(value => matchesDictationKey(event, value)) || Date.now() - this.compositionEndedAt < 100) return false;
    if (active || event.repeat) return false;
    event.preventDefault();
    this.heldKey = key;
    this.pendingText = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey ? event.key : "";
    this.pendingHold = true;
    this.stopping = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      const latest = this.context.binding();
      if (this.heldKey === null || !latest?.enabled || latest.active || this.context.blocked()
        || this.context.composing() || this.editor.ownerDocument.activeElement !== this.editor) {
        this.pendingHold = false;
        return;
      }
      this.pendingHold = false;
      this.hold = true;
      latest.onStart("hold");
    }, DICTATION_HOLD_DELAY_MS);
    return true;
  }

  keyup = (event: globalThis.KeyboardEvent): void => {
    this.suppressedKeys.delete(event.key);
    if ((event.code || event.key) !== this.heldKey) return;
    event.preventDefault();
    const hold = this.hold;
    const short = this.pendingHold;
    const text = this.pendingText;
    this.heldKey = null;
    this.clearPending();
    if (hold) this.stop();
    else if (short && text && !event.isComposing && event.keyCode !== 229 && !this.context.composing()
      && this.editor.ownerDocument.activeElement === this.editor) this.context.insertText(text);
  };

  compositionStart(): void {
    if (this.hold) this.interrupt();
    this.clearPending();
    this.heldKey = null;
  }

  compositionEnd(): void { this.compositionEndedAt = Date.now(); }

  editorBlur(): void {
    if (this.hold) this.interrupt();
    else this.clearPending(); // Click/toggle survives a toolbar focus transfer.
  }

  interrupt = (): void => {
    const binding = this.context.binding();
    const active = this.hold || binding?.active;
    this.clearPending();
    this.hold = false;
    if (active && !this.stopping) { this.stopping = true; binding?.onInterrupt(); }
  };

  visibilityChange = (): void => {
    if (this.editor.ownerDocument.visibilityState === "hidden") this.interrupt();
  };

  dispose(): void { this.interrupt(); }

  private stop(): void {
    this.clearPending();
    this.hold = false;
    if (this.stopping) return;
    this.stopping = true;
    this.context.binding()?.onStop();
  }

  private cancel(): void {
    this.clearPending();
    this.hold = false;
    this.stopping = true;
    this.context.binding()?.onCancel();
  }

  private clearPending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pendingHold = false;
    this.pendingText = "";
  }

  /** An inactive boundary arms the next click-mode stop/cancel. */
  bindingChanged(): void {
    if (!this.context.binding()?.active && !this.hold) this.stopping = false;
    if (!this.context.binding()?.enabled && (this.hold || this.pendingHold)) this.interrupt();
  }
}
