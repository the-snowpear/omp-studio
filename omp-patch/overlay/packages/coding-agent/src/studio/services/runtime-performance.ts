import {
	createDiagnosticsSampler,
	createMemorySampleGate,
	formatMemorySampleLine,
	selectCounters,
	type DiagnosticsSampler,
	type DiagnosticsSamplerOptions,
	type PerformanceCounters,
} from "../performance-diagnostics";

const COUNTERS = [
	"workerResidency",
	"workerGeneration",
	"projectors",
	"messages",
	"tools",
	"pending",
	"blockBytes",
	"listeners",
];
/** Process-local numeric sampling; intentionally has no session/Bridge access. */
export function createRuntimePerformanceSampler(options: {
	counters: () => PerformanceCounters;
	emit: (line: string) => void;
	memory?: () => NodeJS.MemoryUsage;
	now?: () => number;
	setInterval?: DiagnosticsSamplerOptions["setInterval"];
	clearInterval?: DiagnosticsSamplerOptions["clearInterval"];
}): DiagnosticsSampler {
	return createDiagnosticsSampler({
		gate: createMemorySampleGate({ now: options.now ?? Date.now }),
		sample: () => {
			const memory = (options.memory ?? process.memoryUsage)();
			return {
				role: "runtime",
				rssBytes: memory.rss,
				heapUsedBytes: memory.heapUsed,
				heapTotalBytes: memory.heapTotal,
				externalBytes: memory.external,
				arrayBuffersBytes: memory.arrayBuffers,
				counters: selectCounters(options.counters(), COUNTERS),
			};
		},
		emit: (sample, decision) =>
			options.emit(
				formatMemorySampleLine(sample, { prefix: { seq: decision.seq, reason: decision.reason ?? "first" } }),
			),
		setInterval: options.setInterval ?? ((callback, ms) => setInterval(callback, ms)),
		clearInterval: options.clearInterval ?? (handle => clearInterval(handle as never)),
		onScheduled: handle => (handle as { unref?: () => void }).unref?.(),
	});
}
