import { createHash } from "node:crypto";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import {
  assertSafeVersion,
  createTrustedKeyVerifier,
  parseRuntimeSignatureManifest,
} from "@omp-studio/runtime-installer";
import { compareSemver, parseSemver } from "./chrome-app-update.js";
import { compareRuntimeVersions } from "./runtime-install.js";

export const UPDATE_INDEX_SCHEMA = 1;
export const PAYLOAD_FORMAT = 1;
export const EXPECTED_NODE_PTY_VERSION = "1.1.0";

export interface SetupAsset {
  readonly asset: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PayloadAsset {
  readonly asset: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  readonly payloadFormat: number;
  readonly minAppVersion: string;
  readonly platform: string;
  readonly abi: {
    readonly electron: string;
    readonly modules: string;
    readonly nodePty: string;
  };
  readonly clientContractVersion: number;
  readonly studioProtocol: {
    readonly min: number;
    readonly max: number;
  };
}

export interface RuntimeFileAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UpdateIndex {
  readonly schema: number;
  readonly sequence: number;
  readonly generatedAt: string;
  readonly repo: string;
  readonly app: {
    readonly version: string;
    readonly releaseNotesUrl?: string;
    readonly setup: SetupAsset;
    readonly payload?: PayloadAsset;
  };
  readonly runtime: {
    readonly runtimeVersion: string;
    readonly channel: "stable" | "canary";
    readonly platform: string;
    readonly entrypoint: string;
    readonly minAppVersion: string;
    readonly studioProtocol: {
      readonly min: number;
      readonly max: number;
    };
    readonly files: readonly RuntimeFileAsset[];
  };
}

const SHA256_REGEX = /^[a-f0-9]{64}$/u;

function assertAssetName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new TypeError("Unsafe runtime asset name");
  }
}

function assertAppVersion(version: string): void {
  assertSafeVersion(version);
  if (!parseSemver(version)) throw new TypeError("Invalid application version");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHttpsUrl(raw: unknown, context: string): string {
  if (typeof raw !== "string") throw new TypeError(`${context} must be a string`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${context} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new TypeError(`${context} must be an https URL`);
  }
  return raw;
}

function parseSha256(raw: unknown, context: string): string {
  if (typeof raw !== "string" || !SHA256_REGEX.test(raw)) {
    throw new TypeError(`${context} must be a 64-char lowercase hex sha256`);
  }
  return raw;
}

function parseSetupAsset(value: unknown): SetupAsset {
  if (!isRecord(value)) throw new TypeError("setup asset must be an object");
  if (typeof value.asset !== "string" || value.asset.trim().length === 0) {
    throw new TypeError("setup asset name is required");
  }
  const url = parseHttpsUrl(value.url, "setup.url");
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new TypeError("setup.size must be a positive integer");
  }
  const sha256 = parseSha256(value.sha256, "setup.sha256");
  return {
    asset: value.asset,
    url,
    size: value.size,
    sha256,
  };
}

function parsePayloadAsset(value: unknown): PayloadAsset {
  if (!isRecord(value)) throw new TypeError("payload asset must be an object");
  if (typeof value.asset !== "string" || value.asset.trim().length === 0) {
    throw new TypeError("payload asset name is required");
  }
  const url = parseHttpsUrl(value.url, "payload.url");
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new TypeError("payload.size must be a positive integer");
  }
  const sha256 = parseSha256(value.sha256, "payload.sha256");

  if (
    typeof value.payloadFormat !== "number" ||
    !Number.isSafeInteger(value.payloadFormat) ||
    value.payloadFormat < 1
  ) {
    throw new TypeError("payloadFormat must be an integer >= 1");
  }
  if (typeof value.minAppVersion !== "string") throw new TypeError("minAppVersion must be a string");
  assertAppVersion(value.minAppVersion);
  if (typeof value.platform !== "string") throw new TypeError("platform must be a string");

  if (!isRecord(value.abi)) throw new TypeError("abi must be an object");
  if (typeof value.abi.electron !== "string") throw new TypeError("abi.electron must be a string");
  if (typeof value.abi.modules !== "string") throw new TypeError("abi.modules must be a string");
  if (typeof value.abi.nodePty !== "string") throw new TypeError("abi.nodePty must be a string");

  if (
    typeof value.clientContractVersion !== "number" ||
    !Number.isSafeInteger(value.clientContractVersion)
  ) {
    throw new TypeError("clientContractVersion must be an integer");
  }

  if (!isRecord(value.studioProtocol)) throw new TypeError("studioProtocol must be an object");
  if (
    typeof value.studioProtocol.min !== "number" ||
    typeof value.studioProtocol.max !== "number" ||
    !Number.isSafeInteger(value.studioProtocol.min) || value.studioProtocol.min < 0 ||
    !Number.isSafeInteger(value.studioProtocol.max) ||
    value.studioProtocol.min > value.studioProtocol.max
  ) {
    throw new TypeError("studioProtocol range is invalid");
  }

  return {
    asset: value.asset,
    url,
    size: value.size,
    sha256,
    payloadFormat: value.payloadFormat,
    minAppVersion: value.minAppVersion,
    platform: value.platform,
    abi: {
      electron: value.abi.electron,
      modules: value.abi.modules,
      nodePty: value.abi.nodePty,
    },
    clientContractVersion: value.clientContractVersion,
    studioProtocol: {
      min: value.studioProtocol.min,
      max: value.studioProtocol.max,
    },
  };
}

