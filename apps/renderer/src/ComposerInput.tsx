/**
 * Composer textarea with a mirrored highlight layer for magic keywords.
 * Transparent text + visible caret; overlay paints gradients (shimmer when focused).
 */

import { useLayoutEffect, useRef, useState, type Ref, type TextareaHTMLAttributes } from "react";

import { hasMagicKeyword } from "./magicKeywords";
import { renderMagicKeywordText } from "./MagicKeywordText";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "children"> & {
  value: string;
  inputRef?: Ref<HTMLTextAreaElement>;
};

function assignRef(ref: Ref<HTMLTextAreaElement> | undefined, node: HTMLTextAreaElement | null): void {
  if (ref === null || ref === undefined) return;
  if (typeof ref === "function") {
    ref(node);
    return;
  }
  (ref as { current: HTMLTextAreaElement | null }).current = node;
}

export function ComposerInput({ value, inputRef, onScroll, onFocus, onBlur, className, ...rest }: Props) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const glow = hasMagicKeyword(value);

  useLayoutEffect(() => {
    const input = localRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [value]);

  return (
    <div className={`composer-input-shell${glow ? " has-magic" : ""}`}>
      <div className="composer-input-mirror" ref={mirrorRef} aria-hidden="true">
        {renderMagicKeywordText(value, focused && glow)}
        {/* Trailing newline needs a visible line box so mirror height tracks textarea. */}
        {value.endsWith("\n") ? "\n" : null}
      </div>
      <textarea
        {...rest}
        className={["composer-input", className].filter(Boolean).join(" ")}
        value={value}
        ref={(node) => {
          localRef.current = node;
          assignRef(inputRef, node);
        }}
        onScroll={(event) => {
          const mirror = mirrorRef.current;
          if (mirror) {
            mirror.scrollTop = event.currentTarget.scrollTop;
            mirror.scrollLeft = event.currentTarget.scrollLeft;
          }
          onScroll?.(event);
        }}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
      />
    </div>
  );
}
