import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BrowserObservationInput } from "@omp-studio/studio-protocol";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { PREVIEW_BROWSER_IMAGE } from "../preview/browserPreview";
import type { Copy } from "./BrowserToolbar";
import type { NativeBrowserFrame as Frame, NativeBrowserFrames, NativeBrowserState } from "./useNativeBrowserObservation";
const noFrames = () => () => {};

/** Account for letterboxing in capture pixels; the Runtime maps this fraction into the unchanged CSS viewport. */
export function browserFramePoint(rect: { left: number; top: number; width: number; height: number }, image: { width: number; height: number }, x: number, y: number): { x: number; y: number } | undefined {
  if (!rect.width || !rect.height || !image.width || !image.height) return;
  const scale = Math.min(rect.width / image.width, rect.height / image.height), width = image.width * scale, height = image.height * scale;
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  if (x < left || y < top || x >= left + width || y >= top + height) return;
  return { x: (x - left) / width, y: (y - top) / height };
}

/** A real capture, not an iframe/reopened URL. The text input exists only for keyboard/IME delivery to this view. */
export function NativeBrowserFrame({ frame: suppliedFrame, frames, state, preview, connecting, paused, error, copy, resume, acknowledge, input, onDecodeError, onAddress }: {
  frame?: Frame | undefined; frames?: NativeBrowserFrames | undefined; state?: NativeBrowserState | undefined; preview: boolean; connecting: boolean; paused: boolean; error: string; copy: Copy;
  resume(): void; acknowledge(frame: Frame): Promise<void>; input(action: BrowserObservationInput): Promise<void>; onDecodeError(): void; onAddress(): void;
}) {
  const document = useSurfaceDocument(), view = document.defaultView;
  const frame = useSyncExternalStore(frames?.subscribe ?? noFrames, frames?.getSnapshot ?? (() => suppliedFrame));
  const picture = useRef<HTMLImageElement>(null), keyboard = useRef<HTMLTextAreaElement>(null), composing = useRef(false), compositionEvent = useRef<Event | null>(null);
  const latest = useRef(frame); latest.current = frame;
  const human = state?.control === "human" && (preview || !!frame);
  const active = useRef(human); active.current = human;
  const queuedWheel = useRef<{ x: number; y: number; deltaX: number; deltaY: number; sequence: number } | undefined>(undefined);
  const wheelFrame = useRef(0);
  const [decodeError, setDecodeError] = useState("");
  useEffect(() => { setDecodeError(""); }, [frame?.sequence]);
  useEffect(() => {
    const image = picture.current;
    if (!image || !human || !frame || !view) return;
    const wheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current || !active.current) return;
      const point = browserFramePoint(image.getBoundingClientRect(), current, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.cssHeight ?? current.height : 1;
      const previous = queuedWheel.current;
      queuedWheel.current = { ...point, sequence: current.sequence, deltaX: Math.max(-2048, Math.min(2048, (previous?.sequence === current.sequence ? previous.deltaX : 0) + event.deltaX * factor)),
        deltaY: Math.max(-2048, Math.min(2048, (previous?.sequence === current.sequence ? previous.deltaY : 0) + event.deltaY * factor)) };
      if (!wheelFrame.current) wheelFrame.current = view.requestAnimationFrame(() => {
        wheelFrame.current = 0;
        const next = queuedWheel.current; queuedWheel.current = undefined;
        if (next && active.current && next.sequence === latest.current?.sequence) void input({ kind: "wheel", ...next });
      });
    };
    image.addEventListener("wheel", wheel, { passive: false });
    return () => { image.removeEventListener("wheel", wheel); view.cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0; queuedWheel.current = undefined; };
  }, [human, !!frame, input, view]);
  const src = preview ? PREVIEW_BROWSER_IMAGE : frame ? `data:image/jpeg;base64,${frame.data}` : undefined;
  if (paused || !src) return <div className="mb-state" role={error || decodeError ? "alert" : "status"}>
    <strong>{paused ? copy("已停止同页观察", "Same-page viewing stopped") : connecting ? copy("正在连接原生页面…", "Connecting to the native page…") : error ? copy("无法观察原生页面", "Native page observation unavailable") : copy("等待同页画面…", "Waiting for the same-page image…")}</strong>
    <p>{error || decodeError || copy("CLI 的标签、DOM 和登录状态保持不变；这里不会另开网页。", "The CLI tab, DOM and sign-in stay unchanged. Viewing never opens another page.")}</p>
    {!connecting ? <button type="button" className="btn small outline" onClick={resume}>{copy("继续观察", "Resume viewing")}</button> : null}
  </div>;
  return <div className={`mb-native-frame${human ? " is-controlled" : ""}`} role="group" aria-label={copy("同一原生标签的实时画面", "Live image of the same native tab")}
    onMouseDown={event => {
      if (!human || !frame) return;
      const image = picture.current;
      const point = image && browserFramePoint(image.getBoundingClientRect(), frame, event.clientX, event.clientY);
      if (!point || (event.button !== 0 && event.button !== 2)) return;
      event.preventDefault(); keyboard.current?.focus({ preventScroll: true });
      void input({ kind: "click", sequence: frame.sequence, ...point, button: event.button === 2 ? "right" : "left" });
    }} onContextMenu={event => { if (human) event.preventDefault(); }}>
    <img ref={picture} alt={copy("当前原生浏览器画面", "Current native browser image")} src={src} draggable={false} decoding="async"
      onLoad={event => {
        if (preview || !frame || event.currentTarget.currentSrc && event.currentTarget.currentSrc !== src) return;
        const image = event.currentTarget;
        if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 4_000_000) { setDecodeError(copy("画面超过资源限额", "Image exceeds the capture budget")); onDecodeError(); return; }
        void acknowledge(frame);
      }} onError={() => { setDecodeError(copy("原生画面无法解码", "Native image could not be decoded")); onDecodeError(); }} />
    <textarea ref={keyboard} className="mb-native-input" aria-label={copy("向原生页面输入；Esc 退出键盘控制", "Input to the native page; Escape leaves keyboard control")} tabIndex={human ? 0 : -1} readOnly={!human} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
      onCompositionStart={() => { composing.current = true; compositionEvent.current = null; }}
      onCompositionEnd={event => { composing.current = false; compositionEvent.current = event.nativeEvent; if (human && frame && event.data) void input({ kind: "text", sequence: frame.sequence, text: event.data.slice(0, 16384) }); event.currentTarget.value = ""; }}
      onBeforeInput={event => {
        const native = event.nativeEvent as InputEvent;
        if (native === compositionEvent.current || native.inputType === "insertFromComposition") { event.preventDefault(); return; }
        if (!human || !frame || composing.current || native.isComposing || !native.data) return;
        event.preventDefault(); void input({ kind: "text", sequence: frame.sequence, text: native.data.slice(0, 16384) });
      }} onChange={event => {
        if (composing.current || !human || !frame) return;
        // Browsers without beforeinput still deliver committed text once; normally the prevented event never reaches here.
        if (event.currentTarget.value) void input({ kind: "text", sequence: frame.sequence, text: event.currentTarget.value.slice(0, 16384) });
        event.currentTarget.value = "";
      }} onPaste={event => { if (human && frame) { event.preventDefault(); void input({ kind: "text", sequence: frame.sequence, text: event.clipboardData.getData("text/plain").slice(0, 16384) }); } }}
      onKeyDown={event => {
        if (!human || !frame || composing.current || event.nativeEvent.isComposing || event.key === "Process") return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") { event.preventDefault(); onAddress(); return; }
        if ([...event.key].length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) return;
        event.preventDefault();
        void input({ kind: "key", sequence: frame.sequence, key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        if (event.key === "Escape") event.currentTarget.blur();
      }} />
    {human ? <span className="mb-native-input-hint">{copy("点击画面后输入 · Esc 退出键盘", "Click to type · Esc leaves the keyboard")}</span> : null}
  </div>;
}
