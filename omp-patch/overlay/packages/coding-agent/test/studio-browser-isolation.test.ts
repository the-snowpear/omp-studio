import { expect, test } from "bun:test";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connect, type Socket } from "node:net";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { acquireBrowser, releaseBrowser } from "../src/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "../src/tools/browser/tab-supervisor";
import { StudioBrowserObservationService } from "../src/studio/services/browser-observation-service";
import { studioTabIdentity, studioTabControlState } from "../src/studio/services/browser-tab-control";
import {
	validateBrowserObservationEvent,
	type BrowserObservationEvent,
	type StudioBrowserTab,
} from "../src/studio/browser-observation-protocol";

test.skipIf(process.env.OMP_STUDIO_BROWSER_E2E !== "1")(
	"a parent can observe only its live descendants; slow viewers are bounded and losing ownership returns Agent control",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-isolation-"));
		const prefix = path.basename(directory);
		const settings = Settings.isolated();
		const parent = { sessionId: prefix + "-parent", settings } as AgentSession;
		const child = { sessionId: prefix + "-child", settings } as AgentSession;
		const foreign = { sessionId: prefix + "-foreign", settings } as AgentSession;
		const registry = AgentRegistry.global();
		const refs = [
			registry.register({ id: parent.sessionId, displayName: "Parent", kind: "main", session: parent }),
			registry.register({
				id: child.sessionId,
				displayName: "Child",
				kind: "sub",
				parentId: parent.sessionId,
				session: child,
			}),
			registry.register({ id: foreign.sessionId, displayName: "Foreign", kind: "main", session: foreign }),
		];
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: directory });
		const service = new StudioBrowserObservationService(parent, directory, directory);
		const foreignService = new StudioBrowserObservationService(foreign, directory, directory);
		const pageServer = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("<!doctype html><title>Local isolation fixture</title><p>Local fixture</p>", {
					headers: { "content-type": "text/html" },
				}),
		});
		const names = [prefix + "-main", prefix + "-child", prefix + "-foreign"];
		let socket: Socket | undefined;
		const waitFor = async (predicate: () => boolean) => {
			const deadline = Date.now() + 10000;
			while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
			expect(predicate()).toBe(true);
		};
		try {
			const tabs = [];
			for (const [index, owner] of [parent, child, foreign].entries()) {
				tabs.push(
					(
						await acquireTab(names[index]!, browser, {
							ownerSessionId: owner.sessionId,
							url: "http://127.0.0.1:" + pageServer.port,
							viewport: { width: 800, height: 600 },
							timeoutMs: 30000,
						})
					).tab,
				);
			}
			const childTab = tabs[1]!;
			const childId = studioTabIdentity(childTab);
			const list = (await service.execute({ kind: "browser.tabs.get", sessionId: parent.sessionId })) as {
				tabs: StudioBrowserTab[];
			};
			expect(list.tabs.map(tab => tab.ownerSessionId).sort()).toEqual([parent.sessionId, child.sessionId].sort());
			await expect(
				foreignService.execute({ kind: "browser.observe.prepare", sessionId: foreign.sessionId, tabId: childId }),
			).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
			await expect(
				service.execute({ kind: "browser.observe.prepare", sessionId: foreign.sessionId, tabId: childId }),
			).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
			const prepared = (await service.execute({
				kind: "browser.observe.prepare",
				sessionId: parent.sessionId,
				tabId: childId,
			})) as { observationId: string };
			const descriptor = JSON.parse(
				await fs.readFile(path.join(directory, "browser", prepared.observationId + ".json"), "utf8"),
			) as { endpoint: string; token: string };
			const events: BrowserObservationEvent[] = [];
			let pending = "";
			socket = connect(descriptor.endpoint);
			const peer = socket;
			peer.on("error", () => {});
			peer.on("data", chunk => {
				pending += chunk.toString();
				for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
					const line = pending.slice(0, at);
					pending = pending.slice(at + 1);
					if (line === "OK") continue;
					const event: unknown = JSON.parse(line);
					validateBrowserObservationEvent(event);
					events.push(event);
				}
			});
			peer.once("connect", () => peer.write(descriptor.token + "\n"));
			await waitFor(() => events.some(event => event.kind === "frame"));
			const toolSession = {
				cwd: directory,
				settings,
				getSessionId: () => child.sessionId,
			} as unknown as ToolSession;
			await runInTab(childTab.name, {
				code: "await page.evaluate(() => { document.body.style.backgroundColor = 'rgb(20, 60, 100)'; }); return true",
				timeoutMs: 5000,
				session: toolSession,
			});
			await Bun.sleep(700);
			expect(events.filter(event => event.kind === "frame")).toHaveLength(1);
			const frame = events.find(event => event.kind === "frame")!;
			peer.write(JSON.stringify({ kind: "ack", sequence: frame.sequence }) + "\n");
			await waitFor(() => events.filter(event => event.kind === "frame").length === 2);
			const current = runInTab(childTab.name, {
				code: "await new Promise(resolve => setTimeout(resolve, 500)); return 7",
				timeoutMs: 5000,
				session: toolSession,
			});
			void current.catch(() => {});
			await waitFor(() => childTab.pending.size > 0);
			peer.write('{"kind":"take"}\n');
			await waitFor(() => events.some(event => event.kind === "state" && event.control === "waiting"));
			await expect(
				runInTab(childTab.name, { code: "return 8", timeoutMs: 1000, session: toolSession }),
			).rejects.toThrow(/busy|human control/);
			expect((await current).returnValue).toBe(7);
			await waitFor(() => events.some(event => event.kind === "state" && event.control === "human"));
			await expect(
				runInTab(childTab.name, { code: "return 8", timeoutMs: 1000, session: toolSession }),
			).rejects.toThrow("human control");
			const foreignTool = {
				cwd: directory,
				settings,
				getSessionId: () => foreign.sessionId,
			} as unknown as ToolSession;
			expect(
				(await runInTab(names[2]!, { code: "return 9", timeoutMs: 5000, session: foreignTool })).returnValue,
			).toBe(9);
			registry.unregister(child.sessionId, refs[1]);
			await waitFor(() => peer.destroyed);
			expect(studioTabControlState(childTab)).toBe("agent");
			expect(
				(await runInTab(childTab.name, { code: "return 10", timeoutMs: 5000, session: toolSession })).returnValue,
			).toBe(10);
			expect(events.filter(event => event.kind === "frame").length).toBeLessThanOrEqual(2);
			await releaseTab(childTab.name, { kill: true });
			const replacement = (
				await acquireTab(childTab.name, browser, {
					ownerSessionId: parent.sessionId,
					url: "http://127.0.0.1:" + pageServer.port,
					timeoutMs: 30000,
				})
			).tab;
			expect(studioTabIdentity(replacement)).not.toBe(childId);
			await expect(
				service.execute({ kind: "browser.observe.prepare", sessionId: parent.sessionId, tabId: childId }),
			).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		} finally {
			socket?.destroy();
			service.dispose();
			foreignService.dispose();
			for (const name of names) await releaseTab(name, { kill: true }).catch(() => false);
			await releaseBrowser(browser, { kill: true });
			pageServer.stop(true);
			for (const ref of refs) registry.unregister(ref.id, ref);
			if (
				path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
				!path.basename(directory).startsWith("omp-browser-isolation-")
			)
				throw new Error("Unexpected browser test directory");
			await removeWithRetries(directory);
		}
	},
	60000,
);
