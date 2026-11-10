import type { AnnotationNote, AnnotationSource } from "@omp-studio/studio-protocol";

export type AnnotationSelection = NonNullable<AnnotationNote["selection"]>;

/** End-exclusive UTF-16 anchors stay in the original snapshot, including CRLF. */
export function annotationLines(text: string, selection: AnnotationSelection) {
  const start = text.slice(0, selection.start).split("\n").length;
  const last = Math.max(selection.start, selection.end - 1);
  const end = text.slice(0, last).split("\n").length;
  return { start, end };
}

export function annotationLocation(text: string, selection: AnnotationSelection | undefined, zh: boolean) {
  if (!selection) return zh ? "整份来源" : "Whole source";
  const { start, end } = annotationLines(text, selection);
  return zh
    ? start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`
    : start === end ? `Line ${start}` : `Lines ${start}-${end}`;
}

export function annotationSourceKind(kind: AnnotationSource["kind"], zh: boolean) {
  const labels = {
    message: ["回复", "Reply"],
    quote: ["文本", "Text"],
    file: ["文件", "File"],
    diff: ["改动", "Changes"],
  };
  return labels[kind][zh ? 0 : 1]!;
}
