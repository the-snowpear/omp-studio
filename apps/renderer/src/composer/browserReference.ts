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
export function serializeBrowserReference(reference: BrowserReferenceSnapshot): string {
  const { text, ...metadata } = reference;
  return `<browser-reference metadata=${JSON.stringify(metadata)} length=${text.length}>\n${text}\n</browser-reference>`;
}
export function nextBrowserReference(text: string, from: number): { start: number; end: number; reference: BrowserReferenceSnapshot } | null {
  const pattern = /<browser-reference metadata=(\{[^\n]*\}) length=(\d+)>\n/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const bodyStart = pattern.lastIndex, bodyEnd = bodyStart + Number(match[2]);
    const closing = "\n</browser-reference>";
    if (text.slice(bodyEnd, bodyEnd + closing.length) !== closing) continue;
    try {
      const metadata = JSON.parse(match[1]!) as Omit<BrowserReferenceSnapshot, "text">;
      if (metadata.kind !== "browser" || typeof metadata.key !== "string" || !metadata.element) continue;
      return { start: match.index, end: bodyEnd + closing.length, reference: { ...metadata, text: text.slice(bodyStart, bodyEnd) } };
    } catch { continue; }
  }
  return null;
}
