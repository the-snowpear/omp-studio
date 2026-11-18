import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  PredictionChannel,
  PredictionInput,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { HostReceiptTimeout, hostErrorMessage, waitReceipt } from "../hostError";
import { insertPlainText } from "./editorDom";
import { isZh, useI18n } from "../i18n";
import { getPreviewNextMessages } from "../preview/nextMessagePreview";
import "./prediction.css";
export interface ComposerPrediction {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
  nextMessageAvailable?: boolean;
}
type ScannedDraft = {
  readonly text: string;
  readonly caret: number;
  readonly hasAfter: boolean;
  readonly hasChip: boolean;
};

/** Plain prose only: chips, hidden attachment names and image bytes never reach prediction. */
function scanEditorDraft(
  editor: HTMLElement,
  caretNode: Node | null,
  caretOffset: number,
): ScannedDraft | undefined {
  let text = "";
  let caret = 0;
  let passedCaret = caretNode === null;
  let hasAfter = false;
  let hasChip = false;
  let overflow = false;

  const markContent = (chunk: string, isChip = false) => {
    if (isChip) hasChip = true;
    if (passedCaret && (chunk.length > 0 || isChip)) hasAfter = true;
    text += chunk;
    if (text.length > 4096) overflow = true;
  };

  const walk = (node: Node): void => {
    if (overflow) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (node === caretNode) {
        const clamped = Math.max(0, Math.min(caretOffset, value.length));
        caret = text.length + clamped;
        passedCaret = true;
        if (clamped < value.length) hasAfter = true;
        text += value;
        if (text.length > 4096) overflow = true;
        return;
      }
      markContent(value);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.hasAttribute("data-composer-dictation")) {
      if (node === caretNode) {
        caret = text.length;
        passedCaret = true;
      }
      return;
    }
    if (node.matches(".cm-chip,[contenteditable=false]")) {
      if (node === caretNode) {
        caret = text.length;
        passedCaret = true;
      }
      markContent("\n", true);
      return;
    }
    if (node.tagName === "BR") {
      if (node === caretNode) {
        caret = text.length;
        passedCaret = true;
      }
      markContent("\n");
      return;
    }
    const startLen = text.length;
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (node === caretNode && i === caretOffset) {
        caret = text.length;
        passedCaret = true;
      }
      walk(children[i]!);
      if (overflow) return;
    }
    if (node === caretNode && caretOffset >= children.length && !passedCaret) {
      caret = text.length;
      passedCaret = true;
    }
    if ((node.tagName === "DIV" || node.tagName === "P") && text.length > startLen && !text.endsWith("\n")) {
      markContent("\n");
    }
  };

  const rootChildren = editor.childNodes;
  for (let i = 0; i < rootChildren.length; i++) {
    if (editor === caretNode && i === caretOffset) {
      caret = text.length;
      passedCaret = true;
    }
    walk(rootChildren[i]!);
    if (overflow) return undefined;
  }
  if (editor === caretNode && caretOffset >= rootChildren.length && !passedCaret) {
    caret = text.length;
    passedCaret = true;
  }
  return { text, caret: Math.min(caret, text.length), hasAfter, hasChip };
}

