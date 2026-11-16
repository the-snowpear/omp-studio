import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { createHash } from "node:crypto";
import type { AgentSession } from "../../session/agent-session";
import { cfgOffline } from "../../config/auxiliary-model-policy";
import { cfgProvidersTinyModelDevice, cfgProvidersTinyModelDtype } from "../../session/settings";
import { getSttModelSpec, resolveSttModelSpec, sttLanguageSupport } from "../../stt/models";
import { cfgSttEnabled, cfgSttLanguage, cfgSttSubmitTrigger } from "../../stt/settings";
import { resolveSttRoleModel, sttProviderAllowed } from "../../stt/stt-controller";
import type { DictationConfiguration } from "../dictation-protocol";

/** Side-effect-free: no OAuth refresh, command-backed key execution, model download or microphone. */
export function inspectDictationConfiguration(
	session: AgentSession,
	available: boolean,
): {
	model: Model<Api> | undefined;
	configuration: DictationConfiguration;
} {
	const settings = session.settings;
	// Include unauthed models so a missing credential cannot silently switch the
	// configured voice provider to a local fallback during first-use inspection.
	const activeProvider = session.model?.provider;
	const providerPolicy: NonNullable<DictationConfiguration["providerPolicy"]> = {
		mode: cfgOffline.get(settings) ? "active-provider" : "unrestricted",
		...(activeProvider ? { activeProvider } : {}),
	};
	const model = resolveSttRoleModel(settings, session.modelRegistry, true, activeProvider);
	const providerRestricted = !sttProviderAllowed(settings, model, activeProvider);
	const spec = resolveSttModelSpec(model?.id);
	const cloud = !!model && model.api !== "local-inference";
	const modelAvailable =
		(!model && !settings.getModelRole("dictation")) ||
		(!!model &&
			(model.api === "openai-transcriptions" || (model.api === "local-inference" && !!getSttModelSpec(model.id))));
	const enabled = cfgSttEnabled.get(settings);
	const language = cfgSttLanguage.get(settings);
	const submitTrigger = cfgSttSubmitTrigger.get(settings);
	const languageSupport = cloud ? "unknown" : sttLanguageSupport(spec, language);
	const credentials = !cloud ? "local" : session.modelRegistry.hasConfiguredAuth(model!) ? "configured" : "missing";
	const authSource = cloud
		? session.modelRegistry.authStorage.keys.source(model!.provider, { env: "aliases" })
		: undefined;
	const credentialSource = !cloud
		? "local"
		: session.modelRegistry.hasCommandBackedApiKey(model!.provider)
			? "config-command"
			: (authSource?.kind ?? (credentials === "configured" ? "configured" : "missing"));
	// Neither cache readiness, credential rotation/provenance nor transient Live
	// state changes consent identity. Only the effective route/recording settings
	// are digested; tokens and headers are deliberately excluded.
	const configurationId = createHash("sha256")
		.update(
			stableStringifyJson({
				version: 2,
				enabled,
				language,
				submitTrigger,
				providerPolicy: providerPolicy.mode === "active-provider" ? providerPolicy : { mode: "unrestricted" },
				route: model
					? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl }
					: { local: spec.key, repo: spec.repo },
				...(!cloud
					? {
							engine: spec.engine,
							repo: spec.repo,
							localMode: spec.engine === "sherpa" ? spec.mode : "offline",
							dtype: process.env.PI_TINY_DTYPE ?? cfgProvidersTinyModelDtype.get(settings),
							device: process.env.PI_TINY_DEVICE ?? cfgProvidersTinyModelDevice.get(settings),
						}
					: {}),
			}),
		)
		.digest("hex");
	const blockedReason = !available
		? "desktop-unavailable"
		: !enabled
			? "disabled"
			: providerRestricted
				? "provider-restricted"
				: !modelAvailable
					? "model-unavailable"
					: languageSupport === "unsupported"
						? "language-unsupported"
						: credentials === "missing"
							? "credentials-missing"
							: undefined;
	return {
		model,
		configuration: {
			protocolVersion: 2,
			configurationId,
			providerPolicy,
			available,
			enabled,
			model: model ? `${model.provider}/${model.id}` : spec.key,
			language,
			submitTrigger,
			languageSupport,
			cloud,
			credentials,
			mode: cloud ? "batch" : spec.engine === "sherpa" && spec.mode === "online" ? "streaming" : "segmented",
			downloadRequired: false,
			...(!cloud ? { downloadSize: spec.sizeHint } : {}),
			...(blockedReason ? { blockedReason } : {}),
			...(providerRestricted
				? { message: "Dictation is restricted to the active session provider by models.offline" }
				: credentials === "configured"
					? { message: "Credentials are configured locally; the remote service has not been verified" }
					: {}),
			sources: {
				enabled: settings.getProvenance(cfgSttEnabled),
				language: settings.getProvenance(cfgSttLanguage),
				submitTrigger: settings.getProvenance(cfgSttSubmitTrigger),
				model: settings.getModelRoleProvenance("dictation"),
				credentials: credentialSource,
			},
		},
	};
}
