import { expect, spyOn, test } from "bun:test";
import * as tabSupervisor from "../src/tools/browser/tab-supervisor";
import type { TabSession } from "../src/tools/browser/tab-supervisor";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connect, type Socket } from "node:net";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { acquireBrowser, releaseBrowser, type PuppeteerBrowserKind } from "../src/tools/browser/registry";
import { acquireTab, getTab, listTabs, releaseTab, runInTab } from "../src/tools/browser/tab-supervisor";
import { StudioBrowserObservationService } from "../src/studio/services/browser-observation-service";
import { studioTabIdentity } from "../src/studio/services/browser-tab-control";
import { type BrowserObservationEvent } from "../src/studio/browser-observation-protocol";

test("native Edge keeps Chromium-only actions available without granting them to an unknown engine", async () => {
	const sessionId = "engine-probe",
		ownerSessionId = "engine-owner";
	const session = { sessionId, studioEvalKernelOwnerId: ownerSessionId } as unknown as AgentSession;
	const tab = {
		backend: "worker",
		name: "engine-tab",
		targetId: "engine-target",
		state: "alive",
		ownerSessionId,
		kindTag: "spawned",
		ownsPage: true,
		frozen: false,
		pending: new Map(),
		info: { url: "https://native.test/", title: "Native browser", viewport: { width: 800, height: 600 } },
		browser: { kind: { kind: "spawned" }, browser: { version: async () => "Edg/157.0.4341.46" } },
	} as unknown as TabSession;
	const list = spyOn(tabSupervisor, "listTabs").mockReturnValue([
		{
			name: tab.name,
			targetId: tab.targetId,
			kind: "spawned",
			url: tab.info.url,
			title: "Native browser",
			persist: false,
		},
	]);
	const get = spyOn(tabSupervisor, "getTab").mockReturnValue(tab);
	const service = new StudioBrowserObservationService(session, "isolated-display", "isolated-socket");
	try {
		expect(await service.tabs()).toMatchObject([
			{ engine: "chromium", capabilities: { webmcp: true, cdp: true, pdf: true, tracing: true } },
		]);
		get.mockReturnValue({
			...tab,
			browser: { kind: { kind: "spawned" }, browser: { version: async () => "UnverifiedBrowser/1" } },
		} as unknown as TabSession);
		expect(await service.tabs()).toMatchObject([
			{ engine: "unknown", capabilities: { webmcp: false, cdp: false, pdf: false, tracing: false } },
		]);
	} finally {
		service.dispose();
		get.mockRestore();
		list.mockRestore();
	}
});

