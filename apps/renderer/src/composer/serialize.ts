import type { ComposerChip, ComposerDoc, ComposerSnapshot, PromptImage } from "./types";
import { emptyDoc, emptySnapshot } from "./types";

const NEEDS_QUOTES = /[\s@'"\\]/u;

/** Quote a mention path so omp `FILE_MENTION_REGEX` keeps it as one token. */
export function quoteMentionPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!NEEDS_QUOTES.test(normalized)) return normalized;
  if (!normalized.includes('"')) return `"${normalized}"`;
  if (!normalized.includes("'")) return `'${normalized}'`;
  return `"${normalized.replaceAll('"', "")}"`;
}

export function serializeChip(chip: ComposerChip, imageIndex?: number): string {
  switch (chip.kind) {
    case "file":
      return `@${quoteMentionPath(chip.path ?? chip.label)}`;
    case "dir": {
      const raw = chip.path ?? chip.label;
      const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
      return `@${quoteMentionPath(withSlash)}`;
    }
    case "skill":
      return `/skill:${chip.name ?? chip.label}`;
    case "agent":
      return `@${chip.name ?? chip.label}`;
    case "image":
      if (chip.image) return `[图${imageIndex ?? 1}]`;
      return `@${quoteMentionPath(chip.path ?? chip.label)}`;
  }
}

export function serializeDoc(doc: ComposerDoc): { text: string; images: PromptImage[] } {
  const images: PromptImage[] = [];
  let text = "";
  for (const node of doc.nodes) {
    if (node.type === "text") {
      text += node.value;
      continue;
    }
    if (node.chip.kind === "image" && node.chip.image) {
      images.push(node.chip.image);
      text += serializeChip(node.chip, images.length);
      continue;
    }
    text += serializeChip(node.chip);
  }
  return { text, images };
}

export function snapshotFromDoc(doc: ComposerDoc): ComposerSnapshot {
  const { text, images } = serializeDoc(doc);
  return { text, images, doc };
}

export function snapshotFromText(text: string): ComposerSnapshot {
  if (text.length === 0) return emptySnapshot();
  return { text, images: [], doc: { nodes: [{ type: "text", value: text }] } };
}

export function docIsEmpty(doc: ComposerDoc): boolean {
  if (doc.nodes.length === 0) return true;
  return doc.nodes.every((node) => node.type === "text" && node.value.trim().length === 0);
}

export function snapshotIsEmpty(snapshot: ComposerSnapshot): boolean {
  return snapshot.text.trim().length === 0 && snapshot.images.length === 0;
}

/** Join adjacent text nodes; drop empty text. Used after DOM reads. */
export function normalizeDoc(doc: ComposerDoc): ComposerDoc {
  const nodes: Array<ComposerDoc["nodes"][number]> = [];
  for (const node of doc.nodes) {
    if (node.type === "chip") {
      nodes.push(node);
      continue;
    }
    if (node.value.length === 0) continue;
    const last = nodes[nodes.length - 1];
    if (last?.type === "text") {
      nodes[nodes.length - 1] = { type: "text", value: `${last.value}${node.value}` };
    } else {
      nodes.push(node);
    }
  }
  return nodes.length === 0 ? emptyDoc() : { nodes };
}