function parseRuntimeFile(value: unknown): RuntimeFileAsset {
  if (!isRecord(value)) throw new TypeError("runtime file must be an object");
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("runtime file name is required");
  }
  assertAssetName(value.name);
  const url = parseHttpsUrl(value.url, `runtime file ${value.name} url`);
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new TypeError(`runtime file ${value.name} size must be a positive integer`);
  }
  const sha256 = parseSha256(value.sha256, `runtime file ${value.name} sha256`);
  return {
    name: value.name,
    url,
    size: value.size,
    sha256,
  };
}

export function parseUpdateIndex(value: unknown): UpdateIndex {
  if (!isRecord(value)) throw new TypeError("Update index must be an object");

  const allowedKeys = new Set(["schema", "sequence", "generatedAt", "repo", "app", "runtime"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Unknown top-level field in update index: ${key}`);
    }
  }

  if (value.schema !== UPDATE_INDEX_SCHEMA) {
    throw new TypeError(`Unsupported update index schema: ${String(value.schema)}`);
  }
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new TypeError("sequence must be a positive integer");
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new TypeError("generatedAt must be a valid ISO date string");
  }
  if (typeof value.repo !== "string" || value.repo.trim().length === 0) {
    throw new TypeError("repo must be a non-empty string");
  }

  if (!isRecord(value.app)) throw new TypeError("app section must be an object");
  if (typeof value.app.version !== "string") throw new TypeError("app.version must be a string");
  assertAppVersion(value.app.version);
  const releaseNotesUrl =
    value.app.releaseNotesUrl !== undefined
      ? parseHttpsUrl(value.app.releaseNotesUrl, "app.releaseNotesUrl")
      : undefined;
  const setup = parseSetupAsset(value.app.setup);
  const payload = value.app.payload !== undefined ? parsePayloadAsset(value.app.payload) : undefined;

  if (!isRecord(value.runtime)) throw new TypeError("runtime section must be an object");
  if (typeof value.runtime.runtimeVersion !== "string") {
    throw new TypeError("runtime.runtimeVersion must be a string");
  }
  assertSafeVersion(value.runtime.runtimeVersion);
  assertAssetName(value.runtime.runtimeVersion);
  if (value.runtime.channel !== "stable" && value.runtime.channel !== "canary") {
    throw new TypeError("runtime.channel must be stable or canary");
  }
  if (typeof value.runtime.platform !== "string") throw new TypeError("runtime.platform must be a string");
  if (typeof value.runtime.entrypoint !== "string") throw new TypeError("runtime.entrypoint must be a string");
  assertAssetName(value.runtime.entrypoint);
  if (typeof value.runtime.minAppVersion !== "string") {
    throw new TypeError("runtime.minAppVersion must be a string");
  }
  assertAppVersion(value.runtime.minAppVersion);
  if (!isRecord(value.runtime.studioProtocol)) {
    throw new TypeError("runtime.studioProtocol must be an object");
  }
  if (
    typeof value.runtime.studioProtocol.min !== "number" ||
    typeof value.runtime.studioProtocol.max !== "number" ||
    !Number.isSafeInteger(value.runtime.studioProtocol.min) || value.runtime.studioProtocol.min < 0 ||
    !Number.isSafeInteger(value.runtime.studioProtocol.max) ||
    value.runtime.studioProtocol.min > value.runtime.studioProtocol.max
  ) {
    throw new TypeError("runtime.studioProtocol range is invalid");
  }

  if (!Array.isArray(value.runtime.files) || value.runtime.files.length === 0) {
    throw new TypeError("runtime.files must be a non-empty array");
  }
  const files = value.runtime.files.map(parseRuntimeFile);
  if (new Set(files.map((file) => file.name.toLowerCase())).size !== files.length) {
    throw new TypeError("Duplicate runtime asset name");
  }

  return {
    schema: value.schema,
    sequence: value.sequence,
    generatedAt: value.generatedAt,
    repo: value.repo,
    app: {
      version: value.app.version,
      ...(releaseNotesUrl !== undefined ? { releaseNotesUrl } : {}),
      setup,
      ...(payload !== undefined ? { payload } : {}),
    },
    runtime: {
      runtimeVersion: value.runtime.runtimeVersion,
      channel: value.runtime.channel,
      platform: value.runtime.platform,
      entrypoint: value.runtime.entrypoint,
      minAppVersion: value.runtime.minAppVersion,
      studioProtocol: {
        min: value.runtime.studioProtocol.min,
        max: value.runtime.studioProtocol.max,
      },
      files,
    },
  };
}

/**
 * The root of trust for updates is the Ed25519 signature and SHA-256 digests
 * on the assets themselves, not the transport channel. Mirror prefixes can
 * therefore be configured freely.
 */
export function applyMirror(prefix: string, url: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const allowedHosts = new Set(["github.com", "objects.githubusercontent.com", "api.github.com"]);
  if (!allowedHosts.has(parsed.host.toLowerCase())) {
    return url;
  }

  let result: string;
  if (trimmed.includes("{url}")) {
    result = trimmed.replace("{url}", url);
  } else if (trimmed.endsWith("/")) {
    result = `${trimmed}${url}`;
  } else {
    result = `${trimmed}/${url}`;
  }

  try {
    const resUrl = new URL(result);
    if (resUrl.protocol !== "https:") return url;
  } catch {
    return url;
  }

  return result;
}

export async function fetchUpdateIndex(input: {
  readonly repo: string;
  readonly mirrorPrefix: string;
  readonly trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly lastSequence: number;
  readonly fetcher?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly arch?: "x64" | "arm64" | undefined;
  readonly channel?: "stable" | "canary" | undefined;
}): Promise<UpdateIndex> {
  const fetchFn = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;

  const indexName = (input.arch ?? process.arch) === "arm64" ? "update-index-win32-arm64" : "update-index";
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]);
  const readBounded = async (response: Response, maxBytes: number): Promise<Buffer> => {
    if (!response.body) throw new Error("Empty update metadata response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        total += value.length;
        if (total > maxBytes) throw new Error("Update metadata exceeds size limit");
        chunks.push(value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  let releasePath = "latest/download";
  if (input.channel === "canary") {
    const response = await fetchFn(applyMirror(input.mirrorPrefix,
      `https://api.github.com/repos/${input.repo}/releases?per_page=30`), { signal });
    if (!response.ok) throw new Error(`Failed to discover canary releases: HTTP ${response.status}`);
    const releases: unknown = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString("utf8"));
    if (!Array.isArray(releases)) throw new Error("Invalid canary release listing");
    const release = releases.filter(isRecord).filter((candidate) =>
      candidate.draft === false && candidate.prerelease === true &&
      typeof candidate.tag_name === "string" && /-canary(?:[.-]|$)/u.test(candidate.tag_name) &&
      Array.isArray(candidate.assets) && [indexName + ".json", indexName + ".sig.json"].every((name) =>
        (candidate.assets as unknown[]).some((asset: unknown) => isRecord(asset) && asset.name === name)))
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    if (!release) throw new Error("No signed canary release is available for this architecture");
    releasePath = `download/${encodeURIComponent(release.tag_name as string)}`;
  }
  const baseUrl = `https://github.com/${input.repo}/releases/${releasePath}/${indexName}`;
  const [indexRes, sigRes] = await Promise.all([
    fetchFn(applyMirror(input.mirrorPrefix, `${baseUrl}.json`), { signal }),
    fetchFn(applyMirror(input.mirrorPrefix, `${baseUrl}.sig.json`), { signal }),
  ]);
  if (!indexRes.ok) throw new Error(`Failed to fetch update index: HTTP ${indexRes.status}`);
  if (!sigRes.ok) throw new Error(`Failed to fetch update index signature: HTTP ${sigRes.status}`);
  const [signedPayload, signatureBytes] = await Promise.all([readBounded(indexRes, 1024 * 1024), readBounded(sigRes, 16 * 1024)]);
  const indexText = signedPayload.toString("utf8");
  const sigText = signatureBytes.toString("utf8");

  const signature = parseRuntimeSignatureManifest(JSON.parse(sigText) as unknown);
  const verifier = createTrustedKeyVerifier(input.trustedKeys);

  if (createHash("sha256").update(signedPayload).digest("hex") !== signature.payloadSha256 || !verifier.verify(signature, signedPayload)) {
    throw new Error("Update index signature verification failed");
  }

  const index = parseUpdateIndex(JSON.parse(indexText) as unknown);
  if (input.channel !== undefined && index.runtime.channel !== input.channel) throw new Error("Update index channel mismatch");
  if (index.repo !== input.repo) throw new Error("Update index repository mismatch");
  // Re-checking or downloading the same signed release must remain possible.
  if (index.sequence < input.lastSequence) {
    throw new Error(
      `Update index sequence ${index.sequence} is older than local watermark ${input.lastSequence}`,
    );
  }

  return index;
}

