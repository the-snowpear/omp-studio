import { isAlias, isMap, isScalar, parseDocument, stringify } from "yaml";

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

const YAML_FORMAT = { lineWidth: 0, blockQuote: false, doubleQuotedAsJSON: true } as const;

export class ModelsYmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsYmlError";
  }
}

function readDocument(source: string, redact = false) {
  const document = parseDocument(source, { prettyErrors: false, keepSourceTokens: true });
  if (document.errors[0]) throw new ModelsYmlError(document.errors[0].message);
  if (document.contents !== null && !isMap(document.contents)) {
    throw new ModelsYmlError("models.yml root must be a mapping");
  }

  const providers = document.get("providers", true);
  if (!isMap(providers)) return document;
  for (const { value: provider } of providers.items) {
    if (!isMap(provider)) continue;
    const apiKey = provider.items.find(({ key }) => isScalar(key) && key.value === "apiKey");
    if (!apiKey) continue;
    if (redact) {
      apiKey.value = document.createNode("********");
      continue;
    }

    // Older Studio saves emitted these credentials without YAML quotes.
    const value = apiKey.value;
    if (isAlias(value) && value.resolve(document) === undefined) {
      apiKey.value = document.createNode("*" + value.source);
    } else if (isScalar(value) && value.tag?.startsWith("!")) {
      const tag = apiKey.srcToken?.sep?.find((token) => token.type === "tag");
      if (tag && value.range) {
        apiKey.value = document.createNode(source.slice(tag.offset, value.range[1]));
      }
    }
  }
  return document;
}

export function parseModelsYml(source: string): { [key: string]: YamlValue } {
  return (readDocument(source).toJS({ maxAliasCount: 0 }) ?? {}) as { [key: string]: YamlValue };
}

export function serializeModelsYml(root: { [key: string]: YamlValue }): string {
  return stringify(root, { ...YAML_FORMAT, aliasDuplicateObjects: false });
}

export function redactModelsYmlText(source: string): string {
  return readDocument(source, true).toString(YAML_FORMAT);
}

export function isRedactedApiKey(value: unknown): boolean {
  return typeof value === "string" && /^\*{6,}$/.test(value);
}

/** Copy previous apiKey when the new document still has the redaction placeholder. */
export function restoreRedactedApiKeys(
  next: { [key: string]: YamlValue },
  previous: { [key: string]: YamlValue },
): void {
  const nextProviders = yamlMap(next.providers);
  const prevProviders = yamlMap(previous.providers);
  if (!nextProviders || !prevProviders) return;
  for (const [id, node] of Object.entries(nextProviders)) {
    const current = yamlMap(node);
    const prior = yamlMap(prevProviders[id]);
    if (!current || !prior) continue;
    if (isRedactedApiKey(current.apiKey) && typeof prior.apiKey === "string") {
      current.apiKey = prior.apiKey;
    }
  }
}

function yamlMap(value: YamlValue | undefined): { [key: string]: YamlValue } | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}
