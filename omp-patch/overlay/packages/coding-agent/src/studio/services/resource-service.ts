import { listLocalFiles } from "../../internal-urls/local-protocol";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../../utils/atomic-file";
import type { LocalResourceOperation } from "../local-resources-protocol";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
	LocalProtocolHandler,
	OmpProtocolHandler,
	AttachmentProtocolHandler,
	ConflictProtocolHandler,
	parseInternalUrl,
	sessionResolveContext,
	type ProtocolHandler,
} from "../../internal-urls";
import type { AgentSession } from "../../session/agent-session";
import { resizeImage } from "../../utils/image-resize";
import {
	validateResourceOperation,
	validateResourcePage,
	type ResourceOperation,
	type ResourcePage,
} from "../resources-protocol";
export class StudioResourceService {
	constructor(readonly session: AgentSession) {}
	async local(operation: LocalResourceOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId || !this.session.studioToolSession)
			throw Error("Local resources require the active session");
		const context = sessionResolveContext(this.session.studioToolSession);
		const options = LocalProtocolHandler.resolveOptions(context);
		if (!options) throw Error("Session local resource mapping is unavailable");
		if (operation.kind === "resource.local.list") {
			const files = await listLocalFiles(options);
			return {
				files: files
					.slice(0, 500)
					.map(file => ({ name: file.name, uri: file.url, bytes: file.size, modifiedAt: file.mtimeMs })),
				truncated: files.length > 500,
			};
		}
		if (!operation.uri.startsWith("local://")) throw Error("Choose a session-local file");
		const handler = new LocalProtocolHandler();
		const located = await handler.locate(parseInternalUrl(operation.uri), context);
		if (!located) throw Error("Local file no longer exists");
		const lock = operation.kind === "resource.local.save" ? await acquireFileLock(located) : undefined;
		try {
			const stat = await fs.stat(located);
			if (!stat.isFile() || stat.size > 512 * 1024)
				throw Error("The text editor supports regular files up to 512 KiB");
			const bytes = await fs.readFile(located);
			if (bytes.includes(0)) throw Error("This local resource is binary");
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const version = createHash("sha256").update(bytes).digest("hex");
			if (operation.sessionId !== this.session.sessionId) throw Error("Session changed while opening local file");
			if (operation.kind === "resource.local.open") return { uri: operation.uri, version, text };
			if (version !== operation.version) throw Error("The local file changed; reopen it before saving");
			if (
				typeof operation.text !== "string" ||
				Buffer.byteLength(operation.text) > 512 * 1024 ||
				operation.text.includes("\0")
			)
				throw Error("Local text exceeds editor limits");
			await writeFileAtomically(located, operation.text, stat.mode & 0o777);
			return { saved: true, uri: operation.uri, version: createHash("sha256").update(operation.text).digest("hex") };
		} finally {
			lock?.release();
		}
	}

	async read(operation: ResourceOperation): Promise<ResourcePage> {
		validateResourceOperation(operation);
		if (operation.sessionId !== this.session.sessionId || !this.session.studioToolSession)
			throw Error("Resource session is no longer active");
		const handlers: Record<string, ProtocolHandler> = {
			local: new LocalProtocolHandler(),
			omp: new OmpProtocolHandler(),
			attachment: new AttachmentProtocolHandler(),
			conflict: new ConflictProtocolHandler(),
		};
		const scheme = operation.uri.split(":")[0]!;
		const handler = handlers[scheme]!;
		const url = parseInternalUrl(operation.uri);
		const context = sessionResolveContext(this.session.studioToolSession);
		let content = "";
		let bytes: Uint8Array | undefined;
		let image: ResourcePage["image"];
		if (handler.spec.backing === "file" && handler.locate) {
			const located = await handler.locate(url, context);
			if (located) {
				const stat = await fs.stat(located);
				if (stat.isFile()) {
					if (stat.size > 16 * 1024 * 1024) throw Error("Resource exceeds the 16 MiB viewer limit");
					bytes = await fs.readFile(located);
					const imageType = /\.(png|jpe?g|gif|webp)$/i.exec(located)?.[1];
					if (imageType || scheme === "attachment") {
						const resized = await resizeImage(
							{
								type: "image",
								data: Buffer.from(bytes).toString("base64"),
								mimeType:
									imageType === "png"
										? "image/png"
										: imageType === "gif"
											? "image/gif"
											: imageType === "webp"
												? "image/webp"
												: "image/jpeg",
							},
							{ maxBytes: 300000, maxWidth: 1280, maxHeight: 1280 },
						);
						if (resized.data.length > 600000) throw Error("Resource image exceeds preview budget");
						image = { mimeType: resized.mimeType, data: resized.data };
						content = `${resized.originalWidth}×${resized.originalHeight} → ${resized.width}×${resized.height}`;
					} else {
						if (bytes.includes(0)) throw Error("Binary resource; use the IDA panel or its native application");
						content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					}
				}
			}
		}
		if (bytes === undefined) content = (await handler.resolve(url, context)).content;
		if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw Error("Resource exceeds viewer budget");
		const version = createHash("sha256")
			.update(bytes ?? content)
			.digest("hex");
		if (operation.version && operation.version !== version)
			throw Error("Resource changed; restart from the first page");
		const lines = content.split("\n");
		const offset = operation.offset ?? 0;
		if (offset > lines.length) throw Error("Resource page is out of range");
		const selected = lines.slice(offset, offset + 100);
		const result: ResourcePage = {
			uri: operation.uri,
			version,
			offset,
			total: lines.length,
			text: selected.map(line => line.slice(0, 2048)).join("\n"),
			truncated: selected.some(line => line.length > 2048),
			...(offset + selected.length < lines.length ? { nextOffset: offset + selected.length } : {}),
			...(image ? { image } : {}),
		};
		if (operation.sessionId !== this.session.sessionId) throw Error("Resource session changed while reading");
		validateResourcePage(result);
		return result;
	}
}
