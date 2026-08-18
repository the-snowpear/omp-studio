import type { ComposerChip, ComposerDoc, ComposerSnapshot, PromptImage } from "./types";
import { emptyDoc, emptySnapshot, fileLabel, newChipId } from "./types";

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
    case "mode":
      return "";
    case "image":
      // Disk-backed images travel as @path so OMP `extractFileMentions` auto-reads
      // them. Clipboard captures have no path and become [图N] plus wire bytes.
      if (chip.path) return `@${quoteMentionPath(chip.path)}`;
      if (chip.image) return `[图${imageIndex ?? 1}]`;
      return `@${quoteMentionPath(chip.label)}`;
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
    if (node.chip.kind === "image" && node.chip.image && !node.chip.path) {
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

/** Restore/branch fill-back: text plus optional image capsules. Overwrites the draft. */
export function snapshotFromTextAndImages(
  text: string,
  images?: ReadonlyArray<PromptImage>,
): ComposerSnapshot {
  if (images === undefined || images.length === 0) return snapshotFromText(text);
  const nodes: ComposerDoc["nodes"][number][] = [];
  if (text.length > 0) nodes.push({ type: "text", value: text });
  for (const image of images) {
    nodes.push({
      type: "chip",
      chip: { id: newChipId(), kind: "image", label: "图", image },
    });
  }
  return snapshotFromDoc({ nodes });
}

export function docIsEmpty(doc: ComposerDoc): boolean {
  if (doc.nodes.length === 0) return true;
  return doc.nodes.every((node) => node.type === "text" && node.value.trim().length === 0);
}

export function snapshotIsEmpty(snapshot: ComposerSnapshot): boolean {
  if (snapshot.doc.nodes.some((node) => node.type === "chip" && node.chip.kind === "mode")) return false;
  return snapshot.text.trim().length === 0 && snapshot.images.length === 0;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/iu;
const MENTION_BOUNDARY = /[\s([{<"'`]/u;
const IMAGE_TOKEN_RE = /\[图(\d+)\]/gu;
const SKILL_TOKEN_RE = /\/skill:([^\s/]+)(?=\s|$)/gu;
const MENTION_TOKEN_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/gu;

function isMentionBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return MENTION_BOUNDARY.test(text[index - 1] ?? "");
}

function isSkillBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /\s/u.test(text[index - 1] ?? "");
}

function firstMatch(
  source: string,
  flags: string,
  text: string,
  from: number,
  accept?: (match: RegExpExecArray) => boolean,
): RegExpExecArray | null {
  const matcher = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
  matcher.lastIndex = from;
  let match: RegExpExecArray | null = matcher.exec(text);
  while (match !== null) {
    if (accept === undefined || accept(match)) return match;
    match = matcher.exec(text);
  }
  return null;
}

function mentionChipFromPath(raw: string): ComposerChip {
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.endsWith("/")) {
    const path = normalized.replace(/\/+$/u, "");
    return { id: newChipId(), kind: "dir", label: fileLabel(path), path };
  }
  if (IMAGE_EXT.test(normalized)) {
    return { id: newChipId(), kind: "image", label: fileLabel(normalized), path: normalized };
  }
  if (normalized.includes("/") || normalized.includes(".")) {
    return { id: newChipId(), kind: "file", label: fileLabel(normalized), path: normalized };
  }
  return { id: newChipId(), kind: "agent", label: normalized, name: normalized };
}

function nextSerializedToken(
  text: string,
  from: number,
): { readonly start: number; readonly end: number; readonly chip: ComposerChip } | null {
  let best: { start: number; end: number; chip: ComposerChip } | null = null;
  const consider = (start: number, end: number, chip: ComposerChip): void => {
    if (best === null || start < best.start) best = { start, end, chip };
  };
  const image = firstMatch(IMAGE_TOKEN_RE.source, "gu", text, from);
  if (image?.index !== undefined && image[1] !== undefined) {
    consider(image.index, image.index + image[0].length, {
      id: newChipId(),
      kind: "image",
      label: `图${image[1]}`,
    });
  }
  const skill = firstMatch(SKILL_TOKEN_RE.source, "gu", text, from, (match) => isSkillBoundary(text, match.index));
  if (skill?.index !== undefined && skill[1] !== undefined) {
    consider(skill.index, skill.index + skill[0].length, {
      id: newChipId(),
      kind: "skill",
      label: skill[1],
      name: skill[1],
    });
  }
  const mention = firstMatch(MENTION_TOKEN_RE.source, "gu", text, from, (match) => isMentionBoundary(text, match.index));
  const raw = mention?.[1] ?? mention?.[2] ?? mention?.[3];
  if (mention?.index !== undefined && raw !== undefined && raw.length > 0) {
    consider(mention.index, mention.index + mention[0].length, mentionChipFromPath(raw));
  }
  return best;
}

function attachClipboardImages(doc: ComposerDoc, images?: ReadonlyArray<PromptImage>): ComposerDoc {
  if (images === undefined || images.length === 0) return doc;
  return {
    nodes: doc.nodes.map((node) => {
      if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image !== undefined) return node;
      const numbered = /^图(\d+)$/u.exec(node.chip.label);
      if (numbered?.[1] === undefined) return node;
      const image = images[Number(numbered[1]) - 1];
      if (image === undefined) return node;
      return { type: "chip", chip: { ...node.chip, image } };
    }),
  };
}

export function stripModeChips(doc: ComposerDoc): ComposerDoc {
  return normalizeDoc({
    nodes: doc.nodes.filter((node) => node.type === "text" || node.chip.kind !== "mode"),
  });
}

export function docHasDisplayChips(doc: ComposerDoc): boolean {
  return doc.nodes.some((node) => node.type === "chip");
}

/** Inverse of `serializeDoc` for user-bubble display after send / reload. */
export function displayDocFromSerializedText(
  text: string,
  images?: ReadonlyArray<PromptImage>,
): ComposerDoc {
  const nodes: ComposerDoc["nodes"][number][] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const token = nextSerializedToken(text, cursor);
    if (token === null) {
      nodes.push({ type: "text", value: text.slice(cursor) });
      break;
    }
    if (token.start > cursor) nodes.push({ type: "text", value: text.slice(cursor, token.start) });
    nodes.push({ type: "chip", chip: token.chip });
    cursor = token.end;
  }
  return attachClipboardImages(normalizeDoc({ nodes }), images);
}

/**
 * Prefer the composer doc (minus mode capsules) when it still has chips;
 * otherwise rebuild capsules from the serialized transcript text.
 */
export function displayDocForUserMessage(
  text: string,
  doc?: ComposerDoc,
  images?: ReadonlyArray<PromptImage>,
): ComposerDoc {
  if (doc !== undefined) {
    const stripped = attachClipboardImages(stripModeChips(doc), images);
    if (docHasDisplayChips(stripped)) return stripped;
  }
  return displayDocFromSerializedText(text, images);
}

/** Clipboard-style copy token for one capsule. */
export function chipCopyToken(chip: ComposerChip): string {
  if (chip.kind === "image" && chip.path === undefined) {
    const numbered = /^图(\d+)$/u.exec(chip.label);
    return `[图${numbered?.[1] ?? "1"}]`;
  }
  return serializeChip(chip);
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
