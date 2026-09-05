import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  APP_PAYLOAD_ARTIFACT_LAYOUT,
  APP_PAYLOAD_FORMAT,
  AppPayloadInstaller,
  parseAppPayloadManifest,
  verifySignedArtifact,
  type ActiveAppPayloadRecord,
  type AppPayloadManifest,
  type RuntimeSignatureVerifier,
} from "@omp-studio/runtime-installer";

export const PAYLOAD_DIR = "payload";
export const PRELOAD_OUTPUT = "dist/preload.cjs";

export interface AppResourceLayout {
  readonly effectiveVersion: string;
  readonly rendererDist: string;
  readonly preloadPath: string;
  readonly payloadVersion?: string;
  readonly bootNotice?: "payload-rolled-back" | "payload-rejected";
}

export interface ResolveAppResourceLayoutInput {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly bundledVersion: string;
  readonly forceBaseline: boolean;
  readonly runtime: {
    readonly electron: string;
    readonly modules: string;
    readonly nodePty: string;
  };
  readonly platform: string;
  readonly trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly payloadRoot?: string;
  readonly signatureVerifier?: RuntimeSignatureVerifier;
}

export async function resolveAppResourceLayout(
  input: ResolveAppResourceLayoutInput,
): Promise<AppResourceLayout> {
  const baselineRenderer = resolve(input.appPath, "..", "renderer", "dist");
  const baselinePreload = resolve(input.appPath, PRELOAD_OUTPUT);

  const fallback = (bootNotice?: "payload-rolled-back" | "payload-rejected"): AppResourceLayout => ({
    effectiveVersion: input.bundledVersion,
    rendererDist: baselineRenderer,
    preloadPath: baselinePreload,
    ...(bootNotice ? { bootNotice } : {}),
  });

  const isCompatible = (manifest: AppPayloadManifest, version: string): boolean =>
    manifest.payloadVersion === version &&
    manifest.abi.electron === input.runtime.electron &&
    manifest.abi.modules === input.runtime.modules &&
    manifest.abi.nodePty === input.runtime.nodePty &&
    manifest.platform === input.platform &&
    manifest.payloadFormat <= APP_PAYLOAD_FORMAT &&
    manifest.clientContractVersion === CLIENT_CONTRACT_VERSION &&
    manifest.studioProtocol.min <= STUDIO_PROTOCOL_VERSION &&
    manifest.studioProtocol.max >= STUDIO_PROTOCOL_VERSION;

  // 1. forceBaseline -> baseline, never touch current.json
  if (input.forceBaseline) {
    return fallback();
  }

  const payloadRoot = input.payloadRoot ?? resolve(input.appPath, "..", PAYLOAD_DIR);
  const installer = new AppPayloadInstaller(payloadRoot, {
    trustedKeys: input.trustedKeys,
    signatureVerifier: input.signatureVerifier,
  });

  // 2. Read current.json; missing or corrupt -> baseline
  let current: ActiveAppPayloadRecord | undefined;
  try {
    current = await installer.current();
  } catch {
    return fallback();
  }
  if (current === undefined) {
    return fallback();
  }

  // 3. bootAttempts >= 2 -> downgrade to previous or fallback to baseline
  if (current.bootAttempts >= 2) {
    if (current.previousPayloadVersion !== undefined) {
      try {
        const prevDir = join(payloadRoot, "versions", current.previousPayloadVersion);
        const verifiedPrev = await verifySignedArtifact({
          directory: prevDir,
          layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
          parseManifest: parseAppPayloadManifest,
          requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
          trustedKeys: input.trustedKeys,
          ...(input.signatureVerifier ? { signatureVerifier: input.signatureVerifier } : {}),
        });
        if (isCompatible(verifiedPrev.manifest, current.previousPayloadVersion)) {
          // Do not point back to the failed candidate if the previous payload also fails.
          await installer.rollback({ discardFailedVersion: true });
          await installer.noteBootAttempt();
          return {
            effectiveVersion: verifiedPrev.manifest.payloadVersion,
            payloadVersion: verifiedPrev.manifest.payloadVersion,
            rendererDist: join(prevDir, "renderer"),
            preloadPath: join(prevDir, "preload.cjs"),
            bootNotice: "payload-rolled-back",
          };
        }
      } catch {
        // Previous verification failed
      }
    }
    try {
      await rm(join(payloadRoot, "current.json"), { force: true });
    } catch {
      // Ignore removal failure
    }
    return fallback("payload-rolled-back");
  }

  // 4. Verify candidate artifact
  const versionDir = join(payloadRoot, "versions", current.payloadVersion);
  let verified: { manifest: AppPayloadManifest };
  try {
    verified = await verifySignedArtifact({
      directory: versionDir,
      layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
      parseManifest: parseAppPayloadManifest,
      requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
      trustedKeys: input.trustedKeys,
      ...(input.signatureVerifier ? { signatureVerifier: input.signatureVerifier } : {}),
    });
  } catch {
    return fallback("payload-rejected");
  }

  // 5. ABI & platform gate
  if (!isCompatible(verified.manifest, current.payloadVersion)) {
    return fallback("payload-rejected");
  }

  // 6. Note attempt and return layout
  try {
    await installer.noteBootAttempt();
  } catch {
    return fallback("payload-rejected");
  }
  return {
    effectiveVersion: verified.manifest.payloadVersion,
    payloadVersion: verified.manifest.payloadVersion,
    rendererDist: join(versionDir, "renderer"),
    preloadPath: join(versionDir, "preload.cjs"),
  };
}
