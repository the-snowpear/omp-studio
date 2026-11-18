import type { ReactNode } from "react";
import type { HighlightToken } from "./protocol";

export function renderHighlightTokens(tokens: readonly HighlightToken[]): ReactNode {
  return tokens.map((token, index) =>
    token.type === "text"
      ? token.value
      : <span key={index} className={token.classes.join(" ")}>{renderHighlightTokens(token.children)}</span>,
  );
}

export function splitTokensBySeparator(tokens: readonly HighlightToken[], separator: string): HighlightToken[][] {
  const segments: HighlightToken[][] = [[]];
  for (const token of tokens) {
    if (token.type === "text") {
      const parts = token.value.split(separator);
      if (parts[0]) segments[segments.length - 1]!.push({ type: "text", value: parts[0] });
      for (let index = 1; index < parts.length; index += 1) {
        const part = parts[index]!;
        segments.push(part ? [{ type: "text", value: part }] : []);
      }
    } else {
      const subSegments = splitTokensBySeparator(token.children, separator);
      if (subSegments[0]!.length > 0) {
        segments[segments.length - 1]!.push({ type: "span", classes: token.classes, children: subSegments[0]! });
      }
      for (let index = 1; index < subSegments.length; index += 1) {
        const sub = subSegments[index]!;
        segments.push(sub.length > 0 ? [{ type: "span", classes: token.classes, children: sub }] : []);
      }
    }
  }
  return segments;
}

export function splitTokensByLine(tokens: readonly HighlightToken[]): HighlightToken[][] {
  return splitTokensBySeparator(tokens, "\n");
}
