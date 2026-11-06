/** Tools can occupy their conversation or its shared slots in the main document. */
export function conversationDocument(surface: Document, owner?: string): Document {
  if (!owner) return surface;
  const roots = () => [...new Set([surface, document].flatMap(doc => [...doc.querySelectorAll<HTMLElement>(`[data-conversation-document="${owner}"], [data-conversation-owner="${owner}"]`)]))];
  return new Proxy(surface, {
    get(target, property) {
      if (property === "querySelector") return (selector: string) => roots().map(root => root.querySelector(selector)).find(Boolean) ?? null;
      if (property === "querySelectorAll") return (selector: string) => [...new Set(roots().flatMap(root => [...root.querySelectorAll(selector)]))];
      if (property === "elementsFromPoint") return (x: number, y: number) => target.elementsFromPoint(x, y);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
