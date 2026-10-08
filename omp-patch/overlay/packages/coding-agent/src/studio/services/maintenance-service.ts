import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { collectGc, collectGcErrors, type GcCommandFlags, type GcResult } from "../../cli/gc-cli";
import {
	cfgGcColdArchiveAfterDays,
	cfgGcRetainNewestGlobal,
	cfgGcRetainNewestPerCwd,
	cfgGcStaleRetainDays,
	cfgGcStaleRetainNewest,
} from "../../cli/gc-settings";
import type { AgentSession } from "../../session/agent-session";
import type {
	GcCategory,
	GcPolicy,
	GcPreview,
	GcStatus,
	GcSummary,
	MaintenanceOperation,
	SessionExportResult,
	SessionExportStatus,
	NativeConnectionCheck,
} from "../maintenance-protocol";
import { SessionControlError } from "./session-control-service";
import { StudioMediaFiles } from "./media-files";
const EXPIRES = 5 * 60_000;
function clean(error: unknown): string {
	return (
		sanitizeText(error instanceof Error ? error.message : String(error))
			.replaceAll("\0", "")
			.slice(0, 1024) || "Maintenance failed"
	);
}
function number(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function projectGc(result: GcResult, policy: GcPolicy): GcSummary {
	const rows: GcSummary["rows"] = [];
	if (result.blobs)
		rows.push({
			category: "blobs",
			candidates: result.blobs.wouldDelete,
			changed: result.blobs.deleted,
			bytes: result.blobs.bytes,
			skippedActive: 0,
		});
	if (result.archive)
		rows.push({
			category: "archive",
			candidates: result.archive.wouldArchive,
			changed: result.archive.archived,
			bytes: 0,
			skippedActive: result.archive.skippedActive,
		});
	if (result.wal)
		rows.push({
			category: "wal",
			candidates: result.wal.databases.filter(row => row.wouldCheckpoint).length,
			changed: result.wal.databases.filter(row => row.checkpointed).length,
			bytes: result.wal.walBytes,
			skippedActive: result.wal.databases.filter(row => row.busy > 0).length,
		});
	if (result.stale)
		rows.push({
			category: "stale",
			candidates: result.stale.wouldDelete,
			changed: result.stale.deleted,
			bytes: result.stale.bytes,
			skippedActive: 0,
		});
	return {
		applied: result.apply,
		checkedAt: Date.now(),
		policy,
		rows,
		errors: collectGcErrors(result).slice(0, 20).map(clean),
	};
}
interface PendingGc {
	preview: GcPreview;
	flags: GcCommandFlags;
	categories: GcCategory[];
	sessionId: string;
}
export class StudioMaintenanceService {
	#plan: PendingGc | undefined;
	#exportOwner: string | undefined;
	#gcOwner: string | undefined;
	#gc: GcStatus = { phase: "idle" };
	#export: SessionExportStatus = { phase: "idle" };
	#disposed = false;
	readonly #files: StudioMediaFiles | undefined;
	constructor(
		readonly session: AgentSession,
		files?: StudioMediaFiles,
	) {
		this.#files =
			files ??
			(process.env.OMP_STUDIO_MEDIA_ROOT ? new StudioMediaFiles(process.env.OMP_STUDIO_MEDIA_ROOT) : undefined);
	}
	dispose(): void {
		this.#disposed = true;
		this.#plan = undefined;
	}
	#check(sessionId: string): void {
		if (this.#disposed || sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Maintenance requires the current connected session");
	}
	#policy(): GcPolicy {
		return {
			coldDays: number(cfgGcColdArchiveAfterDays.get(this.session.settings)),
			keepGlobal: number(cfgGcRetainNewestGlobal.get(this.session.settings)),
			keepPerWorkspace: number(cfgGcRetainNewestPerCwd.get(this.session.settings)),
			staleDays: number(cfgGcStaleRetainDays.get(this.session.settings)),
			staleKeep: number(cfgGcStaleRetainNewest.get(this.session.settings)),
		};
	}
	#flags(categories: GcCategory[], policy: GcPolicy): GcCommandFlags {
		return {
			agentDir: getAgentDir(),
			blobs: categories.includes("blobs"),
			archive: categories.includes("archive"),
			wal: categories.includes("wal"),
			stale: categories.includes("stale"),
			coldArchiveAfterDays: policy.coldDays,
			retainNewestGlobal: policy.keepGlobal,
			retainNewestPerCwd: policy.keepPerWorkspace,
			staleRetainDays: policy.staleDays,
			staleRetainNewest: policy.staleKeep,
		};
	}
	async execute(operation: MaintenanceOperation): Promise<unknown> {
		this.#check(operation.sessionId);
		if (operation.kind === "maintenance.gc.status") {
			if (this.#gcOwner !== operation.sessionId) return { phase: "idle" };
			if (
				this.#plan &&
				(this.#plan.sessionId !== operation.sessionId || this.#plan.preview.expiresAt < Date.now())
			) {
				this.#plan = undefined;
				this.#gc = { phase: "idle" };
			}
			return structuredClone(this.#gc);
		}
		if (operation.kind === "maintenance.export.status")
			return this.#exportOwner === operation.sessionId ? structuredClone(this.#export) : { phase: "idle" };
		if (operation.kind === "maintenance.connection.check") {
			const model = this.session.model;
			const available =
				!!model &&
				this.session.modelRegistry
					.getAvailable()
					.some(row => row.provider === model.provider && row.id === model.id);
			const result: NativeConnectionCheck = {
				checkedAt: Date.now(),
				checks: [
					{ id: "bridge", status: "ok", detail: "Authenticated Studio Bridge responded" },
					{ id: "session", status: "ok", detail: this.session.sessionId },
					{
						id: "model",
						status: available ? "ok" : "warning",
						detail: model ? model.provider + "/" + model.id : "No model configured",
					},
				],
			};
			return result;
		}
		if (operation.kind === "maintenance.session.export")
			return this.#exportSession(operation.sessionId, operation.format ?? "archive");
		if (this.#gc.phase === "previewing" || this.#gc.phase === "applying")
			throw new SessionControlError("COMMAND_BLOCKED", "A native cleanup scan is already in progress");
		if (operation.kind === "maintenance.gc.preview") {
			this.#gcOwner = operation.sessionId;
			this.#plan = undefined;
			this.#gc = { phase: "previewing" };
			try {
				const policy = this.#policy(),
					flags = this.#flags(operation.categories, policy);
				const summary = projectGc(await collectGc({ flags: { ...flags, apply: false } }), policy);
				this.#check(operation.sessionId);
				const preview: GcPreview = { token: crypto.randomUUID(), expiresAt: Date.now() + EXPIRES, summary };
				this.#plan = { preview, flags, categories: [...operation.categories], sessionId: operation.sessionId };
				this.#gc = { phase: "complete", preview, summary };
				return preview;
			} catch (error) {
				this.#gc = { phase: "failed", error: clean(error) };
				throw error;
			}
		}
		const plan = this.#plan;
		if (
			!plan ||
			plan.preview.token !== operation.token ||
			plan.sessionId !== operation.sessionId ||
			plan.preview.expiresAt < Date.now()
		)
			throw new SessionControlError("COMMAND_BLOCKED", "The cleanup preview expired; scan and confirm again");
		if (
			plan.preview.summary.errors.length ||
			JSON.stringify(this.#flags(plan.categories, this.#policy())) !== JSON.stringify(plan.flags)
		)
			throw new SessionControlError("COMMAND_BLOCKED", "Cleanup settings or scan errors require a fresh preview");
		this.#plan = undefined;
		this.#gc = { phase: "applying", summary: plan.preview.summary };
		try {
			const result = projectGc(
				await collectGc({ flags: { ...plan.flags, apply: true } }),
				plan.preview.summary.policy,
			);
			this.#gc = { phase: "complete", summary: result };
			return result;
		} catch (error) {
			this.#gc = { phase: "failed", error: clean(error) };
			throw error;
		}
	}
	async #exportSession(sessionId: string, format: "archive" | "html"): Promise<SessionExportResult> {
		if (this.#export.phase === "exporting")
			throw new SessionControlError("COMMAND_BLOCKED", "A session export is already running");
		if (this.session.isStreaming || this.session.isCompacting)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Wait until the current turn and compaction finish before exporting",
			);
		if (!this.#files)
			throw new SessionControlError("COMMAND_BLOCKED", "The private desktop file channel is unavailable");
		const files = this.#files;
		this.#exportOwner = sessionId;
		this.#export = { phase: "exporting" };
		const id = crypto.randomUUID(),
			dir = path.join(files.directory, "export-staging", id),
			file = path.join(dir, format === "archive" ? "session.zip" : "session.html");
		const warnings: string[] = [];
		let members = 1;
		try {
			await files.assertSession(sessionId);
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			if (format === "html") await this.session.exportToHtml(file);
			else {
				const archive = await this.session.dumpSessionArchiveToTmpDir(file);
				if (!archive) throw new SessionControlError("COMMAND_BLOCKED", "The session has no messages to export");
				members = archive.files.length;
				if (archive.subagentError) warnings.push(clean(archive.subagentError));
				if (!archive.files.includes("llm-request.json"))
					warnings.push("The native exporter could not include the model request payload");
			}
			this.#check(sessionId);
			const info = await fs.lstat(file);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
				throw new SessionControlError("COMMAND_BLOCKED", "Session export exceeds the 64 MiB file budget");
			const data = await files.output(
				{
					kind: "transcript",
					name: "omp-session-" + sessionId + (format === "archive" ? ".zip" : ".html"),
					mimeType: format === "archive" ? "application/zip" : "text/html",
				},
				Bun.file(file).stream(),
				sessionId,
			);
			const result: SessionExportResult = {
				id,
				format,
				members,
				warnings,
				createdAt: Date.now(),
				asset: { ...data, kind: "export" },
			};
			await files.saveJob(sessionId, id, { job: { id, sessionId }, outputs: [result.asset] });
			this.#export = { phase: "complete", result };
			return result;
		} catch (error) {
			this.#export = { phase: "failed", error: clean(error) };
			throw error;
		} finally {
			await fs.rm(file, { force: true }).catch(() => {});
			await fs.rmdir(dir).catch(() => {});
		}
	}
}
