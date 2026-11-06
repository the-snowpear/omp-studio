import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import { cfgHindsightApiToken, cfgHindsightApiUrl } from "../src/hindsight/settings";
import { bindStudioHindsightCredential } from "../src/studio/hindsight-credential";

test("Studio credential is available before session creation and stays below native config", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-memory-credential-"));
	const tokenFile = join(directory, "bridge-token");
	await writeFile(tokenFile, "bridge-secret");
	let credential = "desktop-secret";
	let revision = 0;
	let wake: ((response: Response) => void) | undefined;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.headers.get("authorization") !== "Bearer bridge-secret") return new Response("", { status: 401 });
			const url = new URL(request.url);
			if (url.pathname === "/credential")
				return Response.json({
					revision,
					...(url.searchParams.get("url") === "http://localhost:8888" ? { token: credential } : {}),
				});
			return new Promise<Response>(resolve => {
				wake = resolve;
			});
		},
	});
	const previous = process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
	process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER = `http://127.0.0.1:${server.port}`;
	const settings = Settings.isolated({ "memory.backend": "hindsight" });
	let stop = () => {};
	try {
		stop = await bindStudioHindsightCredential(settings, tokenFile);
		expect(cfgHindsightApiToken.get(settings)).toBe("desktop-secret");
		cfgHindsightApiToken.set(settings, "native-secret");
		await Bun.sleep(30);
		expect(cfgHindsightApiToken.get(settings)).toBe("native-secret");
		cfgHindsightApiToken.unset(settings);
		await Bun.sleep(50);
		expect(cfgHindsightApiToken.get(settings)).toBe("desktop-secret");
		credential = "rotated-secret";
		revision++;
		wake?.(Response.json({ revision }));
		await Bun.sleep(50);
		expect(cfgHindsightApiToken.get(settings)).toBe("rotated-secret");
		cfgHindsightApiUrl.override(settings, "https://other.example");
		expect(cfgHindsightApiToken.get(settings)).toBeUndefined();
		await Bun.sleep(50);
		expect(cfgHindsightApiToken.get(settings)).toBeUndefined();
	} finally {
		stop();
		server.stop(true);
		if (previous === undefined) delete process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
		else process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hindsight startup waits for remote credential provisioning", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-memory-startup-"));
	const tokenFile = join(directory, "bridge-token");
	await writeFile(tokenFile, "bridge-secret");
	const gate = Promise.withResolvers<Response>();
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			return new URL(request.url).pathname === "/credential" ? gate.promise : new Promise<Response>(() => {});
		},
	});
	const previous = process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
	process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER = `http://127.0.0.1:${server.port}`;
	const settings = Settings.isolated({ "memory.backend": "hindsight" });
	let completed = false;
	let stop = () => {};
	try {
		const start = bindStudioHindsightCredential(settings, tokenFile).then(dispose => {
			completed = true;
			return dispose;
		});
		await Bun.sleep(30);
		expect(completed).toBe(false);
		gate.resolve(Response.json({ revision: 1, token: "remote-secret" }));
		stop = await start;
		expect(cfgHindsightApiToken.get(settings)).toBe("remote-secret");
	} finally {
		stop();
		server.stop(true);
		if (previous === undefined) delete process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
		else process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
