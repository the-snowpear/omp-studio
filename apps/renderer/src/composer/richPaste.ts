import { isImageMimeType, type PromptImage } from "./types";

/**
 * Clipboard `text/html` → Markdown with ordered images.
 *
 * The HTML is parsed into an inert DOMParser document: scripts never run and
 * nothing is fetched. Only `data:` images become attachments; remote images
 * stay as Markdown links, and unresolvable sources (file:, cid:, blob:) may be
 * filled from image files on the same clipboard, in order. Code-editor copies
 * (spans and divs with no semantic markup) are left to the plain-text path.
 */
export type RichPastePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly image?: PromptImage; readonly slot?: number; readonly alt: string };

export interface RichPaste {
  readonly parts: readonly RichPastePart[];
  /** Number of image slots that need clipboard files. */
  readonly slots: number;
}

const SEMANTIC = "h1,h2,h3,h4,h5,h6,ul,ol,li,table,blockquote,pre,code,strong,b,em,i,a[href],img,hr,del,s,strike";
const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "META", "LINK", "TITLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "SVG", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "ADDRESS", "CENTER"]);
const BASE64_DATA_URI = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/iu;
/** Matches the attachment ceiling the Composer already enforces for pasted files. */
const MAX_IMAGE_BASE64 = 28 * 1024 * 1024;
const TOKEN = /\u0000(\d+)\u0000/gu;

function safeHref(href: string | null): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  return /^(?:https?:|mailto:)/iu.test(value) ? value : undefined;
}

function fence(code: string): string {
  let marks = "```";
  while (code.includes(marks)) marks += "`";
  return marks;
}

function inlineCode(text: string): string {
  const ticks = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function wrap(mark: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.slice(0, text.indexOf(trimmed));
  const tail = text.slice(text.indexOf(trimmed) + trimmed.length);
  return `${lead}${mark}${trimmed}${mark}${tail}`;
}

function languageOf(element: Element): string {
  const own = `${element.getAttribute("class") ?? ""} ${element.querySelector("code")?.getAttribute("class") ?? ""}`;
  return /(?:language|lang)-([\w#+.-]+)/iu.exec(own)?.[1] ?? "";
}

class Converter {
  readonly images: RichPastePart[] = [];
  slots = 0;

  image(element: Element): string {
    const src = element.getAttribute("src")?.trim() ?? "";
    const alt = (element.getAttribute("alt") ?? "").trim();
    const data = BASE64_DATA_URI.exec(src);
    const mimeType = data?.[1]?.toLowerCase();
    const base64 = data?.[2];
    if (mimeType && isImageMimeType(mimeType) && base64 && base64.length <= MAX_IMAGE_BASE64) {
      this.images.push({ kind: "image", image: { type: "image", mimeType, data: base64.replace(/\s+/gu, "") }, alt });
      return `\u0000${this.images.length - 1}\u0000`;
    }
    const remote = safeHref(src);
    if (remote) return `![${alt}](${remote})`;
    /* Local or opaque source: a clipboard image file may stand in for it. */
    this.images.push({ kind: "image", slot: this.slots++, alt });
    return `\u0000${this.images.length - 1}\u0000`;
  }

  inline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/gu, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as Element;
    const tag = element.tagName;
    if (SKIP.has(tag)) return "";
    const inner = () => Array.from(element.childNodes, child => this.inline(child)).join("");
    switch (tag) {
      case "BR": return "\n";
      case "IMG": return this.image(element);
      case "CODE": case "KBD": case "SAMP": return inlineCode(element.textContent ?? "");
      /* Google Docs wraps whole selections in <b style="font-weight:normal">. */
      case "STRONG": case "B": return /font-weight\s*:\s*(?:normal|[1-4]00)\b/iu.test(element.getAttribute("style") ?? "") ? inner() : wrap("**", inner());
      case "EM": case "I": return wrap("_", inner());
      case "DEL": case "S": case "STRIKE": return wrap("~~", inner());
      case "SPAN": {
        const style = element.getAttribute("style") ?? "";
        let text = inner();
        if (/font-weight\s*:\s*(?:bold|[6-9]00)\b/iu.test(style)) text = wrap("**", text);
        if (/font-style\s*:\s*italic\b/iu.test(style)) text = wrap("_", text);
        if (/text-decoration[^;]*line-through/iu.test(style)) text = wrap("~~", text);
        return text;
      }
      case "A": {
        const href = safeHref(element.getAttribute("href"));
        const text = inner().trim();
        return href && text && text !== href ? `[${text}](${href})` : href ?? text;
      }
      default:
        return this.isBlock(element) ? `\n${this.block(element)}\n` : inner();
    }
  }

  isBlock(element: Element): boolean {
    return BLOCK.has(element.tagName) || /^H[1-6]$/u.test(element.tagName) || ["UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "HR"].includes(element.tagName);
  }

  /** Children of a container: inline runs become paragraphs, blocks stay blocks. */
  blocks(element: Element): string {
    const out: string[] = [];
    let run = "";
    const flush = () => { const text = run.replace(/[ \t]+\n/gu, "\n").replace(/\n[ \t]+/gu, "\n").trim(); if (text) out.push(text); run = ""; };
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && this.isBlock(child as Element)) {
        flush();
        const text = this.block(child as Element);
        if (text.trim()) out.push(text);
      } else run += this.inline(child);
    }
    flush();
    return out.join("\n\n");
  }

  list(element: Element, depth: number): string {
    const ordered = element.tagName === "OL";
    let index = Number(element.getAttribute("start") ?? "1") || 1;
    const lines: string[] = [];
    for (const item of Array.from(element.children)) {
      if (item.tagName !== "LI") continue;
      const marker = ordered ? `${index++}. ` : "- ";
      const nested: string[] = [];
      let text = "";
      for (const child of Array.from(item.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && ["UL", "OL"].includes((child as Element).tagName)) nested.push(this.list(child as Element, depth + 1));
        else if (child.nodeType === Node.ELEMENT_NODE && this.isBlock(child as Element)) text += `${text ? "\n" : ""}${this.block(child as Element)}`;
        else text += this.inline(child);
      }
      const indent = "  ".repeat(depth);
      const body = text.trim().split("\n").map((line, at) => at === 0 ? line : `${indent}${" ".repeat(marker.length)}${line}`).join("\n");
      lines.push(`${indent}${marker}${body}`, ...nested);
    }
    return lines.join("\n");
  }

  table(element: HTMLTableElement): string {
    /* Owned rows/cells only: nested tables are converted once through their parent cell. */
    const rows = Array.from(element.rows, row => Array.from(row.cells, cell =>
      Array.from(cell.childNodes, child => this.inline(child)).join("").replace(/\s*\n\s*/gu, " ").replace(/\|/gu, "\\|").trim()));
    const width = Math.max(0, ...rows.map(row => row.length));
    if (!width) return "";
    const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill("")];
    const [head, ...body] = rows.map(pad);
    return [`| ${head!.join(" | ")} |`, `| ${Array<string>(width).fill("---").join(" | ")} |`, ...body.map(row => `| ${row.join(" | ")} |`)].join("\n");
  }

  block(element: Element): string {
    const tag = element.tagName;
    if (SKIP.has(tag)) return "";
    const heading = /^H([1-6])$/u.exec(tag);
    if (heading) return `${"#".repeat(Number(heading[1]))} ${Array.from(element.childNodes, child => this.inline(child)).join("").replace(/\s+/gu, " ").trim()}`;
    switch (tag) {
      case "HR": return "---";
      case "UL": case "OL": return this.list(element, 0);
      case "TABLE": return this.table(element as HTMLTableElement);
      case "PRE": {
        const code = (element.textContent ?? "").replace(/\n$/u, "");
        const marks = fence(code);
        return `${marks}${languageOf(element)}\n${code}\n${marks}`;
      }
      case "BLOCKQUOTE": return this.blocks(element).split("\n").map(line => line ? `> ${line}` : ">").join("\n");
      default: return this.blocks(element);
    }
  }
}

