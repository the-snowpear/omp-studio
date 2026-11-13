import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../src/session/agent-session";
import { StudioManagedBrowserService } from "../src/studio/services/managed-browser-service";
import { ownsPage } from "../src/tools/browser/tab-protocol";
import { DownloadManager } from "../src/tools/browser/downloads";
import type { Browser, Page } from "puppeteer-core";

test("managed relay waits for in-flight actions before handing the chat to the user", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-managed-browser-"));
	const service = new StudioManagedBrowserService({ sessionId: "browser-test-chat" } as AgentSession, {
		enabled: true,
		directory,
	});
	let socket: WebSocket | undefined;
	try {
		const prepared = await service.prepare("browser-test-chat");
		expect(prepared.descriptorId).not.toContain("managed/");
		const descriptor = JSON.parse(
			await fs.readFile(path.join(directory, "managed-browser", prepared.descriptorId), "utf8"),
		);
		expect(new URL(descriptor.endpoint).port).not.toBe("0");
		expect((await fetch(new URL("/json/version", descriptor.endpoint))).status).toBe(404);
		socket = new WebSocket(descriptor.endpoint.replace("http:", "ws:") + "/ext");
		const opened = Promise.withResolvers<void>();
		socket.addEventListener("open", () => opened.resolve());
		await opened.promise;
		socket.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "130.0.0",
				tabs: [],
				attachedTabIds: [],
				discardedTabsProtocol: 1,
				instanceId: "studio-test",
				browserSession: "run-one",
			}),
		);
		const replies = new Map<number, PromiseWithResolvers<void>>();
		socket.addEventListener("message", event => {
			const message = JSON.parse(String(event.data));
			if (message.t === "studioControlResult") replies.get(message.id)?.resolve();
		});
		const control = (mode: string, id: number) => {
			const reply = Promise.withResolvers<void>();
			replies.set(id, reply);
			socket!.send(JSON.stringify({ t: "studioControl", id, control: mode }));
			return reply.promise;
		};
		await control("agent", 1);
		const release = await service.begin();
		let completed = false;
		const taking = control("human", 2).then(() => {
			completed = true;
		});
		await Bun.sleep(30);
		expect(completed).toBe(false);
		await expect(service.begin()).rejects.toThrow("user controls");
		release();
		await taking;
		await expect(service.begin()).rejects.toThrow("user controls");
		await control("agent", 3);
		(await service.begin())();
	} finally {
		socket?.close();
		service.dispose();
		await Bun.sleep(20);
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("managed Runtime workers borrow pages so cleanup cannot close Desktop state", () => {
	const base = {
		mode: "attach" as const,
		browserWSEndpoint: "ws://local",
		safeDir: "/tmp",
		uploadDir: "/tmp/uploads",
		page: { kind: "create" as const },
	};
	expect(ownsPage({ ...base, studioManaged: true })).toBe(false);
	expect(ownsPage(base)).toBe(true);
});

test("embedded download start/read/wait use Studio DownloadItems even when pageEvents is set", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-download-chain-"));
	const calls: string[] = [];
	let rows = [
		{
			id: "saved",
			state: "completed",
			path: "report.txt",
			suggestedFilename: "report.txt",
			url: "https://same-view.test/report",
			bytes: 5,
		},
	];
	const browser = {
		_connection: {
			createSession: () => {
				throw new Error("No browser target may be attached");
			},
			send: async (method: string) => {
				calls.push(method);
				return { downloads: method.endsWith("list") ? rows : {} };
			},
		},
	} as unknown as Browser;
	const downloads = new DownloadManager(browser, {} as Page, "embedded-page", {
		perTab: false,
		pageEvents: true,
		managed: true,
	});
	try {
		await downloads.start(directory);
		expect(await downloads.read()).toEqual([
			{ path: "report.txt", suggestedFilename: "report.txt", url: "https://same-view.test/report", bytes: 5 },
		]);
		expect(await downloads.wait()).toMatchObject({ path: "report.txt", bytes: 5 });
		rows = [];
		const waiting = downloads.wait();
		void waiting.catch(() => {});
		await Bun.sleep(0);
		await downloads.close();
		await expect(waiting).rejects.toThrow("Tab closed while waiting");
		expect(calls.every(method => method.startsWith("Studio.downloads."))).toBe(true);
		expect(await fs.readdir(directory)).toEqual([]);
	} finally {
		await downloads.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
