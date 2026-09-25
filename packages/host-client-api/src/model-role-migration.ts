/**
 * Native kind-role migration from OMP v18.3.0 (62bc57be), config/settings.ts.
 * Host reads the same effective roles before Runtime has saved config.yml.
 * Keep this logic and the selected priority lists aligned on upstream upgrades.
 */
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export const MODEL_ROLE_PRIORITIES = {
  "web": [
    "web/parallel",
    "web/perplexity",
    "google/gemini-2.5-flash",
    "google-antigravity/gemini-2.5-flash",
    "anthropic/claude-haiku-4-5",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6",
    "openai-codex/gpt-5.5",
    "xai/grok-4.5",
    "xai-oauth/grok-4.5",
    "web/zai",
    "web/exa",
    "web/tinyfish",
    "web/jina",
    "web/kagi",
    "web/tavily",
    "web/firecrawl",
    "web/brave",
    "web/kimi",
    "web/synthetic",
    "web/ollama",
    "web/searxng",
    "web/startpage",
    "web/duckduckgo",
    "web/ecosia",
    "web/google",
    "web/mojeek",
    "web/public"
  ],
  "image": [
    "openai/gpt-image-1",
    "openai-codex/gpt-image-1",
    "google-antigravity/gemini-3-pro-image",
    "xai/grok-imagine-image",
    "xai-oauth/grok-imagine-image",
    "openrouter/google/gemini-3-pro-image-preview",
    "google/gemini-3-pro-image-preview",
    "deepinfra/black-forest-labs/FLUX-2-pro"
  ]
};
const MODEL_PRIO = MODEL_ROLE_PRIORITIES;
export function migrateModelRoleConfig(source: unknown): Record<string, unknown> {
  const raw = isRecord(source) ? structuredClone(source) : {};
		function migrateKindRoleSettings(): void {
			const providerSettings = isRecord(raw.providers) ? raw.providers : undefined;
			const ttsSettings = isRecord(raw.tts) ? raw.tts : undefined;
			const sttSettings = isRecord(raw.stt) ? raw.stt : undefined;
			const legacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): unknown =>
				root && Object.hasOwn(root, key) ? root[key] : raw[flatKey];
			const removeLegacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): void => {
				if (root) delete root[key];
				delete raw[flatKey];
			};
			const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

			const roles = isRecord(raw.modelRoles) ? raw.modelRoles : {};
			const retrySettings = isRecord(raw.retry) ? raw.retry : {};
			const fallbackChains = isRecord(retrySettings.fallbackChains) ? retrySettings.fallbackChains : {};
			let rolesChanged = false;
			let fallbackChainsChanged = false;
			const setRoleChain = (role: string, candidates: readonly string[]): void => {
				if (candidates.length === 0) return;
				if (!Object.hasOwn(roles, role)) {
					roles[role] = candidates[0];
					rolesChanged = true;
				}
				if (!Object.hasOwn(fallbackChains, role)) {
					fallbackChains[role] = candidates.slice(1);
					fallbackChainsChanged = true;
				}
			};

			const legacyWebSearch = legacy(providerSettings, "webSearch", "providers.webSearch");
			const legacyWebOrder = legacy(providerSettings, "webSearchOrder", "providers.webSearchOrder");
			const legacyWebExclude = legacy(providerSettings, "webSearchExclude", "providers.webSearchExclude");
			const legacyGeminiModel = legacy(providerSettings, "webSearchGeminiModel", "providers.webSearchGeminiModel");
			const webSelector = (provider: string, geminiModel: string): string | undefined => {
				switch (provider) {
					case "gemini":
						return `google/${geminiModel}`;
					case "anthropic":
						return "anthropic/claude-haiku-4-5";
					case "codex":
						return "openai-codex/gpt-5.6-luna";
					case "xai":
						return "xai/grok-4.5";
					case "auto":
						return undefined;
					default:
						return MODEL_PRIO.web.includes(`web/${provider}`) ? `web/${provider}` : undefined;
				}
			};
			const geminiModel =
				typeof legacyGeminiModel === "string" && legacyGeminiModel.trim()
					? legacyGeminiModel.trim()
					: "gemini-2.5-flash";
			const webDefaults = MODEL_PRIO.web.map(selector => {
				if (selector === "google/gemini-2.5-flash") return `google/${geminiModel}`;
				if (selector === "google-antigravity/gemini-2.5-flash") {
					return `google-antigravity/${geminiModel}`;
				}
				return selector;
			});
			const excludedWebProviders = new Set(
				Array.isArray(legacyWebExclude)
					? legacyWebExclude.filter(
							(value): value is string =>
								typeof value === "string" && webSelector(value, geminiModel) !== undefined,
						)
					: [],
			);
			const isWebSelectorExcluded = (selector: string): boolean => {
				if (excludedWebProviders.has("gemini") && /^(?:google|google-antigravity)\//.test(selector)) return true;
				if (excludedWebProviders.has("anthropic") && selector.startsWith("anthropic/")) return true;
				if (excludedWebProviders.has("codex") && selector.startsWith("openai-codex/")) return true;
				if (excludedWebProviders.has("xai") && (selector.startsWith("xai/") || selector.startsWith("xai-oauth/"))) {
					return true;
				}
				for (const provider of excludedWebProviders) {
					if (selector === `web/${provider}`) return true;
				}
				return false;
			};
			const orderedWebProviders = Array.isArray(legacyWebOrder)
				? legacyWebOrder
				: typeof legacyWebSearch === "string" && legacyWebSearch !== "auto"
					? [legacyWebSearch]
					: [];
			const orderedWebSelectors = orderedWebProviders.flatMap(value =>
				typeof value === "string" ? (webSelector(value, geminiModel) ?? []) : [],
			);
			const shouldMigrateWeb =
				orderedWebSelectors.length > 0 ||
				excludedWebProviders.size > 0 ||
				(typeof legacyGeminiModel === "string" && legacyGeminiModel.trim().length > 0);
			if (shouldMigrateWeb) {
				setRoleChain(
					"web",
					dedupe([...orderedWebSelectors, ...webDefaults]).filter(selector => !isWebSelectorExcluded(selector)),
				);
			}

			const legacyImage = legacy(providerSettings, "image", "providers.image");
			const legacyImageOrder = legacy(providerSettings, "imageOrder", "providers.imageOrder");
			const imageSelector = (provider: string): string | undefined => {
				switch (provider) {
					case "openai":
						return "openai/gpt-image-1";
					case "openai-codex":
						return "openai-codex/gpt-image-1";
					case "antigravity":
						return "google-antigravity/gemini-3-pro-image";
					case "xai":
						return "xai/grok-imagine-image";
					case "openrouter":
						return "openrouter/google/gemini-3-pro-image-preview";
					case "gemini":
						return "google/gemini-3-pro-image-preview";
					case "deepinfra":
						return "deepinfra/black-forest-labs/FLUX-2-pro";
					default:
						return undefined;
				}
			};
			const orderedImageProviders = Array.isArray(legacyImageOrder)
				? legacyImageOrder
				: typeof legacyImage === "string" && legacyImage !== "auto"
					? [legacyImage]
					: [];
			const orderedImageSelectors = orderedImageProviders.flatMap(value =>
				typeof value === "string" ? (imageSelector(value) ?? []) : [],
			);
			if (orderedImageSelectors.length > 0) {
				setRoleChain("image", dedupe([...orderedImageSelectors, ...MODEL_PRIO.image]));
			}

			const legacyTtsProvider = legacy(providerSettings, "tts", "providers.tts");
			const speechSelector =
				legacyTtsProvider === "local"
					? "local/kokoro"
					: legacyTtsProvider === "xai"
						? "xai/grok-tts"
						: legacyTtsProvider === "deepinfra"
							? "deepinfra/hexgrad/Kokoro-82M"
							: undefined;
			if (speechSelector) setRoleChain("speech", [speechSelector]);

			const legacySttModel = legacy(sttSettings, "modelName", "stt.modelName");
			const dictationSelector =
				legacySttModel === "fast" || legacySttModel === "whisper-base"
					? "local/whisper-base"
					: legacySttModel === "balanced" || legacySttModel === "whisper-small"
						? "local/whisper-small"
						: legacySttModel === "turbo" || legacySttModel === "whisper-large-v3-turbo"
							? "local/whisper-large-v3-turbo"
							: undefined;
			if (dictationSelector && !Object.hasOwn(roles, "dictation")) {
				roles.dictation = dictationSelector;
				rolesChanged = true;
			}

			const legacyJudgmentProvider = legacy(providerSettings, "judgmentProvider", "providers.judgmentProvider");
			const legacyAutoThinkingModel = legacy(providerSettings, "autoThinkingModel", "providers.autoThinkingModel");
			const legacyUnexpectedStopModel = legacy(
				providerSettings,
				"unexpectedStopModel",
				"providers.unexpectedStopModel",
			);
			const nonDefaultJudge =
				(typeof legacyJudgmentProvider === "string" && legacyJudgmentProvider !== "auto") ||
				(typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") ||
				(typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online");
			if (nonDefaultJudge) {
				const judgeCandidates: string[] = [];
				if (legacyJudgmentProvider !== "llm") judgeCandidates.push("typesafe/jev-latest");
				if (typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") {
					judgeCandidates.push(`local/${legacyAutoThinkingModel}`);
				}
				if (typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online") {
					judgeCandidates.push(`local/${legacyUnexpectedStopModel}`);
				}
				judgeCandidates.push("@tiny", "@smol", "@default");
				setRoleChain("judge", dedupe(judgeCandidates));
			}

			const prependLocalRole = (role: "tiny" | "memory", model: unknown): void => {
				if (typeof model !== "string" || model === "online" || model.length === 0) return;
				const selector = `local/${model}`;
				const configured = typeof roles[role] === "string" ? roles[role] : undefined;
				const patterns = configured
					? configured
							.split(",")
							.map(pattern => pattern.trim())
							.filter(Boolean)
					: [];
				roles[role] = dedupe([selector, ...patterns]).join(",");
				rolesChanged = true;
			};
			prependLocalRole("tiny", legacy(providerSettings, "tinyModel", "providers.tinyModel"));
			prependLocalRole("memory", legacy(providerSettings, "memoryModel", "providers.memoryModel"));

			for (const key of [
				"webSearch",
				"webSearchOrder",
				"webSearchExclude",
				"webSearchGeminiModel",
				"image",
				"imageOrder",
				"tts",
				"judgmentProvider",
				"autoThinkingModel",
				"unexpectedStopModel",
				"tinyModel",
				"memoryModel",
			]) {
				removeLegacy(providerSettings, key, `providers.${key}`);
			}
			removeLegacy(ttsSettings, "localModel", "tts.localModel");
			removeLegacy(sttSettings, "modelName", "stt.modelName");

			if (rolesChanged) raw.modelRoles = roles;
			if (fallbackChainsChanged) {
				retrySettings.fallbackChains = fallbackChains;
				raw.retry = retrySettings;
			}
			if (providerSettings && Object.keys(providerSettings).length === 0) delete raw.providers;
			if (ttsSettings && Object.keys(ttsSettings).length === 0) delete raw.tts;
			if (sttSettings && Object.keys(sttSettings).length === 0) delete raw.stt;
		}
  migrateKindRoleSettings();
  return raw;
}
