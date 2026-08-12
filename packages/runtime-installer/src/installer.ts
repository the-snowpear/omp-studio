import { createHash, randomBytes, verify as verifySignature, createPublicKey } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";
import {
  parseChecksumManifest,
  parseRuntimeInstallationManifest,
  parseRuntimeSignatureManifest,
  type RuntimeSignatureManifest,
} from "./manifest.js";
import { createSmokeTestRunner } from "./self-check.js";
import type { SelfCheckRunner } from "./self-check.js";

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

export interface RuntimeSignatureVerifier {
  verify(signature: RuntimeSignatureManifest, signedPayload: Buffer): boolean;
}

export interface RuntimeInstallerOptions {
  signatureVerifier?: RuntimeSignatureVerifier;
  trustedKeys?: Readonly<Record<string, string | Buffer>>;
  isRuntimeReferenced?: (runtimeVersion: string) => boolean | Promise<boolean>;
}

function safeVersion(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(version)) {
    throw new TypeError("Runtime version is not safe for a directory name");
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
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

  async install(artifactDirectory: string): Promise<RuntimeInstallationManifest> {
    const manifest = parseRuntimeInstallationManifest(
      JSON.parse(await readFile(join(artifactDirectory, "runtime-manifest.json"), "utf8")) as unknown,
    );
    safeVersion(manifest.runtimeVersion);
    const checksums = parseChecksumManifest(
      JSON.parse(await readFile(join(artifactDirectory, "checksums.json"), "utf8")) as unknown,
    );
    const signature = parseRuntimeSignatureManifest(
      JSON.parse(await readFile(join(artifactDirectory, "runtime-signature.json"), "utf8")) as unknown,
    );
    const manifestBytes = Buffer.from(await readFile(join(artifactDirectory, "runtime-manifest.json")));
    const checksumsBytes = Buffer.from(await readFile(join(artifactDirectory, "checksums.json")));
    const signedPayload = Buffer.concat([manifestBytes, Buffer.from("\0"), checksumsBytes]);
    if (signature.payloadSha256 !== createHash("sha256").update(signedPayload).digest("hex")) {
      throw new Error("Runtime signature does not match the artifact metadata");
    }
    const verifier = this.#signatureVerifier ?? createTrustedKeyVerifier(this.#trustedKeys);
    if (!verifier.verify(signature, signedPayload)) throw new Error("Runtime signature verification failed");
    if (checksums.files["runtime-manifest.json"] === undefined) {
      throw new Error("checksums.json must cover runtime-manifest.json");
    }
    if (checksums.files[manifest.entrypoint] === undefined) {
      throw new Error("checksums.json must cover the Runtime entrypoint");
    }
    await this.#verifyArtifactCoverage(artifactDirectory, checksums.files);
    await this.#verifyFiles(artifactDirectory, checksums.files);

    const finalDirectory = join(this.#versionsDirectory, manifest.runtimeVersion);
    if (!inside(this.#versionsDirectory, finalDirectory)) throw new Error("Runtime target escaped the versions directory");
    try {
      await access(finalDirectory);
      throw new Error(`Runtime ${manifest.runtimeVersion} is already installed`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await mkdir(this.#versionsDirectory, { recursive: true });
    const staging = join(this.#versionsDirectory, `.staging-${manifest.runtimeVersion}-${randomBytes(6).toString("hex")}`);
    try {
      await cp(artifactDirectory, staging, { recursive: true, errorOnExist: true, force: false });
      const entrypoint = join(staging, manifest.entrypoint);
      if (!inside(staging, entrypoint) || !(await lstat(entrypoint)).isFile()) {
        throw new Error("Runtime entrypoint is missing or escapes the artifact");
      }
      await rename(staging, finalDirectory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  }

  async activate(runtimeVersion: string, options: ActivateOptions = {}): Promise<ActiveRuntimeRecord> {
    safeVersion(runtimeVersion);
    const versionDirectory = join(this.#versionsDirectory, runtimeVersion);
    const manifest = parseRuntimeInstallationManifest(
      JSON.parse(await readFile(join(versionDirectory, "runtime-manifest.json"), "utf8")) as unknown,
    );
    if (manifest.runtimeVersion !== runtimeVersion) {
      throw new Error("Runtime manifest version does not match its installation directory");
    }
    const entrypointPath = join(versionDirectory, manifest.entrypoint);
    if (!inside(versionDirectory, entrypointPath) || !(await lstat(entrypointPath)).isFile()) {
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
    const record: ActiveRuntimeRecord = {
      runtimeVersion,
      ...(current === undefined ? {} : { previousRuntimeVersion: current.runtimeVersion }),
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
    safeVersion(runtimeVersion);
    const current = await this.current();
    if (current?.runtimeVersion === runtimeVersion || current?.previousRuntimeVersion === runtimeVersion) {
      throw new Error(`Runtime ${runtimeVersion} is referenced by current.json`);
    }
    if (await this.#isRuntimeReferenced?.(runtimeVersion)) {
      throw new Error(`Runtime ${runtimeVersion} is referenced by an active Thread binding`);
    }
    const target = join(this.#versionsDirectory, runtimeVersion);
    if (!inside(this.#versionsDirectory, target)) throw new Error("Runtime uninstall target escaped the versions directory");
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
    for (const version of names.filter(name => !name.startsWith("."))) {
      try {
        safeVersion(version);
        const directory = join(this.#versionsDirectory, version);
        const manifest = parseRuntimeInstallationManifest(
          JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8")) as unknown,
        );
        installed.push({ version, channel: manifest.channel, mtimeMs: (await lstat(directory)).mtimeMs });
      } catch {
        // Invalid/non-version entries are not touched by retention.
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
      await this.uninstall(entry.version);
      removed.push(entry.version);
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
   * state; used by the Runtime Resolver's managed lookup.
   */
  async currentManifest(): Promise<InstalledRuntimeManifest | undefined> {
    const record = await this.current();
    if (record === undefined) return undefined;
    const versionDirectory = join(this.#versionsDirectory, record.runtimeVersion);
    const manifest = parseRuntimeInstallationManifest(
      JSON.parse(await readFile(join(versionDirectory, "runtime-manifest.json"), "utf8")) as unknown,
    );
    if (manifest.runtimeVersion !== record.runtimeVersion) {
      throw new Error("Runtime manifest version does not match the active installation");
    }
    const entrypointPath = join(versionDirectory, manifest.entrypoint);
    if (!inside(versionDirectory, entrypointPath) || !(await lstat(entrypointPath)).isFile()) {
      throw new Error("Active runtime entrypoint escapes the version directory");
    }
    return { record, manifest, entrypointPath };
  }

  async #verifyFiles(artifactDirectory: string, files: Record<string, string>): Promise<void> {
    for (const [file, expected] of Object.entries(files)) {
      const path = join(artifactDirectory, file);
      if (!inside(artifactDirectory, path)) throw new Error(`Checksum path escapes artifact: ${file}`);
      const metadata = await lstat(path);
      if (!metadata.isFile()) throw new Error(`Runtime artifact file must be a regular file: ${file}`);
      const actual = await sha256(path);
      if (actual !== expected) throw new Error(`Checksum mismatch for ${file}`);
    }
  }

  async #verifyArtifactCoverage(artifactDirectory: string, files: Record<string, string>): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const artifactPath = relative(artifactDirectory, path).split(sep).join("/");
        if (entry.isSymbolicLink()) {
          throw new Error(`Runtime artifact cannot contain symbolic links: ${artifactPath}`);
        }
        if (entry.isDirectory()) {
          await walk(path);
        } else if (!entry.isFile()) {
          throw new Error(`Runtime artifact contains an unsupported file type: ${artifactPath}`);
        } else if (
          artifactPath !== "checksums.json" &&
          artifactPath !== "runtime-signature.json" &&
          files[artifactPath] === undefined
        ) {
          throw new Error(`Runtime artifact file is not covered by checksums: ${artifactPath}`);
        }
      }
    };
    await walk(artifactDirectory);
  }
}

function createTrustedKeyVerifier(keys: Readonly<Record<string, string | Buffer>>): RuntimeSignatureVerifier {
  return {
    verify(signature, signedPayload) {
      const key = keys[signature.keyId];
      if (key === undefined) return false;
      try {
        return verifySignature(null, signedPayload, createPublicKey(key), Buffer.from(signature.signature, "base64url"));
      } catch {
        return false;
      }
    },
  };
}
