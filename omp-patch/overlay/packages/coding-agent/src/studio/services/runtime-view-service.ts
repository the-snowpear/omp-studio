import { isRecord } from "@oh-my-pi/pi-utils";
import { isShellTrace, type ShellTrace } from "@oh-my-pi/pi-wire/shell-trace";
import {
	defaultShellVizPreferences,
	readShellPresentation,
	shellVisualization,
} from "@oh-my-pi/pi-tui/tools/shell-viz";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { probeSessionLeases } from "../../session/session-storage";
import { loadEntriesFromFile } from "../../session/session-loader";
import { isAgentViewSession } from "../../session/agent-session-handle";
import { cfgDisplayShellVisualization } from "../../modes/settings";
import type { RuntimeViewOperation } from "../runtime-views-protocol";
import type { InteractionForm } from "../form-protocol";
import {
	isModelServicesQueryKind,
	type ModelServicesOperation,
	type ModelServicesQueryInputMap,
} from "../model-services-protocol";
import type { StudioLiveAudioService } from "./live-audio-service";
import { ownedStudioAgent } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";
import { studioLinkTarget } from "./extension-links-service";
import { managedBrowserFor } from "./managed-browser-service";
import { readStudioTaskOptions } from "./task-options-service";

type ShellRead = Extract<RuntimeViewOperation, { kind: "shell.view.read" }>;
function shellKey(operation: Pick<ShellRead, "sessionId" | "sourceSessionId" | "agentId" | "toolCallId">): string {
	return JSON.stringify([operation.sessionId, operation.sourceSessionId, operation.agentId, operation.toolCallId]);
}

