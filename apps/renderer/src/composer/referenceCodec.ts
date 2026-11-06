/** Length framing keeps pasted Markdown and nested-looking tags intact. */
export function referenceCodec<T extends { readonly text: string }>(
  tag: string,
  accepts: (metadata: Omit<T, "text">) => boolean,
) {
  const closing = `\n</${tag}>`;
  return {
    serialize(reference: T): string {
      const { text, ...metadata } = reference;
      return `<${tag} metadata=${JSON.stringify(metadata)} length=${text.length}>\n${text}${closing}`;
    },
    next(text: string, from: number): { start: number; end: number; reference: T } | null {
      const pattern = new RegExp(`<${tag} metadata=(\\{[^\\n]*\\}) length=(\\d+)>\\n`, "g");
      pattern.lastIndex = from;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const bodyStart = pattern.lastIndex, bodyEnd = bodyStart + Number(match[2]);
        if (text.slice(bodyEnd, bodyEnd + closing.length) !== closing) continue;
        try {
          const metadata = JSON.parse(match[1]!) as Omit<T, "text">;
          if (accepts(metadata)) return {
            start: match.index, end: bodyEnd + closing.length,
            reference: { ...metadata, text: text.slice(bodyStart, bodyEnd) } as T,
          };
        } catch { /* Ordinary pasted text is left untouched. */ }
      }
      return null;
    },
  };
}
