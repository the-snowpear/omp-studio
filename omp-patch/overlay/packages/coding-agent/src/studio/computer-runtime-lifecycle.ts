import type { ComputerScreenshot } from "../tools/computer/protocol";

/** Host-owned policy and telemetry. Absent outside Studio; never parses tool source or input. */
export interface ComputerRunIdentity {
	runId: string;
	sessionId: string;
	toolCallId?: string;
	invocationId?: string;
}
export type ComputerLifecycleEvent =
	| { kind: "run"; identity: ComputerRunIdentity; phase: "running" | "completed" | "failed" | "cancelled"; at: number }
	| {
			kind: "action";
			identity: ComputerRunIdentity;
			actionId: string;
			method: string;
			target?: string;
			mode: "read" | "background" | "takeover" | "unknown";
			phase: "running" | "completed" | "failed" | "cancelled";
			at: number;
	  }
	| { kind: "frame"; identity: ComputerRunIdentity; screenshot: ComputerScreenshot; actionId?: string; at: number }
	| {
			kind: "control";
			identity: ComputerRunIdentity;
			foreground: "none" | "requested" | "held" | "unknown";
			at: number;
	  };
export interface ComputerRunPermit {
	signal: AbortSignal;
	revision: number;
}
export interface ComputerScopeHook {
	owns(sessionId: string, ownerId?: string): boolean;
	authorize(sessionId: string, ownerId?: string): ComputerRunPermit | Promise<ComputerRunPermit>;
	event(event: ComputerLifecycleEvent): void;
	consumeIntent?(sessionId: string, message: unknown): void;
	deliver?(sessionId: string, toolCallId: string, result: unknown): void;
}
const scopes = new Set<ComputerScopeHook>();
export function registerComputerScope(hook: ComputerScopeHook): () => void {
	scopes.add(hook);
	return () => scopes.delete(hook);
}
export async function computerRunPermits(sessionId: string, ownerId?: string): Promise<ComputerRunPermit[]> {
	return Promise.all(
		[...scopes].filter(scope => scope.owns(sessionId, ownerId)).map(scope => scope.authorize(sessionId, ownerId)),
	);
}
export function hasComputerScope(sessionId: string, ownerId?: string): boolean {
	return [...scopes].some(scope => scope.owns(sessionId, ownerId));
}
export function emitComputerLifecycle(event: ComputerLifecycleEvent): void {
	for (const scope of scopes) {
		if (!scope.owns(event.identity.sessionId)) continue;
		try {
			scope.event(event);
		} catch {
			/* Observation must never rerun or fail a native action. */
		}
	}
}
/** Called only at the actual AgentSession message/result boundary, not on enqueue. */
export function computerUserMessageStarted(sessionId: string, message: unknown): void {
	for (const scope of scopes) if (scope.owns(sessionId)) scope.consumeIntent?.(sessionId, message);
}
export function computerToolResultDelivered(sessionId: string, toolCallId: string, result: unknown): void {
	for (const scope of scopes) if (scope.owns(sessionId)) scope.deliver?.(sessionId, toolCallId, result);
}
