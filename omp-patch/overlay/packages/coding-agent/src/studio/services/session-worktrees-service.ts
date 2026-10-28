import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAgentDir, withFileLock, logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { cfgSessionWorktreeScope } from "../../session/settings";
import { resolveResumeTarget, sessionDisplayName } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import {
	canAutoCreateWorktree,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	type SessionWorktree,
	type WorktreeExitPlan,
} from "../../session/session-worktree";
import { cfgWorktreeOnStart, cfgWorktreeOnExit } from "../../task/settings";
import type {
	SessionWorktreeRow,
	SessionWorktreeOperation,
	WorktreeRemovalPreview,
} from "../session-worktrees-protocol";
import type { StudioInteractionGateway } from "./interaction-port";
import { SessionControlError } from "./session-control-service";

interface OwnedWorktree {
	id: string;
	sessionId: string;
	worktree: SessionWorktree;
}
const clean = (cause: unknown) =>
	String(cause instanceof Error ? cause.message : cause)
		.replace(/[\u0000-\u001f]/gu, " ")
		.slice(0, 1024) || "Worktree operation failed";
const equalPath = async (a: string, b: string): Promise<boolean> => {
	try {
		const [left, right] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
		return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	} catch {
		// Missing or inaccessible directories cannot prove ownership.
		return false;
	}
};
export class StudioSessionWorktreesService {
	#pending:
		| { owner: string; preview: WorktreeRemovalPreview; plan: WorktreeExitPlan[]; owned: OwnedWorktree }
		| undefined;
	#busy = false;
	#disposed = false;
	#startDecisionSession: string | undefined;
	interaction: StudioInteractionGateway | undefined;
	constructor(readonly session: AgentSession) {}
	get running(): boolean {
		return this.#busy;
	}
	dispose(): void {
		this.#disposed = true;
		this.#pending = undefined;
	}
	async ensureStartResolved(): Promise<void> {
		if (
			this.#startDecisionSession === this.session.sessionId ||
			this.session.messages.length ||
			cfgWorktreeOnStart.get(this.session.settings) === "off"
		)
			return;
		if (await canAutoCreateWorktree(this.session.sessionManager.getCwd()))
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Choose the session worktree before sending the first prompt",
			);
	}
	#check(id: string): void {
		if (this.#disposed || id !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Worktree session changed");
	}
	async #registry(): Promise<string> {
		const cwd = this.session.sessionManager.getCwd(),
			repository = vcs.git(cwd);
		const root = await fs.realpath(repository?.primaryRoot() ?? cwd);
		return path.join(
			getAgentDir(),
			"studio",
			"worktrees",
			createHash("sha256")
				.update(process.platform === "win32" ? root.toLowerCase() : root)
				.digest("hex") + ".json",
		);
	}
	async #load(file: string): Promise<OwnedWorktree[]> {
		try {
			const stat = await fs.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw Error("Invalid worktree registry");
			const rows: unknown = JSON.parse(await fs.readFile(file, "utf8"));
			if (!Array.isArray(rows) || rows.length > 1000) throw Error("Invalid worktree registry");
			for (const row of rows) {
				if (
					!row ||
					typeof row !== "object" ||
					typeof row.id !== "string" ||
					!/^[a-f0-9-]{36}$/u.test(row.id) ||
					typeof row.sessionId !== "string" ||
					!row.worktree
				)
					throw Error("Invalid managed worktree");
				for (const key of ["path", "sourceCwd", "branch", "baseCommit"])
					if (typeof row.worktree[key] !== "string" || !row.worktree[key])
						throw Error("Invalid managed worktree path");
				if (!path.isAbsolute(row.worktree.path) || !path.isAbsolute(row.worktree.sourceCwd))
					throw Error("Invalid worktree registry path");
			}
			return rows as OwnedWorktree[];
		} catch (cause) {
			if ((cause as { code?: string }).code === "ENOENT") return [];
			throw cause;
		}
	}
	async #save(file: string, rows: OwnedWorktree[]): Promise<void> {
		const temporary = file + "." + crypto.randomUUID() + ".partial";
		try {
			await fs.writeFile(temporary, JSON.stringify(rows), { flag: "wx", mode: 0o600 });
			await fs.rename(temporary, file);
		} finally {
			await fs.unlink(temporary).catch(() => {});
		}
	}
	async #row(owned: OwnedWorktree): Promise<SessionWorktreeRow> {
		const base = {
			id: owned.id,
			branch: owned.worktree.branch,
			directory: owned.worktree.path,
			sessionId: owned.sessionId,
			current: await equalPath(owned.worktree.path, this.session.sessionManager.getCwd()),
		};
		try {
			const stat = await fs.lstat(owned.worktree.path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Worktree directory is unavailable");
			const state = await inspectSessionWorktree(owned.worktree);
			return { ...base, dirty: state.dirty, hasCommits: state.moved, detached: state.offBranch, missing: false };
		} catch (cause) {
			return { ...base, dirty: false, hasCommits: true, detached: false, missing: true, reason: clean(cause) };
		}
	}
	async #leases(owned: OwnedWorktree): Promise<() => void> {
		const repository = vcs.git(owned.worktree.sourceCwd);
		if (
			!repository ||
			!(await Promise.all((await repository.worktrees()).map(row => equalPath(row.path, owned.worktree.path)))).some(
				Boolean,
			)
		)
			throw Error("Worktree is no longer registered in its source repository");
		const sessions = await SessionManager.list(owned.worktree.path),
			releases: Array<() => void> = [];
		try {
			for (const session of sessions) {
				const release = new FileSessionStorage().claimSession(session.id, session.path);
				if (!release) throw Error("A live session still owns this worktree");
				releases.push(release);
			}
			return () => {
				for (const release of releases) release();
			};
		} catch (cause) {
			for (const release of releases) release();
			throw cause;
		}
	}
	async execute(operation: SessionWorktreeOperation): Promise<unknown> {
		this.#check(operation.sessionId);
		if (operation.kind === "worktrees.session.resume.list" || operation.kind === "worktrees.session.resume.prepare") {
			const cwd = this.session.sessionManager.getCwd();
			const scope = operation.scope ?? cfgSessionWorktreeScope.get(this.session.settings);
			const sessions = await SessionManager.listForPicker(cwd, undefined, new FileSessionStorage(), scope);
			this.#check(operation.sessionId);
			if (operation.kind === "worktrees.session.resume.list")
				return {
					scope,
					sessions: sessions.slice(0, 200).map(info => ({
						sessionId: info.id,
						title: sessionDisplayName(info),
						modifiedAt: info.modified.toISOString(),
						currentDirectory: path.resolve(info.cwd) === path.resolve(cwd),
						...(info.continuationOf ? { continuationOf: info.continuationOf } : {}),
					})),
					truncated: sessions.length > 200,
				};
			const selected = sessions.find(info => info.id === operation.targetSessionId);
			if (!selected)
				throw new SessionControlError("INVALID_ARGUMENT", "Session is outside the selected resume scope");
			const target = await resolveResumeTarget(selected.id, selected.cwd);
			this.#check(operation.sessionId);
			if (!target) throw new SessionControlError("INVALID_ARGUMENT", "Resume session is unavailable");
			return { targetSessionId: target.session.id, requestedSessionId: selected.id, cwd: target.session.cwd };
		}
		if (operation.kind === "worktrees.session.continueHere") {
			this.#startDecisionSession = operation.sessionId;
			return { continued: true };
		}
		const file = await this.#registry();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		if (operation.kind === "worktrees.session.startPolicy") {
			const eligible =
				this.#startDecisionSession !== operation.sessionId &&
				!this.session.messages.length &&
				!this.session.isStreaming &&
				!this.session.isCompacting &&
				(await canAutoCreateWorktree(this.session.sessionManager.getCwd()));
			return {
				eligible,
				policy: cfgWorktreeOnStart.get(this.session.settings),
				...(!eligible ? { reason: "Only a fresh session in a primary Git checkout can start a worktree" } : {}),
			};
		}
		if (operation.kind === "worktrees.session.list") {
			const rows = await this.#load(file);
			return {
				worktrees: await Promise.all(rows.slice(0, 100).map(row => this.#row(row))),
				truncated: rows.length > 100,
			};
		}
		if (this.#busy) throw new SessionControlError("COMMAND_BLOCKED", "A worktree operation is already running");
		this.#busy = true;
		try {
			return await withFileLock(file + ".lock", async () => {
				const rows = await this.#load(file);
				this.#check(operation.sessionId);
				if (operation.kind === "worktrees.session.create") {
					if (
						operation.freshOnly &&
						(this.session.messages.length || !(await canAutoCreateWorktree(this.session.sessionManager.getCwd())))
					)
						throw new SessionControlError(
							"COMMAND_BLOCKED",
							"The session is no longer eligible for an automatic worktree",
						);
					if (this.session.isStreaming || this.session.isCompacting)
						throw new SessionControlError("COMMAND_BLOCKED", "Wait until the current session is idle");
					if (rows.length >= 1000) throw Error("Managed worktree limit reached");
					const worktree = await createSessionWorktree(
						this.session.sessionManager.getCwd(),
						this.session.settings,
						operation.branch ?? defaultSessionWorktreeBranch(),
						{ keepChanges: operation.keepChanges ?? false },
					);
					const owned = { id: crypto.randomUUID(), sessionId: operation.sessionId, worktree };
					rows.unshift(owned);
					await this.#save(file, rows);
					if (operation.freshOnly) this.#startDecisionSession = operation.sessionId;
					return { worktree: await this.#row(owned), cwd: worktree.path };
				}
				if (operation.kind === "worktrees.session.remove.apply") {
					const pending = this.#pending;
					this.#pending = undefined;
					if (
						!pending ||
						pending.owner !== operation.sessionId ||
						pending.preview.token !== operation.token ||
						pending.preview.expiresAt < Date.now()
					)
						throw new SessionControlError("COMMAND_BLOCKED", "Worktree removal preview expired");
					const release = await this.#leases(pending.owned);
					try {
						const messages = await removeExitWorktrees(pending.plan);
						const removed = !(await fs.lstat(pending.owned.worktree.path).catch(() => undefined));
						if (removed)
							await this.#save(
								file,
								rows.filter(row => row.id !== pending.owned.id),
							);
						return { removed, messages: messages.slice(0, 20).map(clean) };
					} finally {
						release();
					}
				}
				const owned = rows.find(row => row.id === operation.id);
				if (!owned) throw Error("Unknown managed worktree");
				const row = await this.#row(owned);
				if (row.missing) throw Error(row.reason ?? "Worktree unavailable");
				if (operation.kind === "worktrees.session.open") return { cwd: owned.worktree.path };
				if (row.current || row.dirty || row.detached)
					throw new SessionControlError(
						"COMMAND_BLOCKED",
						"Switch away and save all worktree changes before removing it",
					);
				const release = await this.#leases(owned);
				try {
					const messages: string[] = [],
						plan = await planWorktreeExit(
							[owned.worktree],
							"ask",
							async () => true,
							message => messages.push(message),
						);
					if (plan.length !== 1) throw Error(messages.join("; ") || "Worktree cannot be removed");
					const preview: WorktreeRemovalPreview = {
						token: crypto.randomUUID(),
						expiresAt: Date.now() + 300000,
						worktree: row,
						keepBranch: row.hasCommits,
					};
					this.#pending = { owner: operation.sessionId, owned, preview, plan };
					return preview;
				} finally {
					release();
				}
			});
		} finally {
			this.#busy = false;
		}
	}
	async cleanupOnShutdown(): Promise<void> {
		const policy = cfgWorktreeOnExit.get(this.session.settings);
		if (policy === "keep") return;
		const file = await this.#registry();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await withFileLock(file + ".lock", async () => {
			const rows = await this.#load(file);
			for (const owned of rows) {
				if (!(await equalPath(owned.worktree.path, this.session.sessionManager.getCwd()))) continue;
				try {
					const release = await this.#leases(owned);
					try {
						const plan = await planWorktreeExit(
							[owned.worktree],
							policy,
							async (title, message) =>
								this.interaction
									? this.interaction.confirm({
											commandId: "worktree-exit:" + owned.id,
											title,
											message,
											destructive: true,
										})
									: false,
							message => logger.warn(message),
						);
						for (const message of await removeExitWorktrees(plan))
							this.session.emitNotice("info", message, "worktree-exit");
						if (!(await fs.lstat(owned.worktree.path).catch(() => undefined)))
							rows.splice(rows.indexOf(owned), 1);
					} finally {
						release();
					}
				} catch (cause) {
					logger.warn("Kept session worktree during shutdown", { error: clean(cause) });
				}
			}
			await this.#save(file, rows);
		});
	}
}
