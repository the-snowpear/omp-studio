import { cfgBinjaInstallDir, cfgBinjaPython } from "../../binja/settings";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	acquireDatabase,
	cfgDisassembler,
	cfgDisasmBackend,
	cfgDisasmIdleCloseSec,
	cfgDisasmMaxOpen,
	findOpenDatabase,
	installStatus,
	listDatabases,
	resolveWorkerRuntime,
	type DisasmDatabase,
} from "../../disasm";
import { readBinaryMetadata } from "../../disasm/metadata";
import { isGhidraInstall } from "../../ghidra/install";
import { ghidraHostSupported } from "../../ghidra/platform";
import { cfgGhidraInstallDir } from "../../ghidra/settings";
import type { AgentSession } from "../../session/agent-session";
import type {
	DisassemblerBackendStatus,
	DisassemblerDatabase,
	DisassemblerEdit,
	DisassemblerEngine,
	DisassemblerOperation,
	DisassemblerResultMap,
	DisassemblerStatus,
} from "../disassembler-protocol";
import { runtimeText } from "../locale";
import { SessionControlError } from "./session-control-service";

type Binding = { identity: string; version: number };
type WorkerReply<T> = Binding & { result: T };
type Checkpoint<T = unknown> = { result: T; backup: string };
type ScriptResult = { output: string; value: string | null; error: string | null };
type Review = { edit: DisassemblerEdit; expiresAt: number } & (
	| { binding: Binding }
	| { file: string; fingerprint: string; arch?: string }
);
const engines = ["ida", "ghidra", "binja"] as const;

function workerBinding(db: DisasmDatabase, signal?: AbortSignal): Promise<Binding> {
	return db.request("studio", { method: "status" }, { timeoutMs: 5000, signal });
}

export class StudioDisassemblerService {
	readonly #reviews = new Map<string, Review>();
	readonly #offSession: () => void;
	#active: { id?: string; controller: AbortController } | undefined;

	constructor(readonly session: AgentSession) {
		this.#offSession = session.registerSessionChangeCallback?.(() => this.#reset()) ?? (() => {});
	}

	get running(): boolean {
		return this.#active !== undefined;
	}

	dispose(): void {
		this.#offSession();
		this.#reset();
	}

