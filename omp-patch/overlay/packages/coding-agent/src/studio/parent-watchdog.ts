/**
 * Exits a Studio Runtime whose desktop Host is gone.
 *
 * The Host starts each Runtime as the leader of its own process group, so a
 * Host that crashes or is force-quit leaves the Runtime running with nobody to
 * read results or answer prompts. The Host passes its pid in
 * `OMP_STUDIO_PARENT_PID`; the Runtime checks once a second and treats a new
 * parent (adopted by launchd or init) or a vanished pid as the loss of its
 * Host. A Bridge disconnect alone is not a loss: a live Host reconnects to the
 * Runtime it started.
 */

export const STUDIO_PARENT_PID_ENV = "OMP_STUDIO_PARENT_PID";

/** Reads and removes the Host pid so processes the Runtime starts do not inherit it. */
export function takeStudioParentPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[STUDIO_PARENT_PID_ENV];
	delete env[STUDIO_PARENT_PID_ENV];
	if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return undefined;
	const pid = Number(raw);
	return Number.isSafeInteger(pid) ? pid : undefined;
}

/** ESRCH: gone. EPERM: the pid now belongs to another user's process, so the Host is gone too. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The watchdog never keeps the Runtime alive on its own. */
function scheduleUnref(callback: () => void, intervalMs: number): unknown {
	const handle = setInterval(callback, intervalMs);
	handle.unref?.();
	return handle;
}

function cancelInterval(handle: unknown): void {
	clearInterval(handle as NodeJS.Timeout);
}

export interface StudioParentWatchdogOptions {
	readonly parentPid: number;
	readonly onLost: () => void;
	readonly intervalMs?: number;
	/** `process.ppid` changes when the parent dies and the Runtime is adopted. */
	readonly currentParentPid?: () => number;
	/** Covers a runtime that caches `process.ppid`. */
	readonly isAlive?: (pid: number) => boolean;
	readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
	readonly clearInterval?: (handle: unknown) => void;
}

/** Calls `onLost` at most once; the returned function stops watching. */
export function watchStudioParent(options: StudioParentWatchdogOptions): () => void {
	const currentParentPid = options.currentParentPid ?? (() => process.ppid);
	const isAlive = options.isAlive ?? processExists;
	const schedule = options.setInterval ?? scheduleUnref;
	const cancel = options.clearInterval ?? cancelInterval;
	const initialParentPid = currentParentPid();
	let stopped = false;
	const handle = schedule(() => {
		if (stopped) return;
		if (currentParentPid() === initialParentPid && isAlive(options.parentPid)) return;
		stopped = true;
		cancel(handle);
		options.onLost();
	}, options.intervalMs ?? 1_000);
	return () => {
		if (stopped) return;
		stopped = true;
		cancel(handle);
	};
}

/** Watches the pid the Host passed, or does nothing when it passed none. */
export function watchStudioParentFromEnv(onLost: () => void, env: NodeJS.ProcessEnv = process.env): () => void {
	const parentPid = takeStudioParentPid(env);
	return parentPid === undefined ? () => {} : watchStudioParent({ parentPid, onLost });
}
