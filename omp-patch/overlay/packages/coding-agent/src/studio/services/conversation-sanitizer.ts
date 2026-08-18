/**
 * Shared conversation sanitizer for live events and (plan 02) transcript mapping.
 *
 * Truncates, redacts secret-shaped keys, drops providerPayload, and rejects
 * cyclic / non-JSON values. Import this module instead of copying
 * CONVERSATION_REDACT_KEY_PATTERN or a second redaction regex.
 */
import * as os from "node:os";
import * as path from "node:path";
import { CONVERSATION_LIMITS, CONVERSATION_REDACT_KEY_PATTERN, type JsonValue } from "../conversation-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REDACTED = "[redacted]";

export function utf8ByteLength(text: string): number {
	return encoder.encode(text).byteLength;
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
	return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Mirrors `tools/render-utils.shortenPath` (home → `~`) without importing the
 * TUI renderer graph. Transcript and live projectors must share this helper.
 */
export function shortenHomePath(filePath: string, homeDir = os.homedir()): string {
	if (!homeDir) return filePath;
	if (!filePath.startsWith(homeDir)) return filePath;
	const suffix = filePath.slice(homeDir.length);
	if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
		return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
	}
	return filePath;
}

export function sanitizePublicText(
	text: string,
	maxBytes: number,
	homeDir = os.homedir(),
): { text: string; truncated: boolean } {
	return truncateUtf8(shortenHomePath(text, homeDir), maxBytes);
}

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function redactKey(key: string): boolean {
	return CONVERSATION_REDACT_KEY_PATTERN.test(key);
}

export type SanitizeJsonResult = {
	value: JsonValue | undefined;
	truncated: boolean;
};

function sanitizeJsonWalk(
	value: unknown,
	depth: number,
	maxDepth: number,
	seen: Set<object>,
	homeDir: string,
): SanitizeJsonResult {
	if (depth > maxDepth) return { value: null, truncated: true };
	if (value === null || typeof value === "boolean") return { value, truncated: false };
	if (typeof value === "string") {
		const shortened = shortenHomePath(value, homeDir);
		return { value: shortened, truncated: shortened !== value };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return { value: null, truncated: true };
		return { value, truncated: false };
	}
	if (typeof value !== "object") return { value: undefined, truncated: true };
	if (seen.has(value)) return { value: null, truncated: true };
	if (Array.isArray(value)) {
		seen.add(value);
		try {
			let truncated = false;
			const items: JsonValue[] = [];
			for (const item of value) {
				const next = sanitizeJsonWalk(item, depth + 1, maxDepth, seen, homeDir);
				truncated = truncated || next.truncated;
				if (next.value !== undefined) items.push(next.value);
				else truncated = true;
			}
			return { value: items, truncated };
		} finally {
			seen.delete(value);
		}
	}
	if (!isPlainObject(value)) return { value: undefined, truncated: true };
	seen.add(value);
	try {
		let truncated = false;
		const record: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (redactKey(key)) {
				record[key] = REDACTED;
				truncated = true;
				continue;
			}
			const next = sanitizeJsonWalk(item, depth + 1, maxDepth, seen, homeDir);
			truncated = truncated || next.truncated;
			if (next.value !== undefined) record[key] = next.value;
			else truncated = true;
		}
		return { value: record, truncated };
	} finally {
		seen.delete(value);
	}
}

function collectStrings(
	value: JsonValue,
	bucket: { text: string; parent: Record<string, JsonValue> | JsonValue[]; key: string | number }[],
): void {
	if (typeof value === "string") return;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (typeof item === "string") bucket.push({ text: item, parent: value as JsonValue[], key: index });
			else if (item !== null && typeof item === "object") collectStrings(item, bucket);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, JsonValue>;
		for (const [key, item] of Object.entries(record)) {
			if (typeof item === "string") bucket.push({ text: item, parent: record, key });
			else if (item !== null && typeof item === "object") collectStrings(item, bucket);
		}
	}
}

function shrinkToBudget(value: JsonValue, maxBytes: number): SanitizeJsonResult {
	if (utf8ByteLength(JSON.stringify(value)) <= maxBytes) return { value, truncated: false };
	if (typeof value === "string") {
		let keep = Math.max(0, maxBytes - 2);
		let next = truncateUtf8(value, keep);
		while (keep > 0 && utf8ByteLength(JSON.stringify(next.text)) > maxBytes) {
			keep = Math.floor(keep / 2);
			next = truncateUtf8(value, keep);
		}
		return { value: next.text, truncated: true };
	}
	const clone = JSON.parse(JSON.stringify(value)) as JsonValue;
	const strings: { text: string; parent: Record<string, JsonValue> | JsonValue[]; key: string | number }[] = [];
	collectStrings(clone, strings);
	strings.sort((a, b) => utf8ByteLength(b.text) - utf8ByteLength(a.text));
	for (const entry of strings) {
		if (utf8ByteLength(JSON.stringify(clone)) <= maxBytes) break;
		const keep = Math.max(0, Math.floor(utf8ByteLength(entry.text) / 2));
		const next = truncateUtf8(entry.text, keep);
		if (Array.isArray(entry.parent)) entry.parent[entry.key as number] = next.text;
		else entry.parent[entry.key as string] = next.text;
	}
	if (utf8ByteLength(JSON.stringify(clone)) <= maxBytes) return { value: clone, truncated: true };
	return { value: undefined, truncated: true };
}

export function sanitizeJsonValue(
	value: unknown,
	options: { maxBytes?: number; maxDepth?: number; homeDir?: string } = {},
): SanitizeJsonResult {
	const maxBytes = options.maxBytes ?? CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES;
	const maxDepth = options.maxDepth ?? CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH;
	const homeDir = options.homeDir ?? os.homedir();
	const walked = sanitizeJsonWalk(value, 1, maxDepth, new Set(), homeDir);
	if (walked.value === undefined) return walked;
	const shrunk = shrinkToBudget(walked.value, maxBytes);
	return { value: shrunk.value, truncated: walked.truncated || shrunk.truncated };
}

export function sanitizeToolArguments(
	value: unknown,
	options: { maxBytes?: number; maxDepth?: number; homeDir?: string } = {},
): { arguments?: JsonValue; truncated: boolean } {
	if (value === undefined) return { truncated: false };
	const sanitized = sanitizeJsonValue(value, options);
	if (sanitized.value === undefined) return { truncated: true };
	return { arguments: sanitized.value, truncated: sanitized.truncated };
}

/** FNV-1a 32-bit hex. Must match `@omp-studio/studio-protocol` `fnv1aHex`. */
export function fnv1aHex(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Bound a vendor toolCallId to the public contract without collapsing
 * distinct long ids onto one key. Empty raw values use `fallback`.
 */
export function publicToolCallId(raw: string, fallback: string): { id: string; truncated: boolean } {
	if (raw.length === 0) return { id: fallback, truncated: true };
	const max = CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS;
	if (raw.length <= max) return { id: raw, truncated: false };
	const digest = fnv1aHex(raw);
	const keep = Math.max(1, max - digest.length - 1);
	return { id: `${raw.slice(0, keep)}-${digest}`, truncated: true };
}
