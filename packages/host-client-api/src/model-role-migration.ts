/**
 * Native kind-role migration from OMP v18.4.4 (8ac1309b), config/settings.ts.
 * Host reads the same effective roles before Runtime has saved config.yml.
 * Keep this logic and the selected priority lists aligned on upstream upgrades.
 */
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export const MODEL_ROLE_PRIORITIES = {
  "web": [
    "web/parallel",
    "web/hosted",
    "web/exa",
    "web/firecrawl",
    "web/searxng",
    "web/startpage",
    "web/duckduckgo",
    "web/ecosia",
    "web/google",
    "web/mojeek",
    "web/public"
  ],
  "image": [
    "openai/gpt-image-2",
    "openai-codex/gpt-image-2",
    "google-antigravity/gemini-3-pro-image",
    "xai/grok-imagine-image",
    "xai-oauth/grok-imagine-image",
    "openrouter/google/gemini-3-pro-image",
    "google/gemini-3-pro-image",
    "deepinfra/black-forest-labs/FLUX-2-pro"
  ]
};
/** Pure search engines, including paid engines available for explicit legacy selections. */
export const REGISTERED_SEARCH_ENGINES = ["perplexity","zai","exa","tinyfish","jina","kagi","tavily","firecrawl","brave","kimi","parallel","synthetic","ollama","searxng","duckduckgo","google","ecosia","startpage","mojeek","public"];
function isRegisteredSearchEngine(id: string): boolean { return REGISTERED_SEARCH_ENGINES.includes(id); }
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
			const geminiSelectors = (model: string): string[] => [
				`google-gemini-cli/${model}`,
				`google-antigravity/${model}`,
				`google/${model}`,
			];
			const webSelectors = (provider: string, geminiModel: string): string[] => {
				switch (provider) {
					case "gemini":
						return geminiSelectors(geminiModel);
					case "anthropic":
						return ["anthropic/claude-haiku-4-5"];
					case "codex":
						return ["openai-codex/gpt-5.6-luna"];
					case "xai":
						return ["xai/grok-4.5"];
					case "auto":
						return [];
					default:
						return isRegisteredSearchEngine(provider) ? [`web/${provider}`] : [];
				}
			};
			const geminiModel =
				typeof legacyGeminiModel === "string" && legacyGeminiModel.trim()
					? legacyGeminiModel.trim()
					: "gemini-2.5-flash";
			const excludedWebProviders = new Set(
				Array.isArray(legacyWebExclude)
					? legacyWebExclude.filter(
							(value): value is string =>
								typeof value === "string" && webSelectors(value, geminiModel).length > 0,
						)
					: [],
			);
			const isWebSelectorExcluded = (selector: string): boolean => {
				if (excludedWebProviders.has("gemini") && geminiSelectors(geminiModel).includes(selector)) return true;
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
				typeof value === "string" ? webSelectors(value, geminiModel) : [],
			);
			// The Gemini model only shapes an ordered `gemini` entry; the defaults hold no chat models.
			if (orderedWebSelectors.length > 0 || excludedWebProviders.size > 0) {
				setRoleChain(
					"web",
					dedupe([...orderedWebSelectors, ...MODEL_PRIO.web]).filter(selector => !isWebSelectorExcluded(selector)),
				);
			}

			const legacyImage = legacy(providerSettings, "image", "providers.image");
			const legacyImageOrder = legacy(providerSettings, "imageOrder", "providers.imageOrder");
			const imageSelector = (provider: string): string | undefined => {
				switch (provider) {
					case "openai":
						return "openai/gpt-image-2";
					case "openai-codex":
						return "openai-codex/gpt-image-2";
					case "antigravity":
						return "google-antigravity/gemini-3-pro-image";
					case "xai":
						return "xai/grok-imagine-image";
					case "openrouter":
						return "openrouter/google/gemini-3-pro-image";
					case "gemini":
						return "google/gemini-3-pro-image";
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
