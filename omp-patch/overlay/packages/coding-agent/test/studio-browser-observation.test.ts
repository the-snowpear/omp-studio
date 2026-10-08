import { expect, test } from "bun:test";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connect, type Socket } from "node:net";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { acquireBrowser, releaseBrowser, type PuppeteerBrowserKind } from "../src/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "../src/tools/browser/tab-supervisor";
import { StudioBrowserObservationService } from "../src/studio/services/browser-observation-service";
import { studioTabIdentity } from "../src/studio/services/browser-tab-control";
import {
	validateBrowserObservationEvent,
	type BrowserObservationEvent,
} from "../src/studio/browser-observation-protocol";

test.skipIf(process.env.OMP_STUDIO_BROWSER_E2E !== "1")(
	"native browser observation shares the target, preserves its viewport and fences human control",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-probe-"));
		const pageServer = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					'<!doctype html><html><body style="margin:0"><button id="button" style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="window.clicks=(window.clicks||0)+1;this.textContent=String(window.clicks)">Click</button></body></html>',
					{ headers: { "content-type": "text/html" } },
				),
		});
		const settings = Settings.isolated();
		const sessionId = "studio-browser-probe";
		const toolSession = { cwd: directory, settings, getSessionId: () => sessionId } as unknown as ToolSession;
		const session = { sessionId, settings } as AgentSession;
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
			const { tab } = await acquireTab("studio-observe-test", browser, {
				ownerSessionId: sessionId,
				url: "http://127.0.0.1:" + pageServer.port,
				viewport: { width: 1000, height: 600 },
				timeoutMs: 30000,
			});
			const baseline = (
				await runInTab(tab.name, {
					code: "return { width: await page.evaluate(() => innerWidth), height: await page.evaluate(() => innerHeight), viewport: page.viewport() }",
					timeoutMs: 10000,
					session: toolSession,
				})
			).returnValue as { width: number; height: number; viewport: { width: number; height: number } | null };
			const activity = tab.lastActivityAt;
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
					const event: unknown = JSON.parse(line);
					validateBrowserObservationEvent(event);
					events.push(event);
					if (event.kind === "frame") peer.write(JSON.stringify({ kind: "ack", sequence: event.sequence }) + "\n");
				}
			});
			peer.once("connect", () => peer.write(descriptor.token + "\n"));
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
			peer.write('{"kind":"take"}\n');
			await waitFor(() => events.some(event => event.kind === "state" && event.control === "human"));
			await expect(runInTab(tab.name, { code: "return 1", timeoutMs: 1000, session: toolSession })).rejects.toThrow(
				"human control",
			);
			const latest = events.filter(event => event.kind === "frame").at(-1)!;
			if (latest.kind !== "frame") throw new Error("No browser frame");
			peer.write(
				JSON.stringify({
					kind: "click",
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
				code: "return { button: await page.$eval('#button', element => element.textContent), viewport: page.viewport() }",
				timeoutMs: 10000,
				session: toolSession,
			});
			expect(result.returnValue).toMatchObject({ button: "1", viewport: baseline.viewport });
			service.dispose();
			expect(tab.state).toBe("alive");
		} finally {
			socket?.destroy();
			service.dispose();
			await releaseTab("studio-observe-test", { kill: true }).catch(() => false);
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
