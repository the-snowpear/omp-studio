/**
 * Minimal models.yml codec for the Host adapter.
 *
 * Supports the subset OMP actually writes: mappings, sequences, scalars,
 * quoted strings, and comments. Anchors/tags/multiline blocks fail closed
 * so we never silently mis-parse a user file.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

export class ModelsYmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsYmlError";
  }
}

interface Line {
  indent: number;
  text: string;
  raw: string;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line;
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim().length === 0) continue;
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const text = withoutComment.slice(indent);
    if (text.startsWith("|") || text.startsWith(">") || text.startsWith("&") || text.startsWith("*") || text.startsWith("!!")) {
      throw new ModelsYmlError("models.yml uses unsupported YAML features");
    }
    lines.push({ indent, text, raw });
  }
  return lines;
}

function parseScalar(raw: string): YamlScalar {
  if (raw === "~" || raw === "null" || raw === "Null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseBlock(lines: Line[], start: number, parentIndent: number): { value: YamlValue; next: number } {
  if (start >= lines.length || lines[start]!.indent < parentIndent) {
    return { value: null, next: start };
  }
  const first = lines[start]!;
  if (first.text.startsWith("- ")) {
    const items: YamlValue[] = [];
    let index = start;
    while (index < lines.length && lines[index]!.indent === first.indent && lines[index]!.text.startsWith("- ")) {
      const rest = lines[index]!.text.slice(2).trim();
      if (rest.length === 0) {
        const child = parseBlock(lines, index + 1, first.indent + 1);
        items.push(child.value);
        index = child.next;
        continue;
      }
      if (rest.includes(": ")) {
        const key = rest.slice(0, rest.indexOf(":"));
        const value = rest.slice(rest.indexOf(":") + 1).trim();
        const obj: { [key: string]: YamlValue } = { [key.trim()]: value.length === 0 ? null : parseScalar(value) };
        let cursor = index + 1;
        while (cursor < lines.length && lines[cursor]!.indent > first.indent) {
          const nested = parseBlock(lines, cursor, first.indent + 1);
          if (nested.value !== null && typeof nested.value === "object" && !Array.isArray(nested.value)) {
            Object.assign(obj, nested.value);
          }
          cursor = nested.next;
          break;
        }
        // continue consuming sibling keys of this list item
        while (cursor < lines.length && lines[cursor]!.indent > first.indent && !lines[cursor]!.text.startsWith("- ")) {
          const nested = parseBlock(lines, cursor, first.indent + 1);
          if (nested.value !== null && typeof nested.value === "object" && !Array.isArray(nested.value)) {
            Object.assign(obj, nested.value);
          }
          cursor = nested.next;
        }
        items.push(obj);
        index = cursor;
        continue;
      }
      items.push(parseScalar(rest));
      index += 1;
    }
    return { value: items, next: index };
  }

  const obj: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length && lines[index]!.indent === first.indent && lines[index]!.text.includes(":")) {
    const line = lines[index]!;
    const colon = line.text.indexOf(":");
    const key = line.text.slice(0, colon).trim();
    const inline = line.text.slice(colon + 1).trim();
    if (inline.length > 0) {
      obj[key] = parseScalar(inline);
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    // Common YAML: a sequence can sit at the same indent as its key
    // (`models:\n- id: foo`). OMP's models.yml uses this form.
    const sameIndentSequence = Boolean(next && next.indent === line.indent && next.text.startsWith("- "));
    const child = parseBlock(lines, index + 1, sameIndentSequence ? line.indent : line.indent + 1);
    obj[key] = child.value;
    index = child.next;
  }
  return { value: obj, next: index };
}

export function parseModelsYml(source: string): { [key: string]: YamlValue } {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const parsed = parseBlock(lines, 0, 0).value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsYmlError("models.yml root must be a mapping");
  }
  return parsed;
}

function quoteIfNeeded(value: string): string {
  if (value.length === 0) return '""';
  if (/[:#\n]|^\s|\s$/.test(value) || value === "true" || value === "false" || value === "null") {
    return JSON.stringify(value);
  }
  return value;
}

function emit(value: YamlValue, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (value === null) return [`${pad}null`];
  if (typeof value === "boolean" || typeof value === "number") return [`${pad}${value}`];
  if (typeof value === "string") return [`${pad}${quoteIfNeeded(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const firstKey = keys[0]!;
        const firstVal = item[firstKey];
        const firstInline = firstVal === null || typeof firstVal === "string" || typeof firstVal === "number" || typeof firstVal === "boolean";
        if (firstInline) {
          lines.push(`${pad}- ${firstKey}: ${emit(firstVal ?? null, 0)[0]}`);
        } else {
          lines.push(`${pad}- ${firstKey}:`);
          lines.push(...emit(firstVal ?? null, indent + 2));
        }
        for (const key of keys.slice(1)) {
          const child = item[key];
          if (child !== null && typeof child === "object") {
            lines.push(`${pad}  ${key}:`);
            lines.push(...emit(child, indent + 2));
          } else {
            lines.push(`${pad}  ${key}: ${emit(child ?? null, 0)[0]}`);
          }
        }
      } else {
        lines.push(`${pad}- ${emit(item, 0)[0]}`);
      }
    }
    return lines;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return [`${pad}{}`];
  const lines: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child !== null && typeof child === "object") {
      lines.push(`${pad}${key}:`);
      lines.push(...emit(child, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${emit(child ?? null, 0)[0]}`);
    }
  }
  return lines;
}

export function serializeModelsYml(root: { [key: string]: YamlValue }): string {
  return `${emit(root, 0).join("\n")}\n`;
}

export function redactModelsYmlText(source: string): string {
  return source.replace(/^(\s*apiKey:\s+)(?!"?\*)(?!!).+$/gm, '$1"********"');
}

export function isRedactedApiKey(value: unknown): boolean {
  return typeof value === "string" && /^\*{6,}$/.test(value);
}

/** Copy previous apiKey when the new document still has the redaction placeholder. */
export function restoreRedactedApiKeys(
  next: { [key: string]: YamlValue },
  previous: { [key: string]: YamlValue },
): void {
  const nextProviders = yamlMap(next.providers);
  const prevProviders = yamlMap(previous.providers);
  if (!nextProviders || !prevProviders) return;
  for (const [id, node] of Object.entries(nextProviders)) {
    const current = yamlMap(node);
    const prior = yamlMap(prevProviders[id]);
    if (!current || !prior) continue;
    if (isRedactedApiKey(current.apiKey) && typeof prior.apiKey === "string") {
      current.apiKey = prior.apiKey;
    }
  }
}

function yamlMap(value: YamlValue | undefined): { [key: string]: YamlValue } | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}
