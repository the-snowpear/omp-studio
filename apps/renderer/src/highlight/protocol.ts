export const HIGHLIGHT_MAX_UNITS = 96 * 1024;
export const TOKEN_MAX_NODES = 40_000;
export const TOKEN_MAX_DEPTH = 64;
export const TOKEN_MAX_BYTES = 2 * 1024 * 1024;
export type HighlightToken = { type: "text"; value: string } | { type: "span"; classes: string[]; children: HighlightToken[] };
export type HighlightRequest = { version: 1; jobId: number; language: string; code: string; batch?: true };
export type HighlightResponse = { version: 1; jobId: number; ok: true; tokens: HighlightToken[] }
  | { version: 1; jobId: number; ok: false; reason: string };

const scopes = "keyword built_in type literal number operator punctuation property regexp string char escape subst symbol variable template-variable link selector-tag selector-id selector-class selector-attr selector-pseudo meta meta-keyword meta-string title params bullet code emphasis strong formula section name attr attribute tag template-tag deletion addition comment quote doctag".split(" ");
const classes = new Set([...scopes.map((scope) => `hljs-${scope}`),
  "class_", "function_", "inherited__", "invoke__", "constant_", "language_", "escape_", "prompt_", "keyword_", "string_",
  // Embedded sublanguages emitted by the common grammar collection.
  ..."bash c cpp csharp css diff go graphql ini java javascript json kotlin less lua makefile markdown objectivec perl php php-template plaintext python python-repl r ruby rust scss shell sql swift typescript vbnet wasm xml yaml".split(" ")]);
export const validTokenClass = (value: unknown): value is string => typeof value === "string" && classes.has(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function utf8JsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Validate and measure UTF-8 JSON bytes in a single pass without `JSON.stringify`; returns -1 when invalid. */
export function measureTokens(value: unknown, code: string): number {
  let nodes = 0, units = 0, bytes = 0;
  const text: string[] = [];
  const visit = (input: unknown, depth: number): boolean => {
    if (!Array.isArray(input) || depth > TOKEN_MAX_DEPTH || input.length > TOKEN_MAX_NODES) return false;
    bytes += 2 + (input.length > 1 ? input.length - 1 : 0);
    if (bytes > TOKEN_MAX_BYTES) return false;
    for (const node of input) {
      if (++nodes > TOKEN_MAX_NODES || !record(node)) return false;
      if (node.type === "text") {
        if (Object.keys(node).length !== 2 || typeof node.value !== "string") return false;
        units += node.value.length;
        if (units > HIGHLIGHT_MAX_UNITS) return false;
        bytes += 24 + utf8JsonStringBytes(node.value);
        if (bytes > TOKEN_MAX_BYTES) return false;
        text.push(node.value);
      } else if (node.type === "span") {
        if (Object.keys(node).length !== 3 || !Array.isArray(node.classes) || node.classes.length > 6 || !node.classes.every(validTokenClass)) return false;
        let classBytes = 2 + (node.classes.length > 1 ? node.classes.length - 1 : 0);
        for (const cls of node.classes) classBytes += 2 + cls.length;
        bytes += 39 + classBytes;
        if (bytes > TOKEN_MAX_BYTES) return false;
        if (!visit(node.children, depth + 1)) return false;
      } else return false;
    }
    return true;
  };
  return visit(value, 0) && bytes <= TOKEN_MAX_BYTES && text.join("") === code ? bytes : -1;
}

/** Validate before building any React elements; the Worker cannot supply HTML. */
export function validateTokens(value: unknown, code: string): value is HighlightToken[] {
  return measureTokens(value, code) >= 0;
}

export function validHighlightRequest(value: unknown): value is HighlightRequest {
  if (!record(value)) return false;
  const keyCount = Object.keys(value).length;
  const validBatchFlag = keyCount === 4 ? !("batch" in value) : keyCount === 5 && value.batch === true;
  return validBatchFlag && value.version === 1
    && Number.isSafeInteger(value.jobId) && Number(value.jobId) > 0 && typeof value.language === "string"
    && /^[\w+#.-]{1,80}$/.test(value.language) && typeof value.code === "string" && value.code.length <= HIGHLIGHT_MAX_UNITS;
}
