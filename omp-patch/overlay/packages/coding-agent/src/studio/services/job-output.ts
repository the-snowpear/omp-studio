import { utf8ByteLength } from "./conversation-sanitizer";

/** Output shared by job and associated Actions-log inspectors. */
export const JOB_INSPECT_OUTPUT_TAIL_BYTES = 16 * 1024;

/** Drop terminal escapes for display only; job state is never parsed from terminal output. */
export function cleanJobText(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return Bun.stripANSI(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Last maxBytes UTF-8 bytes, cut at a nearby line start when possible. */
export function outputTail(text: string, maxBytes = JOB_INSPECT_OUTPUT_TAIL_BYTES): string {
	if (utf8ByteLength(text) <= maxBytes) return text;
	const bytes = new TextEncoder().encode(text);
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start += 1;
	const tail = new TextDecoder().decode(bytes.subarray(start));
	const newline = tail.indexOf("\n");
	return newline >= 0 && newline < 512 ? tail.slice(newline + 1) : tail;
}
