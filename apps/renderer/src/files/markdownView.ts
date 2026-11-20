import { useRef, type RefObject } from "react";
import type { FileModeOption } from "./FileHeader";
import type { EditorController } from "./FileTextEditor";

export const MARKDOWN_SPLIT_MIN_WIDTH = 640;
export function markdownModes(zh: boolean, split: boolean): FileModeOption[] {
  const options: FileModeOption[] = [{ id: "source", label: zh ? "源码" : "Source", icon: "code" }];
  if (split) options.push({ id: "split", label: zh ? "分栏" : "Split", icon: "columns" });
  options.push({ id: "preview", label: zh ? "预览" : "Preview", icon: "eye" });
  return options;
}

/** Source and rendered Markdown scroll by proportion, even when their line heights differ. */
export function useMarkdownScroll(controller: RefObject<EditorController | null>) {
  const markdownRef = useRef<HTMLDivElement>(null), following = useRef(false);
  function followEditor(ratio: number) {
    const element = markdownRef.current;
    if (!element) return;
    const top = Math.round(ratio * (element.scrollHeight - element.clientHeight));
    if (Math.abs(element.scrollTop - top) > 1) { following.current = true; element.scrollTop = top; }
  }
  function previewScroll() {
    if (following.current) { following.current = false; return; }
    const element = markdownRef.current;
    if (!element) return;
    const range = element.scrollHeight - element.clientHeight;
    controller.current?.scrollToRatio(range > 0 ? element.scrollTop / range : 0);
  }
  return { markdownRef, followEditor, previewScroll };
}
