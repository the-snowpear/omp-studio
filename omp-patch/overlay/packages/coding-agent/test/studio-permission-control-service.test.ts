import { beforeEach } from "bun:test";
import { resetSettingsForTest } from "../src/config/settings";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { cfgToolsApprovalMode } from "../src/tools/settings";
afterEach(() => vi.restoreAllMocks());
import {
	StudioPermissionControlError,
	StudioPermissionControlService,
	type StudioPermissionSession,
} from "@oh-my-pi/pi-coding-agent/studio/services/permission-control-service";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

function fixture(overrides: { streaming?: boolean; compacting?: boolean; flushError?: Error } = {}) {
	let flushed = 0;
	const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
	vi.spyOn(settings, "flush").mockImplementation(async () => {
		if (overrides.flushError) throw overrides.flushError;
		flushed++;
	});
	const session: StudioPermissionSession = {
		get isStreaming() {
			return overrides.streaming === true;
		},
		get isCompacting() {
			return overrides.compacting === true;
		},
		settings,
	};
	return {
		service: new StudioPermissionControlService(session),
		getMode: () => cfgToolsApprovalMode.get(settings),
		getFlushed: () => flushed,
	};
}

describe("StudioPermissionControlService", () => {
	test("idle persist writes tools.approvalMode immediately", async () => {
		const { service, getMode, getFlushed } = fixture();
		expect(await service.setMode("write", true)).toEqual({ mode: "write", persisted: true });
		expect(service.state()).toBe("write");
		expect(getMode()).toBe("write");
		expect(getFlushed()).toBe(1);
	});

	test("streaming queues the mode so in-flight tools keep the previous trust level", async () => {
		const { service, getMode, getFlushed } = fixture({ streaming: true });
		expect(await service.setMode("always-ask", true)).toEqual({ mode: "always-ask", persisted: true });
		expect(service.state()).toBe("always-ask");
		expect(getMode()).toBe("yolo");
		expect(getFlushed()).toBe(0);
		await service.applyPending();
		expect(getMode()).toBe("always-ask");
		expect(getFlushed()).toBe(1);
	});

	test("compacting queues an override until applyPending", async () => {
		const { service, getMode, getFlushed } = fixture({ compacting: true });
		expect(await service.setMode("write", false)).toEqual({ mode: "write", persisted: false });
		expect(getMode()).toBe("yolo");
		expect(getFlushed()).toBe(0);
		await service.applyPending();
		expect(getMode()).toBe("write");
		expect(getFlushed()).toBe(0);
	});

	test("later queued selection replaces the earlier one before applyPending", async () => {
		const { service, getMode } = fixture({ streaming: true });
		await service.setMode("write", true);
		await service.setMode("always-ask", false);
		expect(service.state()).toBe("always-ask");
		await service.applyPending();
		expect(getMode()).toBe("always-ask");
	});

	test("applyPending keeps the queue when flush fails so a later turn can retry", async () => {
		const { service } = fixture({ streaming: true, flushError: new Error("disk full") });
		await service.setMode("write", true);
		await expect(service.applyPending()).rejects.toThrow("disk full");
		expect(service.state()).toBe("write");
	});

	test("rejects an unsupported mode before touching settings", async () => {
		const { service, getMode } = fixture();
		await expect(service.setMode("root" as "yolo", true)).rejects.toBeInstanceOf(StudioPermissionControlError);
		await expect(service.setMode("root" as "yolo", true)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(getMode()).toBe("yolo");
		expect(service.state()).toBe("yolo");
	});
});
