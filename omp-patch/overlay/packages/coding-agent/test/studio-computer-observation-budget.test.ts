import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ComputerObservationBudget } from "../src/studio/services/computer-observation-budget";

const hash = (id: string): string => createHash("sha256").update(id).digest("hex");
test("independent Runtime producers cannot reserve more than the profile observation budget", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "computer-profile-budget-"));
	try {
		const one = new ComputerObservationBudget(directory),
			two = new ComputerObservationBudget(directory);
		const ids = Array.from({ length: 9 }, () => crypto.randomUUID());
		const results = await Promise.allSettled(
			ids.map((id, index) =>
				(index % 2 ? one : two).reserve(id, `root-${index}`, `session-${index}`, Date.now() + 120_000),
			),
		);
		expect(results.filter(result => result.status === "fulfilled").length).toBe(8);
		expect(results.filter(result => result.status === "rejected").length).toBe(1);
		const accepted = results.findIndex(result => result.status === "fulfilled");
		await one.commit(ids[accepted], 1024, Date.now() + 120_000);
		await expect(two.reserve(crypto.randomUUID(), "root-next", "session-next", Date.now() + 120_000)).rejects.toThrow(
			"64 MiB",
		);
		await one.release(ids[accepted]);
		await two.reserve(crypto.randomUUID(), "root-next", "session-next", Date.now() + 120_000);
		const state = await Bun.file(path.join(directory, "computer-workspace", "observation-budget.json")).json();
		expect(
			state.reservations.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
		).toBeLessThanOrEqual(64 * 1024 * 1024);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("crash TTL reclaims only registered observation copies and saved frames leave the stage budget", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "computer-profile-ttl-"));
	let now = 10;
	try {
		const budget = new ComputerObservationBudget(directory, () => now);
		const scope = "scope",
			session = "child";
		const expired = crypto.randomUUID(),
			saved = crypto.randomUUID();
		for (const frameId of [expired, saved]) {
			await budget.reserve(frameId, scope, session, 120_010);
			await Bun.write(
				path.join(directory, "computer-workspace", hash(scope), `${frameId}.json`),
				JSON.stringify({
					version: 1,
					scopeSessionId: scope,
					frame: { frameId, sessionId: session, source: "observation" },
				}),
			);
			await Bun.write(path.join(directory, "outputs", hash(session), `${frameId}.bin`), "registered bytes");
		}
		await Bun.write(
			path.join(directory, "computer-workspace", hash(scope), `${saved}.artifact.json`),
			JSON.stringify({ frameId: saved, scopeSessionId: scope, kept: true, artifactId: "saved-artifact" }),
		);
		const native = path.join(directory, "native-source.png");
		await Bun.write(native, "native source");
		now = 120_011;
		await new ComputerObservationBudget(directory, () => now).reap();
		expect(await Bun.file(path.join(directory, "outputs", hash(session), `${expired}.bin`)).exists()).toBe(false);
		expect(await Bun.file(path.join(directory, "computer-workspace", hash(scope), `${expired}.json`)).exists()).toBe(
			false,
		);
		expect(await Bun.file(path.join(directory, "outputs", hash(session), `${saved}.bin`)).exists()).toBe(true);
		expect(await Bun.file(path.join(directory, "computer-workspace", hash(scope), `${saved}.json`)).exists()).toBe(
			true,
		);
		expect(await Bun.file(native).exists()).toBe(true);
		expect(
			(await Bun.file(path.join(directory, "computer-workspace", "observation-budget.json")).json()).reservations,
		).toEqual([]);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
