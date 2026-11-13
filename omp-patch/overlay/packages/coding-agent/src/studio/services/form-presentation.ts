import { defaultFormData, fieldQuestions } from "@oh-my-pi/pi-tui/html-form/data";
import { isSvgMedia, loadFormImage, svgMedia, type FormMediaOptions } from "@oh-my-pi/pi-tui/html-form/media";
import type { FormBlock, HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { resizeImage } from "../../utils/image-resize";
import type { InteractionForm, InteractionFormBlock } from "../form-protocol";
import { utf8ByteLength } from "./conversation-sanitizer";

/** Leave envelope space inside the existing 1 MiB control-frame limit; do not enlarge that limit. */
export const FORM_DTO_MAX_BYTES = 768 * 1024;
const FORM_RASTER_MAX_BYTES = 192 * 1024;

/** Native parser owns structure, captions and defaults. Only media and field references change for the wire. */
export async function presentHtmlForm(form: HtmlForm, options: FormMediaOptions): Promise<InteractionForm> {
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
				return { kind: "media-unavailable", alt: block.alt, reason: "图示不可用" };
			}),
		})),
		fields: form.fields.map(field => ({
			...field,
			id: ids.get(field)!,
			question: questions.get(field) ?? field.name,
		})),
		hidden: form.hidden,
		defaults: defaultFormData(form),
	};
	let bytes = utf8ByteLength(JSON.stringify(presentation));
	if (bytes > FORM_DTO_MAX_BYTES)
		throw new Error("表单文字与字段超过当前展示预算；请拆分表单。字段与默认值未被截断。");
	for (const slot of mediaBlocks) {
		options.signal?.throwIfAborted();
		const previous = presentation.sections[slot.section]!.blocks[slot.index]!;
		let next: InteractionFormBlock;
		try {
			const media =
				slot.block.kind === "svg" ? svgMedia(slot.block.markup) : await loadFormImage(slot.block.src, options);
			if (isSvgMedia(media)) {
				next = {
					kind: "graphic",
					format: "svg",
					source: new TextDecoder().decode(media.bytes),
					alt: slot.block.alt,
				};
			} else {
				const maxBytes = Math.min(FORM_RASTER_MAX_BYTES, Math.floor((FORM_DTO_MAX_BYTES - bytes) * 0.7));
				if (maxBytes < 1024) throw new Error("图示超过当前表单展示预算");
				const image = await resizeImage(
					{ bytes: media.bytes, mimeType: media.mime },
					{ maxBytes, maxWidth: 1280, maxHeight: 1280, minDimension: 0 },
				);
				if (image.buffer.byteLength > maxBytes) throw new Error("图示无法压缩到当前展示预算");
				next = { kind: "image", src: `data:${image.mimeType};base64,${image.data}`, alt: slot.block.alt };
			}
			if (
				bytes - utf8ByteLength(JSON.stringify(previous)) + utf8ByteLength(JSON.stringify(next)) >
				FORM_DTO_MAX_BYTES
			) {
				throw new Error("图示超过当前表单展示预算");
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
	if (bytes > FORM_DTO_MAX_BYTES) throw new Error("表单图示与文字超过当前展示预算；请拆分表单。");
	return presentation;
}
