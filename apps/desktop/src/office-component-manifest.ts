import { assertSafeVersion, canonicalUpdateJson, createTrustedKeyVerifier, type RuntimeSignatureManifest } from "@omp-studio/runtime-installer";

export interface OfficeComponentManifest {
  schema: 1; component: "office-preview"; version: string; platform: "win32-x64" | "win32-arm64" | "darwin-arm64";
  engineVersion: string; entrypoint: string;
  archive: { url: string; sha256: string; bytes: number };
  sourceUrl: string; license: string;
}
export interface SignedOfficeComponent { manifest: OfficeComponentManifest; signature: RuntimeSignatureManifest }
export const officeManifestPayload = (manifest: OfficeComponentManifest) => Buffer.from(`omp-studio-office-preview-v1\n${canonicalUpdateJson(manifest)}`);
export function verifyOfficeComponent(value: unknown, keys: Readonly<Record<string, string | Buffer>>, platform: string): SignedOfficeComponent {
  const envelope = value as SignedOfficeComponent, manifest = envelope?.manifest;
  if (!manifest || manifest.schema !== 1 || manifest.component !== "office-preview" || manifest.platform !== platform) throw new Error("Office 组件不匹配当前平台");
  assertSafeVersion(manifest.version);
  if (!createTrustedKeyVerifier(keys).verify(envelope.signature, officeManifestPayload(manifest))) throw new Error("Office 组件签名无效");
  const entrypoint = platform.startsWith("win32-") ? "LibreOffice/program/soffice.com" : "LibreOffice.app/Contents/MacOS/soffice";
  if (manifest.entrypoint !== entrypoint || !/^https:\/\//.test(manifest.archive.url) || !/^[a-f0-9]{64}$/i.test(manifest.archive.sha256) || !Number.isSafeInteger(manifest.archive.bytes) || manifest.archive.bytes <= 0) throw new Error("Office 组件清单无效");
  return envelope;
}
