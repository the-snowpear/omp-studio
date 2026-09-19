import { createPublicKey, verify } from "node:crypto";
import { assertSafeVersion } from "./signed-artifact.js";

export type UpdateChannel = "stable" | "canary";
export type UpdateComponent = "app" | "runtime";
export type DownloadMethod = "differential" | "full" | "reuse";
export interface UpdateFile {
  asset: string; url: string; size: number; sha256: string; sha512: string;
}
export interface ComponentRelease {
  version: string; sequence: number; channel: UpdateChannel;
  file: UpdateFile; blockmap: UpdateFile;
  minAppVersion: string;
  studioProtocol: { min: number; max: number };
  bundledRuntimeVersion?: string;
}
export interface UpdateManifest {
  schema: 2; repo: string; platform: "win32-x64" | "win32-arm64";
  generatedAt: string; releaseNotesUrl: string;
  app?: ComponentRelease; runtime?: ComponentRelease;
}
export interface SignedUpdateManifest {
  manifest: UpdateManifest;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}
export function canonicalUpdateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalUpdateJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalUpdateJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function updateSigningBytes(manifest: UpdateManifest): Buffer {
  return Buffer.from(`omp-studio-update-v2\n${canonicalUpdateJson(manifest)}`, "utf8");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid update integer");
  return value as number;
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)) throw new Error("Invalid update version");
  assertSafeVersion(value); return value;
}
function https(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing update URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid update URL");
  return value;
}
function file(value: unknown, repo: string): UpdateFile {
  const x = object(value);
  if (typeof x.asset !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(x.asset)) throw new Error("Unsafe update asset");
  const url = https(x.url);
  if (!url.startsWith(`https://github.com/${repo}/releases/download/`) || new URL(url).pathname.split("/").at(-1) !== x.asset) throw new Error("Asset is outside release repository");
  if (typeof x.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(x.sha256) || typeof x.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(x.sha512)) throw new Error("Invalid update digest");
  return { asset: x.asset, url, size: integer(x.size), sha256: x.sha256, sha512: x.sha512 };
}
function component(value: unknown, repo: string, kind: UpdateComponent): ComponentRelease {
  const x = object(value), protocol = object(x.studioProtocol);
  if (x.channel !== "stable" && x.channel !== "canary") throw new Error("Invalid update channel");
  const result: ComponentRelease = {
    version: version(x.version), sequence: integer(x.sequence), channel: x.channel,
    file: file(x.file, repo), blockmap: file(x.blockmap, repo), minAppVersion: version(x.minAppVersion),
    studioProtocol: { min: integer(protocol.min), max: integer(protocol.max) },
  };
  if (result.studioProtocol.min > result.studioProtocol.max || !result.file.asset.endsWith(kind === "app" ? ".exe" : ".zip") || result.blockmap.asset !== `${result.file.asset}.blockmap`) throw new Error("Invalid component metadata");
  if (x.bundledRuntimeVersion !== undefined) result.bundledRuntimeVersion = version(x.bundledRuntimeVersion);
  return result;
}
export function verifyUpdateManifest(value: unknown, keys: Readonly<Record<string, string | Buffer>>, repo: string, platform: string): SignedUpdateManifest {
  const envelope = object(value), raw = object(envelope.manifest), sig = object(envelope.signature);
  if (sig.algorithm !== "ed25519" || typeof sig.keyId !== "string" || typeof sig.value !== "string" || !Object.hasOwn(keys, sig.keyId)) throw new Error("Untrusted update signing key");
  const key = createPublicKey(keys[sig.keyId]!);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, updateSigningBytes(raw as unknown as UpdateManifest), key, Buffer.from(sig.value, "base64url"))) throw new Error("Update signature verification failed");
  if (raw.schema !== 2 || raw.repo !== repo || raw.platform !== platform || !["win32-x64", "win32-arm64"].includes(platform)) throw new Error("Update manifest identity mismatch");
  if (typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))) throw new Error("Invalid update timestamp");
  const manifest: UpdateManifest = { schema: 2, repo, platform: platform as UpdateManifest["platform"], generatedAt: raw.generatedAt, releaseNotesUrl: https(raw.releaseNotesUrl) };
  if (raw.app !== undefined) manifest.app = component(raw.app, repo, "app");
  if (raw.runtime !== undefined) manifest.runtime = component(raw.runtime, repo, "runtime");
  if (!manifest.app && !manifest.runtime) throw new Error("Empty update manifest");
  return { manifest, signature: { algorithm: "ed25519", keyId: sig.keyId, value: sig.value } };
}

export type UpdatePhase = "idle" | "checking" | "downloading" | "verifying" | "ready" | "applying" | "failed" | "cancelled";
export interface ComponentUpdateState {
  component: UpdateComponent; currentVersion?: string | undefined; version?: string | undefined;
  phase: UpdatePhase; method?: DownloadMethod | undefined;
  receivedBytes?: number | undefined; totalBytes?: number | undefined; message?: string | undefined;
}
export interface UnifiedUpdateSnapshot {
  schema: 2; checking: boolean; app: ComponentUpdateState; runtime: ComponentUpdateState;
  rollbackAppVersion?: string | undefined;
  rollbackAppPending?: boolean | undefined;
  error?: string | undefined; releaseNotesUrl?: string | undefined;
}
