import { readFile } from "node:fs/promises";
import { request } from "node:http";
import type { Settings } from "../config/settings";
import { cfgHindsightApiToken, cfgHindsightApiUrl } from "../hindsight/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";

function readBroker<T>(url: string, authorization: string, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		// node:http connects directly to loopback and never sends the Bridge token through a proxy.
		const req = request(url, { headers: { authorization }, signal }, response => {
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error("Credential channel unavailable"));
				return;
			}
			let body = "";
			response.setEncoding("utf8");
			response.on("data", chunk => {
				body += chunk;
			});
			response.on("end", () => {
				try {
					resolve(JSON.parse(body) as T);
				} catch (error) {
					reject(error);
				}
			});
			response.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

/** Bind the desktop's encrypted credential as a soft default, below native config and env. */
export async function bindStudioHindsightCredential(
	settings: Settings,
	tokenFile: string | undefined,
): Promise<() => void> {
	const endpoint = process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
	delete process.env.OMP_STUDIO_MEMORY_CREDENTIAL_BROKER;
	if (!endpoint || !tokenFile) return () => {};
	const authorization = `Bearer ${(await readFile(tokenFile, "utf8")).trim()}`;
	const abort = new AbortController();
	let revision = 0;
	let owned: string | undefined;
	let lastApplied = cfgHindsightApiToken.get(settings);
	let pending = Promise.resolve();
	const dropOwned = () => {
		if (
			owned !== undefined &&
			settings.getProvenance(cfgHindsightApiToken) === "runtime" &&
			cfgHindsightApiToken.get(settings) === owned
		) {
			cfgHindsightApiToken.clearOverride(settings);
		}
		owned = undefined;
		lastApplied = cfgHindsightApiToken.get(settings);
	};

	const update = () => {
		pending = pending
			.then(async () => {
				const url = cfgHindsightApiUrl.get(settings);
				const result = await readBroker<{ revision: number; token?: string }>(
					`${endpoint}/credential?url=${encodeURIComponent(url)}`,
					authorization,
					AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
				);
				if (abort.signal.aborted || cfgHindsightApiUrl.get(settings) !== url) return;
				revision = result.revision;
				dropOwned();
				if (result.token && cfgHindsightApiToken.provenance(settings) === "default") {
					settings.pinDefaultValue(cfgHindsightApiToken, result.token);
					owned = result.token;
				}
				lastApplied = cfgHindsightApiToken.get(settings);
			})
			.catch(() => {});
		return pending;
	};

	// A remote Host can accept its SSH owner while Runtime startup waits for
	// provisioning. Other backends and explicit native tokens need no wait.
	if (cfgMemoryBackend.get(settings) === "hindsight" && cfgHindsightApiToken.provenance(settings) === "default")
		await update();
	else void update();
	// Clear the old service's token synchronously before any backend can use the new URL.
	const stopUrl = settings.onEffectiveChange([cfgHindsightApiUrl], () => {
		dropOwned();
		void update();
	});
	const stopToken = cfgHindsightApiToken.listen(settings, value => {
		if (value !== lastApplied) void update();
	});
	void (async () => {
		while (!abort.signal.aborted) {
			try {
				const result = await readBroker<{ revision: number }>(
					`${endpoint}/watch?revision=${revision}`,
					authorization,
					abort.signal,
				);
				if (result.revision !== revision) await update();
			} catch {
				if (!abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}
	})();
	return () => {
		abort.abort();
		stopUrl();
		stopToken();
	};
}
