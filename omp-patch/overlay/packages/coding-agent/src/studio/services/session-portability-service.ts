import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { loadEntriesFromFile } from "../../session/session-loader";
import { anonymizeSessionTranscripts } from "../../session/session-anonymizer";
import { inspectSessionArchive, packSession, unpackSession, markSessionMoved } from "../../session/session-transfer";
import type {
	PortableExport,
	SessionImportPreview,
	SessionPortabilityOperation,
	SessionPortabilityStatus,
} from "../session-portability-protocol";
import { StudioMediaFiles } from "./media-files";
import { SessionControlError } from "./session-control-service";

const MAX_BYTES = 64 * 1024 * 1024;
const EXPIRES = 5 * 60_000;
const clean = (cause: unknown) =>
	String(cause instanceof Error ? cause.message : cause)
		.replaceAll("\0", "")
		.slice(0, 1024) || "Session transfer failed";
export class StudioSessionPortabilityService {
	readonly #files: StudioMediaFiles | undefined;
	#owner: string | undefined;
	get running(): boolean {
		return ["preparing", "exporting", "importing"].includes(this.#status.phase);
	}
	#status: SessionPortabilityStatus = { phase: "idle" };
	#pending:
		| { preview: SessionImportPreview; file: string; hash: string; cwd: string; owner: string; timer: NodeJS.Timeout }
		| undefined;
	#disposed = false;
	constructor(
		readonly session: AgentSession,
		files?: StudioMediaFiles,
	) {
		this.#files =
			files ??
			(process.env.OMP_STUDIO_MEDIA_ROOT ? new StudioMediaFiles(process.env.OMP_STUDIO_MEDIA_ROOT) : undefined);
	}
	#check(id: string): void {
		if (this.#disposed || id !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed during transfer");
	}
	async #source(id: string): Promise<string> {
		if (id === this.session.sessionId) {
			if (this.session.isStreaming || this.session.isCompacting)
				throw new SessionControlError("COMMAND_BLOCKED", "Wait until the session is idle");
			await this.session.sessionManager.flush();
			const file = this.session.sessionManager.getSessionFile();
			if (!file) throw new SessionControlError("COMMAND_BLOCKED", "This session has no saved transcript");
			return file;
		}
		const manager = this.session.sessionManager;
		const rows = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
		const row = rows.find(row => row.id === id);
		if (!row) throw new SessionControlError("INVALID_ARGUMENT", "Session is not in this workspace");
		return row.path;
	}
	async #clearPending(): Promise<void> {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending) return;
		clearTimeout(pending.timer);
		await fs.unlink(pending.file).catch(() => {});
	}
	async execute(operation: SessionPortabilityOperation): Promise<unknown> {
		this.#check(operation.sessionId);
		if (operation.kind === "session.portability.status")
			return this.#owner === operation.sessionId ? structuredClone(this.#status) : { phase: "idle" };
		if (["preparing", "exporting", "importing"].includes(this.#status.phase))
			throw new SessionControlError("COMMAND_BLOCKED", "A session transfer is already running");
		if (operation.kind === "session.portability.cancel") {
			if (
				!this.#pending ||
				this.#pending.owner !== operation.sessionId ||
				this.#pending.preview.token !== operation.token
			)
				throw new SessionControlError("COMMAND_BLOCKED", "Import preview expired");
			await this.#clearPending();
			this.#status = { phase: "idle" };
			return { cancelled: true };
		}
		this.#owner = operation.sessionId;
		if (operation.kind === "session.portability.moved") {
			if (operation.targetSessionId === this.session.sessionId)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Switch away from the source session before marking it moved",
				);
			const source = await this.#source(operation.targetSessionId);
			this.#check(operation.sessionId);
			await markSessionMoved(source, operation.label);
			return { marked: true };
		}
		if (!this.#files)
			throw new SessionControlError("COMMAND_BLOCKED", "Private desktop file transfer is unavailable");
		const files = this.#files;
		try {
			if (operation.kind === "session.portability.prepare") {
				this.#status = { phase: "preparing" };
				await this.#clearPending();
				const grant = operation.inputTransfers?.find(row => row.artifactId === operation.artifactId);
				if (!grant) throw new SessionControlError("INVALID_ARGUMENT", "Archive requires a desktop file grant");
				const input = await files.input(grant.transferId);
				if (input.bytes.length > MAX_BYTES) throw new Error("Archive exceeds the 64 MiB transfer limit");
				const token = crypto.randomUUID(),
					directory = path.join(files.directory, "session-imports");
				await fs.mkdir(directory, { recursive: true, mode: 0o700 });
				const file = path.join(directory, token + ".tar"),
					cwd = operation.targetCwd ?? this.session.sessionManager.getCwd();
				await fs.writeFile(file, input.bytes, { flag: "wx", mode: 0o600 });
				try {
					const info = await inspectSessionArchive(file, cwd);
					this.#check(operation.sessionId);
					const preview: SessionImportPreview = {
						token,
						expiresAt: Date.now() + EXPIRES,
						sourceSessionId: info.id,
						title: info.title,
						sourceDirectory: info.cwd || "—",
						destinationDirectory: cwd,
						upstreamVersion: info.omp,
						messages: info.messages,
						artifacts: info.artifacts,
						blobs: info.blobs,
						conflicts: info.conflicts,
					};
					const timer = setTimeout(() => {
						if (this.#pending?.preview.token === token) {
							void this.#clearPending();
							this.#status = { phase: "idle" };
						}
					}, EXPIRES);
					timer.unref();
					this.#pending = { preview, file, cwd, hash: input.meta.sha256, owner: operation.sessionId, timer };
					this.#status = { phase: "complete", preview };
					return preview;
				} catch (cause) {
					await fs.unlink(file).catch(() => {});
					throw cause;
				}
			}
			if (operation.kind === "session.portability.import") {
				const pending = this.#pending;
				if (
					!pending ||
					pending.owner !== operation.sessionId ||
					pending.preview.token !== operation.token ||
					pending.preview.expiresAt < Date.now()
				)
					throw new SessionControlError("COMMAND_BLOCKED", "Import preview expired; inspect the archive again");
				this.#status = { phase: "importing", preview: pending.preview };
				clearTimeout(pending.timer);
				const bytes = await fs.readFile(pending.file);
				if (createHash("sha256").update(bytes).digest("hex") !== pending.hash)
					throw new Error("Archive changed after inspection");
				this.#check(operation.sessionId);
				const result = await unpackSession(pending.file, { cwd: pending.cwd, preserveExisting: true });
				if (result.mode === "replaced") throw new Error("Native import unexpectedly replaced an existing session");
				this.#status = {
					phase: "complete",
					imported: { sessionId: result.id, mode: result.mode, cwd: pending.cwd },
				};
				await this.#clearPending();
				return { sessionId: result.id, mode: result.mode, cwd: pending.cwd };
			}
			this.#status = { phase: "exporting" };
			const id = crypto.randomUUID(),
				directory = path.join(files.directory, "transfer-exports");
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			const format = operation.kind === "session.portability.pack" ? "pack" : "anonymous";
			const file = path.join(directory, id + (format === "pack" ? ".tar" : ".zip"));
			try {
				const source = await this.#source(operation.targetSessionId);
				this.#check(operation.sessionId);
				let members = 0;
				const warnings: string[] = [];
				if (format === "pack") {
					const result = await packSession(source, file);
					if (result.missingBlobs.length)
						warnings.push(`${result.missingBlobs.length} referenced blobs were unavailable`);
					const info = await inspectSessionArchive(file, this.session.sessionManager.getCwd());
					members = 2 + info.artifacts + info.blobs;
				} else {
					const release = new FileSessionStorage().claimSession(operation.targetSessionId, source);
					if (!release) throw new Error("The source session is being written by another process");
					try {
						const entries = await loadEntriesFromFile(source),
							header = entries[0];
						if (!header || header.type !== "session" || header.id !== operation.targetSessionId)
							throw new Error("Source session identity changed");
						const result = await anonymizeSessionTranscripts({
							header,
							entries: entries.filter(entry => entry.type !== "session"),
							sessionFile: source,
						});
						await writeArchive(file, "zip", result.files);
						members = result.files.length;
						if (result.subagentError) warnings.push(clean(result.subagentError));
					} finally {
						release();
					}
				}
				this.#check(operation.sessionId);
				const info = await fs.lstat(file);
				if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
					throw new Error("Export exceeds the 64 MiB transfer limit");
				const asset = await files.output(
					{
						kind: "transcript",
						name: `omp-${format}-${operation.targetSessionId}.${format === "pack" ? "tar" : "zip"}`,
						mimeType: format === "pack" ? "application/x-tar" : "application/zip",
					},
					Bun.file(file).stream(),
					operation.sessionId,
				);
				const result: PortableExport = { id, format, members, warnings, asset: { ...asset, kind: "export" } };
				await files.saveJob(operation.sessionId, id, {
					job: { id, sessionId: operation.sessionId },
					outputs: [result.asset],
				});
				this.#status = { phase: "complete", exported: result };
				return result;
			} finally {
				await fs.unlink(file).catch(() => {});
			}
		} catch (cause) {
			if (operation.kind === "session.portability.import") await this.#clearPending();
			this.#status = { phase: "failed", error: clean(cause) };
			throw cause;
		}
	}
	dispose(): void {
		this.#disposed = true;
		void this.#clearPending();
	}
}
