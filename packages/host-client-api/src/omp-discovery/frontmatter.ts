/**
 * YAML frontmatter parser — portable from omp-patch/vendor/oh-my-pi/packages/utils/src/frontmatter.ts
 * Supports arrays, multi-line values, kebab→camel normalization, and repair mode.
 */

import { parse as parseYaml } from "yaml";

/**
 * Strip HTML comments from content.
 */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Convert kebab-case to camelCase (e.g. "thinking-level" -> "thinkingLevel").
 */
function kebabToCamel(key: string): string {
  if (!key.includes("-")) return key;
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively normalize object keys from kebab-case to camelCase.
 */
export function normalizeFrontmatterKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    let changed = false;
    const out: unknown[] = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      const nv = normalizeFrontmatterKeys(v);
      out[i] = nv;
      if (nv !== v) changed = true;
    }
    return (changed ? out : obj) as T;
  }
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const nk = key.includes("-") ? kebabToCamel(key) : key;
    const nv = normalizeFrontmatterKeys(value);
    result[nk] = nv;
    if (nk !== key || nv !== value) changed = true;
  }
  return (changed ? result : obj) as T;
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

/**
 * Quote ambiguous plain scalars that contain ": " (which YAML interprets as nested keys).
 */
function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
  let changed = false;
  const lines = metadata.split("\n").map((line) => {
    const match = line.match(PLAIN_SCALAR_KEY_VALUE);
    if (!match) return line;
    const [, prefix, rawValue, suffix] = match;
    const value = rawValue!.trimEnd();
    if (!value.includes(": ")) return line;
    if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0]!)) return line;
    changed = true;
    return `${prefix}${JSON.stringify(value)}${suffix}`;
  });
  return changed ? lines.join("\n") : undefined;
}

/**
 * Parse YAML metadata into a record.
 */
function parseYamlRecord(metadata: string, repairTabs: boolean): Record<string, unknown> | null {
  const loaded = parseYaml(repairTabs ? metadata.replaceAll("\t", "  ") : metadata);
  if (loaded === null || loaded === undefined) return null;
  if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
  return loaded as Record<string, unknown>;
}

export interface FrontmatterOptions {
  /** Source of the content (for error messages) */
  source?: unknown;
  /** Fallback frontmatter values */
  fallback?: Record<string, unknown>;
  /** Normalize the content (CRLF → LF, strip HTML comments) */
  normalize?: boolean;
  /** Error handling level */
  level?: "off" | "warn" | "fatal";
  /**
   * Attempt lenient recovery: quote ambiguous plain scalars, replace tabs with spaces,
   * strip leading HTML comments. Default true.
   */
  repair?: boolean;
  /**
   * Preserve frontmatter keys verbatim instead of normalizing kebab-case to camelCase.
   * Default false.
   */
  rawKeys?: boolean;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, body } where body has frontmatter stripped.
 */
export function parseFrontmatter(
  content: string,
  options?: FrontmatterOptions
): { frontmatter: Record<string, unknown>; body: string } {
  const {
    source,
    fallback,
    normalize = true,
    level = "warn",
    repair = true,
    rawKeys = false,
  } = options ?? {};

  const finalizeKeys = (fm: Record<string, unknown>): Record<string, unknown> =>
    rawKeys ? fm : normalizeFrontmatterKeys(fm);

  const frontmatter: Record<string, unknown> = { ...fallback };

  const newlineNormalized = normalize ? content.replace(/\r\n?/g, "\n") : content;
  const normalized = normalize && repair ? stripHtmlComments(newlineNormalized) : newlineNormalized;

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }

  const metadata = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  try {
    const loaded = parseYamlRecord(metadata, repair);
    return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
  } catch (error) {
    const quotedMetadata = repair ? quoteAmbiguousPlainScalars(metadata) : undefined;
    if (quotedMetadata) {
      try {
        const loaded = parseYamlRecord(quotedMetadata, true);
        return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
      } catch {
        // Fall through to simple key/value fallback
      }
    }

    if (level === "warn") {
      console.warn(`Failed to parse YAML frontmatter (${source ?? "inline"}):`, error);
    }
    if (level === "fatal") {
      throw new Error(
        `Failed to parse YAML frontmatter (${source ?? "inline"}): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Simple key: value fallback (per-line parsing)
    for (const line of metadata.split("\n")) {
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (!match) continue;
      const raw = match[2]!.trim();
      let value: unknown = raw;
      if (raw.length > 0) {
        try {
          const parsed = parseYaml(raw);
          if (parsed !== null && typeof parsed !== "object") value = parsed;
          else if (Array.isArray(parsed)) value = parsed;
        } catch {
          // keep the raw string
        }
      }
      frontmatter[match[1]!] = value;
    }

    return { frontmatter: finalizeKeys(frontmatter), body };
  }
}
