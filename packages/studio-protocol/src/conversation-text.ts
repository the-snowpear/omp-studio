import { CONVERSATION_LIMITS } from "./contracts/conversation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** UTF-8 never spends more than 3 bytes per UTF-16 code unit (a surrogate pair
 * is 2 units → 4 bytes), so this bound needs no encoding pass. */
const MAX_UTF8_BYTES_PER_UNIT = 3;

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * codepoint. Used by live buffers so they match the persisted sanitizer cap.
 *
 * Streaming appends call this once per delta with the whole accumulated block
 * (up to `TEXT_BLOCK_MAX_BYTES`), so the common "still far below the cap" case
 * must not encode: the length bound decides it in O(1).
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length * MAX_UTF8_BYTES_PER_UNIT <= maxBytes) return { text, truncated: false };
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Keep the LAST `maxBytes` UTF-8 bytes of `text` without splitting a codepoint.
 *
 * Mirror image of `truncateUtf8`, and the direction matters: that one keeps the
 * head, so it walks the cut at `maxBytes` *backward* to a codepoint boundary;
 * this one keeps the tail, so it starts at `bytes.length - maxBytes` and must
 * walk *forward* — walking backward would retain more than `maxBytes`.
 *
 * Live tool output calls this once per `tool.updated` event with the whole
 * accumulated candidate, so the "still below the cap" case must not encode:
 * the length bound decides it in O(1). Never loop-and-re-encode per character —
 * on multibyte text that degrades to O(n²) and blocks the renderer for seconds.
 */
export function tailUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length * MAX_UTF8_BYTES_PER_UNIT <= maxBytes) return { text, truncated: false };
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start += 1;
  return { text: decoder.decode(bytes.subarray(start)), truncated: true };
}

/**
 * FNV-1a 32-bit hex. Must match overlay `publicToolCallId` and the archive
 * reader: a truncated id still has to be unique so live overlay and history
 * pairing keep using the same key.
 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function publicConversationToolCallId(
  raw: string,
  fallback: string,
): { id: string; truncated: boolean } {
  if (raw.length === 0) return { id: fallback, truncated: true };
  const max = CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS;
  if (raw.length <= max) return { id: raw, truncated: false };
  const digest = fnv1aHex(raw);
  const keep = Math.max(1, max - digest.length - 1);
  return { id: `${raw.slice(0, keep)}-${digest}`, truncated: true };
}
