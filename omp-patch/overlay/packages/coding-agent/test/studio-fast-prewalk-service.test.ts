import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Prewalk } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
	StudioFastPrewalkError,
	StudioFastPrewalkService,
} from "@oh-my-pi/pi-coding-agent/studio/services/fast-prewalk-service";

function model(id: string): Model {
	return { id, provider: "anthropic" } as Model;
}

function fixture(
	overrides: {
		fastSupported?: boolean;
		armResult?: boolean;
		resolve?: (selector: string) => { model: Model; selector: string };
	} = {},
) {
	let fastEnabled = false;
	let prewalk: Prewalk | undefined;
	const armCalls: Model[] = [];
	const disarmCalls: number[] = [];
	const session = {
		setFastMode(enabled: boolean) {
			if (overrides.fastSupported === false) return false;
			fastEnabled = enabled;
			return true;
		},
		isFastModeEnabled: () => fastEnabled,
		isFastModeActive: () => fastEnabled,
		getPrewalkState: () => prewalk,
		armPrewalk(target: Model) {
			armCalls.push(target);
			if (overrides.armResult === false) return false;
			prewalk = { target };
			return true;
		},
		disarmPrewalk() {
			disarmCalls.push(1);
			const had = prewalk !== undefined;
			prewalk = undefined;
			return had;
		},
	} as unknown as AgentSession;
	const resolve =
		overrides.resolve ??
		((selector: string) => ({
			model: model(selector === "@smol" ? "smol" : selector),
			selector,
		}));
	return {
		service: new StudioFastPrewalkService(session, resolve),
		armCalls,
		disarmCalls,
	};
}

describe("StudioFastPrewalkService", () => {
	test("sets fast mode and reports whether priority is active", () => {
		const { service } = fixture();
		expect(service.setFast(true)).toEqual({ enabled: true, active: true });
		expect(service.setFast(false)).toEqual({ enabled: false, active: false });
	});

	test("fails closed when the active model has no service-tier family", () => {
		const { service } = fixture({ fastSupported: false });
		expect(() => service.setFast(true)).toThrow(StudioFastPrewalkError);
		try {
			service.setFast(true);
		} catch (error) {
			expect(error).toMatchObject({ code: "COMMAND_BLOCKED" });
		}
	});

	test("arms @smol by default and replaces an already-armed different target", () => {
		const { service, armCalls, disarmCalls } = fixture();
		expect(service.arm()).toEqual({ status: "armed", target: "@smol" });
		expect(armCalls.map(item => item.id)).toEqual(["smol"]);
		expect(service.arm("opus")).toEqual({ status: "armed", target: "opus" });
		expect(disarmCalls).toHaveLength(1);
		expect(armCalls.map(item => item.id)).toEqual(["smol", "opus"]);
	});

	test("re-arming the same target is a no-op", () => {
		const { service, armCalls, disarmCalls } = fixture();
		service.arm("opus");
		expect(service.arm("opus")).toEqual({ status: "armed", target: "opus" });
		expect(armCalls).toHaveLength(1);
		expect(disarmCalls).toHaveLength(0);
	});

	test("maps a no-op arm to COMMAND_BLOCKED", () => {
		const { service } = fixture({ armResult: false });
		expect(() => service.arm("opus")).toThrow("already matches the active model");
	});

	test("disarm reports whether a prewalk was armed", () => {
		const { service } = fixture();
		expect(service.disarm()).toEqual({ disarmed: false });
		service.arm("opus");
		expect(service.disarm()).toEqual({ disarmed: true });
		expect(service.disarm()).toEqual({ disarmed: false });
	});
});
