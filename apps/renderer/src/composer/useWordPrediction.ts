import { useEffect, useRef, useState, type RefObject } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  PredictionChannel,
  PredictionInput,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { waitReceipt } from "../hostError";
import { insertPlainText } from "./editorDom";
import "./prediction.css";
export interface ComposerPrediction {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
}
/** Plain prose only: chips, hidden attachment names and image bytes never reach prediction. */
function plain(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (
    node instanceof Element &&
    node.matches(".cm-chip,[contenteditable=false]")
  )
    return "\n";
  if (node instanceof Element && node.tagName === "BR") return "\n";
  let text = Array.from(node.childNodes).map(plain).join("");
  if (
    node instanceof Element &&
    ["DIV", "P"].includes(node.tagName) &&
    text &&
    !text.endsWith("\n")
  )
    text += "\n";
  return text;
}
export function predictionDraft(
  editor: HTMLElement,
): { text: string; caret: number } | undefined {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  const parent =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (parent?.closest(".cm-chip,[contenteditable=false]")) return;
  if ((editor.textContent?.length ?? 0) > 4096) return;
  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  const text = plain(editor),
    head = plain(before.cloneContents());
  if (text.length > 4096) return;
  return { text, caret: Math.min(head.length, text.length) };
}
function previewSuffix(text: string, caret: number): string | null {
  const before = text.slice(0, caret),
    word = before.match(/[\p{L}]+$/u)?.[0];
  if (!word || /[/\\@]/.test(before)) return null;
  const choices = ["review", "implementation", "testing", "测试", "验证"];
  const full = choices.find(
    (value) =>
      value.toLowerCase().startsWith(word.toLowerCase()) &&
      value.length > word.length,
  );
  return full?.slice(word.length) ?? null;
}
type Ghost = {
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
  const { preview } = usePreviewMode();
  const [ghost, setGhost] = useState<Ghost>(),
    [error, setError] = useState("");
  const shown = useRef<Ghost | undefined>(undefined);
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
    setError("");
    if (
      !editor ||
      !options ||
      blocked ||
      (!preview && (!options.available || !options.sessionId))
    )
      return;
    const chrome = globalThis.ompStudioChrome;
    if (
      !preview &&
      (!chrome?.attachPrediction ||
        !chrome.predictionInput ||
        !chrome.onPrediction)
    )
      return;
    let channel: PredictionChannel | undefined,
      connecting: Promise<void> | undefined,
      composing = false,
      timer: number | undefined,
      lastDraft: { text: string; caret: number; revision: number } | undefined;
    const send = (input: Exclude<PredictionInput, { kind: "import" }>) => {
      if (channel && !preview)
        void chrome!.predictionInput!({ channelId: channel.channelId, input })
          .then((result) => {
            if (!result.ok && generation.current === current) {
              setError(result.message ?? "Prediction unavailable");
              setGhost(undefined);
            }
          })
          .catch(() => {
            if (generation.current === current) setGhost(undefined);
          });
    };
    inputPort.current = send;
    const close = () => {
      const previous = channel;
      channel = undefined;
      if (previous && !preview)
        void chrome
          ?.detachPrediction?.({ channelId: previous.channelId })
          .catch(() => {});
    };
    const show = (suffix: string | null, version: number) => {
      const draft = lastDraft;
      if (
        generation.current !== current ||
        !draft ||
        draft.revision !== version ||
        document.activeElement !== editor ||
        document.hidden
      )
        return;
      if (!suffix) {
        setGhost(undefined);
        return;
      }
      const now = predictionDraft(editor);
      if (!now || now.text !== draft.text || now.caret !== draft.caret) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0).cloneRange();
      let rect = range.getBoundingClientRect();
      if (
        !rect.height &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startOffset > 0
      ) {
        range.setStart(range.startContainer, range.startOffset - 1);
        rect = range.getBoundingClientRect();
        rect = new DOMRect(rect.right, rect.top, 0, rect.height);
      }
      const editorBounds = editor.getBoundingClientRect();
      if (rect.bottom < editorBounds.top || rect.top > editorBounds.bottom) {
        setGhost(undefined);
        return;
      }
      const parent = editor.parentElement!.getBoundingClientRect();
      const left = Math.max(0, rect.left - parent.left),
        top = rect.top - parent.top,
        width = Math.max(0, parent.width - left - 8);
      if (width < 20 || !rect.height) {
        setGhost(undefined);
        return;
      }
      setGhost({
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
            event.channelId !== channel?.channelId ||
            generation.current !== current
          )
            return;
          if (event.kind === "suggestion") {
            if (event.revision === 0) {
              setGhost(undefined);
              return;
            }
            show(event.suffix, event.revision);
          }
          if (event.kind === "error" && !event.requestId) {
            setError(event.message);
            setGhost(undefined);
          }
          if (event.kind === "closed") {
            channel = undefined;
            setGhost(undefined);
          }
        });
    const ensure = async () => {
      if (preview || channel) return;
      if (connecting) return connecting;
      connecting = (async () => {
        const handle = await options.client.command("prediction.prepare", {
          sessionId: options.sessionId!,
        });
        const prepared = (
          await waitReceipt<{ result: PredictionChannel }>(
            options.client,
            handle.requestId,
          )
        ).result;
        if (
          generation.current !== current ||
          document.activeElement !== editor ||
          document.hidden
        ) {
          void options.client
            .command("prediction.release", {
              sessionId: prepared.sessionId,
              channelId: prepared.channelId,
            })
            .catch(() => {});
          return;
        }
        const attached = await chrome!.attachPrediction!(prepared);
        if (
          !attached.ok ||
          generation.current !== current ||
          document.activeElement !== editor ||
          document.hidden
        ) {
          void chrome!.detachPrediction!({
            channelId: prepared.channelId,
          }).catch(() => {});
          void options.client
            .command("prediction.release", {
              sessionId: prepared.sessionId,
              channelId: prepared.channelId,
            })
            .catch(() => {});
          if (!attached.ok)
            throw new Error(attached.message ?? "Prediction unavailable");
          return;
        }
        channel = prepared;
      })()
        .catch((cause) => {
          if (generation.current === current)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    };
    const update = () => {
      clearTimeout(timer);
      setGhost(undefined);
      if (composing || document.hidden || document.activeElement !== editor)
        return;
      timer = window.setTimeout(
        () =>
          void (async () => {
            const draft = predictionDraft(editor);
            if (!draft || !draft.text.trim()) return;
            const version = ++revision.current;
            lastDraft = { ...draft, revision: version };
            if (preview) {
              show(previewSuffix(draft.text, draft.caret), version);
              return;
            }
            await ensure();
            if (
              generation.current !== current ||
              lastDraft?.revision !== version
            )
              return;
            const latest = predictionDraft(editor);
            if (latest?.text !== draft.text || latest.caret !== draft.caret)
              return;
            send({ kind: "update", revision: version, ...draft });
          })(),
        140,
      );
    };
    const blur = () => {
      clearTimeout(timer);
      setGhost(undefined);
      close();
    };
    const start = () => {
      composing = true;
      clearTimeout(timer);
      setGhost(undefined);
    };
    const end = () => {
      composing = false;
      update();
    };
    const visibility = () => {
      if (document.hidden) blur();
      else update();
    };
    const observer = new MutationObserver(update);
    observer.observe(editor, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    editor.addEventListener("input", update);
    editor.addEventListener("focus", update);
    editor.addEventListener("blur", blur);
    editor.addEventListener("scroll", update);
    editor.addEventListener("compositionstart", start);
    editor.addEventListener("compositionend", end);
    document.addEventListener("selectionchange", update);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", update);
    const ping = window.setInterval(() => {
      if (document.activeElement === editor && !document.hidden)
        send({ kind: "ping" });
    }, 15000);
    update();
    return () => {
      generation.current++;
      clearTimeout(timer);
      clearInterval(ping);
      close();
      unsubscribe?.();
      inputPort.current = undefined;
      observer.disconnect();
      editor.removeEventListener("input", update);
      editor.removeEventListener("focus", update);
      editor.removeEventListener("blur", blur);
      editor.removeEventListener("scroll", update);
      editor.removeEventListener("compositionstart", start);
      editor.removeEventListener("compositionend", end);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", update);
    };
  }, [
    editorRef,
    options?.client,
    options?.sessionId,
    options?.available,
    blocked,
    preview,
  ]);
  function key(key: string): boolean {
    const current = shown.current,
      editor = editorRef.current;
    if (!current || !editor) return false;
    const draft = predictionDraft(editor);
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
      setGhost(undefined);
      return true;
    }
    if (key !== "Tab" && key !== "ArrowRight") return false;
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
  return { ghost, error, key };
}
