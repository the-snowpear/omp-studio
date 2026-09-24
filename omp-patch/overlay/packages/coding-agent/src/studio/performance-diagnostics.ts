/**
 * Shared numeric diagnostics helpers (W01).
 *
 * Every process (Electron Main/Host, Renderer, Runtime) owns caches, queues and
 * listeners whose *counts* are worth logging, but nothing here is a wire
 * contract: no envelope, no client-contract query, no Host capability. The
 * module deals only in finite non-negative numbers under fixed keys, so a
 * pasted log line can never carry a transcript, a path or a session title.
 *
 * Three pieces, each independently testable with injected clocks:
 *
 * - `createCounterRegistry()` — modules register a `read()` returning scalars
 *   they already track; the sampler never reaches into private state.
 * - `createMemorySampleGate()` — first / significant change / counter change /
 *   heartbeat gating so a static process writes one line per heartbeat, not
 *   one per sample.
 * - `formatMemorySampleLine()` — the single bounded `k=v` line handed to the
 *   existing log sinks (HostLog `detail` is capped at 2000 chars).
 */

export type PerformanceCounters = Readonly<Record<string, number>>;

export interface CounterRegistry {
	/**
	 * Register a provider under a fixed name. Returns an idempotent unregister.
	 * A second provider under the same name is a programming error and throws;
	 * silently replacing it would hide a leaked registration.
	 */
	register(name: string, read: () => PerformanceCounters): () => void;
	/** Read every provider once. Keys are `${provider}.${counter}`. */
	collect(): PerformanceCounters;
	/** Number of live providers — itself a resource count worth reporting. */
	providerCount(): number;
}

export type MemorySampleRole = "main-host" | "renderer" | "runtime";

export interface MemorySample {
	role: MemorySampleRole;
	rssBytes?: number;
	heapUsedBytes?: number;
	heapTotalBytes?: number;
	externalBytes?: number;
	arrayBuffersBytes?: number;
	counters: PerformanceCounters;
}

/**
 * Provider and counter names: lowercase start, then a short identifier. This
 * is the whole defence against dynamic keys — a session title or file path
 * cannot pass it, so providers cannot leak content by accident.
 */
const COUNTER_NAME = /^[a-z][A-Za-z0-9_.-]{0,79}$/u;
const PROVIDER_NAME = /^[a-z][A-Za-z0-9_-]{0,31}$/u;
/** A provider that returns more than this many counters is misusing the registry. */
const MAX_COUNTERS_PER_PROVIDER = 64;

export function isValidCounterValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidCounterName(name: unknown): name is string {
	return typeof name === "string" && COUNTER_NAME.test(name);
}

/**
 * Keep only well-formed entries of a provider result: valid key, finite
 * non-negative value. Invalid entries are dropped, never coerced — a `NaN`
 * turned into `0` would read as "empty", which is exactly the lie the plan
 * forbids ("missing" must stay missing).
 */
export function sanitizeCounters(input: unknown): PerformanceCounters {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
	const result: Record<string, number> = {};
	let kept = 0;
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (!isValidCounterName(key) || !isValidCounterValue(value)) continue;
		result[key] = value;
		kept += 1;
		if (kept >= MAX_COUNTERS_PER_PROVIDER) break;
	}
	return result;
}

export function createCounterRegistry(): CounterRegistry {
	const providers = new Map<string, () => PerformanceCounters>();
	return {
		register(name, read) {
			if (!PROVIDER_NAME.test(name)) {
				throw new Error(`invalid diagnostics provider name ${JSON.stringify(name)}`);
			}
			if (providers.has(name)) {
				throw new Error(`diagnostics provider ${JSON.stringify(name)} is already registered`);
			}
			providers.set(name, read);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				// Only remove our own entry: a later provider re-using the name after
				// we unregistered must not be torn down by our stale closure.
				if (providers.get(name) === read) providers.delete(name);
			};
		},
		collect() {
			const result: Record<string, number> = {};
			for (const [name, read] of providers) {
				let raw: unknown;
				try {
					raw = read();
				} catch {
					// A broken provider loses its own counters, nothing else.
					continue;
				}
				for (const [key, value] of Object.entries(sanitizeCounters(raw))) {
					result[`${name}.${key}`] = value;
				}
			}
			return result;
		},
		providerCount() {
			return providers.size;
		},
	};
}

/** Pick a fixed subset of counters; unknown names are ignored, missing stay missing. */
export function selectCounters(counters: PerformanceCounters, allowList: readonly string[]): PerformanceCounters {
	const result: Record<string, number> = {};
	for (const key of allowList) {
		const value = counters[key];
		if (isValidCounterValue(value)) result[key] = value;
	}
	return result;
}

