import { randomUUID } from "node:crypto";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { TabSession } from "../../tools/browser/tab-supervisor";

interface ControlLease {
	holder: string;
	identity: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
}
const identities = new WeakMap<TabSession, { id: string; worker: unknown; targetId: string; browser: unknown }>();
const controls = new WeakMap<TabSession, ControlLease>();
export const STUDIO_BROWSER_LEASE_MS = 15_000;
export function studioTabIdentity(tab: TabSession): string {
	let identity = identities.get(tab);
	const worker = tab.backend === "worker" ? tab.worker : undefined;
	if (
		!identity ||
		identity.worker !== worker ||
		identity.targetId !== tab.targetId ||
		identity.browser !== tab.browser
	) {
		identity = { id: randomUUID(), worker, targetId: tab.targetId, browser: tab.browser };
		identities.set(tab, identity);
	}
	return identity.id;
}
function current(tab: TabSession): ControlLease | undefined {
	const lease = controls.get(tab);
	if (lease && (lease.expiresAt <= Date.now() || tab.state !== "alive" || lease.identity !== studioTabIdentity(tab))) {
		clearTimeout(lease.timer);
		controls.delete(tab);
		return undefined;
	}
	return lease;
}
export function studioTabControlState(
	tab: TabSession,
	holder?: string,
): "agent" | "waiting" | "human" | "other-window" {
	const lease = current(tab);
	if (!lease) return "agent";
	if (holder !== lease.holder) return "other-window";
	return tab.pending.size > 0 ? "waiting" : "human";
}
export function assertBrowserTabAgentControl(tab: TabSession | undefined): void {
	if (tab && current(tab))
		throw new ToolError(
			"This browser tab is under Studio human control. Wait for the user to return control before acting on it.",
		);
}
export function acquireStudioTabControl(tab: TabSession, holder: string, ttlMs = STUDIO_BROWSER_LEASE_MS): void {
	if (tab.state !== "alive") throw new ToolError("Browser target is no longer alive");
	const previous = current(tab);
	if (previous && previous.holder !== holder) throw new ToolError("Another Studio window controls this browser tab");
	if (previous) clearTimeout(previous.timer);
	const lease: ControlLease = {
		holder,
		identity: studioTabIdentity(tab),
		expiresAt: Date.now() + ttlMs,
		timer: setTimeout(() => {
			if (controls.get(tab) === lease) controls.delete(tab);
		}, ttlMs),
	};
	lease.timer.unref();
	controls.set(tab, lease);
}
export function releaseStudioTabControl(tab: TabSession, holder: string): void {
	const lease = current(tab);
	if (!lease || lease.holder !== holder) return;
	clearTimeout(lease.timer);
	controls.delete(tab);
}
