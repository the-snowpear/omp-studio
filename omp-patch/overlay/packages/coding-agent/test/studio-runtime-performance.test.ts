import { expect, test } from "bun:test";
import { createRuntimePerformanceSampler } from "../src/studio/services/runtime-performance";

test("dormant diagnostics use only counters, omit private keys, gate static logs and stop cleanly", async () => {
	let now = 0, scheduled = 0, cleared = 0, unref = 0, reads = 0;
	const lines: string[] = [];
	const sampler = createRuntimePerformanceSampler({
		now: () => now,
		counters: () => { reads++; return { workerResidency: 4, workerGeneration: 2, messages: 0, secretPath: 99 }; },
		memory: () => ({ rss: 100, heapUsed: 10, heapTotal: 20, external: 3, arrayBuffers: 1 }),
		emit: line => lines.push(line),
		setInterval: (_callback, ms) => { expect(ms).toBe(60000); scheduled++; return { unref: () => { unref++; } }; },
		clearInterval: () => { cleared++; },
	});
	sampler.start(); sampler.start();
	expect(scheduled).toBe(1); expect(unref).toBe(1);
	await sampler.tick(); await sampler.tick();
	expect(lines).toHaveLength(1); expect(lines[0]).toContain("workerResidency=4"); expect(lines[0]).not.toContain("secretPath");
	now = 300000; await sampler.tick(); expect(lines).toHaveLength(2);
	sampler.dispose(); sampler.dispose(); await sampler.tick();
	expect(reads).toBe(3); expect(cleared).toBe(1);
});

test("a failed numeric sample never escapes into Runtime work", async () => {
	const sampler = createRuntimePerformanceSampler({ counters: () => { throw new Error("unavailable"); }, emit: () => { throw new Error("must not emit"); } });
	await sampler.tick(); sampler.dispose();
});
