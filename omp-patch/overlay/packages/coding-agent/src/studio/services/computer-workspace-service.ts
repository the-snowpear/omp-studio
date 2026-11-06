import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { DesktopCapture } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { cfgComputerEnabled } from "../../tools/settings";
import { computerPreludeAvailableForOwner, revokeComputerControlForOwner } from "../../tools/computer/supervisor";
import { registerComputerScope, type ComputerLifecycleEvent } from "../computer-runtime-lifecycle";
import type {
	ComputerAction,
	ComputerActivityPage,
	ComputerControlState,
	ComputerFrame,
	ComputerObservationLease,
	ComputerStructureSnapshot,
	ComputerWorkspaceChange,
	ComputerWorkspaceCommand,
	ComputerWorkspaceQuery,
	ComputerWorkspaceSnapshot,
} from "../computer-workspace-protocol";
import { ComputerControlPolicy, type ComputerContinueIntent } from "./computer-control-policy";
import { createComputerObserver, type ComputerObserver } from "./computer-observer";
import { ComputerWorkspaceMedia } from "./computer-workspace-media";
import { ownedStudioSessions, ownedStudioSessionAgent } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";
import continuePrompt from "./computer-continue.md" with { type: "text" };

const CONTROL_ENTRY = "studio.computer.control.v1";
const HISTORY_ENTRY = "studio.computer.history.v1";
const LEASE_TTL = 120_000;
const EXECUTION_TTL = 30 * 24 * 60 * 60 * 1000;
interface HistoryRecord {
	sessionId: string;
	kind: "start" | "terminal" | "frames";
	runId?: string;
	actions: ComputerAction[];
	frames: ComputerFrame[];
}
interface Lease extends ComputerObservationLease {
	consumerId: string;
}
interface StoredFrame {
	frame: ComputerFrame;
	bytes: number;
	digest?: string;
}
export interface ComputerWorkspaceOptions {
	directory?: string;
	observer?: () => ComputerObserver;
	ownedSessions?: () => AgentSession[];
	revoke?: (owner: string) => Promise<void>;
	now?: () => number;
}

