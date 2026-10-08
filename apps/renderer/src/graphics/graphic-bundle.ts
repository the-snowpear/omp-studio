import { unzipSync } from "fflate";
import {
  graphicFormat,
  GRAPHIC_MAX_BYTES,
  type GraphicBundle,
} from "./graphic-types";
export function normalizeGraphicPath(value: string): string {
  const clean = decodeURIComponent(value).replaceAll("\\", "/");
  if (clean.includes("\0") || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(clean))
    throw new Error("Remote and absolute resources are not loaded");
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Resource escapes the graphic bundle");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}
export function openGraphicBundle(
  name: string,
  buffer: ArrayBuffer,
): GraphicBundle {
  if (buffer.byteLength > GRAPHIC_MAX_BYTES)
    throw new Error("Graphic exceeds the 32 MiB input limit");
  let resources: Record<string, Uint8Array> = Object.create(null);
  let file = name;
  let bytes: Uint8Array = new Uint8Array(buffer);
  if (name.toLowerCase().endsWith(".zip")) {
    let total = 0,
      count = 0;
    resources = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name.endsWith("/")) return false;
        if (
          ++count > 64 ||
          entry.originalSize > GRAPHIC_MAX_BYTES ||
          (total += entry.originalSize) > GRAPHIC_MAX_BYTES
        )
          throw new Error(
            "Graphic archive exceeds its 64 file / 32 MiB resource limit",
          );
        if (normalizeGraphicPath(entry.name) !== entry.name)
          throw new Error("Unsafe resource path in graphic archive");
        return true;
      },
    });
    const candidates = Object.keys(resources).filter(
      (file) => graphicFormat(file) !== undefined,
    );
    const basename = name.replace(/\.zip$/iu, "");
    const preferred = candidates.filter(
      (file) =>
        file === basename || /^(?:scene|model|index)\.[^/]+$/iu.test(file),
    );
    file =
      preferred.length === 1
        ? preferred[0]!
        : candidates.length === 1
          ? candidates[0]!
          : "";
    if (!file)
      throw new Error(
        "The archive must contain one main graphic, or a root scene/model/index file",
      );
    bytes = resources[file]!;
  } else {
    const safe = name.replaceAll("\\", "/").split("/").at(-1)!;
    resources[safe] = bytes;
    file = safe;
  }
  const format = graphicFormat(file);
  if (!format) throw new Error("Unsupported graphic format");
  return { name: file, format, bytes, resources };
}
/** Resource guard only; the actual grammar is parsed by the format library. */
export function checkTextGraphic(text: string, maximum: number): void {
  if (text.length > maximum)
    throw new Error("Graphic source exceeds its parsing limit");
  let depth = 0;
  let quote = false;
  let comment = false;
  let escaped = false;
  for (const character of text) {
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') quote = false;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (++depth > 96) throw new Error("Graphic nesting exceeds 96 levels");
    } else if (character === "}" || character === "]") depth--;
  }
  if (depth !== 0 || quote) throw new Error("Graphic source is incomplete");
}
