import * as path from "node:path";
import { requireState, RatchetError } from "../../ratchet/ratchet";
interface Boundary {
	flow: string;
	rounds: number;
	stopped(): boolean;
}
const boundaries = new Map<string, Boundary>();
export function installStudioRatchetBoundary(
	cwd: string,
	flow: string,
	rounds: number,
	stopped: () => boolean,
): () => void {
	const key = path.resolve(cwd);
	const boundary = { flow, rounds, stopped };
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