/** Reads native state and negotiates media without recording transient payloads. */
export class StudioRuntimeViews {
	formReader?: (interactionId: string, leaseGeneration: number) => { form: InteractionForm };
	modelServicesReader?: (
		operation: Extract<ModelServicesOperation, { kind: keyof ModelServicesQueryInputMap }>,
	) => Promise<unknown>;
	#closeAttempt: AbortController | undefined;
	// One open recorded command shares its journal load and native visualization across replay steps.
	#recordedShell: { key: string; trace: Promise<ShellTrace | undefined> } | undefined;
	constructor(
		readonly session: AgentSession,
		readonly audio: StudioLiveAudioService,
	) {}
	dispose(): void {
		this.cancelClose();
		this.#recordedShell = undefined;
	}
	cancelClose(): void {
		this.#closeAttempt?.abort();
		this.#closeAttempt = undefined;
	}
	async #confirmClose(): Promise<{ allowed: boolean }> {
		if (this.session.isDisposed) return { allowed: true };
		this.cancelClose();
		const attempt = new AbortController();
		this.#closeAttempt = attempt;
		try {
			// Native handler budgets pause while the operator answers a dialog.
			// Only an actual stop/dispose aborts this reversible close attempt.
			return { allowed: await this.session.confirmClose(attempt.signal) };
		} catch {
			return { allowed: true };
		} finally {
			if (this.#closeAttempt === attempt) this.#closeAttempt = undefined;
		}
	}
	async execute(operation: RuntimeViewOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The Runtime view belongs to another session");
		if (isModelServicesQueryKind(operation.kind)) {
			if (!this.modelServicesReader)
				throw new SessionControlError("CAPABILITY_UNAVAILABLE", "Native model services are unavailable");
			return this.modelServicesReader(
				operation as Extract<ModelServicesOperation, { kind: keyof ModelServicesQueryInputMap }>,
			);
		}
		switch (operation.kind) {
			case "runtime.close.confirm":
				return this.#confirmClose();
			case "interaction.form.read":
				if (!this.formReader) throw new SessionControlError("COMMAND_BLOCKED", "No form is pending");
				return this.formReader(operation.interactionId, operation.leaseGeneration);
			case "agent.spawn.options.read":
				return readStudioTaskOptions(this.session, operation.definition);
			case "session.lease.read":
				return probeSessionLeases(operation.targetSessionIds);
			case "extensions.links.list":
				return { schemes: studioLinkTarget(this.session, operation)?.getStudioLinkSchemes() ?? [] };
			case "browser.webmcp.list": {
				const browser = managedBrowserFor(operation.sessionId);
				if (!browser)
					return {
						pageId: operation.pageId,
						status: "unavailable",
						tools: [],
						truncated: false,
						untrusted: true,
						invocationAvailable: false,
						reason: "Connect this chat's managed desktop browser to inspect its page tools.",
					};
				return browser.webMcpList(operation.sessionId, operation.pageId, operation.options);
			}
			case "session.cache.get":
				return { cache: this.session.getPromptCacheStatus() ?? null };
			case "live.webrtc.connect":
				return this.audio.connectWebRtc(operation);
			case "live.webrtc.status":
				return this.audio.webRtcStatus(operation.sessionId, operation.audioId);
			case "live.webrtc.mute":
				return this.audio.execute({ ...operation, kind: "live.audio.mute" });
			case "live.webrtc.release":
				return this.audio.execute({ ...operation, kind: "live.audio.release" });
			case "shell.view.release":
				if (this.#recordedShell?.key === shellKey(operation)) this.#recordedShell = undefined;
				return { released: true };
			case "shell.view.read": {
				if (!cfgDisplayShellVisualization.get(this.session.settings))
					return { available: false, reason: "Shell visualization is disabled." };
				const ref = operation.agentId ? ownedStudioAgent(this.session, operation.agentId) : undefined;
				const target = operation.agentId ? ref?.session : this.session;
				const useLive =
					!operation.sourceSessionId || operation.sourceSessionId === target?.sessionManager.getSessionId();
				const messages = useLive ? (target?.messages ?? []) : [];
				const result = messages.findLast(
					message => message.role === "toolResult" && message.toolCallId === operation.toolCallId,
				);
				const update =
					useLive && target && isAgentViewSession(target)
						? target.activeToolExecutionUpdates().find(event => event.toolCallId === operation.toolCallId)
						: undefined;
				let details =
					update?.partialResult?.details ?? (result?.role === "toolResult" ? result.details : undefined);
				if (useLive && isRecord(details) && isRecord(details.async) && typeof details.async.jobId === "string") {
					const job = this.session.asyncJobManager?.getJob(details.async.jobId);
					if (job?.latestDetails) details = job.latestDetails;
				}
				const liveTrace = isRecord(details) ? details.trace : undefined;
				let trace: ShellTrace | undefined;
				if (isShellTrace(liveTrace)) {
					trace = liveTrace;
					this.#recordedShell = undefined;
				} else {
					const file = useLive ? (ref?.sessionFile ?? target?.sessionManager.getSessionFile()) : undefined;
					if (!useLive || file) trace = await this.#readRecordedShell(operation, file);
				}
				if (!trace) return { available: false, reason: "This command has no recorded execution trace." };
				const visualization = shellVisualization(trace);
				if (!visualization)
					return { available: false, reason: "The native engine cannot replay this recorded shell trace." };
				const presentation = readShellPresentation(
					visualization,
					operation.preferences ?? defaultShellVizPreferences(),
					trace,
				);
				return { available: true, presentation };
			}
		}
	}

	async #readRecordedShell(operation: ShellRead, file?: string): Promise<ShellTrace | undefined> {
		const key = shellKey(operation);
		let cached = this.#recordedShell;
		if (cached?.key !== key) {
			cached = { key, trace: this.#loadRecordedShell(operation, file) };
			this.#recordedShell = cached;
		}
		try {
			const trace = await cached.trace;
			if (!trace && this.#recordedShell === cached) this.#recordedShell = undefined;
			return trace;
		} catch (error) {
			if (this.#recordedShell === cached) this.#recordedShell = undefined;
			throw error;
		}
	}

	async #loadRecordedShell(operation: ShellRead, file?: string): Promise<ShellTrace | undefined> {
		const source = file ?? (await SessionManager.listAll()).find(row => row.id === operation.sourceSessionId)?.path;
		if (!source) throw new SessionControlError("COMMAND_BLOCKED", "The recorded shell session is unavailable");
		const entries = await loadEntriesFromFile(source);
		const entry = entries.findLast(
			row =>
				row.type === "message" &&
				row.message.role === "toolResult" &&
				row.message.toolCallId === operation.toolCallId,
		);
		const details =
			entry?.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
		return isRecord(details) && isShellTrace(details.trace) ? details.trace : undefined;
	}
}
