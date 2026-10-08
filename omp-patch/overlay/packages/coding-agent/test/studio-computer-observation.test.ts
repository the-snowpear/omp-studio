import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { registerComputerController, type ComputerController } from "../src/tools/computer/supervisor";
import { StudioComputerObservationService } from "../src/studio/services/computer-observation-service";
import type { StudioComputerStatus, StudioComputerCapture } from "../src/studio/computer-observation-protocol";
import { validateWorkbenchResult } from "../src/studio/workbench-protocol";

test("computer activity and stop are native owner-scoped and never revoke another session", async () => {
	let running = 1;
	let foreign = 1;
	const controller = {
		get running() {
			return running;
		},
		revokeControl: async () => {
			running = 0;
		},
	} as ComputerController;
	const other = {
		get running() {
			return foreign;
		},
		revokeControl: async () => {
			foreign = 0;
		},
	} as ComputerController;
	const remove = registerComputerController("studio-computer-test", controller);
	const removeOther = registerComputerController("foreign-computer-test", other);
	const session = {
		sessionId: "s",
		settings: Settings.isolated({ "computer.enabled": false }),
		studioToolSession: { getEvalKernelOwnerId: () => "studio-computer-test" },
	} as unknown as AgentSession;
	const service = new StudioComputerObservationService(session);
	try {
		expect(await service.status()).toMatchObject({ enabled: false, available: false, running: 1 });
		await service.execute({ kind: "computer.stop", sessionId: "s" });
		expect(running).toBe(0);
		expect(foreign).toBe(1);
		await expect(service.execute({ kind: "computer.stop", sessionId: "foreign" })).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
	} finally {
		service.dispose();
		remove();
		removeOther();
	}
});

test.skipIf(process.env.OMP_STUDIO_COMPUTER_E2E !== "1" || process.platform !== "win32")(
	"Windows native observation creates a bounded private PNG and removes it on release",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-computer-observe-"));
		const session = {
			sessionId: "capture-test",
			settings: Settings.isolated({ "computer.enabled": true }),
		} as AgentSession;
		const service = new StudioComputerObservationService(session, directory);
		try {
			const status = (await service.execute({
				kind: "computer.status",
				sessionId: session.sessionId,
			})) as StudioComputerStatus;
			validateWorkbenchResult("computer.status", status);
			expect(status.available).toBe(true);
			const target = status.targets.find(value => value.kind === "display");
			expect(target).toBeDefined();
			const result = (await service.execute({
				kind: "computer.capture",
				sessionId: session.sessionId,
				targetId: target!.id,
			})) as StudioComputerCapture;
			validateWorkbenchResult("computer.capture", result);
			expect(result.width).toBeLessThanOrEqual(1280);
			expect(result.height).toBeLessThanOrEqual(896);
			const image = await fs.readFile(path.join(directory, "computer", result.captureId + ".png"));
			expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			service.release();
			await Bun.sleep(30);
			expect(await fs.readdir(path.join(directory, "computer"))).toEqual([]);
		} finally {
			service.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	30000,
);
