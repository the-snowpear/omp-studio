import { common, createLowlight } from "lowlight";
import { commandLanguages } from "./commandLanguages";
import { TOKEN_MAX_DEPTH, TOKEN_MAX_NODES, validTokenClass, validateTokens, type HighlightToken } from "./protocol";

const lowlight = createLowlight(common);
lowlight.register(commandLanguages);
lowlight.registerAlias({ powershell: ["pwsh", "ps1"] });
/** This module is imported only by the Worker and equivalence tests. */
export function computeHighlight(language: string, code: string): HighlightToken[] {
  if (!lowlight.registered(language)) throw new Error("unknown-language");
  const tree = lowlight.highlight(language, code);
  let count = 0;
  const convert = (nodes: typeof tree.children, depth: number): HighlightToken[] => {
    if (depth > TOKEN_MAX_DEPTH) throw new Error("token-depth");
    return nodes.map((node): HighlightToken => {
      if (++count > TOKEN_MAX_NODES) throw new Error("token-count");
      if (node.type === "text") return { type: "text", value: node.value };
      if (node.type !== "element" || node.tagName !== "span") throw new Error("token-kind");
      const classes = node.properties.className;
      if (!Array.isArray(classes) || !classes.every(validTokenClass)) throw new Error("token-class");
      return { type: "span", classes, children: convert(node.children, depth + 1) };
    });
  };
  const tokens = convert(tree.children, 0);
  if (!validateTokens(tokens, code)) throw new Error("token-budget");
  return tokens;
}

/** Highlights isolated snippets independently so unclosed comments/strings never bleed across snippets. */
export function computeHighlightBatch(language: string, code: string): HighlightToken[] {
  if (!lowlight.registered(language)) throw new Error("unknown-language");
  const parts = code.split("\u0000");
  let count = 0;
  const convert = (nodes: ReturnType<typeof lowlight.highlight>["children"], depth: number): HighlightToken[] => {
    if (depth > TOKEN_MAX_DEPTH) throw new Error("token-depth");
    return nodes.map((node): HighlightToken => {
      if (++count > TOKEN_MAX_NODES) throw new Error("token-count");
      if (node.type === "text") return { type: "text", value: node.value };
      if (node.type !== "element" || node.tagName !== "span") throw new Error("token-kind");
      const classes = node.properties.className;
      if (!Array.isArray(classes) || !classes.every(validTokenClass)) throw new Error("token-class");
      return { type: "span", classes, children: convert(node.children, depth + 1) };
    });
  };
  const out: HighlightToken[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      if (++count > TOKEN_MAX_NODES) throw new Error("token-count");
      out.push({ type: "text", value: "\u0000" });
    }
    const part = parts[index]!;
    if (!part) continue;
    const tree = lowlight.highlight(language, part);
    out.push(...convert(tree.children, 0));
  }
  if (!validateTokens(out, code)) throw new Error("token-budget");
  return out;
}
