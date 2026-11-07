import { ownedStudioSessions } from "./owned-sessions";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DesktopSession } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "../../session/agent-session";
import { cfgComputerEnabled } from "../../tools/settings";
import { computerActivityForOwner, revokeComputerControlForOwner } from "../../tools/computer/supervisor";
import type {
	ComputerObservationOperation,
	StudioComputerStatus,
	StudioComputerTarget,
} from "../computer-observation-protocol";
import { SessionControlError } from "./session-control-service";
import type { StudioComputerWorkspaceService } from "./computer-workspace-service";
import type { ComputerWorkspaceSnapshot } from "../computer-workspace-protocol";

/** Uses native capture only. No mouse or keyboard API is exposed to Studio. */
export class StudioComputerObservationService {
	#desktop?: DesktopSession;
	#captureSession?: DesktopSession;
	#timer?: NodeJS.Timeout;
	#capturing = false;
	#generation = 0;
	readonly #captures = new Map<string, NodeJS.Timeout>();
	readonly #targets = new Map<string, { display: string; target: string }>();
	constructor(
		readonly session: AgentSession,
		readonly directory = process.env.OMP_STUDIO_MEDIA_ROOT,
		readonly workspace?: StudioComputerWorkspaceService,
	) {}
	#owners(): string[] {
		return ownedStudioSessions(this.session)
			.map(session => session.studioEvalKernelOwnerId)
			.filter((owner): owner is string => typeof owner === "string");
	}
	#ensure(): DesktopSession {
		this.#desktop ??= this.#createObserver("all");
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.release(), 15_000);
		this.#timer.unref();
		return this.#desktop;
	}
	#createObserver(display: string): DesktopSession {
		const options = { display, observationOnly: true };
		const observer = new DesktopSession(options);
		if ((observer as DesktopSession & { observationOnly?: boolean }).observationOnly !== true) {
			void observer.close().catch(() => {});
			throw new SessionControlError("CAPABILITY_UNAVAILABLE", "Native binding does not support passive observation");
		}
		return observer;
	}
	async status(): Promise<StudioComputerStatus> {
		if (this.workspace) {
			const snapshot = (await this.workspace.query({
				kind: "computer.workspace.get",
				sessionId: this.session.sessionId,
			})) as ComputerWorkspaceSnapshot;
			this.#targets.clear();
			for (const target of snapshot.targets)
				this.#targets.set(target.id, {
					display: target.kind === "display" ? target.id.slice(8) : "all",
					target: target.kind === "display" ? "desktop" : target.id.slice(7),
				});
			return {
				enabled: snapshot.enabled,
				available: snapshot.capabilities.capture,
				backend: snapshot.backend,
				capturePermission: snapshot.permissions.capture,
				inputPermission: snapshot.permissions.input,
				axPermission: snapshot.permissions.accessibility,
				running: snapshot.active.filter(action => action.method === "computer.run").length,
				targets: snapshot.targets,
				...(snapshot.reason ? { reason: snapshot.reason } : {}),
			};
		}
		const result: StudioComputerStatus = {
			enabled: cfgComputerEnabled.get(this.session.settings),
			available: false,
			backend: "unavailable",
			capturePermission: "unknown",
			inputPermission: "unknown",
			axPermission: "unknown",
			running: this.#owners().reduce((sum, owner) => sum + computerActivityForOwner(owner), 0),
			targets: [],
		};
		if (!result.enabled) return { ...result, reason: "Computer Use is disabled in native settings." };
		if (!this.directory) return { ...result, reason: "Private desktop capture transport is unavailable." };
		try {
			const desktop = this.#ensure();
			const capabilities = desktop.capabilities;
			Object.assign(result, {
				backend: capabilities.backend,
				available: capabilities.capture,
				capturePermission: capabilities.capturePermission,
				inputPermission: capabilities.inputPermission,
				axPermission: capabilities.axPermission,
			});
			if (!capabilities.capture)
				return { ...result, reason: "Screen capture is unavailable or permission has not been granted." };
			const [displays, windows] = await Promise.all([desktop.listDisplays(), desktop.listWindows()]);
			if (desktop !== this.#desktop) throw new Error("Computer observation was released");
			this.#targets.clear();
			const targets: StudioComputerTarget[] = [];
			for (const display of displays.slice(0, 32)) {
				const id = "display:" + display.id;
				this.#targets.set(id, { display: display.id, target: "desktop" });
				targets.push({
					id,
					kind: "display",
					name: display.name || display.id,
					width: display.width,
					height: display.height,
				});
			}
			for (const window of windows.slice(0, 224)) {
				const id = "window:" + window.id;
				this.#targets.set(id, { display: "all", target: window.id });
				targets.push({
					id,
					kind: "window",
					name: (window.app + " · " + window.title).slice(0, 4096),
					width: window.width,
					height: window.height,
				});
			}
			result.targets = targets;
		} catch (error) {
			result.reason = error instanceof Error ? error.message : String(error);
		}
		return result;
	}
	async execute(operation: ComputerObservationOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The session changed; reload computer targets");
		if (operation.kind === "computer.status") return this.status();
		if (operation.kind === "computer.configure") {
			if (this.workspace) {
				await this.workspace.setEnabled(operation.enabled);
				if (!operation.enabled) this.release();
				return { enabled: cfgComputerEnabled.get(this.session.settings) };
			}
			cfgComputerEnabled.set(this.session.settings, operation.enabled);
			await this.session.settings.flush();
			if (!operation.enabled) this.release();
			return { enabled: cfgComputerEnabled.get(this.session.settings) };
		}
		if (operation.kind === "computer.stop") {
			if (this.workspace) await this.workspace.stop();
			else await Promise.all(this.#owners().map(owner => revokeComputerControlForOwner(owner)));
			return { stopped: true };
		}
		if (operation.kind === "computer.observe.release") {
			this.release();
			return { released: true };
		}
		if (!cfgComputerEnabled.get(this.session.settings) || !this.directory)
			throw new SessionControlError("COMMAND_BLOCKED", "Computer capture is unavailable");
		if (this.#capturing) throw new SessionControlError("COMMAND_BLOCKED", "A computer capture is already running");
		const target = this.#targets.get(operation.targetId);
		if (!target)
			throw new SessionControlError("COMMAND_BLOCKED", "The target changed; refresh the screen and window list");
		const generation = this.#generation;
		const captureSession = target.display === "all" ? this.#ensure() : this.#createObserver(target.display);
		this.#capturing = true;
		this.#captureSession = captureSession;
		try {
			const capture = await captureSession.capture(target.target, { maxWidth: 1280, maxHeight: 896 });
			if (generation !== this.#generation || operation.sessionId !== this.session.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Capture cancelled by a session or view change");
			if (capture.data.byteLength > 8 * 1024 * 1024 || capture.width * capture.height > 4_000_000)
				throw new SessionControlError("COMMAND_BLOCKED", "Capture exceeds the resource budget");
			const id = randomUUID();
			const directory = path.join(this.directory, "computer");
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			const result = {
				captureId: id,
				sessionId: operation.sessionId,
				targetId: operation.targetId,
				width: capture.width,
				height: capture.height,
				expiresAt: Date.now() + 30_000,
			};
			try {
				await fs.writeFile(path.join(directory, id + ".png"), capture.data, { flag: "wx", mode: 0o600 });
				await fs.writeFile(path.join(directory, id + ".json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
			} catch (error) {
				await Promise.all(
					[".png", ".json"].map(suffix => fs.unlink(path.join(directory, id + suffix)).catch(() => {})),
				);
				throw error;
			}
			if (generation !== this.#generation) {
				await Promise.all([
					fs.unlink(path.join(directory, id + ".png")).catch(() => {}),
					fs.unlink(path.join(directory, id + ".json")).catch(() => {}),
				]);
				throw new SessionControlError("COMMAND_BLOCKED", "Capture view was released");
			}
			const timer = setTimeout(() => this.#remove(id), 30_000);
			timer.unref();
			this.#captures.set(id, timer);
			return result;
		} finally {
			this.#capturing = false;
			this.#captureSession = undefined;
			if (target.display !== "all") await captureSession.close();
		}
	}
	#remove(id: string): void {
		const timer = this.#captures.get(id);
		if (timer) clearTimeout(timer);
		this.#captures.delete(id);
		if (this.directory)
			for (const suffix of [".png", ".json"])
				void fs.unlink(path.join(this.directory, "computer", id + suffix)).catch(() => {});
	}
	release(): void {
		this.#generation++;
		this.#captureSession?.cancel();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		const desktop = this.#desktop;
		this.#desktop = undefined;
		desktop?.cancel();
		void desktop?.close().catch(() => {});
		this.#targets.clear();
		for (const id of this.#captures.keys()) this.#remove(id);
	}
	dispose(): void {
		this.release();
	}
}
