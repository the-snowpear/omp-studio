import { isRecord } from "@oh-my-pi/pi-utils";
import { isShellTrace } from "@oh-my-pi/pi-wire/shell-trace";
import {
	defaultShellVizPreferences,
	readShellPresentation,
	shellVisualization,
} from "@oh-my-pi/pi-tui/tools/shell-viz";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { loadEntriesFromFile } from "../../session/session-loader";
import { isAgentViewSession } from "../../session/agent-session-handle";
import { cfgDisplayShellVisualization } from "../../modes/settings";
import type { RuntimeViewOperation } from "../runtime-views-protocol";
import type { StudioLiveAudioService } from "./live-audio-service";
import { ownedStudioAgent } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";
import { studioLinkTarget } from "./extension-links-service";
import { managedBrowserFor } from "./managed-browser-service";

/** Reads native state and negotiates media without recording transient payloads. */
export class StudioRuntimeViews {
	constructor(
		readonly session: AgentSession,
		readonly audio: StudioLiveAudioService,
	) {}
	async execute(operation: RuntimeViewOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The Runtime view belongs to another session");
		switch (operation.kind) {
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
			case "shell.view.read": {
				if (!cfgDisplayShellVisualization.get(this.session.settings))
					return { available: false, reason: "Shell visualization is disabled." };
				const ref = operation.agentId ? ownedStudioAgent(this.session, operation.agentId) : undefined;
				const target = operation.agentId ? ref?.session : this.session;
				const useLive =
					!operation.sourceSessionId || operation.sourceSessionId === target?.sessionManager.getSessionId();
				let messages = target?.messages ?? [];
				let archived = ref?.sessionFile ?? undefined;
				if (operation.sourceSessionId && operation.sourceSessionId !== target?.sessionManager.getSessionId()) {
					const entry = (await SessionManager.listAll()).find(row => row.id === operation.sourceSessionId);
					if (!entry)
						throw new SessionControlError("COMMAND_BLOCKED", "The recorded shell session is unavailable");
					archived = entry.path;
					messages = [];
				}
				if (messages.length === 0 && archived)
					messages = (await loadEntriesFromFile(archived)).flatMap(entry =>
						entry.type === "message" ? [entry.message] : [],
					);
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
				const trace = isRecord(details) ? details.trace : undefined;
				if (!isShellTrace(trace))
					return { available: false, reason: "This command has no recorded execution trace." };
				const presentation = readShellPresentation(
					shellVisualization(trace),
					operation.preferences ?? defaultShellVizPreferences(),
					trace,
				);
				return { available: true, presentation };
			}
		}
	}
}
