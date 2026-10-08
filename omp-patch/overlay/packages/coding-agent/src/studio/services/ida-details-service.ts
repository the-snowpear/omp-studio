import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
	acquireIdaDatabase,
	cfgIdaInstall,
	findOpenIdaDatabase,
	listIdaDatabases,
	resolveIdaRuntime,
	type IdaDatabase,
} from "../../ida";
import { cfgIdaEnabled, cfgIdaInstallDir, cfgIdaPython } from "../../ida/settings";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import type { StudioIdaDatabase, StudioIdaOperation, StudioIdaStatus } from "../ida-details-protocol";
import { validateStudioIdaOperation } from "../ida-details-protocol";
import { SessionControlError } from "./session-control-service";

function projectDatabase(db: IdaDatabase): StudioIdaDatabase {
	const status = db.status;
	return {
		id: db.id,
		ref: db.ref,
		name: db.name,
		path: db.idbPath,
		state: status.state,
		module: db.info.module,
		format: db.info.format,
		arch: db.info.arch,
		bitness: db.info.bitness,
		busy: status.busy,
		dirty: status.dirty,
		...(status.current ? { current: { ...status.current } } : {}),
	};
}
/** A recoverable on-disk checkpoint before Studio changes a shared native database. */
export async function prepareStudioIdaBackup(cwd: string, db: IdaDatabase): Promise<string> {
	const directory = path.join(cwd, "backup", new Date().toISOString().slice(0, 10), "ida-" + randomUUID());
	await fs.mkdir(directory, { recursive: true });
	const destination = path.join(directory, path.basename(db.idbPath));
	await fs.writeFile(
		path.join(directory, "README.md"),
		[
			"# IDA recovery copy",
			"",
			"Source: " + db.idbPath,
			"Database: " + db.id,
			"Created: " + new Date().toISOString(),
			"",
			"Close the database in IDA before restoring this copy to its source path. Preserve any newer changes first.",
			"",
		].join("\n"),
	);
	return destination;
}

export class StudioIdaDetailsService {
	readonly #running = new Map<string, AbortController>();
	#disposed = false;
	constructor(readonly session: AgentSession) {}
	#toolSession(): ToolSession {
		const toolSession = this.session.studioToolSession;
		if (!toolSession)
			throw new SessionControlError("COMMAND_BLOCKED", "Native IDA context is unavailable in this Runtime");
		return toolSession;
	}
	async status(): Promise<StudioIdaStatus> {
		const settings = this.session.settings;
		const result: StudioIdaStatus = {
			enabled: cfgIdaEnabled.get(settings),
			installDir: cfgIdaInstallDir.get(settings),
			python: cfgIdaPython.get(settings),
			available: false,
			databases: [],
		};
		const detectedInstall = cfgIdaInstall.get(settings);
		if (!detectedInstall)
			return {
				...result,
				reason: result.enabled
					? "No IDA installation with idalib was found. Configure the install directory and Python interpreter."
					: "IDA is disabled.",
			};
		result.detectedInstall = detectedInstall;
		try {
			const toolSession = this.#toolSession();
			const runtime = await resolveIdaRuntime(toolSession);
			result.detectedPython = runtime.pythonPath;
			result.available = true;
			result.databases = (await listIdaDatabases(toolSession)).slice(0, 128).map(projectDatabase);
		} catch (error) {
			result.reason = error instanceof Error ? error.message : String(error);
		}
		return result;
	}
	async execute(operation: StudioIdaOperation): Promise<unknown> {
		validateStudioIdaOperation(operation);
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The session changed; reload IDA state");
		if (operation.kind === "ida.status.details") return this.status();
		if (operation.kind === "ida.configure") {
			if (this.#running.size)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Stop the current IDA request before changing its configuration",
				);
			cfgIdaEnabled.set(this.session.settings, operation.enabled);
			cfgIdaInstallDir.set(this.session.settings, operation.installDir);
			cfgIdaPython.set(this.session.settings, operation.python);
			await this.session.settings.flush();
			return this.status();
		}
		if (operation.kind === "ida.database.cancel") {
			const controller = this.#running.get(operation.id);
			controller?.abort();
			return { cancelled: controller !== undefined };
		}
		const toolSession = this.#toolSession();
		if (operation.kind === "ida.open") {
			const source = path.resolve(toolSession.cwd, operation.path);
			const info = await fs.lstat(source);
			if (!info.isFile() || info.isSymbolicLink())
				throw new SessionControlError("INVALID_ARGUMENT", "Choose a local binary or IDA database file");
			const database = await acquireIdaDatabase(toolSession, source);
			return { database: projectDatabase(database) };
		}
		if (this.#running.has(operation.id))
			throw new SessionControlError("COMMAND_BLOCKED", "A Studio request is already running on this database");
		const controller = new AbortController();
		this.#running.set(operation.id, controller);
		try {
			const database = await findOpenIdaDatabase(toolSession, operation.id);
			if (!database)
				throw new SessionControlError("COMMAND_BLOCKED", "The database is no longer open; refresh the list");
			if (database.status.busy)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"The database is busy. Wait for its current native operation to finish",
				);
			const backup = await prepareStudioIdaBackup(toolSession.cwd, database);
			controller.signal.throwIfAborted();
			if (this.session.sessionId !== operation.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "The active session changed before IDA execution");
			if (operation.kind === "ida.close") {
				await database.request("save", { studioBackup: backup }, { signal: controller.signal, timeoutMs: 120_000 });
				await database.close({ save: true });
				return { closed: true, backup };
			}
			if (operation.kind === "ida.save") {
				await database.request("save", { studioBackup: backup }, { signal: controller.signal, timeoutMs: 120_000 });
				return { saved: true, backup };
			}
			const result = await database.request<{ output: string; value: string | null; error: string | null }>(
				"exec",
				{ code: operation.code, studioBackup: backup },
				{ signal: controller.signal, timeoutMs: operation.timeoutMs },
			);
			const resultFile = path.join(path.dirname(backup), "execution-result.json");
			await fs.writeFile(resultFile, JSON.stringify(result));
			const trim = (value: string | null) => (value === null ? null : value.slice(0, 65536));
			return {
				output: trim(result.output),
				value: trim(result.value),
				error: trim(result.error),
				truncated: [result.output, result.value, result.error].some(
					value => value !== null && value.length > 65536,
				),
				backup,
				resultFile,
			};
		} finally {
			this.#running.delete(operation.id);
		}
	}
	dispose(): void {
		this.#disposed = true;
		for (const controller of this.#running.values()) controller.abort();
		this.#running.clear();
	}
}
