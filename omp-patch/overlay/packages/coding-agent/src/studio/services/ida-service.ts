import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { acquireIdaDatabase, listIdaDatabases, resolveIdaRuntime } from "../../ida";
import {
	validateIdaOperation,
	validateIdaResult,
	type IdaOperation,
	type IdaEdit,
	type IdaResultMap,
	type IdaRow,
} from "../ida-protocol";
import { SessionControlError } from "./session-control-service";
export interface StudioIdaDb {
	id: string;
	label: string;
	state: "opening" | "open";
	dirty: boolean;
	busy: boolean;
	request(params: object, signal?: AbortSignal): Promise<{ identity: string; version: number; result: unknown }>;
}
export interface StudioIdaPort {
	available(): Promise<void>;
	list(): Promise<StudioIdaDb[]>;
	open(file: string, signal: AbortSignal): Promise<void>;
}
function nativePort(session: AgentSession): StudioIdaPort {
	const tool = () => {
		if (!session.studioToolSession) throw Error("Runtime tool session unavailable");
		return session.studioToolSession;
	};
	return {
		available: async () => {
			await resolveIdaRuntime(tool());
		},
		list: async () =>
			Promise.all(
				(await listIdaDatabases(tool())).map(async db => {
					await db.refresh();
					return {
						id: db.id,
						label: db.info.module || db.id,
						state: db.status.state,
						dirty: db.status.dirty,
						busy: db.status.busy,
						request: (params: object, signal?: AbortSignal) =>
							db.request("studio", params, { signal, timeoutMs: 120000 }),
					};
				}),
			),
		open: async (file, signal) => {
			await acquireIdaDatabase(tool(), file, { signal });
		},
	};
}
export class StudioIdaService {
	#reviews = new Map<
		string,
		{
			edit: IdaEdit;
			sessionId: string;
			expiresAt: number;
			identity?: string;
			version?: number;
			file?: string;
			fingerprint?: string;
		}
	>();
	#active: AbortController | undefined;
	constructor(
		readonly session: Pick<AgentSession, "sessionId" | "sessionManager">,
		readonly port: StudioIdaPort = nativePort(session as AgentSession),
	) {}
	get running(): boolean {
		return !!this.#active;
	}
	dispose(): void {
		this.#active?.abort();
		this.#reviews.clear();
	}
	#assert(id: string): void {
		if (id !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Session changed; reopen IDA");
	}
	async #db(id: string): Promise<StudioIdaDb> {
		const db = (await this.port.list()).find(db => db.id === id);
		if (!db || db.state !== "open") throw Error("IDA database is no longer open");
		return db;
	}
	async #file(input: string) {
		const cwd = await fs.realpath(this.session.sessionManager.getCwd());
		const file = await fs.realpath(path.resolve(cwd, input));
		const relative = path.relative(cwd, file);
		if (relative.startsWith("..") || path.isAbsolute(relative))
			throw Error("IDA input must stay in the current workspace");
		const stat = await fs.stat(file);
		if (!stat.isFile()) throw Error("Choose an IDA database or binary file");
		return { file, fingerprint: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]) };
	}
	async execute(op: IdaOperation): Promise<unknown> {
		validateIdaOperation(op);
		this.#assert(op.sessionId);
		const result = await this.#execute(op);
		this.#assert(op.sessionId);
		validateIdaResult(op.kind, result);
		return result;
	}
	async #execute(op: IdaOperation): Promise<unknown> {
		if (op.kind === "ida.cancel") {
			const cancelled = !!this.#active;
			this.#active?.abort();
			return { cancelled };
		}
		if (op.kind === "ida.status") {
			try {
				await this.port.available();
				const databases: IdaRow[] = await Promise.all(
					(await this.port.list()).map(async db => {
						let meta: { identity?: string; version?: number } = {};
						if (db.state === "open")
							try {
								meta = await db.request({ method: "status" });
							} catch {}
						return {
							id: db.id,
							label: db.label,
							state: db.state,
							dirty: db.dirty,
							busy: db.busy,
							...(meta.identity ? { identity: meta.identity, version: meta.version } : {}),
						};
					}),
				);
				return { available: true, databases };
			} catch (error) {
				return {
					available: false,
					reason: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
					databases: [],
				};
			}
		}
		await this.port.available();
		if (op.kind === "ida.view") {
			if (this.#active) throw Error("An IDA operation is still running");
			const controller = new AbortController();
			this.#active = controller;
			try {
				const db = await this.#db(op.dbId);
				controller.signal.throwIfAborted();
				this.#assert(op.sessionId);
				const value = await db.request(
					{
						method: "view",
						identity: op.identity,
						version: op.version,
						params: { kind: op.view, ...(op.target ? { target: op.target } : {}) },
						offset: op.offset ?? 0,
						limit: 100,
					},
					controller.signal,
				);
				return value.result;
			} finally {
				if (this.#active === controller) this.#active = undefined;
			}
		}
		if (op.kind === "ida.prepare") {
			const expiresAt = Date.now() + 300000;
			const token = randomUUID();
			let meta: { identity?: string; version?: number; file?: string; fingerprint?: string } = {};
			if (op.edit.action === "open") meta = await this.#file(op.edit.path);
			else {
				const db = await this.#db(op.edit.dbId);
				const current = await db.request({ method: "status" });
				if (!current.identity || !Number.isSafeInteger(current.version))
					throw Error("This IDA host does not support version-fenced changes");
				meta = { identity: current.identity, version: current.version };
			}
			if (this.#reviews.size >= 16) this.#reviews.clear();
			this.#reviews.set(token, { edit: structuredClone(op.edit), sessionId: op.sessionId, expiresAt, ...meta });
			return {
				token,
				edit: op.edit,
				expiresAt,
				...(meta.identity ? { identity: meta.identity, version: meta.version } : {}),
			};
		}
		const quote = this.#reviews.get(op.token);
		this.#reviews.delete(op.token);
		if (!quote || quote.sessionId !== op.sessionId || quote.expiresAt < Date.now())
			throw Error("IDA review expired; review again");
		if (this.#active) throw Error("An IDA operation is still running");
		const controller = new AbortController();
		this.#active = controller;
		try {
			const edit = quote.edit;
			if (edit.action === "open") {
				const file = await this.#file(edit.path);
				if (file.file !== quote.file || file.fingerprint !== quote.fingerprint)
					throw Error("IDA input changed since review");
				this.#assert(op.sessionId);
				await this.port.open(file.file, controller.signal);
				return { text: "Opened / 已打开" };
			}
			const db = await this.#db(edit.dbId);
			const { action, dbId, ...params } = edit;
			this.#assert(op.sessionId);
			const response = await db.request(
				{ method: action, identity: quote.identity, version: quote.version, params },
				controller.signal,
			);
			const text = JSON.stringify(response.result, null, 2);
			return { text: text.length > 262144 ? text.slice(0, 262100) + "\n[Output truncated]" : text };
		} finally {
			if (this.#active === controller) this.#active = undefined;
		}
	}
}