export function predictionDraft(
  editor: HTMLElement,
): { text: string; caret: number } | undefined {
  const selection = editor.ownerDocument.defaultView!.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  const parent =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (parent?.closest(".cm-chip,[contenteditable=false],[data-composer-dictation]")) return;
  const scanned = scanEditorDraft(editor, range.startContainer, range.startOffset);
  if (!scanned) return;
  return { text: scanned.text, caret: scanned.caret };
}
function currentDraft(editor: HTMLElement, allowEmpty: boolean): { text: string; caret: number } | undefined {
  if (allowEmpty) {
    const emptyCheck = scanEditorDraft(editor, null, 0);
    if (emptyCheck && !emptyCheck.hasChip && (emptyCheck.text === "" || emptyCheck.text === "\n")) {
      return { text: "", caret: 0 };
    }
  }
  if (editor.ownerDocument.activeElement !== editor) return;
  const selection = editor.ownerDocument.defaultView!.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  const parent =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (parent?.closest(".cm-chip,[contenteditable=false],[data-composer-dictation]")) return;
  const scanned = scanEditorDraft(editor, range.startContainer, range.startOffset);
  if (!scanned || scanned.hasAfter) return;
  return { text: scanned.text, caret: scanned.caret };
}
function previewSuffix(text: string, caret: number, zh = isZh()): string | null {
  const before = text.slice(0, caret),
    word = before.match(/[\p{L}]+$/u)?.[0];
  if (!word || /[/\\@]/.test(before)) return null;
  const choices = zh
    ? ["review", "implementation", "testing", "测试", "验证"]
    : ["review", "implementation", "testing", "verify", "tests"];
  const full = choices.find(
    (value) =>
      value.toLowerCase().startsWith(word.toLowerCase()) &&
      value.length > word.length,
  );
  return full?.slice(word.length) ?? null;
}
type Ghost = {
  next?: boolean;
  rank?: number | undefined;
  suffix: string;
  revision: number;
  draft: string;
  caret: number;
  left: number;
  top: number;
  width: number;
};
export function useWordPrediction(
  editorRef: RefObject<HTMLDivElement | null>,
  options: ComposerPrediction | undefined,
  blocked: boolean,
) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const [ghost, setGhost] = useState<Ghost>(),
    [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false), [choiceIndex, setChoiceIndex] = useState(0);
  const [alternatives, setAlternatives] = useState<{ values: readonly string[]; revision: number }>();
  const offers = useRef(alternatives); offers.current = alternatives;
  const installed = useRef<string | undefined>(undefined);
  const shown = useRef<Ghost | undefined>(undefined);
  const acknowledged = useRef<number | undefined>(undefined);
  shown.current = ghost;
  const inputPort = useRef<
    ((input: Exclude<PredictionInput, { kind: "import" }>) => void) | undefined
  >(undefined);
  const generation = useRef(0),
    revision = useRef(0);
  useEffect(() => {
    const editor = editorRef.current;
    const current = ++generation.current;
    setGhost(undefined);
    offers.current = undefined;
    setAlternatives(undefined); setMenuOpen(false); installed.current = undefined;
    setError("");
    if (
      !editor ||
      !options ||
      blocked ||
      (!preview && (!options.available || !options.sessionId))
    )
      return;
    const chrome = window.ompStudioChrome;
    if (
      !preview &&
      (!chrome?.attachPrediction ||
        !chrome.predictionInput ||
        !chrome.onPrediction)
    )
      return;
    let attachment: { channel: PredictionChannel; ready: boolean } | undefined,
      connecting: Promise<void> | undefined,
      composing = false,
      recoverOnLoss = true,
      timer: number | undefined,
      frameId: number | undefined,
      syncedInTurn = false,
      queuedDraft: { text: string; caret: number } | undefined,
      lastDraft: { text: string; caret: number; revision: number } | undefined;
    const eligible = () =>
      generation.current === current && !composing && !document.hidden &&
      currentDraft(editor, !!options.nextMessageAvailable) !== undefined;
    const clearPrediction = () => {
      offers.current = undefined;
      shown.current = undefined;
      setAlternatives(undefined);
      setMenuOpen(false);
      setGhost(undefined);
    };
    const release = ({ sessionId, channelId }: PredictionChannel) => {
      void options.client.command("prediction.release", { sessionId, channelId }).catch(() => {});
    };
    const close = () => {
      const previous = attachment;
      attachment = undefined;
      if (!previous) return;
      void chrome?.detachPrediction?.({ channelId: previous.channel.channelId }).catch(() => {});
      if (!previous.ready) release(previous.channel);
    };
    const lost = () => {
      const wasReady = attachment?.ready;
      close();
      if (wasReady) lastDraft = undefined;
      clearPrediction();
      setError("");
      if (wasReady && recoverOnLoss && eligible()) {
        recoverOnLoss = false;
        update();
      }
    };
    const send = (input: Exclude<PredictionInput, { kind: "import" }>) => {
      const active = attachment;
      if (!active?.ready || preview) return;
      void chrome!.predictionInput!({ channelId: active.channel.channelId, input })
        .then((result) => {
          if (result.ok || attachment !== active) return;
          if (result.channelLost) lost();
          else {
            clearPrediction();
            setError(result.message ?? (zhRef.current ? "输入预测不可用" : "Prediction unavailable"));
          }
        })
        .catch(() => {
          if (attachment === active) lost();
        });
    };
    inputPort.current = send;
    const show = (suffix: string | null, version: number, next = false, rank?: number) => {
      const draft = lastDraft;
      if (
        generation.current !== current ||
        version !== revision.current ||
        !draft ||
        draft.revision !== version ||
        composing ||
        (!next && (document.activeElement !== editor || document.hidden))
      )
        return;
      if (!suffix) {
        setGhost(undefined);
        return;
      }
      const now = currentDraft(editor, !!options.nextMessageAvailable);
      if (!now || now.text !== draft.text || now.caret !== draft.caret) return;
      if (!next && offers.current?.values.some(value => value.startsWith(now.text.trimEnd()))) return;
      const editorBounds = editor.getBoundingClientRect();
      const previous = shown.current;
      if (next && !draft.text && editorBounds.width < 20 && previous?.next && !previous.draft) {
        setGhost({ ...previous, suffix, rank, revision: version });
        return;
      }
      const style = window.getComputedStyle(editor);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20;
      let rect: DOMRect;
      if (!draft.text) {
        rect = new DOMRect(editorBounds.left + (parseFloat(style.paddingLeft) || 0),
          editorBounds.top + (parseFloat(style.paddingTop) || 0), 0,
          lineHeight);
      } else {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0).cloneRange();
        rect = range.getBoundingClientRect();
        if (!rect.height && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1);
          rect = range.getBoundingClientRect();
          rect = new DOMRect(rect.right, rect.top, 0, rect.height);
        }
      }
      if (rect.bottom < editorBounds.top || rect.top > editorBounds.bottom) {
        setGhost(undefined);
        return;
      }
      const parent = editor.parentElement!.getBoundingClientRect();
      const left = Math.max(0, rect.left - parent.left),
        top = rect.top - parent.top - (lineHeight - rect.height) / 2,
        width = Math.max(0, editorBounds.right - (parseFloat(style.paddingRight) || 0) - rect.left);
      if (width < 20 || !rect.height) {
        setGhost(undefined);
        return;
      }
      setGhost({
        next, rank,
        suffix,
        revision: version,
        draft: draft.text,
        caret: draft.caret,
        left,
        top,
        width,
      });
      setError("");
    };
    const unsubscribe = preview
      ? undefined
      : chrome!.onPrediction!((event) => {
          if (
            event.channelId !== attachment?.channel.channelId ||
            generation.current !== current
          )
            return;
          if (event.kind === "next") {
            if (event.revision !== lastDraft?.revision || event.revision !== revision.current) return;
            const next = event.choices?.length ? { values: event.choices, revision: event.revision } : undefined;
            offers.current = next; setAlternatives(next);
            show(event.suffix, event.revision, true, event.rank);
            return;
          }
          if (event.kind === "suggestion") {
            if (event.revision === 0) {
              if (!shown.current?.next) setGhost(undefined);
              return;
            }
            show(event.suffix, event.revision);
          }
          if (event.kind === "error" && !event.requestId) {
            setError(event.message);
            clearPrediction();
          }
          if (event.kind === "closed") lost();
        });
    const ensure = async () => {
      if (preview || attachment?.ready) return;
      if (connecting) return connecting;
      connecting = (async () => {
        for (let attempt = 0; attempt < 2 && eligible(); attempt++) {
          const handle = await options.client.command("prediction.prepare", {
            sessionId: options.sessionId!,
            protocolVersion: 2,
          });
          const { result: prepared } = await waitReceipt<{ result: PredictionChannel }>(
            options.client,
            handle.requestId,
          );
          if (!eligible()) {
            release(prepared);
            return;
          }
          const pending = { channel: prepared, ready: false };
          attachment = pending;
          try {
            const result = await chrome!.attachPrediction!(prepared);
            if (attachment !== pending || !eligible()) continue;
            if (result.ok) {
              pending.ready = true;
              setError("");
              return;
            }
            if (!result.channelLost) throw result;
          } finally {
            if (attachment === pending && !pending.ready) close();
          }
        }
      })()
        .catch((cause) => {
          if (cause instanceof HostReceiptTimeout || !eligible()) return;
          setError(hostErrorMessage(cause, zhRef.current ? "输入预测不可用" : "Prediction unavailable"));
        })
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    };
    const update = () => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      if (!syncedInTurn) {
        syncedInTurn = true;
        queueMicrotask(() => { syncedInTurn = false; });
      }
      const previous = shown.current;
      const draft = currentDraft(editor, !!options.nextMessageAvailable);
      if (
        timer !== undefined &&
        !previous &&
        draft &&
        queuedDraft &&
        draft.text === queuedDraft.text &&
        draft.caret === queuedDraft.caret
      ) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      queuedDraft = undefined;
      if (!composing && previous?.next && !previous.draft && lastDraft?.revision === previous.revision && draft?.text === "") {
        show(previous.suffix, previous.revision, true, previous.rank);
        return;
      }
      const offer = offers.current;
      if (!composing && !document.hidden && options.nextMessageAvailable && draft?.text === "" && offer?.values.length && (preview || attachment?.ready)) {
        const version = ++revision.current;
        lastDraft = { ...draft, revision: version };
        const next = { values: offer.values, revision: version };
        offers.current = next; setAlternatives(next);
        if (!preview) send({ kind: "next", revision: version, empty: true });
        show(next.values[0]!, version, true, 0);
        return;
      }
      lastDraft = undefined;
      setGhost(undefined);
      if (composing || document.hidden)
        return;
      queuedDraft = draft;
      timer = window.setTimeout(
        () => {
          timer = undefined;
          queuedDraft = undefined;
          void (async () => {
            const draft = currentDraft(editor, !!options.nextMessageAvailable);
            if (!draft || (!draft.text.trim() && !options.nextMessageAvailable)) return;
            const version = ++revision.current;
            lastDraft = { ...draft, revision: version };
            if (preview) {
              const previewMessages = getPreviewNextMessages(zhRef.current);
              const rank = options.nextMessageAvailable ? previewMessages.findIndex(value => value.startsWith(draft.text.trimEnd())) : -1;
              if (rank >= 0) {
                const next = { values: previewMessages, revision: version };
                offers.current = next; setAlternatives(next);
                show(previewMessages[rank]!.slice(draft.text.trimEnd().length), version, true, rank);
              } else {
                if (!options.nextMessageAvailable) { offers.current = undefined; setAlternatives(undefined); }
                show(previewSuffix(draft.text, draft.caret, zhRef.current), version);
              }
              return;
            }
            await ensure();
            if (
              generation.current !== current ||
              lastDraft?.revision !== version
            )
              return;
            const latest = currentDraft(editor, !!options.nextMessageAvailable);
            if (latest?.text !== draft.text || latest.caret !== draft.caret)
              return;
            if (!draft.text && options.nextMessageAvailable && !editor.querySelector(".cm-chip,[contenteditable=false]:not([data-composer-dictation])")) {
              send({ kind: "next", revision: version, empty: true });
            } else {
              if (offers.current && !offers.current.values.some(value => value.startsWith(draft.text.trimEnd()))) {
                offers.current = undefined; setAlternatives(undefined);
              }
              send({ kind: "update", revision: version, ...draft });
            }
          })();
        },
        140,
      );
    };
    const scheduleUpdate = () => {
      if (frameId !== undefined) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        if (generation.current === current) update();
      });
    };
    const input = () => {
      recoverOnLoss = true;
      update();
    };
    const blur = () => {
      setMenuOpen(false);
      if (options.nextMessageAvailable && currentDraft(editor, true)?.text === "" && !document.hidden) {
        update();
        return;
      }
      if (frameId !== undefined) { window.cancelAnimationFrame(frameId); frameId = undefined; }
      clearTimeout(timer);
      timer = undefined;
      queuedDraft = undefined;
      lastDraft = undefined;
      setGhost(undefined);
      setAlternatives(undefined); offers.current = undefined;
      close();
    };
    const start = () => {
      if (options.nextMessageAvailable) {
        send({ kind: "next", revision: ++revision.current, empty: false });
        if (!preview && attachment?.ready) { offers.current = undefined; setAlternatives(undefined); }
      }
      composing = true;
      if (frameId !== undefined) { window.cancelAnimationFrame(frameId); frameId = undefined; }
      clearTimeout(timer);
      timer = undefined;
      queuedDraft = undefined;
      lastDraft = undefined;
      setGhost(undefined);
    };
    const end = () => {
      composing = false;
      update();
    };
    const visibility = () => {
      if (document.hidden) {
        if (frameId !== undefined) { window.cancelAnimationFrame(frameId); frameId = undefined; }
        clearTimeout(timer);
        timer = undefined;
        queuedDraft = undefined;
        setMenuOpen(false);
      } else input();
    };
    const selectionChange = () => {
      if (document.activeElement === editor && !syncedInTurn) scheduleUpdate();
    };
    const isDictationNode = (node: Node | null): boolean =>
      node !== null && ((node instanceof Element ? node : node.parentElement)?.closest("[data-composer-dictation]") !== null);
    const isDictationOnlyMutation = (mutation: MutationRecord): boolean => {
      if (isDictationNode(mutation.target)) return true;
      if (mutation.type !== "childList") return false;
      const touched = [...mutation.addedNodes, ...mutation.removedNodes];
      return touched.length > 0 && touched.every(isDictationNode);
    };
    const observer = new MutationObserver((mutations) => {
      if (syncedInTurn || mutations.every(isDictationOnlyMutation)) return;
      scheduleUpdate();
    });
    observer.observe(editor, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const sizeObserver = window.ResizeObserver ? new window.ResizeObserver(update) : undefined;
    sizeObserver?.observe(editor);
    editor.addEventListener("input", input);
    editor.addEventListener("focus", input);
    editor.addEventListener("blur", blur);
    editor.addEventListener("scroll", scheduleUpdate);
    editor.addEventListener("compositionstart", start);
    editor.addEventListener("compositionend", end);
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", scheduleUpdate);
    const ping = window.setInterval(() => {
      if (attachment?.ready && !document.hidden)
        send({ kind: "ping" });
    }, 15000);
    update();
    return () => {
      generation.current++;
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      clearTimeout(timer);
      clearInterval(ping);
      close();
      unsubscribe?.();
      inputPort.current = undefined;
      observer.disconnect();
      sizeObserver?.disconnect();
      editor.removeEventListener("input", input);
      editor.removeEventListener("focus", input);
      editor.removeEventListener("blur", blur);
      editor.removeEventListener("scroll", scheduleUpdate);
      editor.removeEventListener("compositionstart", start);
      editor.removeEventListener("compositionend", end);
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [
    editorRef,
    options?.client,
    options?.sessionId,
    options?.available,
    options?.nextMessageAvailable,
    blocked,
    preview,
    preview ? zh : false,
    document,
    window,
  ]);
  useEffect(() => {
    if (!ghost?.next || !alternatives || acknowledged.current === ghost.revision) return;
    const frame = window.requestAnimationFrame(() => {
      if (!document.hidden && (editorRef.current?.getBoundingClientRect().width ?? 0) >= 20) {
        acknowledged.current = ghost.revision;
        inputPort.current?.({ kind: "next.shown", revision: ghost.revision });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ghost, alternatives, document, editorRef, window]);
  function choose(index: number): boolean {
    const editor = editorRef.current, offer = offers.current, value = offer?.values[index];
    if (!editor || !offer || !value || editor.querySelector(".cm-chip,[contenteditable=false]:not([data-composer-dictation])")) return false;
    const draft = currentDraft(editor, !!options?.nextMessageAvailable);
    if (!draft || (!value.startsWith(draft.text.trimEnd()) && draft.text.trimEnd() !== installed.current)) return false;
    inputPort.current?.({ kind: "next.accepted", revision: offer.revision, rank: index });
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    insertPlainText(editor, value);
    installed.current = value; setChoiceIndex(index); setMenuOpen(false); setGhost(undefined);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  function key(key: string): boolean {
    if (menuOpen && offers.current) {
      if (key === "Escape") { setMenuOpen(false); return true; }
      if (key === "ArrowDown" || key === "ArrowUp") { setChoiceIndex(value => (value + (key === "ArrowDown" ? 1 : offers.current!.values.length - 1)) % offers.current!.values.length); return true; }
      if (key === "Enter" || key === "Tab") return choose(choiceIndex);
    }
    const current = shown.current,
      editor = editorRef.current;
    if (key === "Tab" && editor && installed.current && offers.current && offers.current.values.length > 1 && predictionDraft(editor)?.text.trimEnd() === installed.current) {
      setMenuOpen(true); return true;
    }
    if (!current || !editor) return false;
    const draft = currentDraft(editor, !!options?.nextMessageAvailable);
    if (draft?.text !== current.draft || draft.caret !== current.caret) {
      setGhost(undefined);
      return false;
    }
    if (key === "Escape") {
      inputPort.current?.({
        kind: "feedback",
        revision: current.revision,
        accepted: false,
      });
      revision.current++;
      offers.current = undefined; setAlternatives(undefined);
      setGhost(undefined);
      return true;
    }
    if (key !== "Tab" && key !== "ArrowRight") return false;
    if (current.next && offers.current) return choose(current.rank ?? 0);
    inputPort.current?.({
      kind: "feedback",
      revision: current.revision,
      accepted: true,
    });
    insertPlainText(editor, current.suffix + (key === "Tab" ? " " : ""));
    setGhost(undefined);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return { ghost, error, key, choose, choiceIndex, menuChoices: menuOpen ? alternatives?.values : undefined };
}
