import { createReadStream } from "node:fs";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ChecksumManifest,
  parseChecksumManifest,
  parseRuntimeSignatureManifest,
  type RuntimeSignatureManifest,
} from "./manifest.js";

export interface SignedArtifactLayout {
  readonly manifestFile: string;
  readonly checksumsFile: string;
  readonly signatureFile: string;
}

export const RUNTIME_ARTIFACT_LAYOUT: SignedArtifactLayout = {
  manifestFile: "runtime-manifest.json",
  checksumsFile: "checksums.json",
  signatureFile: "runtime-signature.json",
};

export const APP_PAYLOAD_ARTIFACT_LAYOUT: SignedArtifactLayout = {
  manifestFile: "app-payload-manifest.json",
  checksumsFile: "checksums.json",
  signatureFile: "payload-signature.json",
};

export interface RuntimeSignatureVerifier {
  verify(signature: RuntimeSignatureManifest, signedPayload: Buffer): boolean;
}

export function assertSafeVersion(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(version)) {
    throw new TypeError("Runtime version is not safe for a directory name");
  }
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

export function createTrustedKeyVerifier(
  keys: Readonly<Record<string, string | Buffer>>,
): RuntimeSignatureVerifier {
  return {
    verify(signature, signedPayload) {
      const key = keys[signature.keyId];
      if (key === undefined) return false;
      if (signature.algorithm !== "ed25519") return false;
      try {
        const publicKey = createPublicKey(key);
        if (publicKey.asymmetricKeyType !== "ed25519") return false;
        return verifySignature(
          null,
          signedPayload,
          publicKey,
          Buffer.from(signature.signature, "base64url"),
        );
      } catch {
        return false;
      }
    },
  };
}

export async function verifyFileChecksums(
  artifactDirectory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, expected] of Object.entries(files)) {
    const path = join(artifactDirectory, file);
    if (!isInside(artifactDirectory, path)) throw new Error(`Checksum path escapes artifact: ${file}`);
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error(`Runtime artifact file must be a regular file: ${file}`);
    const actual = await sha256File(path);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${file}`);
  }
}

export async function verifyArtifactCoverage(
  artifactDirectory: string,
  files: Record<string, string>,
  metadataFiles: readonly string[] = ["checksums.json", "runtime-signature.json"],
): Promise<void> {
  const ignored = new Set(metadataFiles);
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
      } else if (!ignored.has(artifactPath) && files[artifactPath] === undefined) {
        throw new Error(`Runtime artifact file is not covered by checksums: ${artifactPath}`);
      }
    }
  };
  await walk(artifactDirectory);
}

export async function verifySignedMetadata<T>(input: {
  readonly directory: string;
  readonly layout: SignedArtifactLayout;
  readonly parseManifest: (value: unknown) => T;
  readonly requireCovered: (manifest: T) => readonly string[];
  readonly trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly signatureVerifier?: RuntimeSignatureVerifier;
  readonly coverageMessage?: (file: string, manifest: T) => string;
}): Promise<{ manifest: T; checksums: ChecksumManifest; signature: RuntimeSignatureManifest }> {
  // Parse exactly the bytes covered by the signature; never reread metadata.
  const manifestBytes = await readFile(join(input.directory, input.layout.manifestFile));
  const checksumsBytes = await readFile(join(input.directory, input.layout.checksumsFile));
  const manifest = input.parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const checksums = parseChecksumManifest(JSON.parse(checksumsBytes.toString("utf8")) as unknown);
  const signature = parseRuntimeSignatureManifest(
    JSON.parse(await readFile(join(input.directory, input.layout.signatureFile), "utf8")) as unknown,
  );

  const signedPayload = Buffer.concat([manifestBytes, Buffer.from("\0"), checksumsBytes]);

  if (signature.payloadSha256 !== createHash("sha256").update(signedPayload).digest("hex")) {
    throw new Error("Runtime signature does not match the artifact metadata");
  }

  const verifier = input.signatureVerifier ?? createTrustedKeyVerifier(input.trustedKeys);
  if (!verifier.verify(signature, signedPayload)) {
    throw new Error("Runtime signature verification failed");
  }

  const required = input.requireCovered(manifest);
  for (const file of required) {
    if (checksums.files[file] === undefined) {
      if (input.coverageMessage) {
        throw new Error(input.coverageMessage(file, manifest));
      }
      throw new Error(`checksums.json must cover ${file}`);
    }
  }

  return { manifest, checksums, signature };
}

export async function verifySignedArtifact<T>(input: {
  readonly directory: string;
  readonly layout: SignedArtifactLayout;
  readonly parseManifest: (value: unknown) => T;
  readonly requireCovered: (manifest: T) => readonly string[];
  readonly trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly signatureVerifier?: RuntimeSignatureVerifier;
  readonly coverageMessage?: (file: string, manifest: T) => string;
  readonly verifyFiles?: boolean;
}): Promise<{ manifest: T; checksums: ChecksumManifest }> {
  const { manifest, checksums } = await verifySignedMetadata(input);

  if (input.verifyFiles !== false) {
    await verifyArtifactCoverage(input.directory, checksums.files, [
      input.layout.checksumsFile,
      input.layout.signatureFile,
    ]);
    await verifyFileChecksums(input.directory, checksums.files);
  }

  return { manifest, checksums };
}

export async function installVerifiedArtifact(input: {
  readonly sourceDirectory: string;
  readonly versionsDirectory: string;
  readonly version: string;
  readonly requireFile?: string;
  readonly verifyStaging?: (directory: string) => Promise<unknown>;
}): Promise<void> {
  assertSafeVersion(input.version);
  const finalDirectory = join(input.versionsDirectory, input.version);
  if (!isInside(input.versionsDirectory, finalDirectory)) {
    throw new Error("Runtime target escaped the versions directory");
  }

  try {
    await access(finalDirectory);
    throw new Error(`Runtime ${input.version} is already installed`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(input.versionsDirectory, { recursive: true });
  const staging = join(
    input.versionsDirectory,
    `.staging-${input.version}-${randomBytes(6).toString("hex")}`,
  );

  try {
    await cp(input.sourceDirectory, staging, { recursive: true, errorOnExist: true, force: false });
    if (input.requireFile !== undefined) {
      const required = join(staging, input.requireFile);
      let isFile = false;
      try {
        const stat = await lstat(required);
        isFile = stat.isFile();
      } catch {
        isFile = false;
      }
      if (!isInside(staging, required) || !isFile) {
        throw new Error("Runtime entrypoint is missing or escapes the artifact");
      }
    }
    // The source may change during cp; only publish the verified copy.
    await input.verifyStaging?.(staging);
    await rename(staging, finalDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
