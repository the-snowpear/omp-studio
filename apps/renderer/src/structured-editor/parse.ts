import { isMap, parseDocument, stringify as stringifyYaml, type Document } from "yaml";

export type StructuredLanguage = "json" | "yaml";

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

export type FormatResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export interface StructuredDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
  source: "json" | "yaml";
}

export function parseStructured(
  language: StructuredLanguage,
  text: string,
  allowEmpty = true,
): ParseResult {
  if (!text.trim()) {
    if (allowEmpty) return { ok: true, value: undefined };
    return { ok: false, message: language === "json" ? "JSON 为空" : "YAML 为空" };
  }
  if (language === "json") {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, message: jsonErrorMessage(error) };
    }
  }
  const loaded = loadYaml(text);
  if (!loaded.ok) return loaded;
  const first = loaded.doc.errors[0];
  if (first) return { ok: false, message: stripYamlPrefix(first.message) };
  try {
    return { ok: true, value: loaded.doc.toJS() };
  } catch (error) {
    return { ok: false, message: yamlErrorMessage(error) };
  }
}

/** JSON first, then YAML — so pasted schema in either encoding still saves. */
export function parseJsonOrYaml(text: string): ParseResult {
  if (!text.trim()) return { ok: true, value: undefined };
  const json = parseStructured("json", text, false);
  if (json.ok) return json;
  return parseStructured("yaml", text, false);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dumpYaml(value: unknown): string {
  return stringifyYaml(value, { indent: 2, lineWidth: 0 });
}

/**
 * Show one map entry as its own YAML document, e.g. `providers.openai` →
 * `openai:\n  api: ...`. Missing paths synthesize `{ key: emptyValue }`.
 */
export function extractYamlMapEntry(
  fullText: string,
  path: ReadonlyArray<string>,
  emptyValue: unknown = {},
): string {
  const last = path[path.length - 1];
  if (!last) return "";
  const parsed = parseStructured("yaml", fullText, true);
  let node: unknown = parsed.ok ? parsed.value : undefined;
  for (const key of path) {
    if (!isPlainRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) {
      return dumpYaml({ [last]: emptyValue });
    }
    node = node[key];
  }
  return dumpYaml({ [last]: node });
}

function unwrapYamlSlice(value: unknown, expectedKey: string): unknown {
  if (!isPlainRecord(value)) return value;
  if (Object.prototype.hasOwnProperty.call(value, expectedKey)) return value[expectedKey];
  const keys = Object.keys(value);
  if (keys.length === 1) return value[keys[0]!];
  return value;
}

/**
 * Replace `path` in `fullText` with the value from a one-entry (or body-only)
 * YAML slice. Other keys and comments on untouched nodes are kept via the YAML
 * Document model.
 */
export function mergeYamlMapEntry(
  fullText: string,
  path: ReadonlyArray<string>,
  sliceText: string,
): { ok: true; text: string } | { ok: false; message: string } {
  if (path.length === 0) return { ok: false, message: "YAML 路径为空" };
  const slice = parseStructured("yaml", sliceText, false);
  if (!slice.ok) return slice;
  const expectedKey = path[path.length - 1]!;
  const incoming = unwrapYamlSlice(slice.value, expectedKey);
  try {
    const doc = parseDocument(fullText.trim() ? fullText : "{}\n", { prettyErrors: true, uniqueKeys: true });
    const first = doc.errors[0];
    if (first) return { ok: false, message: stripYamlPrefix(first.message) };
    const parentPath = path.slice(0, -1);
    if (parentPath.length > 0) {
      const parent = doc.getIn(parentPath, true);
      if (!isMap(parent)) doc.setIn(parentPath, doc.createNode({}));
    }
    doc.setIn(path, incoming);
    return { ok: true, text: String(doc) };
  } catch (error) {
    return { ok: false, message: yamlErrorMessage(error) };
  }
}

export function formatStructured(language: StructuredLanguage, text: string): FormatResult {
  if (!text.trim()) return { ok: true, text: "" };
  if (language === "json") {
    try {
      return { ok: true, text: `${JSON.stringify(JSON.parse(text) as unknown, null, 2)}\n` };
    } catch (error) {
      return { ok: false, message: jsonErrorMessage(error) };
    }
  }
  const loaded = loadYaml(text);
  if (!loaded.ok) return loaded;
  const first = loaded.doc.errors[0];
  if (first) return { ok: false, message: stripYamlPrefix(first.message) };
  try {
    return { ok: true, text: loaded.doc.toString({ indent: 2, lineWidth: 0 }) };
  } catch (error) {
    return { ok: false, message: yamlErrorMessage(error) };
  }
}

export function convertStructured(
  from: StructuredLanguage,
  to: StructuredLanguage,
  text: string,
): FormatResult {
  if (from === to) return { ok: true, text };
  if (!text.trim()) return { ok: true, text: "" };
  const parsed = parseStructured(from, text, false);
  if (!parsed.ok) return parsed;
  return formatValue(to, parsed.value);
}

export function yamlDiagnostics(text: string, allowEmpty: boolean): StructuredDiagnostic[] {
  if (allowEmpty && !text.trim()) return [];
  const loaded = loadYaml(text);
  if (!loaded.ok) {
    return [{ from: 0, to: Math.min(1, text.length), severity: "error", message: loaded.message, source: "yaml" }];
  }
  const len = text.length;
  const diagnostics: StructuredDiagnostic[] = [...loaded.doc.errors, ...loaded.doc.warnings].map((err) => {
    const from = clamp(err.pos[0], 0, len);
    const to = clamp(Math.max(err.pos[1], from), 0, len);
    return {
      from,
      to: to === from ? Math.min(from + 1, len) : to,
      severity: err.name === "YAMLWarning" ? "warning" : "error",
      message: stripYamlPrefix(err.message),
      source: "yaml",
    };
  });
  if (loaded.doc.errors.length === 0) {
    try {
      loaded.doc.toJS();
    } catch (error) {
      diagnostics.push(aliasDiagnostic(text, error));
    }
  }
  return diagnostics;
}

function loadYaml(text: string): { ok: true; doc: Document } | { ok: false; message: string } {
  try {
    return { ok: true, doc: parseDocument(text, { prettyErrors: true, uniqueKeys: true }) };
  } catch (error) {
    return { ok: false, message: yamlErrorMessage(error) };
  }
}

function aliasDiagnostic(text: string, error: unknown): StructuredDiagnostic {
  const message = yamlErrorMessage(error);
  const name = /Unresolved alias \(the anchor must be set before the alias\): (.+)$/.exec(message)?.[1];
  const token = name ? `*${name}` : "";
  const from = token ? Math.max(0, text.indexOf(token)) : 0;
  const to = token && from >= 0 ? Math.min(text.length, from + token.length) : Math.min(1, text.length);
  return { from, to, severity: "error", message, source: "yaml" };
}

function formatValue(language: StructuredLanguage, value: unknown): FormatResult {
  if (value === undefined) return { ok: true, text: "" };
  try {
    if (language === "json") {
      return { ok: true, text: `${JSON.stringify(value, null, 2)}\n` };
    }
    return { ok: true, text: stringifyYaml(value, { indent: 2, lineWidth: 0 }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "格式化失败" };
  }
}

function jsonErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError && error.message) return error.message.replace(/^JSON\.parse:\s*/i, "");
  if (error instanceof Error && error.message) return error.message;
  return "JSON 无法解析";
}

function yamlErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return stripYamlPrefix(error.message);
  return "YAML 无法解析";
}

function stripYamlPrefix(message: string): string {
  return message.replace(/^YAML(?:ParseError|Warning):\s*/i, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
