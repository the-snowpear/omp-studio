import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { MOTION_SLACK_MS, motionReduced } from "../../motion";
import { TAB_PANE_MS, type SlideDir, type TabPaneRole } from "../../pageTransition";

export function hubFaceClass(role: TabPaneRole | null, dir: SlideDir): string {
  return role ? `hub-face hub-face-${role}-${dir}` : "hub-face";
}

/** Shrink the roster grid from the chat-preview height in the same 320ms as the back-facing pane swap. */
export function useHubChatCloseMotion(
  chatOpen: boolean,
  incoming: "chat" | "detail",
  colsRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [closing, setClosing] = useState(false);
  const fromRef = useRef(0);
  const fromHoldRef = useRef(0);
  const toHoldRef = useRef(0);

  useLayoutEffect(() => {
    if (!chatOpen) return;
    const el = colsRef.current;
    if (el) fromRef.current = el.getBoundingClientRect().height;
  });

  useLayoutEffect(() => {
    const el = colsRef.current;
    if (chatOpen) {
      if (el) {
        el.style.height = "";
        el.style.transition = "";
      }
      if (closing) setClosing(false);
      return;
    }
    if (incoming !== "detail") return;
    if (motionReduced() || !el) {
      fromRef.current = 0;
      if (closing) setClosing(false);
      return;
    }
    if (!closing) {
      const from = fromRef.current;
      fromRef.current = 0;
      if (from <= 0) return;
      const to = el.getBoundingClientRect().height;
      if (Math.abs(from - to) < 1) return;
      fromHoldRef.current = from;
      toHoldRef.current = to;
      setClosing(true);
      return;
    }
    const from = fromHoldRef.current;
    const to = toHoldRef.current;
    el.style.height = `${from}px`;
    el.style.transition = "none";
    void el.getBoundingClientRect();
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      el.style.transition = `height ${TAB_PANE_MS}ms var(--ease-nav)`;
      el.style.height = `${to}px`;
    });
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      el.style.height = "";
      el.style.transition = "";
      setClosing(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "height") return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(finish, TAB_PANE_MS + MOTION_SLACK_MS);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
      el.style.height = "";
      el.style.transition = "";
    };
  }, [chatOpen, closing, colsRef, incoming]);

  return closing;
}
