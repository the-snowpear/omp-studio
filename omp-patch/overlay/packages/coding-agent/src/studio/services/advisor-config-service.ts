import {
	discoverAdvisorConfigs,
	resolveAdvisorConfigEditPath,
	loadWatchdogConfigFile,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
} from "../../advisor/config";
import { acquireFileLock, isEnoent } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { AdvisorConfigOperation, AdvisorConfigView } from "../advisor-config-protocol";

/** Edits the native WATCHDOG document and uses the native roster rebuild, never a parallel advisor store. */
export class StudioAdvisorConfigService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: AdvisorConfigOperation): Promise<AdvisorConfigView> {
		if (operation.sessionId !== this.session.sessionId || !["user", "project"].includes(operation.scope))
			throw Error("Advisor configuration target changed");
		const file = await resolveAdvisorConfigEditPath(operation.scope, {
			projectDir: this.session.sessionManager.getCwd(),
			agentDir: this.session.settings.getAgentDir(),
		});
		const lock = operation.kind === "advisors.config.save" ? await acquireFileLock(file) : undefined;
		try {
			const raw = await this.#source(file);
			const version = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
			const loaded = await loadWatchdogConfigFile(file);
			if (operation.kind === "advisors.config.save") {
				if (this.session.isStreaming || this.session.isCompacting)
					throw Error("Wait for the session before reloading advisors");
				if (operation.version !== version) throw Error("WATCHDOG changed; reload it before saving");
				if (loaded.warnings?.length)
					throw Error(
						"Fix the reported WATCHDOG problems before saving; malformed entries would otherwise be lost",
					);
				if (
					!operation.document ||
					!Array.isArray(operation.document.advisors) ||
					operation.document.advisors.length > 64
				)
					throw Error("Choose an advisor roster of at most 64 entries");
				const serialized = serializeWatchdogConfig(operation.document);
				if (serialized.length > 262144) throw Error("Advisor configuration is too large");
				const original = Bun.YAML.parse(raw || "{}");
				if (original && typeof original === "object") {
					for (const key of Object.keys(original))
						if (!["advisors", "instructions", "maxNotesPerUpdate"].includes(key))
							throw Error(
								"WATCHDOG has fields this editor does not manage; edit the source file to preserve them",
							);
					const rows = (original as { advisors?: unknown[] }).advisors;
					const fields = new Set([
						"name",
						"model",
						"tools",
						"instructions",
						"enabled",
						"maxNotesPerUpdate",
						"reviewMode",
						"reviewInterval",
						"syncBacklog",
						"scope",
						"includeReasoning",
					]);
					if (
						Array.isArray(rows) &&
						rows.some(row => row && typeof row === "object" && Object.keys(row).some(key => !fields.has(key)))
					)
						throw Error("An advisor has unmanaged fields; edit the source file to preserve them");
				}
				if (operation.sessionId !== this.session.sessionId) throw Error("Advisor session changed before save");
				await saveWatchdogConfigFile(file, operation.document);
				const discovered = await discoverAdvisorConfigs(
					this.session.sessionManager.getCwd(),
					this.session.settings.getAgentDir(),
				);
				const active = this.session.applyAdvisorConfigs(
					discovered.advisors,
					discovered.sharedInstructions,
					discovered.sharedMaxNotesPerUpdate,
				);
				return {
					scope: operation.scope,
					version: new Bun.CryptoHasher("sha256").update(await this.#source(file)).digest("hex"),
					document: operation.document,
					warnings: discovered.warnings,
					active,
				};
			}
			const { warnings = [], ...document } = loaded;
			return {
				scope: operation.scope,
				version,
				document,
				warnings,
				active: this.session.getAdvisorStatusOverview().advisors.filter(row => !row.isPaused).length,
			};
		} finally {
			lock?.release();
		}
	}
	async #source(file: string): Promise<string> {
		try {
			return await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) return "";
			throw error;
		}
	}
}