/** Returns null when the plain-text paste already says everything. */
export function richPasteFromHtml(html: string, plain: string): RichPaste | null {
  if (!html.trim() || typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const root = parsed.body;
  if (!root || !root.querySelector(SEMANTIC)) return null;
  const converter = new Converter();
  const markdown = converter.blocks(root).replace(/\n{3,}/gu, "\n\n").trim();
  if (!markdown) return null;
  const parts: RichPastePart[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(TOKEN)) {
    const text = markdown.slice(cursor, match.index);
    if (text) parts.push({ kind: "text", text });
    const image = converter.images[Number(match[1])];
    if (image) parts.push(image);
    cursor = match.index + match[0].length;
  }
  const tail = markdown.slice(cursor);
  if (tail) parts.push({ kind: "text", text: tail });
  const hasImage = parts.some(part => part.kind === "image");
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  /* One emphasis wrapping the whole selection (a copied bold label) is source styling, not structure. */
  let bare = normalize(markdown);
  for (let outer = /^(\*\*|_|~~)(.+)\1$/u.exec(bare); outer; outer = /^(\*\*|_|~~)(.+)\1$/u.exec(bare)) bare = outer[2]!.trim();
  /* Formatting that adds nothing over the plain text is not worth a different paste. */
  if (!hasImage && (normalize(markdown) === normalize(plain) || bare === normalize(plain))) return null;
  return { parts, slots: converter.slots };
}

/** True when the HTML carries readable text beyond image alt attributes. */
export function richPasteHasText(paste: RichPaste): boolean {
  return paste.parts.some(part => part.kind === "text" && part.text.trim().length > 0);
}