/** Workspace read model and host policy, separate from native execution and conversation state. */
export class StudioComputerWorkspaceService {
	readonly #listeners = new Set<(event: ComputerWorkspaceChange) => void>();
	readonly #unregister: () => void;
	readonly #options: ComputerWorkspaceOptions;
	#sessionId = "";
	#manager!: SessionManager;
	#policy!: ComputerControlPolicy;
	#media?: ComputerWorkspaceMedia;
	#revision = 0;
	#generation = 0;
	#scopeGeneration = 0;
	readonly #pendingActions = new Map<string, ComputerAction[]>();
	readonly #settlements = new Set<Promise<void>>();
	readonly #historicalFrames = new Set<string>();
	readonly #historicalSessionIds = new Set<string>();
	readonly #foreground = new Map<string, ComputerControlState["foreground"]>();
	readonly #finishedRuns = new Set<string>();
	#disposed = false;
	#observer?: ComputerObserver;
	#snapshot?: ComputerWorkspaceSnapshot;
	#targetsAt = 0;
	#flight?: Promise<ComputerFrame | ComputerStructureSnapshot>;
	#flightKey?: string;
	#timer?: NodeJS.Timeout;
	#writes: Promise<void> = Promise.resolve();
	readonly #leases = new Map<string, Lease>();
	readonly #actions = new Map<string, ComputerAction>();
	readonly #frames = new Map<string, StoredFrame>();
	readonly #frameWrites = new Map<string, Promise<void>>();
	readonly #delivered = new Map<string, Set<string>>();
	constructor(
		readonly session: AgentSession,
		options: ComputerWorkspaceOptions = {},
	) {
		this.#options = options;
		this.#unregister = registerComputerScope({
			owns: (id, owner) => {
				const owned =
					!this.#disposed &&
					this.#owned().some(
						session =>
							session.sessionId === id ||
							(!!owner && session.studioToolSession?.getEvalKernelOwnerId?.() === owner),
					);
				if (owned) this.#bind();
				return owned;
			},
			authorize: (id, owner) =>
				this.#policy.authorize(
					this.#owned().find(
						session =>
							session.sessionId === id ||
							(!!owner && session.studioToolSession?.getEvalKernelOwnerId?.() === owner),
					)?.sessionId ?? id,
				),
			event: event => this.#activity(event),
			consumeIntent: (id, message) => this.#policy.consume(id, message),
			deliver: (id, toolCallId, result) => this.#deliver(id, toolCallId, result),
		});
	}
	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}
	#owned(): AgentSession[] {
		return this.#options.ownedSessions?.() ?? ownedStudioSessions(this.session);
	}
	#owns(id: string): boolean {
		return this.#owned().some(session => session.sessionId === id) || this.#historicalSessionIds.has(id);
	}
	#check(id: string): void {
		this.#bind();
		if (this.#disposed || !this.#owns(id))
			throw new SessionControlError("COMMAND_BLOCKED", "Computer session scope changed");
	}
	#bind(): void {
		if (this.#sessionId === this.session.sessionId) return;
		this.#policy?.dispose();
		this.#generation++;
		this.#scopeGeneration++;
		const old = this.#observer;
		const oldMedia = this.#media;
		const oldFrames = [...this.#frames.values()]
			.filter(item => item.frame.source === "observation")
			.map(item => item.frame);
		if (oldMedia)
			this.#writes = this.#writes
				.then(() => Promise.all(oldFrames.map(frame => oldMedia.remove(frame))))
				.then(() => {})
				.catch(() => {});
		this.#observer = undefined;
		old?.cancel();
		void old?.close().catch(() => {});
		this.#leases.clear();
		this.#actions.clear();
		this.#frames.clear();
		this.#delivered.clear();
		this.#historicalFrames.clear();
		this.#historicalSessionIds.clear();
		this.#pendingActions.clear();
		this.#foreground.clear();
		this.#finishedRuns.clear();
		this.#snapshot = undefined;
		this.#targetsAt = 0;
		this.#sessionId = this.session.sessionId;
		this.#manager = this.session.sessionManager;
		const id = this.#sessionId,
			manager = this.#manager;
		const record = manager.findLastCustomEntry?.(
			CONTROL_ENTRY,
			entry => (entry.data as { sessionId?: string })?.sessionId === id,
		);
		const restored = (record?.data as { control?: ComputerControlState } | undefined)?.control;
		const interrupted = this.#restoreHistory();
		this.#policy = new ComputerControlPolicy(
			id,
			{
				persist: async control => {
					manager.appendCustomEntry(CONTROL_ENTRY, { sessionId: id, control });
					await manager.ensureOnDisk();
					await manager.flush();
				},
				cancel: async () => {
					await Promise.all(
						this.#owned()
							.map(session => session.studioToolSession?.getEvalKernelOwnerId?.())
							.filter((owner): owner is string => !!owner)
							.map(owner =>
								this.#options.revoke ? this.#options.revoke(owner) : revokeComputerControlForOwner(owner, true),
							),
					);
				},
				changed: () => this.#stateChanged(),
			},
			interrupted
				? {
						status: "unconfirmed",
						revision: (restored?.revision ?? 0) + 1,
						updatedAt: this.#now(),
						foreground: "none",
						reason: "Runtime restarted during computer work; confirm stop before continuing",
					}
				: restored,
		);
		const directory = this.#options.directory ?? process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#media = directory
			? new ComputerWorkspaceMedia(
					directory,
					id,
					sessionId => this.#owns(sessionId),
					() => this.#now(),
				)
			: undefined;
		const media = this.#media;
		if (media) this.#writes = this.#writes.then(() => media.cleanup(this.#now())).catch(() => {});
	}
	#restoreHistory(): boolean {
		const unfinished = new Map<string, ComputerAction>();
		for (const record of this.#records()) {
			if (record.kind === "start" && record.runId && record.actions[0])
				unfinished.set(record.runId, record.actions[0]);
			if (record.kind === "terminal" && record.runId) unfinished.delete(record.runId);
			for (const action of record.actions) {
				this.#historicalSessionIds.add(action.sessionId);
				this.#remember(action);
			}
			for (const frame of record.frames)
				this.#frames.set(frame.frameId, {
					frame: {
						...frame,
						availability: frame.expiresAt && frame.expiresAt <= this.#now() ? "expired" : frame.availability,
					},
					bytes: 0,
				});
		}
		for (const id of this.#frames.keys()) this.#historicalFrames.add(id);
		this.#trimFrames();
		for (const action of unfinished.values()) {
			const cancelled: ComputerAction = {
				...action,
				status: "cancelled",
				endedAt: this.#now(),
				error: "Runtime interrupted before a terminal result",
			};
			this.#remember(cancelled);
			this.#append({ kind: "terminal", runId: action.runId, actions: [cancelled], frames: [] });
		}
		return unfinished.size > 0;
	}
	#records(): HistoryRecord[] {
		return this.#manager
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom" &&
				entry.customType === HISTORY_ENTRY &&
				(entry.data as HistoryRecord)?.sessionId === this.#sessionId
					? [entry.data as HistoryRecord]
					: [],
			);
	}
	#remember(action: ComputerAction): void {
		this.#actions.delete(action.id);
		this.#actions.set(action.id, action);
		while (this.#actions.size > 200) {
			const oldest = [...this.#actions.values()].find(
				item => item.status !== "running" && item.status !== "waiting",
			);
			if (!oldest) break;
			this.#actions.delete(oldest.id);
		}
	}
	#append(record: Omit<HistoryRecord, "sessionId">): void {
		const manager = this.#manager,
			sessionId = this.#sessionId;
		manager.appendCustomEntry(HISTORY_ENTRY, { ...record, sessionId });
		this.#writes = this.#writes
			.then(async () => {
				await manager.ensureOnDisk();
				await manager.flush();
			})
			.catch(() => {});
	}
	subscribe(listener: (event: ComputerWorkspaceChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(event: ComputerWorkspaceChange): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				/* A detached viewer cannot fail execution. */
			}
		}
	}
	#stateChanged(): void {
		if (this.#policy?.state.status === "stopped") this.#foreground.clear();
		this.#revision++;
		if (this.#snapshot)
			this.#emit({ kind: "state", sessionId: this.#sessionId, revision: this.#revision, snapshot: this.#current() });
		else this.#emit({ kind: "reset", sessionId: this.#sessionId, revision: this.#revision });
	}
	#current(): ComputerWorkspaceSnapshot {
		const base = this.#snapshot ?? {
			version: 1 as const,
			sessionId: this.#sessionId,
			revision: this.#revision,
			updatedAt: this.#now(),
			enabled: false,
			preludeAvailable: false,
			backend: "unavailable",
			capabilities: {
				capture: false,
				input: false,
				accessibility: false,
				globalEscape: false,
				observationOnly: false,
			},
			permissions: { capture: "unknown", input: "unknown", accessibility: "unknown" },
			screen: { locked: false, asleep: false, known: false },
			control: this.#policy.state,
			targets: [],
			active: [],
			frames: [],
		};
		return {
			...base,
			revision: this.#revision,
			updatedAt: this.#now(),
			enabled: cfgComputerEnabled.get(this.session.settings),
			preludeAvailable: this.preludeAvailable(),
			control: this.#policy.state,
			active: [...this.#actions.values()].filter(
				action => action.status === "running" || action.status === "waiting",
			),
			frames: [...this.#frames.values()]
				.map(item => item.frame)
				.filter(frame => !this.#historicalFrames.has(frame.frameId))
				.slice(-50),
		};
	}
	preludeAvailable(): boolean {
		return (
			this.session.studioToolSession?.computerPreludeAvailable?.() ??
			(this.session.getEvalPreludes().some(prelude => prelude.name === "computer") ||
				computerPreludeAvailableForOwner(this.session.studioToolSession?.getEvalKernelOwnerId?.() ?? undefined))
		);
	}
	async setEnabled(enabled: boolean): Promise<void> {
		this.#bind();
		if (enabled && !this.preludeAvailable())
			throw new SessionControlError("CAPABILITY_UNAVAILABLE", "The native Computer Eval prelude is unavailable");
		if (!enabled) await this.#policy.stop("disable");
		cfgComputerEnabled.override(this.session.settings, enabled);
		this.#stateChanged();
	}
	async stop(reason = "stop"): Promise<ComputerControlState> {
		this.#bind();
		return this.#policy.stop(reason);
	}
	async #workspace(): Promise<ComputerWorkspaceSnapshot> {
		await this.#writes;
		for (const item of [...this.#frames.values()].slice(-50)) item.frame = await this.#availableFrame(item.frame);
		let observer: ComputerObserver | undefined;
		try {
			observer = this.#observer ?? (this.#options.observer ?? createComputerObserver)();
			const capabilities = observer.capabilities,
				screen = observer.screenState;
			const supported = observer.observationOnly === true;
			this.#snapshot = {
				...this.#current(),
				backend: capabilities.backend,
				capabilities: {
					capture: capabilities.capture && supported && !!this.#media,
					input: capabilities.input,
					accessibility: capabilities.ax && supported,
					globalEscape: capabilities.globalEscape,
					observationOnly: supported,
				},
				permissions: {
					capture: capabilities.capturePermission,
					input: capabilities.inputPermission,
					accessibility: capabilities.axPermission,
				},
				screen: {
					locked: screen.screenLocked,
					asleep: screen.displayAsleep,
					known: capabilities.backend === "quartz",
				},
				reason: supported
					? this.#media
						? capabilities.backend === "quartz"
							? undefined
							: "This native backend cannot detect screen lock or display sleep; false does not establish an unlocked or awake screen"
						: "Private Computer image transport is unavailable"
					: "This native binding does not support passive observation; rebuild or upgrade the Runtime",
			};
			if (
				supported &&
				!screen.screenLocked &&
				!screen.displayAsleep &&
				(this.#targetsAt === 0 || this.#now() - this.#targetsAt >= 10_000)
			) {
				const generation = this.#generation;
				const [displays, windows] = await Promise.all([observer.listDisplays(), observer.listWindows()]);
				if (generation !== this.#generation) throw new Error("Computer scope changed while reading targets");
				this.#snapshot.targets = [
					...displays.slice(0, 32).map(display => ({
						id: `display:${display.id}`,
						kind: "display" as const,
						name: display.name || display.id,
						width: display.width,
						height: display.height,
					})),
					...windows.slice(0, 224).map(window => ({
						id: `window:${window.id}`,
						kind: "window" as const,
						name: `${window.app} · ${window.title}`.slice(0, 4096),
						width: window.width,
						height: window.height,
					})),
				];
				this.#targetsAt = this.#now();
			}
		} catch (error) {
			this.#snapshot = {
				...this.#current(),
				reason: error instanceof Error ? error.message : "Computer observation unavailable",
			};
		} finally {
			if (observer && observer !== this.#observer) await observer.close();
		}
		return this.#current();
	}
	async query(
		operation: ComputerWorkspaceQuery,
	): Promise<ComputerWorkspaceSnapshot | ComputerActivityPage | ComputerFrame | ComputerStructureSnapshot | null> {
		this.#check(operation.sessionId);
		await this.#expireLeases();
		switch (operation.kind) {
			case "computer.workspace.get":
				return this.#workspace();
			case "computer.activity.list":
				return this.#page(operation.cursor, operation.limit);
			case "computer.frame.get": {
				const known =
					this.#frames.get(operation.frameId)?.frame ?? (await this.#media?.read(operation.frameId))?.frame;
				if (!known) return null;
				return this.#availableFrame(known);
			}
			case "computer.structure.get":
				return this.#capture(operation.sessionId, operation.leaseId, operation.targetId, true);
		}
	}
	async #availableFrame(frame: ComputerFrame): Promise<ComputerFrame> {
		if (await this.#media?.expired(frame.frameId)) return { ...frame, availability: "expired" };
		if (frame.expiresAt && frame.expiresAt <= this.#now()) {
			if (await this.#media?.kept(frame.frameId)) return { ...frame, availability: "available" };
			return { ...frame, availability: "expired" };
		}
		return frame;
	}
	async #page(cursor?: string, requested = 50): Promise<ComputerActivityPage> {
		const offset = cursor === undefined ? 0 : Number(cursor);
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new SessionControlError("INVALID_ARGUMENT", "Invalid Computer history cursor");
		const limit = Math.min(50, Math.max(1, Math.floor(requested)));
		const all = new Map<string, ComputerAction>();
		const frames = new Map<string, ComputerFrame>();
		for (const record of this.#records()) {
			for (const action of record.actions) all.set(action.id, action);
			for (const frame of record.frames) frames.set(frame.frameId, frame);
		}
		for (const action of this.#actions.values()) all.set(action.id, action);
		for (const item of this.#frames.values()) frames.set(item.frame.frameId, item.frame);
		const ordered = [...all.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
		const items = ordered.slice(offset, offset + limit);
		const ids = new Set(items.flatMap(action => action.frameIds));
		return {
			items,
			frames: await Promise.all(
				[...frames.values()].filter(frame => ids.has(frame.frameId)).map(frame => this.#availableFrame(frame)),
			),
			revision: this.#revision,
			...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}),
		};
	}
	async execute(
		operation: ComputerWorkspaceCommand,
	): Promise<
		| ComputerObservationLease
		| { released: true }
		| ComputerFrame
		| ComputerControlState
		| { queued: boolean; control: ComputerControlState }
	> {
		this.#check(operation.sessionId);
		if (operation.kind === "computer.control.stop") return this.stop(operation.reason);
		await this.#expireLeases();
		switch (operation.kind) {
			case "computer.control.continue":
				return this.#continue(operation.revision);
			case "computer.observe.open": {
				if (!operation.consumerId || operation.consumerId.length > 512)
					throw new SessionControlError("INVALID_ARGUMENT", "Observation consumer identity is required");
				const existing = [...this.#leases.values()].find(
					lease => lease.consumerId === operation.consumerId && lease.sessionId === operation.sessionId,
				);
				if (existing) {
					existing.expiresAt = this.#now() + LEASE_TTL;
					this.#armExpiry();
					return this.#leasePublic(existing);
				}
				if (this.#leases.size >= 32)
					throw new SessionControlError("COMMAND_BLOCKED", "Too many observation consumers");
				this.#ensureObserver();
				const lease: Lease = {
					leaseId: crypto.randomUUID(),
					sessionId: operation.sessionId,
					consumerId: operation.consumerId,
					expiresAt: this.#now() + LEASE_TTL,
				};
				this.#leases.set(lease.leaseId, lease);
				this.#armExpiry();
				return this.#leasePublic(lease);
			}
			case "computer.observe.close": {
				const lease = this.#leases.get(operation.leaseId);
				if (lease && lease.sessionId !== operation.sessionId)
					throw new SessionControlError("COMMAND_BLOCKED", "Observation lease belongs to another session");
				this.#leases.delete(operation.leaseId);
				if (!this.#leases.size) await this.#releaseObservation();
				return { released: true };
			}
			case "computer.frame.capture":
				return this.#capture(
					operation.sessionId,
					operation.leaseId,
					operation.targetId,
					false,
				) as Promise<ComputerFrame>;
		}
	}
	#leasePublic(lease: Lease): ComputerObservationLease {
		return { leaseId: lease.leaseId, sessionId: lease.sessionId, expiresAt: lease.expiresAt };
	}
	async #continue(revision: number): Promise<{ queued: boolean; control: ComputerControlState }> {
		const { intent, fresh } = this.#policy.prepareContinue(revision);
		if (fresh) {
			const admitted = Promise.withResolvers<void>();
			const policy = this.#policy;
			const dispatch = this.session.promptCustomMessage<ComputerContinueIntent>(
				{
					customType: "studio-computer-continue",
					content: continuePrompt,
					display: true,
					attribution: "user",
					details: intent,
				},
				{ streamingBehavior: "followUp", onPromptAdmitted: () => admitted.resolve() },
			);
			void dispatch.then(
				started => {
					if (!started) policy.cancelIntent(intent.nonce);
					admitted.resolve();
				},
				error => {
					policy.cancelIntent(intent.nonce);
					admitted.reject(error);
				},
			);
			await admitted.promise;
		}
		return { queued: this.#policy.state.status !== "allowed", control: this.#policy.state };
	}
	#ensureObserver(): ComputerObserver {
		if (!this.#media)
			throw new SessionControlError("CAPABILITY_UNAVAILABLE", "Private Computer image transport is unavailable");
		if (this.#observer) return this.#observer;
		const observer = (this.#options.observer ?? createComputerObserver)();
		if (observer.observationOnly !== true) {
			void observer.close().catch(() => {});
			throw new SessionControlError(
				"CAPABILITY_UNAVAILABLE",
				"The native binding cannot provide passive observation",
			);
		}
		this.#observer = observer;
		return observer;
	}
	#armExpiry(): void {
		if (this.#timer) clearTimeout(this.#timer);
		const next = Math.min(...[...this.#leases.values()].map(lease => lease.expiresAt));
		if (!Number.isFinite(next)) return;
		this.#timer = setTimeout(
			() => {
				void this.#expireLeases().catch(() => {});
			},
			Math.max(1, next - this.#now()),
		);
		this.#timer.unref();
	}
	async #expireLeases(): Promise<void> {
		let removed = false;
		for (const lease of this.#leases.values())
			if (lease.expiresAt <= this.#now()) {
				this.#leases.delete(lease.leaseId);
				removed = true;
			}
		if (removed && !this.#leases.size) await this.#releaseObservation();
		this.#armExpiry();
	}
	async #releaseObservation(): Promise<void> {
		this.#generation++;
		const observer = this.#observer;
		this.#observer = undefined;
		observer?.cancel();
		await this.#flight?.catch(() => {});
		await observer?.close();
		for (const [id, stored] of this.#frames)
			if (stored.frame.source === "observation") {
				await this.#media?.remove(stored.frame);
				this.#frames.delete(id);
			}
		this.#stateChanged();
	}
	async #capture(
		sessionId: string,
		leaseId: string,
		targetId: string,
		structure: boolean,
	): Promise<ComputerFrame | ComputerStructureSnapshot> {
		const lease = this.#leases.get(leaseId);
		if (!lease || lease.sessionId !== sessionId || lease.expiresAt <= this.#now())
			throw new SessionControlError("COMMAND_BLOCKED", "The visible observation lease expired");
		const observer = this.#ensureObserver();
		if (observer.screenState.screenLocked || observer.screenState.displayAsleep)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"The screen is locked or asleep; observation will not wake it",
			);
		if (!this.#snapshot?.targets.some(target => target.id === targetId)) {
			await this.#workspace();
			if (!this.#snapshot?.targets.some(target => target.id === targetId))
				throw new SessionControlError("COMMAND_BLOCKED", "The target is no longer available; refresh targets");
		}
		lease.expiresAt = this.#now() + LEASE_TTL;
		const key = `${sessionId}:${targetId}:${structure}`;
		if (this.#flight) {
			if (this.#flightKey === key) return this.#flight;
			throw new SessionControlError("COMMAND_BLOCKED", "Another observation is in progress");
		}
		const generation = this.#generation,
			media = this.#media!;
		const valid = (): boolean =>
			!this.#disposed &&
			this.#generation === generation &&
			[...this.#leases.values()].some(lease => lease.sessionId === sessionId && lease.expiresAt > this.#now());
		const nativeTarget = targetId.startsWith("window:") ? targetId.slice(7) : targetId;
		const perform = async (): Promise<ComputerFrame | ComputerStructureSnapshot> => {
			const reservedId = crypto.randomUUID();
			await media.reserveObservation(reservedId, sessionId, this.#now() + LEASE_TTL);
			let committed = false;
			try {
				if (!valid()) throw new Error("Observation was released before capture");
				const caps = { maxWidth: 1280, maxHeight: 896 };
				const observation = structure
					? await observer.observe(nativeTarget, caps, { maxDepth: 12, maxNodes: 500, all: true })
					: undefined;
				const capture = observation?.capture ?? (await observer.capture(nativeTarget, caps));
				const frame = this.#frame(capture, sessionId, targetId, "observation");
				frame.frameId = reservedId;
				if (capture.width * capture.height > 4_000_000) throw new Error("Observation exceeds the pixel budget");
				const retainedBytes = [...this.#frames.values()]
					.filter(item => item.frame.source === "observation" && item.frame.targetId !== targetId)
					.reduce((sum, item) => sum + item.bytes, 0);
				if (retainedBytes + capture.data.byteLength > 64 * 1024 * 1024)
					throw new Error("Observation cache exceeds 64 MiB");
				const descriptor = await media.save(frame, capture.data, valid, leaseId);
				try {
					for (const [id, stored] of this.#frames)
						if (stored.frame.source === "observation" && stored.frame.targetId === targetId) {
							await media.remove(stored.frame);
							this.#frames.delete(id);
						}
					if (!valid()) throw new Error("Observation was released");
					this.#frames.set(frame.frameId, { frame, bytes: descriptor.bytes, digest: descriptor.sha256 });
					committed = true;
				} catch (error) {
					await media.remove(frame, false);
					throw error;
				}
				this.#emit({ kind: "frame", sessionId: this.#sessionId, revision: ++this.#revision, frame });
				if (!structure) return frame;
				return {
					snapshotId: crypto.randomUUID(),
					sessionId,
					targetId,
					capturedAt: frame.capturedAt,
					frame,
					nodes: observation?.nodes ?? [],
					truncated: observation?.accessibility.truncated ?? false,
					coordinateSpace: observation?.coordinateSpace === "frame" ? "frame" : "unavailable",
					...(observation?.coordinateSpace === "frame"
						? {}
						: {
								reason:
									"Native capture geometry could not prove an AX-to-frame transform; bounds are not overlaid",
							}),
				};
			} finally {
				if (!committed) await media.releaseObservationReservation(reservedId);
			}
		};
		this.#flightKey = key;
		this.#flight = perform();
		try {
			return await this.#flight;
		} finally {
			this.#flight = undefined;
			this.#flightKey = undefined;
			this.#armExpiry();
		}
	}
	#frame(
		capture: DesktopCapture,
		sessionId: string,
		targetId: string,
		source: ComputerFrame["source"],
	): ComputerFrame {
		return {
			frameId: crypto.randomUUID(),
			sessionId,
			source,
			capturedAt: this.#now(),
			targetId,
			targetName: this.#snapshot?.targets.find(target => target.id === targetId)?.name,
			width: capture.width,
			height: capture.height,
			coordinateWidth: capture.coordinateWidth,
			coordinateHeight: capture.coordinateHeight,
			sourceWidth: capture.sourceWidth,
			sourceHeight: capture.sourceHeight,
			...(capture.region ? { region: capture.region } : {}),
			screenLocked: capture.screenLocked,
			delivered: false,
			availability: "available",
			expiresAt: this.#now() + (source === "execution" ? EXECUTION_TTL : LEASE_TTL),
		};
	}
	#activity(event: ComputerLifecycleEvent): void {
		if (this.#disposed || !this.#owns(event.identity.sessionId)) return;
		const { identity } = event;
		const agent =
			identity.sessionId === this.#sessionId ? undefined : ownedStudioSessionAgent(this.session, identity.sessionId);
		if (event.kind === "control") {
			this.#foreground.set(identity.sessionId, event.foreground);
			const values = [...this.#foreground.values()];
			this.#policy.setForeground(
				values.includes("held")
					? "held"
					: values.includes("requested")
						? "requested"
						: values.includes("unknown")
							? "unknown"
							: "none",
			);
			const run = this.#actions.get(identity.runId);
			if (run && (run.status === "running" || run.status === "waiting")) {
				run.status = event.foreground === "requested" ? "waiting" : "running";
				this.#publishAction(run);
			}
			return;
		}
		if (event.kind === "run" || event.kind === "action") {
			const id = event.kind === "run" ? identity.runId : event.actionId;
			const previous = this.#actions.get(id);
			const action: ComputerAction = {
				id,
				sessionId: identity.sessionId,
				...(agent ? { agentId: agent.id, agentName: agent.displayName } : {}),
				runId: identity.runId,
				toolCallId: identity.toolCallId,
				method: event.kind === "run" ? "computer.run" : event.method,
				mode: event.kind === "run" ? "unknown" : event.mode,
				status: event.phase,
				startedAt: previous?.startedAt ?? event.at,
				frameIds: previous?.frameIds ?? [],
				...(event.kind === "action" && event.target
					? {
							targetId: event.target.startsWith("display:")
								? event.target
								: event.target === "desktop"
									? "display:all"
									: `window:${event.target}`,
						}
					: {}),
			};
			if (event.phase !== "running") action.endedAt = event.at;
			this.#remember(action);
			this.#publishAction(action);
			if (event.kind === "run" && event.phase === "running")
				this.#append({ kind: "start", runId: id, actions: [action], frames: [] });
			if (event.kind === "action" && event.phase !== "running") {
				const batch = this.#pendingActions.get(identity.runId) ?? [];
				batch.push(action);
				if (batch.length >= 50) {
					this.#append({ kind: "frames", runId: identity.runId, actions: batch.splice(0), frames: [] });
				}
				this.#pendingActions.set(identity.runId, batch);
			}
			if (event.kind === "run" && event.phase !== "running") {
				this.#finishedRuns.add(identity.runId);
				while (this.#finishedRuns.size > 200) this.#finishedRuns.delete(this.#finishedRuns.values().next().value!);
				const generation = this.#scopeGeneration;
				const writes = [...this.#frameWrites.values()];
				const settlement = Promise.all(writes).then(async () => {
					if (generation !== this.#scopeGeneration) return;
					for (const pending of this.#actions.values())
						if (
							pending.runId === identity.runId &&
							pending.id !== action.id &&
							(pending.status === "running" || pending.status === "waiting")
						) {
							pending.status = event.phase === "cancelled" ? "cancelled" : "failed";
							pending.endedAt = event.at;
							this.#publishAction(pending);
							const cancelled = this.#pendingActions.get(identity.runId) ?? [];
							cancelled.push(pending);
							this.#pendingActions.set(identity.runId, cancelled);
						}
					const frames = [...this.#frames.values()]
						.map(item => item.frame)
						.filter(frame => frame.runId === identity.runId);
					await Promise.all(frames.map(frame => this.#media?.update(frame, true).catch(() => {})));
					const actions = this.#pendingActions.get(identity.runId) ?? [];
					this.#pendingActions.delete(identity.runId);
					for (let index = 0; index < frames.length; index += 50)
						this.#append({
							kind: "frames",
							runId: identity.runId,
							actions: [],
							frames: frames.slice(index, index + 50),
						});
					this.#append({
						kind: "terminal",
						runId: identity.runId,
						actions: [...actions, action].slice(-50),
						frames: [],
					});
				});
				this.#settlements.add(settlement);
				void settlement.finally(() => this.#settlements.delete(settlement));
			}
			return;
		}
		const shot = event.screenshot;
		if (!shot.frameId) return;
		const frame: ComputerFrame = {
			frameId: shot.frameId,
			sessionId: identity.sessionId,
			...(agent ? { agentId: agent.id } : {}),
			source: "execution",
			capturedAt: event.at,
			targetId: shot.target.startsWith("display:")
				? shot.target
				: shot.target === "desktop"
					? "display:all"
					: `window:${shot.target}`,
			runId: identity.runId,
			toolCallId: identity.toolCallId,
			actionId: event.actionId,
			width: shot.width,
			height: shot.height,
			coordinateWidth: shot.coordinateWidth,
			coordinateHeight: shot.coordinateHeight,
			...(shot.sourceWidth ? { sourceWidth: shot.sourceWidth } : {}),
			...(shot.sourceHeight ? { sourceHeight: shot.sourceHeight } : {}),
			...(shot.region ? { region: shot.region } : {}),
			screenLocked: shot.screenLocked === true,
			delivered: false,
			availability: "pending",
			expiresAt: event.at + EXECUTION_TTL,
		};
		for (const id of [identity.runId, event.actionId]) {
			const action = id ? this.#actions.get(id) : undefined;
			if (action && !action.frameIds.includes(frame.frameId)) {
				action.frameIds.push(frame.frameId);
				this.#publishAction(action);
			}
		}
		this.#historicalSessionIds.add(frame.sessionId);
		this.#frames.set(frame.frameId, { frame, bytes: 0, ...(shot.sha256 ? { digest: shot.sha256 } : {}) });
		this.#emit({ kind: "frame", sessionId: this.#sessionId, revision: ++this.#revision, frame: { ...frame } });
		const generation = this.#scopeGeneration,
			media = this.#media;
		const valid = (): boolean =>
			!this.#disposed && generation === this.#scopeGeneration && this.#owns(frame.sessionId);
		const persist = async (): Promise<void> => {
			try {
				await this.#writes;
				if (!media) throw new Error("Computer image transport unavailable");
				const stat = await fs.lstat(shot.path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
					throw new Error("Computer image exceeds resource budget");
				const bytes = await fs.readFile(shot.path);
				const digest = createHash("sha256").update(bytes).digest("hex");
				if (shot.sha256 && digest !== shot.sha256) throw new Error("Computer evidence changed after capture");
				frame.delivered = this.#delivered.get(`${frame.sessionId}:${frame.toolCallId}`)?.has(digest) ?? false;
				frame.availability = "available";
				const descriptor = await media.save(frame, bytes, valid);
				if (valid()) {
					this.#frames.set(frame.frameId, { frame, bytes: descriptor.bytes, digest });
					if (this.#finishedRuns.has(identity.runId)) {
						await media.update(frame, true);
						this.#append({ kind: "frames", runId: identity.runId, actions: [], frames: [{ ...frame }] });
					}
				}
			} catch {
				frame.availability = "unavailable";
			}
			if (valid()) {
				this.#emit({ kind: "frame", sessionId: this.#sessionId, revision: ++this.#revision, frame: { ...frame } });
				this.#trimFrames();
			}
		};
		const write = persist().finally(() => this.#frameWrites.delete(frame.frameId));
		this.#frameWrites.set(frame.frameId, write);
	}
	#publishAction(action: ComputerAction): void {
		this.#emit({
			kind: "action",
			sessionId: this.#sessionId,
			revision: ++this.#revision,
			action: { ...action, frameIds: [...action.frameIds] },
		});
	}
	#trimFrames(): void {
		while (this.#frames.size > 200) {
			const candidate = [...this.#frames].find(
				([, item]) => item.frame.source === "execution" && item.frame.availability !== "pending",
			);
			if (!candidate) break;
			this.#frames.delete(candidate[0]);
			this.#historicalFrames.delete(candidate[0]);
		}
	}
	#deliver(sessionId: string, toolCallId: string, value: unknown): void {
		if (!value || typeof value !== "object") return;
		const result = value as { content?: unknown; details?: unknown };
		const frames = [...this.#frames.values()].filter(
			item => item.frame.sessionId === sessionId && item.frame.toolCallId === toolCallId,
		);
		if (!frames.length) return;
		const digests = new Set<string>();
		if (Array.isArray(result.content))
			for (const block of result.content) {
				if (
					block &&
					typeof block === "object" &&
					block.type === "image" &&
					block.mimeType === "image/png" &&
					typeof block.data === "string"
				) {
					const digest = createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex");
					digests.add(digest);
					const linked = frames.find(item => item.digest === digest);
					if (linked) block.computerFrame = { frameId: linked.frame.frameId, sessionId, toolCallId };
				}
			}
		const key = `${sessionId}:${toolCallId}`;
		this.#delivered.set(key, digests);
		while (this.#delivered.size > 200) this.#delivered.delete(this.#delivered.keys().next().value!);
		const references = frames.map(item => ({
			frameId: item.frame.frameId,
			sessionId,
			toolCallId,
			delivered: !!item.digest && digests.has(item.digest),
		}));
		// Metadata only, at the genuine outer result boundary; never inject pixels into state/ledger.
		result.details = {
			...(result.details && typeof result.details === "object" && !Array.isArray(result.details)
				? result.details
				: {}),
			computerFrames: references,
		};
		for (const stored of frames)
			if (stored.digest && digests.has(stored.digest)) {
				stored.frame.delivered = true;
				this.#emit({
					kind: "frame",
					sessionId: this.#sessionId,
					revision: ++this.#revision,
					frame: { ...stored.frame },
				});
				void this.#media?.update(stored.frame).catch(() => {});
			}
		this.#append({ kind: "frames", actions: [], frames: frames.map(item => ({ ...item.frame })).slice(-50) });
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unregister();
		this.#policy?.dispose();
		if (this.#timer) clearTimeout(this.#timer);
		this.#leases.clear();
		await this.#releaseObservation();
		await Promise.all(this.#frameWrites.values());
		await Promise.all(this.#settlements);
		await this.#writes;
		this.#listeners.clear();
	}
}