const MEMORY_FIELDS = ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const;
type MemoryField = (typeof MEMORY_FIELDS)[number];

/** Drop memory fields that are not finite non-negative numbers; keep counters sane. */
export function normalizeMemorySample(sample: MemorySample): MemorySample {
	const result: MemorySample = { role: sample.role, counters: sanitizeCounters(sample.counters) };
	for (const field of MEMORY_FIELDS) {
		const value = sample[field];
		if (isValidCounterValue(value)) result[field] = value;
	}
	return result;
}

export interface MemorySampleGateOptions {
	/** Injected clock in milliseconds. */
	readonly now: () => number;
	/** Heartbeat interval; a static process logs once per heartbeat. Default 5 minutes. */
	readonly heartbeatMs?: number;
	/** Relative heap change that counts as significant. Default 5%. */
	readonly heapRatio?: number;
	/** Relative RSS / external / ArrayBuffer change that counts as significant. Default 10%. */
	readonly nativeRatio?: number;
	/**
	 * Absolute floor under which a relative change is noise. Guards the zero /
	 * tiny-base case: going from 0 to 4 KiB is an infinite ratio but not news.
	 * Default 1 MiB.
	 */
	readonly minDeltaBytes?: number;
}

export type MemorySampleGateReason = "first" | "memory" | "counters" | "heartbeat";

export interface MemorySampleGateDecision {
	readonly log: boolean;
	readonly reason?: MemorySampleGateReason;
	/** Sequence number of accepted samples, starting at 1; stays on the last accepted value when `log` is false. */
	readonly seq: number;
}

export interface MemorySampleGate {
	/** Decide whether `sample` deserves a log line; accepted samples become the new baseline. */
	observe(sample: MemorySample): MemorySampleGateDecision;
	/** Forget the baseline so the next sample logs as `first` again. */
	reset(): void;
}

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_HEAP_RATIO = 0.05;
const DEFAULT_NATIVE_RATIO = 0.1;
const DEFAULT_MIN_DELTA_BYTES = 1024 * 1024;

function significantChange(
	previous: number | undefined,
	next: number | undefined,
	ratio: number,
	minDelta: number,
): boolean {
	if (previous === undefined || next === undefined) return previous !== next;
	const delta = Math.abs(next - previous);
	if (delta < minDelta) return false;
	return delta >= previous * ratio;
}

function countersChanged(previous: PerformanceCounters, next: PerformanceCounters): boolean {
	const previousKeys = Object.keys(previous);
	const nextKeys = Object.keys(next);
	if (previousKeys.length !== nextKeys.length) return true;
	for (const key of nextKeys) {
		if (previous[key] !== next[key]) return true;
	}
	return false;
}

export function createMemorySampleGate(options: MemorySampleGateOptions): MemorySampleGate {
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const heapRatio = options.heapRatio ?? DEFAULT_HEAP_RATIO;
	const nativeRatio = options.nativeRatio ?? DEFAULT_NATIVE_RATIO;
	const minDelta = options.minDeltaBytes ?? DEFAULT_MIN_DELTA_BYTES;
	let baseline: MemorySample | undefined;
	let baselineAt = 0;
	let seq = 0;

	const accept = (sample: MemorySample, reason: MemorySampleGateReason): MemorySampleGateDecision => {
		baseline = sample;
		baselineAt = options.now();
		seq += 1;
		return { log: true, reason, seq };
	};

	return {
		observe(input) {
			const sample = normalizeMemorySample(input);
			if (baseline === undefined) return accept(sample, "first");
			const ratioFor = (field: MemoryField): number =>
				field === "heapUsedBytes" || field === "heapTotalBytes" ? heapRatio : nativeRatio;
			for (const field of MEMORY_FIELDS) {
				if (significantChange(baseline[field], sample[field], ratioFor(field), minDelta))
					return accept(sample, "memory");
			}
			if (countersChanged(baseline.counters, sample.counters)) return accept(sample, "counters");
			if (options.now() - baselineAt >= heartbeatMs) return accept(sample, "heartbeat");
			return { log: false, seq };
		},
		reset() {
			baseline = undefined;
			baselineAt = 0;
		},
	};
}

export interface FormatMemorySampleOptions {
	/** Upper bound on the produced line; default 1900 (under HostLog's 2000-char detail cap). */
	readonly maxLength?: number;
	/** Extra fixed fields rendered before the memory fields (e.g. `seq`, `reason`, `instance`). */
	readonly prefix?: Readonly<Record<string, string | number>>;
}

