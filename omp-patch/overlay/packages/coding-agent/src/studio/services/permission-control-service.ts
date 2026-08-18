export type StudioApprovalMode = "always-ask" | "write" | "yolo";

export class StudioPermissionControlError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioPermissionControlError";
	}
}

export interface StudioPermissionSettings {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	clearOverride(key: string): void;
	override(key: string, value: unknown): void;
	flush(): Promise<void>;
}

export interface StudioPermissionSession {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly settings?: StudioPermissionSettings;
}

type PendingApprovalMode = {
	mode: StudioApprovalMode;
	persist: boolean;
};

/**
 * Runtime-owned tool approval mode. A switch during streaming or compacting
 * is accepted and projected immediately, but `tools.approvalMode` waits for
 * the next user turn so the in-flight tools keep the previous trust level.
 */
export class StudioPermissionControlService {
	#pending: PendingApprovalMode | undefined;

	constructor(private readonly session: StudioPermissionSession) {}

	state(): StudioApprovalMode {
		return this.#pending?.mode ?? readApprovalMode(this.session.settings);
	}

	async setMode(mode: StudioApprovalMode, persist: boolean): Promise<{ mode: StudioApprovalMode; persisted: boolean }> {
		if (mode !== "always-ask" && mode !== "write" && mode !== "yolo") {
			throw new StudioPermissionControlError("INVALID_ARGUMENT", `Unsupported approval mode: ${mode}`);
		}
		if (this.#shouldDefer()) {
			this.#pending = { mode, persist };
			return { mode, persisted: persist };
		}
		await this.#commit({ mode, persist });
		return { mode, persisted: persist };
	}

	/** Apply a deferred switch. Safe when idle; no-ops when nothing is queued. */
	async applyPending(): Promise<void> {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		try {
			await this.#commit(pending);
		} catch (error) {
			this.#pending = pending;
			throw error;
		}
	}

	#shouldDefer(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.#pending !== undefined;
	}

	async #commit(pending: PendingApprovalMode): Promise<void> {
		const settings = this.session.settings;
		if (settings === undefined) {
			throw new StudioPermissionControlError("COMMAND_BLOCKED", "Session settings are unavailable");
		}
		if (pending.persist) {
			settings.clearOverride("tools.approvalMode");
			settings.set("tools.approvalMode", pending.mode);
			await settings.flush();
			return;
		}
		settings.override("tools.approvalMode", pending.mode);
	}
}

function readApprovalMode(settings: StudioPermissionSettings | undefined): StudioApprovalMode {
	if (settings === undefined) return "yolo";
	const value = settings.get("tools.approvalMode");
	return value === "always-ask" || value === "write" || value === "yolo" ? value : "yolo";
}
