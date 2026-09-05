import { access, lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_PAYLOAD_ARTIFACT_LAYOUT,
  assertSafeVersion,
  installVerifiedArtifact,
  isInside,
  verifySignedArtifact,
  writeJsonAtomic,
  type RuntimeSignatureVerifier,
} from "./signed-artifact.js";

export const APP_PAYLOAD_FORMAT = 1;

export interface AppPayloadManifest {
  readonly payloadVersion: string;
  readonly payloadFormat: number;
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
  readonly entries: readonly string[];
}

export function parseAppPayloadManifest(value: unknown): AppPayloadManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("App payload manifest must be an object");
  }

  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "payloadVersion",
    "payloadFormat",
    "platform",
    "abi",
    "clientContractVersion",
    "studioProtocol",
    "entries",
  ]);

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Unknown field in app payload manifest: ${key}`);
    }
  }

  if (typeof record.payloadVersion !== "string" || record.payloadVersion.trim() === "") {
    throw new TypeError("App payload manifest payloadVersion must be a non-empty string");
  }
  assertSafeVersion(record.payloadVersion);

  if (typeof record.payloadFormat !== "number" || !Number.isInteger(record.payloadFormat) || record.payloadFormat < 1) {
    throw new TypeError("App payload manifest payloadFormat must be a positive integer");
  }

  if (typeof record.platform !== "string" || record.platform.trim() === "") {
    throw new TypeError("App payload manifest platform must be a non-empty string");
  }

  if (record.abi === null || typeof record.abi !== "object" || Array.isArray(record.abi)) {
    throw new TypeError("App payload manifest abi must be an object");
  }
  const abiRecord = record.abi as Record<string, unknown>;
  const allowedAbiKeys = new Set(["electron", "modules", "nodePty"]);
  for (const key of Object.keys(abiRecord)) {
    if (!allowedAbiKeys.has(key)) {
      throw new TypeError(`Unknown field in abi: ${key}`);
    }
  }
  if (typeof abiRecord.electron !== "string" || abiRecord.electron.trim() === "") {
    throw new TypeError("App payload manifest abi.electron must be a non-empty string");
  }
  if (typeof abiRecord.modules !== "string" || abiRecord.modules.trim() === "") {
    throw new TypeError("App payload manifest abi.modules must be a non-empty string");
  }
  if (typeof abiRecord.nodePty !== "string" || abiRecord.nodePty.trim() === "") {
    throw new TypeError("App payload manifest abi.nodePty must be a non-empty string");
  }

  if (
    typeof record.clientContractVersion !== "number" ||
    !Number.isInteger(record.clientContractVersion) ||
    record.clientContractVersion < 0
  ) {
    throw new TypeError("App payload manifest clientContractVersion must be a non-negative integer");
  }

  if (
    record.studioProtocol === null ||
    typeof record.studioProtocol !== "object" ||
    Array.isArray(record.studioProtocol)
  ) {
    throw new TypeError("App payload manifest studioProtocol must be an object");
  }
  const protocolRecord = record.studioProtocol as Record<string, unknown>;
  const allowedProtocolKeys = new Set(["min", "max"]);
  for (const key of Object.keys(protocolRecord)) {
    if (!allowedProtocolKeys.has(key)) {
      throw new TypeError(`Unknown field in studioProtocol: ${key}`);
    }
  }
  if (
    typeof protocolRecord.min !== "number" ||
    !Number.isInteger(protocolRecord.min) ||
    protocolRecord.min < 0 ||
    typeof protocolRecord.max !== "number" ||
    !Number.isInteger(protocolRecord.max) ||
    protocolRecord.max < protocolRecord.min
  ) {
    throw new TypeError("App payload manifest studioProtocol min/max must be valid integers with min <= max");
  }

  if (!Array.isArray(record.entries) || record.entries.length === 0) {
    throw new TypeError("App payload manifest entries must be a non-empty array");
  }
  for (const entry of record.entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeError("App payload manifest entries must contain non-empty strings");
    }
  }

  return {
    payloadVersion: record.payloadVersion,
    payloadFormat: record.payloadFormat,
    platform: record.platform,
    abi: {
      electron: abiRecord.electron,
      modules: abiRecord.modules,
      nodePty: abiRecord.nodePty,
    },
    clientContractVersion: record.clientContractVersion,
    studioProtocol: {
      min: protocolRecord.min,
      max: protocolRecord.max,
    },
    entries: Object.freeze([...record.entries]),
  };
}

export interface ActiveAppPayloadRecord {
  readonly payloadVersion: string;
  readonly previousPayloadVersion?: string | undefined;
  readonly activatedAt: string;
  readonly bootAttempts: number;
}

export interface AppPayloadInstallerOptions {
  readonly trustedKeys?: Readonly<Record<string, string | Buffer>> | undefined;
  readonly signatureVerifier?: RuntimeSignatureVerifier | undefined;
}

export class AppPayloadInstaller {
  readonly #rootDirectory: string;
  readonly #versionsDirectory: string;
  readonly #currentPath: string;
  readonly #trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly #signatureVerifier: RuntimeSignatureVerifier | undefined;

  constructor(rootDirectory: string, options: AppPayloadInstallerOptions = {}) {
    this.#rootDirectory = rootDirectory;
    this.#versionsDirectory = join(rootDirectory, "versions");
    this.#currentPath = join(rootDirectory, "current.json");
    this.#trustedKeys = options.trustedKeys ?? {};
    this.#signatureVerifier = options.signatureVerifier;
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  async #refuseIfInstalled(version: string): Promise<void> {
    assertSafeVersion(version);
    const finalDirectory = join(this.#versionsDirectory, version);
    if (!isInside(this.#versionsDirectory, finalDirectory)) {
      throw new Error("Payload target escaped the versions directory");
    }
    try {
      await access(finalDirectory);
      throw new Error(`Payload ${version} is already installed`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async install(artifactDirectory: string): Promise<AppPayloadManifest> {
    const { manifest } = await verifySignedArtifact({
      directory: artifactDirectory,
      layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
      parseManifest: parseAppPayloadManifest,
      requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
      trustedKeys: this.#trustedKeys,
      ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
      coverageMessage: (file) => `checksums.json must cover ${file}`,
    });

    await this.#refuseIfInstalled(manifest.payloadVersion);
    await installVerifiedArtifact({
      sourceDirectory: artifactDirectory,
      versionsDirectory: this.#versionsDirectory,
      version: manifest.payloadVersion,
      requireFile: "preload.cjs",
      verifyStaging: async (directory) => {
        const verified = await verifySignedArtifact({
          directory,
          layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
          parseManifest: parseAppPayloadManifest,
          requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
          trustedKeys: this.#trustedKeys,
          ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
        });
        if (verified.manifest.payloadVersion !== manifest.payloadVersion) throw new Error("Artifact version changed during installation");
      },
    });
    return manifest;
  }

  async activate(version: string): Promise<ActiveAppPayloadRecord> {
    assertSafeVersion(version);
    const versionDirectory = join(this.#versionsDirectory, version);
    const { manifest } = await verifySignedArtifact({
      directory: versionDirectory,
      layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
      parseManifest: parseAppPayloadManifest,
      requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
      trustedKeys: this.#trustedKeys,
      ...(this.#signatureVerifier ? { signatureVerifier: this.#signatureVerifier } : {}),
    });
    if (manifest.payloadVersion !== version) {
      throw new Error("Payload manifest version does not match its installation directory");
    }
    const preloadPath = join(versionDirectory, "preload.cjs");
    if (!isInside(versionDirectory, preloadPath) || !(await lstat(preloadPath)).isFile()) {
      throw new Error("Payload preload.cjs escapes the version directory or is missing");
    }

    const current = await this.current();
    const record: ActiveAppPayloadRecord = {
      payloadVersion: version,
      ...(current ? { previousPayloadVersion: current.payloadVersion } : {}),
      activatedAt: new Date().toISOString(),
      bootAttempts: 0,
    };
    await writeJsonAtomic(this.#currentPath, record);
    return record;
  }

  async rollback(options: { discardFailedVersion?: boolean } = {}): Promise<ActiveAppPayloadRecord | undefined> {
    const current = await this.current();
    if (current === undefined) {
      throw new Error("No active payload to rollback");
    }
    if (current.previousPayloadVersion === undefined) {
      await rm(this.#currentPath, { force: true });
      return undefined;
    }
    const previous = current.previousPayloadVersion;
    await access(join(this.#versionsDirectory, previous, "app-payload-manifest.json"));
    const record: ActiveAppPayloadRecord = {
      payloadVersion: previous,
      ...(options.discardFailedVersion ? {} : { previousPayloadVersion: current.payloadVersion }),
      activatedAt: new Date().toISOString(),
      bootAttempts: 0,
    };
    await writeJsonAtomic(this.#currentPath, record);
    return record;
  }

  async current(): Promise<ActiveAppPayloadRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.#currentPath, "utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("current.json is invalid");
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.payloadVersion !== "string" ||
        typeof record.activatedAt !== "string" ||
        typeof record.bootAttempts !== "number" ||
        !Number.isSafeInteger(record.bootAttempts) || record.bootAttempts < 0
      ) {
        throw new TypeError("current.json is invalid");
      }
      assertSafeVersion(record.payloadVersion);
      if (record.previousPayloadVersion !== undefined) {
        if (typeof record.previousPayloadVersion !== "string") throw new TypeError("current.json is invalid");
        assertSafeVersion(record.previousPayloadVersion);
      }
      return {
        payloadVersion: record.payloadVersion,
        activatedAt: record.activatedAt,
        bootAttempts: record.bootAttempts,
        ...(typeof record.previousPayloadVersion === "string"
          ? { previousPayloadVersion: record.previousPayloadVersion }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Increment the boot attempt counter and write it atomically.
   *
   * **Concurrency note**: This uses a read-modify-write cycle without file
   * locking.  The caller must ensure serial invocation (e.g. only from the
   * single main-process startup path).  Concurrent calls may lose increments.
   */
  async noteBootAttempt(): Promise<number> {
    const current = await this.current();
    if (current === undefined) return 0;
    const nextAttempts = (current.bootAttempts ?? 0) + 1;
    const updated: ActiveAppPayloadRecord = {
      ...current,
      bootAttempts: nextAttempts,
    };
    await writeJsonAtomic(this.#currentPath, updated);
    return nextAttempts;
  }

  async noteBootSuccess(expectedPayloadVersion?: string): Promise<void> {
    const current = await this.current();
    if (current === undefined || current.bootAttempts === 0 ||
      (expectedPayloadVersion !== undefined && current.payloadVersion !== expectedPayloadVersion)) return;
    const updated: ActiveAppPayloadRecord = {
      ...current,
      bootAttempts: 0,
    };
    await writeJsonAtomic(this.#currentPath, updated);
  }

  async prune(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.#versionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const current = await this.current();
    const keep = new Set<string>();
    if (current) {
      keep.add(current.payloadVersion);
      if (current.previousPayloadVersion) keep.add(current.previousPayloadVersion);
    }
    const removed: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (!keep.has(name)) {
        const target = join(this.#versionsDirectory, name);
        if (!isInside(this.#versionsDirectory, target)) continue;
        await rm(target, { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
  }
}
