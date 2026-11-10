import { type ModelParameterDraft } from "../modelParameterDraft";
import type { ModelAuthType, ModelCatalogEntry, ModelOverridePatch, ModelProviderTestResult, ModelRoleRecord } from "@omp-studio/client-contract";
import { useI18n } from "../../i18n";

export type I18nT = ReturnType<typeof useI18n>["t"];

/** Connection-test result bound to the surface that triggered it. */
export type TestResultView = ModelProviderTestResult & {
  readonly source: "list" | "editor";
  readonly providerId: string | undefined;
};

export type DraftOverride = { -readonly [K in keyof ModelOverridePatch]?: ModelOverridePatch[K] };

export type Draft = {
  id: string;
  name: string;
  website: string;
  note: string;
  api: string;
  endpointUrl: string;
  local: boolean;
  enabled: boolean;
  authType: ModelAuthType;
  apiKey: string;
  envName: string;
  command: string;
  discoveryType: string;
  advertisedReasoning?: boolean;
  discoveryTimeoutMs?: number;
  headersText: string;
  disableStrictTools: boolean;
  transport: "" | "pi-native";
  remoteCompactionEnabled: boolean;
  remoteCompactionEndpoint: string;
  remoteCompactionModel: string;
  models: ModelCatalogEntry[];
  modelOverrides: Record<string, DraftOverride>;
};

export type ModelsTab = "catalog" | "discovery" | "custom";

export type ModelEditState =
  | { kind: "override"; modelId: string; draft: DraftOverrideForm; providerId?: string }
  | { kind: "custom"; index: number; draft: CustomModelForm; providerId?: string }
  | { kind: "add"; draft: CustomModelForm; providerId?: string };

export type DraftOverrideForm = {
  parameters: ModelParameterDraft;
  bedrockMessagesApi: "" | "true" | "false";
  requiresThinkingPresence: "" | "true" | "false";
  extendedCacheTtlBeta: "" | "true" | "false";
  statefulResponses: "" | "true" | "false";
  preferWebsockets: "" | "true" | "false";
  name: string;
  tools: "" | "true" | "false";
  image: "" | "true" | "false";
  costIn: string;
  costOut: string;
  costCacheR: string;
  costCacheW: string;
  omitMaxOutputTokens: "" | "true" | "false";
  premiumMultiplier: string;
  imageCountBudget: string;
  headersText: string;
  contextPromotionTarget: string;
  compactionModel: string;
  rcEnabled: "" | "true" | "false";
  rcEndpoint: string;
  rcModel: string;
};

export type CustomModelForm = {
  parameters: ModelParameterDraft;
  bedrockMessagesApi: "" | "true" | "false";
  requiresThinkingPresence: "" | "true" | "false";
  extendedCacheTtlBeta: "" | "true" | "false";
  statefulResponses: "" | "true" | "false";
  preferWebsockets: "" | "true" | "false";
  id: string;
  name: string;
  api: string;
  tools: boolean;
  image: boolean;
  costIn: string;
  costOut: string;
  costCacheR: string;
  costCacheW: string;
  omitMaxOutputTokens: boolean;
  premiumMultiplier: string;
  imageCountBudget: string;
  headersText: string;
  contextPromotionTarget: string;
  compactionModel: string;
  baseUrl: string;
  rcEnabled: boolean;
  rcEndpoint: string;
  rcModel: string;
};

export type ModelRoleDraft = ModelRoleRecord & { readonly thinkingAdjustment?: string };
