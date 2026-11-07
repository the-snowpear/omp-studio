import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { rpcSync } from "../../thread/rpc";
import { getCfgApprovalHost, setCfgApprovalHost, type CfgApprovalHost } from "../../internal-urls/cfg-protocol";
import { ignoreSettle, PeerCleanups } from "../../thread/services/support";
import type { ThreadService } from "../../thread/services";
import { setDefaultToolUiFactory } from "../../tools/context";
import { createStudioRemoteUiFactory, type StudioUiGateway } from "../remote-extension-ui";
import type { StudioInteractionGateway } from "./interaction-port";
import {
	managedBrowserFor,
	installManagedBrowserAccess,
	type StudioManagedBrowserAccess,
} from "./managed-browser-service";
import {
	computerRunPermits,
	hasComputerScope,
	emitComputerLifecycle,
	computerUserMessageStarted,
	computerToolResultDelivered,
	installComputerScopeBridge,
	type ComputerScopeBridge,
} from "../computer-runtime-lifecycle";

interface StudioThreadState {
	paused: boolean;
	interaction?: StudioUiGateway;
}
interface StudioThreadGlobals {
	watch(listener: (state: StudioThreadState) => void): StudioThreadState;
	browser(sessionId: string): StudioManagedBrowserAccess | undefined;
	computer: ComputerScopeBridge;
	configuration(): CfgApprovalHost | null;
}

let interaction: StudioUiGateway | undefined;
const listeners = new Set<(state: StudioThreadState) => void>();
const cleanups = new PeerCleanups("studio");

function state(): StudioThreadState {
	return { paused: agentPauseGate.paused, interaction };
}

function publish(): void {
	const snapshot = state();
	for (const listener of listeners) {
		Promise.resolve(listener(snapshot)).catch(error =>
			logger.debug("Studio worker disconnected", { error: String(error) }),
		);
	}
}

/** Bind all local and worker child dialogs to the Runtime's interaction owner. */
export function setStudioThreadInteraction(gateway: StudioInteractionGateway | undefined): void {
	interaction = gateway
		? {
				select: input => gateway.select(input),
				ask: input => gateway.ask(input),
				confirm: input => gateway.confirm(input),
				input: input => gateway.input(input),
				approve: input => gateway.approve(input),
				editor: input => gateway.editor(input),
				notify: (message, level) => gateway.notify(message, level),
				cancelCommand: rpcSync((commandId, reason, outcome) => gateway.cancelCommand(commandId, reason, outcome)),
			}
		: undefined;
	setDefaultToolUiFactory(interaction ? createStudioRemoteUiFactory(interaction) : undefined);
	publish();
}

/** Extends the native thread bridge; workers keep native loops, jobs and cost gates. */
export const studioThreadService: ThreadService = {
	name: "studio",
	globals(peer): StudioThreadGlobals {
		return {
			browser: rpcSync(sessionId => {
				const owner = managedBrowserFor(sessionId);
				if (!owner) return undefined;
				return {
					kind: owner.kind,
					name: rpcSync(name => owner.name(name)),
					contains: rpcSync(name => owner.contains(name)),
					begin: async (signal, readOnly) =>
						rpcSync(cleanups.track(peer.threadId, await owner.begin(signal, readOnly))),
					webMcpList: (id, pageId, options) => owner.webMcpList(id, pageId, options),
					webMcpInvoke: operation => owner.webMcpInvoke(operation),
				};
			}),
			computer: {
				has: rpcSync(hasComputerScope),
				permits: computerRunPermits,
				event: emitComputerLifecycle,
				consumeIntent: computerUserMessageStarted,
				deliver: computerToolResultDelivered,
			},
			configuration: rpcSync(() => {
				const host = getCfgApprovalHost();
				return host
					? {
							persistentSettings: host.persistentSettings,
							approve: (request, options) => host.approve(request, options),
							applied: rpcSync(change => host.applied(change)),
						}
					: null;
			}),
			watch: rpcSync(listener => {
				listeners.add(listener);
				const stopPause = agentPauseGate.onChange(() => ignoreSettle(listener(state())));
				cleanups.track(peer.threadId, () => {
					listeners.delete(listener);
					stopPause();
				});
				return state();
			}),
		};
	},
	boot(globals): void {
		const source = globals as StudioThreadGlobals;
		installManagedBrowserAccess(source.browser);
		setCfgApprovalHost(source.configuration());
		installComputerScopeBridge({
			has: source.computer.has,
			permits: source.computer.permits,
			event: event => ignoreSettle(source.computer.event(event)),
			consumeIntent: (sessionId, message) => ignoreSettle(source.computer.consumeIntent(sessionId, message)),
			deliver: (sessionId, toolCallId, result) =>
				ignoreSettle(source.computer.deliver(sessionId, toolCallId, result)),
		});
		const apply = (snapshot: StudioThreadState) => {
			if (snapshot.paused) agentPauseGate.pause();
			else agentPauseGate.resume();
			setDefaultToolUiFactory(snapshot.interaction ? createStudioRemoteUiFactory(snapshot.interaction) : undefined);
		};
		apply(source.watch(apply));
	},
	onWorkerExit(peer): void {
		cleanups.release(peer.threadId);
	},
};
