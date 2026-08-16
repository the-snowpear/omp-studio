/**
 * Local managed-Runtime signing keys.
 *
 * Lives under the Host profile (`%APPDATA%\omp-studio\keys` on Windows),
 * never in the git repository. Env vars still win when both are set.
 *
 *   npm run omp:keys
 */

import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_KEY_ID_FILE = "key-id.txt";
export const RUNTIME_PUBLIC_KEY_FILE = "trusted-public.pem";
export const RUNTIME_PRIVATE_KEY_FILE = "signing-private.pem";
export const DEFAULT_RUNTIME_KEY_ID = "omp-studio-local";

export function defaultRuntimeKeysDirectory() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "omp-studio", "keys");
  }
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "omp-studio", "keys");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readRuntimeSigningKeys(keysDirectory = defaultRuntimeKeysDirectory()) {
  const keyId = (await readFile(join(keysDirectory, RUNTIME_KEY_ID_FILE), "utf8")).trim();
  const publicKeyPath = join(keysDirectory, RUNTIME_PUBLIC_KEY_FILE);
  const privateKeyPath = join(keysDirectory, RUNTIME_PRIVATE_KEY_FILE);
  if (keyId.length === 0) {
    throw new Error("Runtime signing key id is empty");
  }
  return {
    keyId,
    publicKeyPath,
    privateKeyPath,
    publicKey: await readFile(publicKeyPath),
    privateKey: await readFile(privateKeyPath),
  };
}

/** Create a local Ed25519 key pair. Refuses to overwrite existing files. */
export async function ensureRuntimeSigningKeys(keysDirectory = defaultRuntimeKeysDirectory()) {
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  const keyIdPath = join(keysDirectory, RUNTIME_KEY_ID_FILE);
  const publicKeyPath = join(keysDirectory, RUNTIME_PUBLIC_KEY_FILE);
  const privateKeyPath = join(keysDirectory, RUNTIME_PRIVATE_KEY_FILE);
  if ((await exists(keyIdPath)) || (await exists(publicKeyPath)) || (await exists(privateKeyPath))) {
    const existing = await readRuntimeSigningKeys(keysDirectory);
    return { created: false, ...existing };
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  await writeFile(keyIdPath, `${DEFAULT_RUNTIME_KEY_ID}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(publicKeyPath, publicKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(privateKeyPath, privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    created: true,
    keyId: DEFAULT_RUNTIME_KEY_ID,
    publicKeyPath,
    privateKeyPath,
    publicKey: Buffer.from(publicKey),
    privateKey: Buffer.from(privateKey),
  };
}

async function main() {
  const result = await ensureRuntimeSigningKeys();
  const action = result.created ? "Created" : "Using existing";
  console.log(`${action} Runtime signing keys in ${defaultRuntimeKeysDirectory()}`);
  console.log(`keyId=${result.keyId}`);
  console.log(`public=${result.publicKeyPath}`);
  console.log(`private=${result.privateKeyPath}`);
  console.log("Private key stays on this machine. Do not commit it.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