export type AppUpdatePlan =
  | { readonly kind: "none" }
  | { readonly kind: "hot"; readonly version: string; readonly payload: PayloadAsset }
  | {
      readonly kind: "full";
      readonly version: string;
      readonly setup: SetupAsset;
      readonly reason:
        | "no-payload"
        | "electron"
        | "modules"
        | "node-pty"
        | "payload-format"
        | "min-app-version"
        | "client-contract"
        | "studio-protocol"
        | "platform";
    };

export function planAppUpdate(input: {
  readonly index: UpdateIndex;
  readonly currentAppVersion: string;
  readonly bundledAppVersion?: string | undefined;
  readonly runtime: { readonly electron: string; readonly modules: string; readonly nodePty: string };
  readonly platform: string;
  readonly skippedVersion: string;
  readonly preferHot: boolean;
}): AppUpdatePlan {
  const version = input.index.app.version;
  if (compareSemver(version, input.currentAppVersion) <= 0) {
    return { kind: "none" };
  }
  if (input.skippedVersion.length > 0 && version === input.skippedVersion) {
    return { kind: "none" };
  }

  const payload = input.index.app.payload;
  if (payload === undefined || input.preferHot === false) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "no-payload" };
  }
  if (payload.platform !== input.platform) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "platform" };
  }
  if (payload.payloadFormat > PAYLOAD_FORMAT) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "payload-format" };
  }
  if (compareSemver(input.bundledAppVersion ?? input.currentAppVersion, payload.minAppVersion) < 0) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "min-app-version" };
  }
  if (payload.abi.electron !== input.runtime.electron) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "electron" };
  }
  if (payload.abi.modules !== input.runtime.modules) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "modules" };
  }
  if (payload.abi.nodePty !== input.runtime.nodePty) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "node-pty" };
  }
  if (payload.clientContractVersion !== CLIENT_CONTRACT_VERSION) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "client-contract" };
  }
  if (payload.studioProtocol.min > STUDIO_PROTOCOL_VERSION || payload.studioProtocol.max < STUDIO_PROTOCOL_VERSION) {
    return { kind: "full", version, setup: input.index.app.setup, reason: "studio-protocol" };
  }

  return { kind: "hot", version, payload };
}

