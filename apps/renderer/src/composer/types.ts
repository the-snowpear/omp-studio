/**
 * Composer inline chips: files, folders, images, skills, agents, and session modes.
 * File/skill/agent serialize to Runtime tokens; mode capsules are omitted from prompt text.
 */

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Wire shape for `core.prompt` / `core.steer` / `core.followUp` images. */
export type PromptImage = {
  readonly type: "image";
  readonly mimeType: ImageMimeType;
  readonly data: string;
};

export type ComposerChipKind = "file" | "dir" | "image" | "skill" | "agent" | "mode";

export type ComposerChip = {
  readonly id: string;
  readonly kind: ComposerChipKind;
  /** Short label shown in the capsule (stem may fade; extension stays). */
  readonly label: string;
  /** Workspace-relative path (forward slashes). Dirs have no trailing slash. */
  readonly path?: string;
  /** Skill or agent definition name. */
  readonly name?: string;
  /** Clipboard / dropped image bytes. Workspace image files may omit this. */
  readonly image?: PromptImage;
};

export type ComposerTextNode = { readonly type: "text"; readonly value: string };
export type ComposerChipNode = { readonly type: "chip"; readonly chip: ComposerChip };
export type ComposerNode = ComposerTextNode | ComposerChipNode;

export type ComposerDoc = {
  readonly nodes: ReadonlyArray<ComposerNode>;
};

export type ComposerSnapshot = {
  readonly text: string;
  readonly images: ReadonlyArray<PromptImage>;
  readonly doc: ComposerDoc;
};

export type MentionCandidate = {
  readonly kind: "skill" | "agent" | "file" | "dir";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly path?: string;
  readonly name?: string;
};

export function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function emptyDoc(): ComposerDoc {
  return { nodes: [] };
}

export function emptySnapshot(): ComposerSnapshot {
  return { text: "", images: [], doc: emptyDoc() };
}

export function newChipId(): string {
  return `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function fileLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Last real extension vs the title stem. `.gitignore` / `Dockerfile` stay
 * whole; `foo.d.ts` keeps `.ts` and treats `foo.d` as the stem.
 */
export function splitChipLabel(label: string): { readonly stem: string; readonly ext: string } {
  const match = /^(.+)(\.[A-Za-z0-9]{1,8})$/u.exec(label);
  if (match?.[1] === undefined || match[2] === undefined) return { stem: label, ext: "" };
  return { stem: match[1], ext: match[2] };
}