const DEFAULT_LINE_MAX_LENGTH = 1900;
const PREFIX_VALUE = /^[A-Za-z0-9._:-]{1,64}$/u;

/**
 * One `k=v` line: role, prefix fields, present memory fields, then counters in
 * insertion order. Missing memory fields are simply absent. When the counters
 * do not fit, trailing ones are dropped and `…+N` records how many.
 *
 * RSS, heap, external and ArrayBuffer bytes are reported side by side and
 * never summed: ArrayBuffers may already be inside `external`, and RSS counts
 * shared pages. Cache byte budgets logged as counters are logical budgets, not
 * V8 heap occupancy — the caller's counter names should say so.
 */
export function formatMemorySampleLine(sample: MemorySample, options: FormatMemorySampleOptions = {}): string {
	const maxLength = options.maxLength ?? DEFAULT_LINE_MAX_LENGTH;
	const normalized = normalizeMemorySample(sample);
	const parts: string[] = [`role=${normalized.role}`];
	for (const [key, value] of Object.entries(options.prefix ?? {})) {
		if (!isValidCounterName(key)) continue;
		const text =
			typeof value === "number"
				? Number.isFinite(value)
					? String(value)
					: undefined
				: PREFIX_VALUE.test(value)
					? value
					: undefined;
		if (text !== undefined) parts.push(`${key}=${text}`);
	}
	for (const field of MEMORY_FIELDS) {
		const value = normalized[field];
		if (value !== undefined) parts.push(`${field}=${Math.round(value)}`);
	}
	let line = parts.join(" ");
	const counterEntries = Object.entries(normalized.counters);
	let rendered = 0;
	for (const [key, value] of counterEntries) {
		const piece = ` ${key}=${Number.isInteger(value) ? value : value.toFixed(3)}`;
		// Reserve room for the overflow marker so the line never exceeds the cap.
		const marker = rendered + 1 < counterEntries.length ? ` …+${counterEntries.length - rendered - 1}`.length : 0;
		if (line.length + piece.length + marker > maxLength) break;
		line += piece;
		rendered += 1;
	}
	if (rendered < counterEntries.length) line += ` …+${counterEntries.length - rendered}`;
	return line;
}

export interface DiagnosticsSamplerOptions {
	/** Regular interval; default 60 seconds. */
	readonly intervalMs?: number;
	/** Take one sample. May be async; a rejected sample is skipped, not retried early. */
	readonly sample: () => MemorySample | undefined | Promise<MemorySample | undefined>;
	/** Receives every sample the gate accepts. Must not throw into the timer. */
	readonly emit: (sample: MemorySample, decision: MemorySampleGateDecision) => void;
	readonly gate: MemorySampleGate;
	/** Injected timers so tests and `unref()`-capable hosts stay in control. */
	readonly setInterval: (callback: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
	/** Called with the interval handle once; Node callers pass `(h) => h.unref?.()`. */
	readonly onScheduled?: (handle: unknown) => void;
}

export interface DiagnosticsSampler {
	/** Idempotent; a started sampler keeps a single interval. */
	start(): void;
	/** Run one sample now (still subject to the no-overlap guard and the gate). */
	tick(): Promise<void>;
	/** Clear the interval; a sample in flight is discarded when it resolves. */
	dispose(): void;
	readonly running: boolean;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;

/**
 * Periodic sampling with two invariants the plan spells out: samples never
 * overlap (a slow `sample()` skips the next tick instead of piling up), and
 * `dispose()` both clears the timer and drops any late result.
 */
export function createDiagnosticsSampler(options: DiagnosticsSamplerOptions): DiagnosticsSampler {
	let handle: unknown;
	let inFlight = false;
	let disposed = false;
	let generation = 0;

	const tick = async (): Promise<void> => {
		if (disposed || inFlight) return;
		inFlight = true;
		const current = generation;
		try {
			const sample = await options.sample();
			if (disposed || current !== generation || sample === undefined) return;
			const decision = options.gate.observe(sample);
			if (!decision.log) return;
			try {
				options.emit(normalizeMemorySample(sample), decision);
			} catch {
				// Sinks are diagnostics; a failing sink must not stop sampling.
			}
		} catch {
			// A failed sample is simply skipped.
		} finally {
			inFlight = false;
		}
	};

	return {
		start() {
			if (disposed || handle !== undefined) return;
			handle = options.setInterval(() => {
				void tick();
			}, options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
			options.onScheduled?.(handle);
		},
		tick,
		dispose() {
			if (disposed) return;
			disposed = true;
			generation += 1;
			if (handle !== undefined) options.clearInterval(handle);
			handle = undefined;
		},
		get running() {
			return handle !== undefined && !disposed;
		},
	};
}