export type RuntimeUpdatePlan =
  | { readonly kind: "none" }
  | { readonly kind: "available"; readonly runtimeVersion: string; readonly totalBytes: number }
  | { readonly kind: "blocked"; readonly reason: "protocol" | "min-app-version" | "platform" | "channel" };

export function planRuntimeUpdate(input: {
  readonly index: UpdateIndex;
  readonly installedRuntimeVersion?: string | undefined;
  readonly channel: "stable" | "canary";
  readonly platform: string;
  readonly appVersion: string;
  readonly studioProtocol: number;
}): RuntimeUpdatePlan {
  const runtime = input.index.runtime;
  if (runtime.channel !== input.channel) return { kind: "blocked", reason: "channel" };
  if (runtime.platform !== input.platform) {
    return { kind: "blocked", reason: "platform" };
  }
  if (input.studioProtocol < runtime.studioProtocol.min || input.studioProtocol > runtime.studioProtocol.max) {
    return { kind: "blocked", reason: "protocol" };
  }
  if (compareSemver(input.appVersion, runtime.minAppVersion) < 0) {
    return { kind: "blocked", reason: "min-app-version" };
  }

  if (input.installedRuntimeVersion !== undefined) {
    const cmp = compareRuntimeVersions(runtime.runtimeVersion, input.installedRuntimeVersion);
    if (cmp !== undefined && cmp <= 0) {
      return { kind: "none" };
    }
  }

  const totalBytes = runtime.files.reduce((acc, file) => acc + file.size, 0);
  return { kind: "available", runtimeVersion: runtime.runtimeVersion, totalBytes };
}
