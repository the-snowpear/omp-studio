#!/usr/bin/env node
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const keysDir = join(rootDir, "packaging", "keys");
const trustedKeysPath = join(keysDir, "trusted-keys.json");

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function verifyTrustedKeys(dir = keysDir) {
  const jsonPath = join(dir, "trusted-keys.json");
  if (!existsSync(jsonPath)) {
    throw new Error(`trusted-keys.json missing in ${dir}`);
  }
  const raw = JSON.parse(await readFile(jsonPath, "utf8"));
  if (raw.schema !== 1 || typeof raw.activeKeyId !== "string" || typeof raw.keys !== "object" || raw.keys === null) {
    throw new Error("Invalid trusted-keys.json structure");
  }
  if (!raw.keys[raw.activeKeyId]) {
    throw new Error(`activeKeyId "${raw.activeKeyId}" not present in keys map`);
  }

  for (const [keyId, fileName] of Object.entries(raw.keys)) {
    if (typeof fileName !== "string" || fileName.trim().length === 0) {
      throw new Error(`Invalid file name for key ${keyId}`);
    }
    const resolvedPath = join(dir, fileName);
    if (!isInside(dir, resolvedPath)) {
      throw new Error(`Key file ${fileName} escapes keys directory`);
    }
    if (!existsSync(resolvedPath)) {
      throw new Error(`Key file ${fileName} does not exist for key ${keyId}`);
    }
    const content = await readFile(resolvedPath, "utf8");
    if (content.includes("BEGIN PRIVATE KEY")) {
      throw new Error(`Key file ${fileName} contains private key marker`);
    }
    try {
      createPublicKey(content);
    } catch (error) {
      throw new Error(`Failed to parse public key ${fileName} for ${keyId}: ${String(error)}`);
    }
  }
  return raw;
}

export async function generateKey(keyId) {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("Key ID is required");
  }
  await mkdir(keysDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const pemFileName = `${keyId}.pem`;
  const pemFilePath = join(keysDir, pemFileName);
  await writeFile(pemFilePath, publicKeyPem, "utf8");

  let table = { schema: 1, activeKeyId: keyId, keys: {} };
  if (existsSync(trustedKeysPath)) {
    try {
      table = JSON.parse(await readFile(trustedKeysPath, "utf8"));
    } catch {
      table = { schema: 1, activeKeyId: keyId, keys: {} };
    }
  }
  table.schema = 1;
  table.activeKeyId = keyId;
  table.keys = { ...table.keys, [keyId]: pemFileName };

  await writeFile(trustedKeysPath, `${JSON.stringify(table, null, 2)}\n`, "utf8");

  console.log(`[Release Keys] Public key saved to ${relative(rootDir, pemFilePath)}`);
  console.log(`[Release Keys] Updated ${relative(rootDir, trustedKeysPath)} (activeKeyId: ${keyId})`);
  console.log("--------------------------------------------------------------------------------");
  console.log("⚠️  Copy the private key below to GitHub Secret OMP_RUNTIME_SIGNING_KEY.");
  console.log("⚠️  DO NOT commit or save the private key to disk in the repository!");
  console.log("--------------------------------------------------------------------------------");
  console.log(privateKeyPem.trim());
  console.log("--------------------------------------------------------------------------------");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "verify") {
    await verifyTrustedKeys();
    console.log("Trusted keys verification passed.");
  } else if (command === "generate") {
    let keyId = "omp-studio-release-2026a";
    const keyIdIdx = args.indexOf("--key-id");
    if (keyIdIdx !== -1 && args[keyIdIdx + 1]) {
      keyId = args[keyIdIdx + 1];
    }
    await generateKey(keyId);
  } else {
    console.error("Usage: node scripts/release-keys.mjs [generate [--key-id <id>] | verify]");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
