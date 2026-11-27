import * as os from "node:os";
import * as path from "node:path";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import { defaultFormData, fieldQuestions } from "../../tools/html-form/data";
import type { FormBlock, HtmlForm } from "../../tools/html-form/parse";
import { resizeImage } from "../../utils/image-resize";
import type { InteractionForm, InteractionFormBlock } from "../form-protocol";
import { utf8ByteLength } from "./conversation-sanitizer";
import { runtimeText } from "../locale";

interface Media {
	bytes: Uint8Array;
	mime: string;
}

export interface MediaOptions {
	cwd: string;
	signal?: AbortSignal;
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const SVG_MIME = "image/svg+xml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function mediaPath(src: string, cwd: string): string {
	if (/^file:/i.test(src)) return Bun.fileURLToPath(src);
	if (src === "~" || src.startsWith("~/")) return path.join(os.homedir(), src.slice(1));
	return path.resolve(cwd, src);
}

function decodeDataUri(uri: string): Uint8Array {
	const comma = uri.indexOf(",");
	if (comma === -1) throw new Error("malformed data: URI");
	const header = uri.slice(5, comma);
	const payload = uri.slice(comma + 1);
	if (/;base64$/i.test(header)) return Uint8Array.fromBase64(payload.replace(/\s+/g, ""));
	return new TextEncoder().encode(decodeURIComponent(payload));
}

async function readMediaSource(src: string, options: MediaOptions): Promise<Uint8Array> {
	if (/^data:/i.test(src)) return decodeDataUri(src);
	if (/^https?:\/\//i.test(src)) {
		const signal = options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
			: AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const response = await fetch(src, { signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > MAX_MEDIA_BYTES) throw new Error(`larger than ${MAX_MEDIA_BYTES >> 20} MiB`);
		return new Uint8Array(await response.arrayBuffer());
	}
	const handle = Bun.file(mediaPath(src, options.cwd));
	if (handle.size > MAX_MEDIA_BYTES) throw new Error(`larger than ${MAX_MEDIA_BYTES >> 20} MiB`);
	return new Uint8Array(await handle.arrayBuffer());
}

function svgMedia(markup: string): Media {
	const open = /<svg\b[^>]*>/i.exec(markup)?.[0];
	if (!open) return { bytes: new TextEncoder().encode(markup), mime: SVG_MIME };
	const added: string[] = [];
	if (!/\bxmlns\s*=/i.test(open)) added.push(`xmlns="${SVG_NAMESPACE}"`);
	const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open);
	if (box && !/\swidth\s*=/i.test(open) && !/\sheight\s*=/i.test(open)) {
		added.push(`width="${box[1]}"`, `height="${box[2]}"`);
	}
	const sized = added.length > 0 ? markup.replace(/<svg\b/i, `<svg ${added.join(" ")}`) : markup;
	return { bytes: new TextEncoder().encode(sized), mime: SVG_MIME };
}

async function loadMedia(src: string, options: MediaOptions): Promise<Media> {
	const bytes = await readMediaSource(src, options);
	if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error(`larger than ${MAX_MEDIA_BYTES >> 20} MiB`);
	const raster = parseImageMetadata(bytes.subarray(0, 64));
	if (raster) return { bytes, mime: raster.mimeType };
	const text = new TextDecoder().decode(bytes.subarray(0, 4096));
	if (/<svg[\s>]/i.test(text)) return svgMedia(new TextDecoder().decode(bytes));
	throw new Error("not a PNG, JPEG, GIF, WebP or SVG image");
}

function isSvgMedia(media: Media): boolean {
	return media.mime === SVG_MIME;
}

/** Leave envelope space inside the existing 1 MiB control-frame limit; do not enlarge that limit. */
export const FORM_DTO_MAX_BYTES = 768 * 1024;
const FORM_RASTER_MAX_BYTES = 192 * 1024;

