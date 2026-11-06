import * as path from "node:path";
import { requireState, RatchetError } from "../../ratchet/ratchet";
interface Boundary {
	flow: string;
	rounds: number;
	stopped(): boolean;
	onGate?: (variant: string, result: unknown) => Promise<void>;
	preparing?: boolean;
	onSetup?: (parameters: Record<string, unknown>) => Promise<void>;
}
const boundaries = new Map<string, Boundary>();
export function installStudioRatchetBoundary(
	cwd: string,
	flow: string,
	rounds: number,
	stopped: () => boolean,
	onGate?: (variant: string, result: unknown) => Promise<void>,
	preparing = false,
	onSetup?: (parameters: Record<string, unknown>) => Promise<void>,
): () => void {
	const key = path.resolve(cwd);
	const boundary = { flow, rounds, stopped, onGate, preparing, onSetup };
	boundaries.set(key, boundary);
	return () => {
		if (boundaries.get(key) === boundary) boundaries.delete(key);
	};
}
/** Studio's execution boundary; scoring, approvals and decisions remain native. */
export async function enforceStudioRatchetBoundary(
	cwd: string,
	parameters: { action: string; flow: string },
): Promise<void> {
	const boundary = boundaries.get(path.resolve(cwd));
	if (!boundary) return;
	if (parameters.flow !== boundary.flow) throw new RatchetError("This isolated run is authorized for one flow only");
	if (boundary.preparing) {
		if (["check", "gate"].includes(parameters.action))
			throw new RatchetError(
				"Preparation is complete. Start the approved evaluation in Studio before executing a variant",
			);
		if (boundary.stopped()) throw new RatchetError("Preparation was stopped");
		return;
	}
	if (["status", "train", "gate"].includes(parameters.action)) return;
	if (["init", "plan", "split", "approve"].includes(parameters.action))
		throw new RatchetError("Stop the run and review changed material in Studio before altering this approved flow");
	if (boundary.stopped()) throw new RatchetError("Ratchet was stopped or its model cost limit was reached");
	const state = await requireState(cwd, boundary.flow);
	if (
		state.rounds.filter(round => round.decision !== "baseline" && round.decision !== "rerun").length >=
		boundary.rounds
	)
		throw new RatchetError("The Studio round limit has been reached");
}

export async function notifyStudioRatchetSetup(cwd: string, parameters: Record<string, unknown>): Promise<void> {
	const boundary = boundaries.get(path.resolve(cwd));
	if (boundary && boundary.flow === parameters.flow) await boundary.onSetup?.(parameters);
}

export async function notifyStudioRatchetGate(
	cwd: string,
	flow: string,
	variant: string,
	result: unknown,
): Promise<void> {
	const boundary = boundaries.get(path.resolve(cwd));
	if (boundary?.flow === flow) await boundary.onGate?.(variant, result);
}
