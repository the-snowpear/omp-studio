import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { rpcSync } from "../../thread/rpc";
import { currentThreadId, type ThreadId } from "../../thread/identity";
import { findLocalSession, type SessionToken } from "../../thread/session-directory";
import { sessionToken } from "../../thread/services/identity";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import {
	StudioBrowserObservationService,
	installBrowserObservationAccess,
	type StudioBrowserObservationAccess,
	type NativeBrowserHomeOperation,
	type NativeBrowserHomeResult,
	type NativeBrowserResult,
} from "./browser-observation-service";
import type { StudioBrowserTab } from "../browser-observation-protocol";
import type { StudioWebMcpCatalog, WebMcpInvokeResult } from "../webmcp-protocol";
import { getCfgApprovalHost, setCfgApprovalHost, type CfgApprovalHost } from "../../internal-urls/cfg-protocol";
import { ignoreSettle, PeerCleanups } from "../../thread/services/support";
import type { ThreadService, WorkerPeer } from "../../thread/services";
import { setDefaultToolUiFactory } from "../../tools/context";
import { createStudioRemoteUiFactory, type StudioUiGateway } from "../remote-extension-ui";
import { StudioInteractionError, type StudioInteractionGateway } from "./interaction-port";
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

export interface StudioThreadState {
	paused: boolean;
	interaction?: StudioUiGateway;
}
export interface StudioThreadGlobals {
	watch(listener: (state: StudioThreadState) => void): StudioThreadState;
	browser(sessionId: string): StudioManagedBrowserAccess | undefined;
	registerBrowserHome(call: BrowserHomeCall): void;
	retainBrowserHome(): () => void;
	computer: ComputerScopeBridge;
	configuration(): CfgApprovalHost | null;
}

type BrowserHomeCall = (
	session: SessionToken,
	operation: NativeBrowserHomeOperation,
) => Promise<NativeBrowserHomeResult>;
const browserHomes = new Map<ThreadId, BrowserHomeCall>();
const localBrowserObservers = new WeakMap<AgentSession, StudioBrowserObservationService>();

