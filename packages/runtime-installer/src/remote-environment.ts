import { createPublicKey, verify } from "node:crypto";
import { canonicalUpdateJson } from "./update-manifest.js";
import { assertSafeVersion } from "./signed-artifact.js";
import { RUNTIME_PLATFORMS } from "./runtime-platform.js";

export interface RemoteEnvironmentManifest {
  schema: 1; repo: string; platform: string; appVersion: string; runtimeVersion: string;
  nodeVersion: string; protocolVersion: number; hostSha256: string; nodeSha256: string;
  archive: { asset: string; url: string; size: number; sha256: string };
}
export interface SignedRemoteEnvironment {
  manifest: RemoteEnvironmentManifest;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}
export function remoteEnvironmentSigningBytes(manifest: RemoteEnvironmentManifest): Buffer {
  return Buffer.from(`omp-studio-remote-environment-v1\n${canonicalUpdateJson(manifest)}`, "utf8");
}
/** The service boundary authenticates the archive before executing its bundled Node. */
export function verifyRemoteEnvironment(value: unknown, keys: Readonly<Record<string, string | Buffer>>, repo: string, platform: string, appVersion: string): SignedRemoteEnvironment {
  const envelope = value as SignedRemoteEnvironment;
  const manifest = envelope?.manifest, signature = envelope?.signature;
  if (!manifest || signature?.algorithm !== "ed25519" || !Object.hasOwn(keys, signature.keyId) || !verify(null, remoteEnvironmentSigningBytes(manifest), createPublicKey(keys[signature.keyId]!), Buffer.from(signature.value, "base64url"))) throw new Error("远端运行包签名验证失败");
  if (manifest.schema !== 1 || manifest.repo !== repo || manifest.platform !== platform || manifest.appVersion !== appVersion || !(RUNTIME_PLATFORMS as readonly string[]).includes(platform)) throw new Error("远端运行包与客户端或目标系统不匹配");
  assertSafeVersion(manifest.runtimeVersion); assertSafeVersion(manifest.nodeVersion);
  const file = manifest.archive;
  if (!file || !/^[a-zA-Z0-9._-]+$/u.test(file.asset) || !/^[a-f0-9]{64}$/u.test(file.sha256) || !/^[a-f0-9]{64}$/u.test(manifest.hostSha256) || !/^[a-f0-9]{64}$/u.test(manifest.nodeSha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || !Number.isSafeInteger(manifest.protocolVersion)) throw new Error("远端运行包元数据不完整");
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.username || url.password || !file.url.startsWith(`https://github.com/${repo}/releases/download/`) || url.pathname.split("/").at(-1) !== file.asset) throw new Error("远端运行包下载地址不属于发布仓库");
  return envelope;
}