test.skipIf(process.env.OMP_STUDIO_BROWSER_E2E !== "1" || !process.env.OMP_STUDIO_BROWSER_EXECUTABLE)(
	"native browser observation shares the target, preserves its viewport and fences human control",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-probe-"));
		let documents = 0;
		const pageServer = Bun.serve({
			port: 0,
			fetch: request => {
				if (new URL(request.url).pathname !== "/") return new Response(null, { status: 204 });
				const marker = ++documents;
				return new Response(
					`<!doctype html><html><body style="margin:0"><script>window.viewMarker=${marker}</script><button id="button" style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="window.clicks=(window.clicks||0)+1;this.textContent=String(window.clicks)">Click</button></body></html>`,
					{ headers: { "content-type": "text/html", "set-cookie": `view-proof=${marker}; Path=/; SameSite=Lax` } },
				);
			},
		});
		const settings = Settings.isolated();
		const sessionId = `studio-browser-probe-${crypto.randomUUID()}`;
		const toolSession = { cwd: directory, settings, getSessionId: () => sessionId } as unknown as ToolSession;
		const session = {
			sessionId,
			settings,
			studioEvalKernelOwnerId: sessionId,
			studioToolSession: toolSession,
		} as unknown as AgentSession;
		const service = new StudioBrowserObservationService(session, directory, directory);
		const executable = process.env.OMP_STUDIO_BROWSER_EXECUTABLE;
		const browserKind: PuppeteerBrowserKind = executable
			? {
					kind: "spawned",
					path: executable,
					args: [
						"--headless=new",
						"--no-first-run",
						"--no-default-browser-check",
						"--user-data-dir=" + path.join(directory, "browser-profile"),
					],
				}
			: { kind: "headless", headless: true };
		const browser = await acquireBrowser(browserKind, { cwd: directory, viewport: { width: 1000, height: 600 } });
		let socket: Socket | undefined;
		try {
			const { tab } = await acquireTab(sessionId, browser, {
				ownerSessionId: sessionId,
				url: "http://127.0.0.1:" + pageServer.port,
				viewport: { width: 1000, height: 600 },
				timeoutMs: 30000,
			});
			const baseline = (
				await runInTab(tab.name, {
					code: "return { width: await page.evaluate(() => innerWidth), height: await page.evaluate(() => innerHeight), viewport: page.viewport(), proof: await page.evaluate(() => ({ marker: window.viewMarker, cookie: document.cookie })) }",
					timeoutMs: 10000,
					session: toolSession,
				})
			).returnValue as {
				width: number;
				height: number;
				viewport: { width: number; height: number } | null;
				proof: { marker: number; cookie: string };
			};
			const activity = tab.lastActivityAt,
				generation = studioTabIdentity(tab),
				targetId = tab.targetId;
			const ownedTargets = () =>
				listTabs()
					.filter(row => getTab(row.name)?.ownerSessionId === sessionId)
					.map(row => row.targetId);
			const targets = ownedTargets();
			const prepared = (await service.execute({
				kind: "browser.observe.prepare",
				sessionId,
				tabId: studioTabIdentity(tab),
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
				for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
					const line = pending.slice(0, index);
					pending = pending.slice(index + 1);
					if (line === "OK") continue;
					const event = JSON.parse(line) as BrowserObservationEvent;
					events.push(event);
					if (event.kind === "frame")
						peer.write(JSON.stringify({ kind: "ack", sequence: event.sequence, generation }) + "\n");
				}
			});
			peer.once("connect", () =>
				peer.write(
					descriptor.token + "\n" + JSON.stringify({ kind: "visibility", visible: true, capture: true }) + "\n",
				),
			);
			const waitFor = async (predicate: () => boolean) => {
				const until = Date.now() + 10000;
				while (!predicate() && Date.now() < until) await Bun.sleep(25);
				expect(predicate()).toBe(true);
			};
			await waitFor(() => events.some(event => event.kind === "frame"));
			expect(tab.lastActivityAt).toBe(activity);
			const frame = events.find(event => event.kind === "frame");
			expect(frame && { width: frame.width, height: frame.height }).toEqual({
				width: baseline.width,
				height: baseline.height,
			});
			peer.write(JSON.stringify({ kind: "take", generation }) + "\n");
			await waitFor(() => events.some(event => event.kind === "state" && event.control === "human"));
			await expect(runInTab(tab.name, { code: "return 1", timeoutMs: 1000, session: toolSession })).rejects.toThrow(
				"human control",
			);
			const latest = events.filter(event => event.kind === "frame").at(-1)!;
			if (latest.kind !== "frame") throw new Error("No browser frame");
			peer.write(
				JSON.stringify({
					kind: "click",
					generation,
					documentEpoch: latest.documentEpoch,
					leaseId: events.filter(event => event.kind === "state").at(-1)?.leaseId,
					sequence: latest.sequence,
					x: 200 / baseline.width,
					y: 140 / baseline.height,
					button: "left",
				}) + "\n",
			);
			await Bun.sleep(250);
			peer.write('{"kind":"release"}\n');
			await waitFor(
				() =>
					events.filter(event => event.kind === "state").at(-1)?.kind === "state" &&
					events.filter(event => event.kind === "state").at(-1)?.control === "agent",
			);
			expect(events.filter(event => event.kind === "error")).toEqual([]);
			const result = await runInTab(tab.name, {
				code: "return { button: await page.$eval('#button', element => element.textContent), viewport: page.viewport(), proof: await page.evaluate(() => ({ marker: window.viewMarker, cookie: document.cookie })) }",
				timeoutMs: 10000,
				session: toolSession,
			});
			expect(result.returnValue).toMatchObject({ button: "1", viewport: baseline.viewport, proof: baseline.proof });
			expect(tab.targetId).toBe(targetId);
			expect(ownedTargets()).toEqual(targets);
			expect(documents).toBe(1);
			service.dispose();
			expect(tab.state).toBe("alive");
		} finally {
			socket?.destroy();
			service.dispose();
			await releaseTab(sessionId, { kill: true }).catch(() => false);
			await releaseBrowser(browser, { kill: true });
			pageServer.stop(true);
			if (
				path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
				!path.basename(directory).startsWith("omp-browser-probe-")
			)
				throw new Error("Unexpected browser test directory");
			await removeWithRetries(directory);
		}
	},
	60000,
);
