import type { ComposerChip, ComposerChipKind, PromptImage } from "./types";
import { isImageMimeType } from "./types";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function chipIconName(kind: ComposerChipKind): string {
  switch (kind) {
    case "dir":
      return "folder";
    case "image":
      return "image";
    case "skill":
      return "sparkles";
    case "agent":
      return "bot";
    default:
      return "file";
  }
}

export function isImageFile(file: File): boolean {
  if (isImageMimeType(file.type)) return true;
  return /\.(png|jpe?g|gif|webp)$/iu.test(file.name);
}

function mimeFromFile(file: File): PromptImage["mimeType"] | null {
  if (isImageMimeType(file.type)) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

export async function fileToPromptImage(file: File): Promise<PromptImage | null> {
  const mimeType = mimeFromFile(file);
  if (mimeType === null) return null;
  if (file.size > MAX_IMAGE_BYTES) return null;
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { type: "image", mimeType, data: btoa(binary) };
}

export function imagePreviewUrl(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function chipPayload(chip: ComposerChip): string {
  return JSON.stringify({
    id: chip.id,
    kind: chip.kind,
    label: chip.label,
    ...(chip.path === undefined ? {} : { path: chip.path }),
    ...(chip.name === undefined ? {} : { name: chip.name }),
  });
}

export function parseChipPayload(value: string): Omit<ComposerChip, "image"> | null {
  try {
    const parsed = JSON.parse(value) as Partial<ComposerChip>;
    if (typeof parsed.id !== "string" || typeof parsed.kind !== "string" || typeof parsed.label !== "string") {
      return null;
    }
    if (parsed.kind !== "file" && parsed.kind !== "dir" && parsed.kind !== "image" && parsed.kind !== "skill" && parsed.kind !== "agent") {
      return null;
    }
    return {
      id: parsed.id,
      kind: parsed.kind,
      label: parsed.label,
      ...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    };
  } catch {
    return null;
  }
}
