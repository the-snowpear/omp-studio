import { expect, test } from "bun:test";
import type { TabSession } from "../src/tools/browser/tab-supervisor";
import {
	acquireStudioTabControl,
	assertBrowserTabAgentControl,
	releaseStudioTabControl,
	studioTabControlState,
	studioTabIdentity,
} from "../src/studio/services/browser-tab-control";

test("takeover waits for the current action while excluding new Agent work and other windows", () => {
	const tab = { state: "alive", pending: new Map([["run", {}]]) } as TabSession;
	acquireStudioTabControl(tab, "window-1");
	try {
		expect(studioTabControlState(tab, "window-1")).toBe("waiting");
		expect(() => assertBrowserTabAgentControl(tab)).toThrow("human control");
		expect(() => acquireStudioTabControl(tab, "window-2")).toThrow("Another Studio window");
		tab.pending.clear();
		expect(studioTabControlState(tab, "window-1")).toBe("human");
		releaseStudioTabControl(tab, "window-2");
		expect(() => assertBrowserTabAgentControl(tab)).toThrow();
	} finally {
		releaseStudioTabControl(tab, "window-1");
	}
	expect(studioTabControlState(tab, "window-1")).toBe("agent");
});
test("a rebuilt same-name tab has a new identity and expired control no longer blocks execution", async () => {
	const first = { name: "same", state: "alive", pending: new Map() } as TabSession;
	const rebuilt = { name: "same", state: "alive", pending: new Map() } as TabSession;
	expect(studioTabIdentity(first)).not.toBe(studioTabIdentity(rebuilt));
	acquireStudioTabControl(first, "window", 5);
	expect(studioTabControlState(rebuilt)).toBe("agent");
	await Bun.sleep(10);
	expect(studioTabControlState(first)).toBe("agent");
});