/** Resolve only a native registry session and its actual home; the caller additionally proves the descendant scope. */
export function studioBrowserObservationFor(sessionId: string): StudioBrowserObservationAccess | undefined {
	const session = AgentRegistry.global()
		.list()
		.find(ref => ref.session?.sessionManager.getSessionId() === sessionId)?.session;
	if (!session) return;
	const token = sessionToken(session),
		home = browserHomes.get(token.home);
	if (!home || token.home === currentThreadId()) return;
	return {
		tabs: async () =>
			((await home(token, { kind: "browser.tabs.get", sessionId })) as { tabs: StudioBrowserTab[] }).tabs,
		execute: operation => home(token, operation) as Promise<NativeBrowserResult>,
		webMcpList: operation => home(token, operation) as Promise<StudioWebMcpCatalog>,
		webMcpInvoke: operation => home(token, operation) as Promise<WebMcpInvokeResult>,
	};
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

/** Bind all local and worker child dialogs to this Runtime generation, never a later rebound bridge. */
export function setStudioThreadInteraction(gateway: StudioInteractionGateway | undefined): void {
	const generation = gateway?.generation;
	const bound = async <T>(run: () => Promise<T>): Promise<T> => {
		if (!gateway || gateway.generation !== generation)
			throw new StudioInteractionError("INTERACTION_STALE", "Studio dialog Runtime generation changed");
		const value = await run();
		if (gateway.generation !== generation)
			throw new StudioInteractionError("INTERACTION_STALE", "Studio dialog Runtime generation changed");
		return value;
	};
	interaction = gateway
		? {
				generation: gateway.generation,
				select: input => bound(() => gateway.select(input)),
				ask: input => bound(() => gateway.ask(input)),
				form: input => bound(() => gateway.form(input)),
				confirm: input => bound(() => gateway.confirm(input)),
				input: input => bound(() => gateway.input(input)),
				approve: input => bound(() => gateway.approve(input)),
				editor: input => bound(() => gateway.editor(input)),
				notify: (message, level) => {
					if (gateway.generation === generation) gateway.notify(message, level);
				},
				cancelCommand: rpcSync((commandId, reason, outcome) => {
					if (gateway.generation === generation) gateway.cancelCommand(commandId, reason, outcome);
				}),
			}
		: undefined;
	setDefaultToolUiFactory(interaction ? createStudioRemoteUiFactory(interaction) : undefined);
	publish();
}

/** Pending dialogs retain their real worker and cancel its existing interaction if that home exits. */
function workerDialogs(gateway: StudioUiGateway, peer: WorkerPeer, active: () => boolean): StudioUiGateway {
	const run = async <T>(commandId: string, action: () => Promise<T>): Promise<T> => {
		if (!active()) throw new StudioInteractionError("INTERACTION_STALE", "Dialog worker home is no longer active");
		const release = peer.retain?.();
		let pending = true;
		let exited = false;
		const forget = cleanups.track(peer.threadId, () => {
			try {
				if (pending) {
					exited = true;
					gateway.cancelCommand(commandId, "Dialog worker exited");
				}
			} finally {
				release?.();
			}
		});
		try {
			const value = await action();
			if (exited || !active())
				throw new StudioInteractionError("INTERACTION_STALE", "Dialog worker exited before its answer returned");
			return value;
		} finally {
			pending = false;
			forget();
		}
	};
	return {
		...gateway,
		cancelCommand: rpcSync((commandId, reason, outcome) => {
			if (active()) gateway.cancelCommand(commandId, reason, outcome);
		}),
		notify: (message, level) => {
			if (active()) gateway.notify(message, level);
		},
		select: input => run(input.commandId, () => gateway.select(input)),
		ask: input => run(input.commandId, () => gateway.ask(input)),
		form: input => run(input.commandId, () => gateway.form(input)),
		confirm: input => run(input.commandId, () => gateway.confirm(input)),
		input: input => run(input.commandId, () => gateway.input(input)),
		approve: input => run(input.commandId, () => gateway.approve(input)),
		editor: input => run(input.commandId, () => gateway.editor(input)),
	};
}

/** Extends the native thread bridge; workers keep native loops, jobs and cost gates. */
export const studioThreadService: ThreadService = {
	name: "studio",
	globals(peer): StudioThreadGlobals {
		return {
			registerBrowserHome: rpcSync(call => {
				browserHomes.set(peer.threadId, call);
				installBrowserObservationAccess(studioBrowserObservationFor);
				cleanups.track(peer.threadId, () => {
					if (browserHomes.get(peer.threadId) === call) browserHomes.delete(peer.threadId);
				});
			}),
			retainBrowserHome: rpcSync(() => rpcSync(cleanups.track(peer.threadId, peer.retain?.() ?? (() => {})))),
			browser: rpcSync(sessionId => {
				const owner = managedBrowserFor(sessionId);
				if (!owner) return undefined;
				return {
					kind: owner.kind,
					name: rpcSync(name => owner.name(name)),
					contains: rpcSync(name => owner.contains(name)),
					pageForTarget: rpcSync(targetId => owner.pageForTarget(targetId)),
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
				let active = true;
				let previous: StudioUiGateway | undefined;
				let dialogs: StudioUiGateway | undefined;
				const forWorker = (snapshot: StudioThreadState): StudioThreadState => {
					if (snapshot.interaction !== previous) {
						previous = snapshot.interaction;
						dialogs = previous ? workerDialogs(previous, peer, () => active) : undefined;
					}
					return { ...snapshot, interaction: dialogs };
				};
				const forward = (snapshot: StudioThreadState) => ignoreSettle(listener(forWorker(snapshot)));
				listeners.add(forward);
				const stopPause = agentPauseGate.onChange(() => forward(state()));
				cleanups.track(peer.threadId, () => {
					active = false;
					listeners.delete(forward);
					stopPause();
				});
				return forWorker(state());
			}),
		};
	},
	boot(globals): void {
		const source = globals as StudioThreadGlobals;
		source.registerBrowserHome(async (token, operation) => {
			if (token.home !== currentThreadId())
				throw new Error("Native browser request reached a different session home.");
			const session = findLocalSession(token.key);
			if (!session || session.sessionId !== operation.sessionId)
				throw new Error("Native browser session generation changed.");
			let observation = localBrowserObservers.get(session);
			if (!observation) {
				observation = new StudioBrowserObservationService(
					session,
					process.env.OMP_STUDIO_MEDIA_ROOT,
					process.env.OMP_STUDIO_SOCKET_DIR,
					source.retainBrowserHome,
				);
				localBrowserObservers.set(session, observation);
			}
			return await observation.executeHome(operation);
		});
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