/** Native parser owns structure, captions and defaults. Only media and field references change for the wire. */
export async function presentHtmlForm(
	form: HtmlForm,
	options: MediaOptions & { acceptImages?: boolean },
): Promise<InteractionForm> {
	const questions = fieldQuestions(form);
	const ids = new Map(form.fields.map((field, index) => [field, `field:${index}`]));
	const mediaBlocks: Array<{ block: Extract<FormBlock, { kind: "image" | "svg" }>; section: number; index: number }> =
		[];
	const presentation: InteractionForm = {
		sections: form.sections.map((section, sectionIndex) => ({
			title: section.title,
			fieldset: section.fieldset,
			blocks: section.blocks.map((block, index): InteractionFormBlock => {
				if (block.kind === "field")
					return {
						kind: "field",
						fieldId: ids.get(block.field)!,
						...(block.optionsEnd === undefined ? {} : { optionsEnd: block.optionsEnd }),
					};
				if (block.kind !== "image" && block.kind !== "svg") return block;
				mediaBlocks.push({ block, section: sectionIndex, index });
				return {
					kind: "media-unavailable",
					alt: block.alt,
					reason: runtimeText("图示不可用", "Diagram unavailable"),
				};
			}),
		})),
		fields: form.fields.map(field => ({
			...field,
			id: ids.get(field)!,
			question: questions.get(field) ?? field.name,
		})),
		acceptImages: options.acceptImages,
		hidden: form.hidden,
		defaults: defaultFormData(form),
	};
	let bytes = utf8ByteLength(JSON.stringify(presentation));
	if (bytes > FORM_DTO_MAX_BYTES)
		throw new Error(
			runtimeText(
				"表单文字与字段超过当前展示预算；请拆分表单。字段与默认值未被截断。",
				"Form text and fields exceed the display budget; split the form. Fields and defaults were not truncated.",
			),
		);
	for (const slot of mediaBlocks) {
		options.signal?.throwIfAborted();
		const previous = presentation.sections[slot.section]!.blocks[slot.index]!;
		let next: InteractionFormBlock;
		try {
			const media =
				slot.block.kind === "svg" ? svgMedia(slot.block.markup) : await loadMedia(slot.block.src, options);
			if (isSvgMedia(media)) {
				next = {
					kind: "graphic",
					format: "svg",
					source: new TextDecoder().decode(media.bytes),
					alt: slot.block.alt,
				};
			} else {
				const maxBytes = Math.min(FORM_RASTER_MAX_BYTES, Math.floor((FORM_DTO_MAX_BYTES - bytes) * 0.7));
				if (maxBytes < 1024)
					throw new Error(runtimeText("图示超过当前表单展示预算", "Diagram exceeds the form display budget"));
				const image = await resizeImage(
					{ bytes: media.bytes, mimeType: media.mime },
					{ maxBytes, maxWidth: 1280, maxHeight: 1280, minDimension: 0 },
				);
				if (image.buffer.byteLength > maxBytes)
					throw new Error(
						runtimeText(
							"图示无法压缩到当前展示预算",
							"Diagram could not be compressed within the form display budget",
						),
					);
				next = { kind: "image", src: `data:${image.mimeType};base64,${image.data}`, alt: slot.block.alt };
			}
			if (
				bytes - utf8ByteLength(JSON.stringify(previous)) + utf8ByteLength(JSON.stringify(next)) >
				FORM_DTO_MAX_BYTES
			) {
				throw new Error(runtimeText("图示超过当前表单展示预算", "Diagram exceeds the form display budget"));
			}
		} catch (error) {
			options.signal?.throwIfAborted();
			next = {
				kind: "media-unavailable",
				alt: slot.block.alt,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		bytes += utf8ByteLength(JSON.stringify(next)) - utf8ByteLength(JSON.stringify(previous));
		presentation.sections[slot.section]!.blocks[slot.index] = next;
	}
	if (bytes > FORM_DTO_MAX_BYTES) {
		throw new Error(
			runtimeText(
				"表单图示与文字超过当前展示预算；请拆分表单。",
				"Form diagrams and text exceed the display budget; split the form.",
			),
		);
	}
	return presentation;
}
