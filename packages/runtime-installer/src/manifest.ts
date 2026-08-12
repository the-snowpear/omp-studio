import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";

export interface ChecksumManifest {
  algorithm: "sha256";
  files: Record<string, string>;
}

export interface RuntimeSignatureManifest {
  algorithm: "ed25519";
  keyId: string;
  payloadSha256: string;
  signature: string;
}

const RUNTIME_MANIFEST_KEYS = new Set([
  "runtimeVersion",
  "upstreamVersion",
  "upstreamCommit",
  "patchsetVersion",
  "studioProtocol",
  "profile",
  "capabilityHash",
  "commandManifestHash",
  "platform",
  "entrypoint",
  "channel",
]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function parseRuntimeInstallationManifest(value: unknown): RuntimeInstallationManifest {
  const input = asRecord(value, "runtime manifest");
  const unknown = Object.keys(input).find((key) => !RUNTIME_MANIFEST_KEYS.has(key));
  if (unknown !== undefined) throw new TypeError(`runtime manifest has unknown field ${unknown}`);

  for (const key of [
    "runtimeVersion",
    "upstreamVersion",
    "upstreamCommit",
    "patchsetVersion",
    "capabilityHash",
    "commandManifestHash",
    "platform",
    "entrypoint",
  ]) {
    requiredString(input[key], `runtime manifest ${key}`);
  }
  if (input.profile !== "full-parity-v1" && input.profile !== "limited") {
    throw new TypeError("runtime manifest profile must be full-parity-v1 or limited");
  }
  if (input.channel !== "stable" && input.channel !== "canary") {
    throw new TypeError("runtime manifest channel must be stable or canary");
  }
  const protocol = asRecord(input.studioProtocol, "runtime manifest studioProtocol");
  if (
    !Number.isSafeInteger(protocol.min) ||
    !Number.isSafeInteger(protocol.max) ||
    (protocol.min as number) < 1 ||
    (protocol.max as number) < (protocol.min as number)
  ) {
    throw new TypeError("runtime manifest studioProtocol range is invalid");
  }
  return input as unknown as RuntimeInstallationManifest;
}

export function parseChecksumManifest(value: unknown): ChecksumManifest {
  const input = asRecord(value, "checksums");
  if (input.algorithm !== "sha256") throw new TypeError("checksums algorithm must be sha256");
  const files = asRecord(input.files, "checksums files");
  for (const [path, digest] of Object.entries(files)) {
    if (path === "checksums.json" || path === "runtime-signature.json") {
      throw new TypeError(`checksums cannot contain self-referential metadata entry ${path}`);
    }
    if (path.length === 0 || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new TypeError(`invalid checksum entry ${path}`);
    }
  }
  return { algorithm: "sha256", files: files as Record<string, string> };
}

export function parseRuntimeSignatureManifest(value: unknown): RuntimeSignatureManifest {
  const input = asRecord(value, "runtime signature");
  const keys = ["algorithm", "keyId", "payloadSha256", "signature"];
  const unknown = Object.keys(input).find(key => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`runtime signature has unknown field ${unknown}`);
  if (input.algorithm !== "ed25519") throw new TypeError("runtime signature algorithm must be ed25519");
  requiredString(input.keyId, "runtime signature keyId");
  if (typeof input.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.payloadSha256)) {
    throw new TypeError("runtime signature payloadSha256 is invalid");
  }
  requiredString(input.signature, "runtime signature signature");
  return input as unknown as RuntimeSignatureManifest;
}
