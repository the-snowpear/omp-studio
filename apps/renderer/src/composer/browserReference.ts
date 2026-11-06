import { referenceCodec } from "./referenceCodec";
import type { BrowserElementReference } from "@omp-studio/studio-protocol";

export interface BrowserReferenceSnapshot {
  readonly kind: "browser";
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly element: Omit<BrowserElementReference, "screenshot">;
}
export function browserReferenceSnapshot(reference: BrowserElementReference): BrowserReferenceSnapshot {
  const { screenshot: _screenshot, ...element } = reference;
  const text = [
    `Page: ${element.title}\nURL: ${element.url}`,
    `Element: ${element.tagName}\nLocator: ${element.selector}\nFrame: ${element.frameUrl}`,
    `Captured: ${element.capturedAt}\nRegion: ${element.rect.x}, ${element.rect.y}, ${element.rect.width} × ${element.rect.height}`,
    `Text:\n${element.text}`,
    ...(element.note ? [`User note:\n${element.note}`] : []),
  ].join("\n\n");
  return { kind: "browser", key: `browser:${element.id}`, title: `${element.tagName} · ${element.title}`, url: element.url, text, element };
}
export const { serialize: serializeBrowserReference, next: nextBrowserReference } = referenceCodec<BrowserReferenceSnapshot>(
  "browser-reference",
  metadata => metadata.kind === "browser" && typeof metadata.key === "string" && !!metadata.element,
);