	#reset(): void {
		this.#active?.controller.abort();
		this.#reviews.clear();
	}

	#assertSession(id: string): void {
		if (id !== this.session.sessionId)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText("会话已变更，请刷新反汇编器", "Session changed; refresh the Disassembler"),
			);
	}

	#tool() {
		const tool = this.session.studioToolSession;
		if (!tool)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText("反汇编上下文不可用", "Disassembler context is unavailable"),
			);
		return tool;
	}

	async #file(input: string) {
		const cwd = await fs.realpath(this.session.sessionManager.getCwd());
		const file = await fs.realpath(path.resolve(cwd, input));
		const relative = path.relative(cwd, file);
		if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
			throw new Error(runtimeText("文件必须位于当前工作区", "Choose a file within the current workspace"));
		const stat = await fs.stat(file);
		if (!stat.isFile())
			throw new Error(runtimeText("请选择二进制文件或分析数据库", "Choose a binary or analysis database file"));
		return { file, fingerprint: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]) };
	}

	async #database(id: string): Promise<DisasmDatabase> {
		const backend = engines.find(engine => id.startsWith(engine + ":"));
		const db = backend && (await findOpenDatabase(backend, id));
		if (!db) throw new Error(runtimeText("数据库已关闭，请刷新列表", "Database closed. Refresh the list."));
		return db;
	}

	async #project(db: DisasmDatabase, backend: DisassemblerEngine): Promise<DisassemblerDatabase> {
		const status = db.status;
		const binding =
			status.state === "open" && !status.busy ? await workerBinding(db).catch(() => undefined) : undefined;
		return {
			id: db.name,
			label: db.info.module || db.ref,
			name: db.name,
			ref: db.ref,
			path: db.idbPath,
			backend,
			state: status.state,
			...db.info,
			busy: status.busy,
			dirty: status.dirty,
			...(status.current ? { current: status.current } : {}),
			...(binding ? { identity: binding.identity, version: binding.version } : {}),
		};
	}

	async #backendStatus(backend: DisassemblerEngine): Promise<DisassemblerBackendStatus> {
		const detail = installStatus(backend);
		if (detail) return { state: "installing", detail };
		if (backend === "ghidra") {
			if (!ghidraHostSupported()) return { state: "unavailable" };
			const configured = cfgGhidraInstallDir.get(this.session.settings);
			if (!configured)
				return {
					state: "unknown",
					detail: runtimeText("首次分析时配置托管 Ghidra", "Managed Ghidra is set up on first analysis"),
				};
			const install = path.resolve(this.#tool().cwd, configured);
			return { state: (await isGhidraInstall(install)) ? "unknown" : "unavailable", detail: install };
		}
		try {
			const worker = await resolveWorkerRuntime(this.#tool(), backend);
			return { state: "ready", detail: worker.pythonPath };
		} catch (error) {
			return { state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
		}
	}

	async #status(): Promise<DisassemblerStatus> {
		const { settings } = this.session;
		const rawActiveBackend = cfgDisasmBackend.get(settings);
		const activeBackend: DisassemblerEngine | undefined =
			rawActiveBackend === "ida" || rawActiveBackend === "ghidra" || rawActiveBackend === "binja"
				? rawActiveBackend
				: undefined;
		const [ida, ghidra, binja, ...rows] = await Promise.all([
			this.#backendStatus("ida"),
			this.#backendStatus("ghidra"),
			this.#backendStatus("binja"),
			...engines.map(async engine => {
				const databases = await listDatabases(engine);
				return Promise.all(databases.map(db => this.#project(db, engine)));
			}),
		]);
		const databases = rows.flat();
		const backends = { ida, ghidra, binja };
		if (
			ghidra.state === "unknown" &&
			databases.some(database => database.backend === "ghidra" && database.state === "open")
		)
			backends.ghidra = { state: "ready" };
		const available = activeBackend !== undefined && backends[activeBackend].state !== "unavailable";
		return {
			backend: cfgDisassembler.get(settings),
			maxOpen: cfgDisasmMaxOpen.get(settings),
			idleCloseSec: cfgDisasmIdleCloseSec.get(settings),
			binjaInstallDir: cfgBinjaInstallDir.get(settings),
			binjaPython: cfgBinjaPython.get(settings),
			activeBackend,
			backends,
			available,
			databases,
		};
	}

	async #open(file: string, arch: string | undefined, signal: AbortSignal) {
		const backend = cfgDisasmBackend.get(this.session.settings);
		if (backend !== "ida" && backend !== "ghidra" && backend !== "binja")
			throw new Error(
				runtimeText("当前配置只允许读取头部元数据", "The current configuration permits header metadata only"),
			);
		return this.#project(await acquireDatabase(this.#tool(), backend, file, { signal, arch }), backend);
	}

	async #run<T>(id: string | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#active)
			throw new Error(runtimeText("反汇编器有操作正在执行", "A Disassembler operation is already running"));
		const controller = new AbortController();
		this.#active = { id, controller };
		try {
			return await action(controller.signal);
		} finally {
			this.#active = undefined;
		}
	}

	async #call<T>(
		db: DisasmDatabase,
		method: string,
		binding: Binding,
		params: object,
		signal: AbortSignal,
		timeoutMs = 120000,
	) {
		return (await db.request<WorkerReply<T>>("studio", { method, ...binding, params }, { signal, timeoutMs })).result;
	}

	async execute(op: DisassemblerOperation): Promise<DisassemblerResultMap[keyof DisassemblerResultMap]> {
		this.#assertSession(op.sessionId);
		const result = await this.#execute(op);
		this.#assertSession(op.sessionId);
		return result;
	}

	async #execute(op: DisassemblerOperation): Promise<DisassemblerResultMap[keyof DisassemblerResultMap]> {
		switch (op.kind) {
			case "disassembler.status":
				return this.#status();
			case "disassembler.configure": {
				if (this.running) throw new Error(runtimeText("请先停止当前分析", "Stop the current analysis first"));
				const { settings } = this.session;
				if (op.binjaInstallDir !== undefined) cfgBinjaInstallDir.set(settings, op.binjaInstallDir);
				if (op.binjaPython !== undefined) cfgBinjaPython.set(settings, op.binjaPython);
				cfgDisassembler.set(settings, op.backend);
				cfgDisasmMaxOpen.set(settings, op.maxOpen);
				cfgDisasmIdleCloseSec.set(settings, op.idleCloseSec);
				await settings.flush();
				return this.#status();
			}
			case "disassembler.metadata.read":
				return readBinaryMetadata((await this.#file(op.path)).file, op.arch);
			case "disassembler.open":
				return this.#run(undefined, async signal => {
					const { file } = await this.#file(op.path);
					this.#assertSession(op.sessionId);
					return { database: await this.#open(file, op.arch, signal) };
				});
			case "disassembler.cancel": {
				const active = this.#active;
				const cancelled = !!active && (op.id === undefined || op.id === active.id);
				if (cancelled) active.controller.abort();
				return { cancelled };
			}
			case "disassembler.query":
				return this.#run(op.dbId, async signal => {
					const db = await this.#database(op.dbId);
					this.#assertSession(op.sessionId);
					const reply = await db.request<WorkerReply<DisassemblerResultMap["disassembler.query"]>>(
						"studio",
						{
							method: "view",
							identity: op.identity,
							version: op.version,
							params: { kind: op.view, target: op.target },
							offset: op.offset ?? 0,
							limit: 100,
						},
						{ signal, timeoutMs: 120000 },
					);
					return reply.result;
				});
			case "disassembler.edit.prepare": {
				const { edit } = op;
				const expiresAt = Date.now() + 300000;
				const token = randomUUID();
				const review: Review =
					edit.action === "open"
						? { edit, expiresAt, ...(await this.#file(edit.path)), arch: edit.arch }
						: { edit, expiresAt, binding: await workerBinding(await this.#database(edit.dbId)) };
				this.#assertSession(op.sessionId);
				if (this.#reviews.size >= 16) this.#reviews.clear();
				this.#reviews.set(token, review);
				return {
					token,
					edit,
					expiresAt,
					...("binding" in review ? { identity: review.binding.identity, version: review.binding.version } : {}),
				};
			}
			case "disassembler.edit.apply": {
				const review = this.#reviews.get(op.token);
				this.#reviews.delete(op.token);
				if (!review || review.expiresAt < Date.now())
					throw new Error(runtimeText("审核已过期，请重新确认", "Review expired. Review the change again."));
				const { edit } = review;
				return this.#run(edit.action === "open" ? undefined : edit.dbId, async signal => {
					if (edit.action === "open" && "file" in review) {
						const current = await this.#file(edit.path);
						if (current.file !== review.file || current.fingerprint !== review.fingerprint)
							throw new Error(runtimeText("文件已更改，请重新审核", "File changed. Review the change again."));
						this.#assertSession(op.sessionId);
						await this.#open(current.file, review.arch, signal);
						return { text: runtimeText("已打开", "Opened") };
					}
					if (edit.action === "open" || !("binding" in review)) throw new Error("Invalid analysis review");
					const db = await this.#database(edit.dbId);
					this.#assertSession(op.sessionId);
					if (edit.action === "close") {
						await this.#close(db, edit.save, review.binding, signal);
						return { text: runtimeText("已关闭", "Closed") };
					}
					const { action, dbId: _dbId, ...params } = edit;
					const result = await this.#call<Checkpoint>(db, action, review.binding, params, signal);
					return { text: JSON.stringify(result, null, 2).slice(0, 262144) };
				});
			}
			case "disassembler.close":
			case "disassembler.save":
			case "disassembler.run":
				return this.#run(op.id, async signal => {
					const db = await this.#database(op.id);
					const binding = await workerBinding(db, signal);
					this.#assertSession(op.sessionId);
					if (op.kind === "disassembler.close")
						return { closed: true, backup: await this.#close(db, op.save !== false, binding, signal) };
					if (op.kind === "disassembler.save") {
						const checkpoint = await this.#call<Checkpoint>(db, "save", binding, {}, signal);
						return { saved: true, backup: checkpoint.backup };
					}
					const { result, backup } = await this.#call<Checkpoint<ScriptResult>>(
						db,
						"exec",
						binding,
						{ code: op.code },
						signal,
						op.timeoutMs,
					);
					const resultFile = backup + ".result.json";
					await fs.writeFile(resultFile, JSON.stringify(result));
					const trim = (text: string | null) => text?.slice(0, 65536) ?? null;
					return {
						output: trim(result.output) ?? "",
						value: trim(result.value),
						error: trim(result.error),
						truncated: [result.output, result.value, result.error].some(text => text && text.length > 65536),
						backup,
						resultFile,
					};
				});
		}
	}

	async #close(db: DisasmDatabase, save: boolean, binding: Binding, signal: AbortSignal) {
		let backup = "";
		if (save) {
			const checkpoint = await this.#call<Checkpoint>(db, "save", binding, {}, signal);
			backup = checkpoint.backup;
		} else {
			const actual = await workerBinding(db, signal);
			if (actual.identity !== binding.identity || actual.version !== binding.version)
				throw new Error(runtimeText("数据库已变化，请重新审核", "Database changed. Review the change again."));
		}
		signal.throwIfAborted();
		await db.close({ save });
		return backup;
	}
}
