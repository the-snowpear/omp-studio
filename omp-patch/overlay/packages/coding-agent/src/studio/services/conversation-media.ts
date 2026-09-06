import { CONVERSATION_LIMITS, type JsonValue } from "../conversation-protocol";
import { sanitizeJsonValue, utf8ByteLength } from "./conversation-sanitizer";

const MEDIA_BUDGET = 192 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Preserve bounded native image blocks for both live and persisted projections. */
export function projectToolMedia(content: unknown, rawDetails: unknown): { data?: JsonValue; truncated: boolean } {
	const media: JsonValue[] = [];
	let bytes = 0;
	let omitted = 0;
	if (Array.isArray(content))
		for (const block of content) {
			if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") continue;
			const { mimeType, data } = block as { mimeType?: unknown; data?: unknown };
			if (
				typeof mimeType !== "string" ||
				!MIME_TYPES.has(mimeType) ||
				typeof data !== "string" ||
				data.length === 0 ||
				data.length > MEDIA_BUDGET ||
				data.length % 4 !== 0 ||
				!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
			) {
				omitted++;
				continue;
			}
			const image = { type: "image", mimeType, data };
			const size = utf8ByteLength(JSON.stringify(image));
			if (media.length >= 8 || bytes + size > MEDIA_BUDGET) {
				omitted++;
				continue;
			}
			media.push(image);
			bytes += size;
		}
	const details = sanitizeJsonValue(rawDetails, { maxBytes: CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES - bytes - 1024 });
	if (media.length === 0 && omitted === 0)
		return {
			...(details.value === undefined ? {} : { data: details.value }),
			truncated: rawDetails !== undefined && details.truncated,
		};
	const source = details.value;
	const data: Record<string, JsonValue> =
		source && typeof source === "object" && !Array.isArray(source)
			? Object.fromEntries(Object.entries(source as Record<string, JsonValue>))
			: source === undefined
				? {}
				: { details: source };
	data.media = media;
	if (omitted > 0) data.mediaOmitted = omitted;
	return { data, truncated: omitted > 0 || (rawDetails !== undefined && details.truncated) };
}
