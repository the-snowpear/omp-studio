import { randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";
import { parseRuntimeInstallationManifest } from "./manifest.js";
import { createSmokeTestRunner } from "./self-check.js";
import type { SelfCheckRunner } from "./self-check.js";
import {
  assertSafeVersion,
  isInside,
  installVerifiedArtifact,
  verifySignedArtifact,
  verifySignedMetadata,
  verifyFileChecksums,
  writeJsonAtomic,
  RUNTIME_ARTIFACT_LAYOUT,
  type RuntimeSignatureVerifier,
} from "./signed-artifact.js";

export type { RuntimeSignatureVerifier } from "./signed-artifact.js";

export interface ActiveRuntimeRecord {
  runtimeVersion: string;
  previousRuntimeVersion?: string;
  activatedAt: string;
}

export interface InstalledRuntimeManifest {
  record: ActiveRuntimeRecord;
  manifest: RuntimeInstallationManifest;
  entrypointPath: string;
}

export interface ActivateOptions {
  /** Functional check run against the installed entrypoint before `current.json` is switched. */
  selfCheck?: SelfCheckRunner;
}

export interface RuntimeInstallerOptions {
  signatureVerifier?: RuntimeSignatureVerifier;
  trustedKeys?: Readonly<Record<string, string | Buffer>>;
  isRuntimeReferenced?: (runtimeVersion: string) => boolean | Promise<boolean>;
}

export interface RuntimeInstallOptions {
  /** Only set inside a maintenance transaction that has stopped all Runtime processes. */
  allowReferencedRepair?: boolean;
}

export class RuntimeInstallationReferencedError extends Error {
  readonly code = "RUNTIME_INSTALLATION_REFERENCED";
  constructor(readonly runtimeVersion: string) {
    super(`Runtime ${runtimeVersion} is referenced by a Thread binding; stop its Runtime processes before repairing it`);
    this.name = "RuntimeInstallationReferencedError";
  }
}

export class RuntimeInstaller {
  readonly #versionsDirectory: string;
  readonly #currentPath: string;

  readonly #signatureVerifier: RuntimeSignatureVerifier | undefined;
  readonly #trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly #isRuntimeReferenced: ((runtimeVersion: string) => boolean | Promise<boolean>) | undefined;

  constructor(readonly rootDirectory: string, options: RuntimeInstallerOptions = {}) {
    this.#versionsDirectory = join(rootDirectory, "versions");
    this.#currentPath = join(rootDirectory, "current.json");
    this.#signatureVerifier = options.signatureVerifier;
    this.#trustedKeys = options.trustedKeys ?? {};
    this.#isRuntimeReferenced = options.isRuntimeReferenced;
  }

  async install(artifactDirectory: string, options: RuntimeInstallOptions = {}): Promise<RuntimeInstallationManifest> {
    const { manifest } = await verifySignedArtifact({
      directory: artifactDirectory,
      layout: RUNTIME_ARTIFACT_LAYOUT,
      parseManifest: parseRuntimeInstallationManifest,
      requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
      trustedKeys: this.#trustedKeys,
      ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
      coverageMessage: (file) =>
        file === "runtime-manifest.json"
          ? "checksums.json must cover runtime-manifest.json"
          : "checksums.json must cover the Runtime entrypoint",
    });
    assertSafeVersion(manifest.runtimeVersion);
    const installedDirectory = join(this.#versionsDirectory, manifest.runtimeVersion);
    let existing = false;
    try {
      const metadata = await lstat(installedDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Runtime installation must be a regular directory");
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      try {
        const installed = await verifySignedArtifact({
          directory: installedDirectory,
          layout: RUNTIME_ARTIFACT_LAYOUT,
          parseManifest: parseRuntimeInstallationManifest,
          requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
          trustedKeys: this.#trustedKeys,
          ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
        });
        if (installed.manifest.runtimeVersion === manifest.runtimeVersion) return installed.manifest;
      } catch {
        // The replacement source is already verified; repair a corrupt installed copy.
      }
    }
    const beforeReplace = async (): Promise<void> => {
      if (!options.allowReferencedRepair && await this.#isRuntimeReferenced?.(manifest.runtimeVersion)) {
        throw new RuntimeInstallationReferencedError(manifest.runtimeVersion);
      }
    };
    if (existing) await beforeReplace();
    await installVerifiedArtifact({
      sourceDirectory: artifactDirectory,
      versionsDirectory: this.#versionsDirectory,
      version: manifest.runtimeVersion,
      requireFile: manifest.entrypoint,
      ...(existing ? { replaceExisting: { beforeReplace } } : {}),
      verifyStaging: async (directory) => {
        const verified = await verifySignedArtifact({
          directory,
          layout: RUNTIME_ARTIFACT_LAYOUT,
          parseManifest: parseRuntimeInstallationManifest,
          requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
          trustedKeys: this.#trustedKeys,
          ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
        });
        if (verified.manifest.runtimeVersion !== manifest.runtimeVersion) throw new Error("Artifact version changed during installation");
      },
    });
    return manifest;
  }

  async activate(runtimeVersion: string, options: ActivateOptions = {}): Promise<ActiveRuntimeRecord> {
    assertSafeVersion(runtimeVersion);
    const versionDirectory = join(this.#versionsDirectory, runtimeVersion);
    const { manifest } = await verifySignedArtifact({
      directory: versionDirectory,
      layout: RUNTIME_ARTIFACT_LAYOUT,
      parseManifest: parseRuntimeInstallationManifest,
      requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
      trustedKeys: this.#trustedKeys,
      ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
    });
    if (manifest.runtimeVersion !== runtimeVersion) {
      throw new Error("Runtime manifest version does not match its installation directory");
    }
    const entrypointPath = join(versionDirectory, manifest.entrypoint);
    if (!isInside(versionDirectory, entrypointPath) || !(await lstat(entrypointPath)).isFile()) {
      throw new Error("Runtime entrypoint escapes the version directory");
    }
    const current = await this.current();
    const selfCheck = options.selfCheck ?? createSmokeTestRunner();
    try {
      await selfCheck.run(entrypointPath);
    } catch (error) {
      const referenced =
        current?.runtimeVersion === runtimeVersion || current?.previousRuntimeVersion === runtimeVersion;
      if (referenced) {
        throw new Error(
          `Runtime ${runtimeVersion} failed its activation self-check; referenced installation and current.json were preserved`,
          { cause: error },
        );
      }
      await this.#quarantineFailedCandidate(versionDirectory, runtimeVersion, error);
    }
    const previousRuntimeVersion = current?.runtimeVersion === runtimeVersion
      ? current.previousRuntimeVersion
      : current?.runtimeVersion;
    const record: ActiveRuntimeRecord = {
      runtimeVersion,
      ...(previousRuntimeVersion === undefined ? {} : { previousRuntimeVersion }),
      activatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.#currentPath, record);
    return record;
  }

  // Self-check failed before activation: keep `current.json` untouched and
  // move the candidate out of the installable set under a `.quarantine-`
  // directory so it can be inspected or restored manually (minimal recoverable
  // semantics), then rethrow.
  async #quarantineFailedCandidate(
    versionDirectory: string,
    runtimeVersion: string,
    selfCheckError: unknown,
  ): Promise<never> {
    const quarantinePath = join(
      this.#versionsDirectory,
      `.quarantine-${runtimeVersion}-${randomBytes(6).toString("hex")}`,
    );
    try {
      await rename(versionDirectory, quarantinePath);
    } catch (quarantineError) {
      throw new AggregateError(
        [selfCheckError, quarantineError],
        `Runtime ${runtimeVersion} failed its activation self-check and could not be quarantined; current.json was not changed`,
      );
    }
    throw new Error(
      `Runtime ${runtimeVersion} failed its activation self-check; candidate moved to ${basename(quarantinePath)} and current.json was not changed`,
      { cause: selfCheckError },
    );
  }

  async rollback(): Promise<ActiveRuntimeRecord> {
    const current = await this.current();
    if (current?.previousRuntimeVersion === undefined) throw new Error("No previous runtime is available for rollback");
    const previous = current.previousRuntimeVersion;
    await access(join(this.#versionsDirectory, previous, "runtime-manifest.json"));
    const record: ActiveRuntimeRecord = {
      runtimeVersion: previous,
      previousRuntimeVersion: current.runtimeVersion,
      activatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.#currentPath, record);
    return record;
  }

  async uninstall(runtimeVersion: string): Promise<void> {
    assertSafeVersion(runtimeVersion);
    const current = await this.current();
    if (current?.runtimeVersion === runtimeVersion || current?.previousRuntimeVersion === runtimeVersion) {
      throw new Error(`Runtime ${runtimeVersion} is referenced by current.json`);
    }
    if (await this.#isRuntimeReferenced?.(runtimeVersion)) {
      throw new Error(`Runtime ${runtimeVersion} is referenced by an active Thread binding`);
    }
    const target = join(this.#versionsDirectory, runtimeVersion);
    if (!isInside(this.#versionsDirectory, target)) throw new Error("Runtime uninstall target escaped the versions directory");
    await rm(target, { recursive: true, force: false });
  }

  async prune(options: { retainStable?: number } = {}): Promise<string[]> {
    const retainStable = Math.max(2, Math.floor(options.retainStable ?? 2));
    let names: string[];
    try {
      names = await readdir(this.#versionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const installed: Array<{ version: string; channel: "stable" | "canary"; mtimeMs: number }> = [];
    const broken: string[] = [];
    for (const version of names.filter(name => !name.startsWith("."))) {
      try {
        assertSafeVersion(version);
        const directory = join(this.#versionsDirectory, version);
        const manifest = parseRuntimeInstallationManifest(
          JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8")) as unknown,
        );
        installed.push({ version, channel: manifest.channel, mtimeMs: (await lstat(directory)).mtimeMs });
      } catch {
        broken.push(version);
      }
    }
    const keep = new Set(
      installed
        .filter(entry => entry.channel === "stable")
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, retainStable)
        .map(entry => entry.version),
    );
    const current = await this.current();
    if (current) {
      keep.add(current.runtimeVersion);
      if (current.previousRuntimeVersion) keep.add(current.previousRuntimeVersion);
    }
    const removed: string[] = [];
    for (const entry of installed) {
      if (keep.has(entry.version) || (await this.#isRuntimeReferenced?.(entry.version))) continue;
      try {
        await this.uninstall(entry.version);
        removed.push(entry.version);
      } catch {
        // Skip on failure
      }
    }
    for (const version of broken) {
      if (keep.has(version) || (await this.#isRuntimeReferenced?.(version))) continue;
      try {
        const target = join(this.#versionsDirectory, version);
        if (isInside(this.#versionsDirectory, target)) {
          await rm(target, { recursive: true, force: true });
          removed.push(version);
        }
      } catch {
        // Skip on failure
      }
    }
    return removed;
  }

  async current(): Promise<ActiveRuntimeRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.#currentPath, "utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("current.json is invalid");
      const record = value as Record<string, unknown>;
      if (typeof record.runtimeVersion !== "string" || typeof record.activatedAt !== "string") {
        throw new TypeError("current.json is invalid");
      }
      assertSafeVersion(record.runtimeVersion);
      if (record.previousRuntimeVersion !== undefined) {
        if (typeof record.previousRuntimeVersion !== "string") throw new TypeError("current.json is invalid");
        assertSafeVersion(record.previousRuntimeVersion);
      }
      return {
        runtimeVersion: record.runtimeVersion,
        activatedAt: record.activatedAt,
        ...(typeof record.previousRuntimeVersion === "string"
          ? { previousRuntimeVersion: record.previousRuntimeVersion }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Read-only query for the active installation: its runtime manifest and the
   * absolute entrypoint path. Never mutates `current.json` or activation
   * state; used by the Runtime Resolver's managed lookup. Re-verifies signed
   * metadata and the actual executable bytes before they reach the process probe.
   */
  async currentManifest(): Promise<InstalledRuntimeManifest | undefined> {
    const record = await this.current();
    if (record === undefined) return undefined;
    const versionDirectory = join(this.#versionsDirectory, record.runtimeVersion);
    const { manifest, checksums } = await verifySignedMetadata({
      directory: versionDirectory,
      layout: RUNTIME_ARTIFACT_LAYOUT,
      parseManifest: parseRuntimeInstallationManifest,
      requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
      trustedKeys: this.#trustedKeys,
      ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
      coverageMessage: (file) =>
        file === "runtime-manifest.json"
          ? "checksums.json must cover runtime-manifest.json"
          : "checksums.json must cover the Runtime entrypoint",
    });
    if (manifest.runtimeVersion !== record.runtimeVersion) {
      throw new Error("Runtime manifest version does not match the active installation");
    }
    const entrypointPath = join(versionDirectory, manifest.entrypoint);
    if (!isInside(versionDirectory, entrypointPath) || !(await lstat(entrypointPath)).isFile()) {
      throw new Error("Runtime entrypoint escapes the version directory");
    }
    await verifyFileChecksums(versionDirectory, { [manifest.entrypoint]: checksums.files[manifest.entrypoint]! });
    return { record, manifest, entrypointPath };
  }
}
