import { CONVERSATION_LIMITS } from "./contracts/conversation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * codepoint. Used by live buffers so they match the persisted sanitizer cap.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
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
