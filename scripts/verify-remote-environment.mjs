import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verifyRemoteEnvironment } from "../packages/runtime-installer/dist/src/index.js";

const root = process.argv[2];
if (!root) throw new Error("Remote environment directory required");
const table = JSON.parse(await readFile("packaging/keys/trusted-keys.json", "utf8"));
const keys = Object.fromEntries(await Promise.all(Object.entries(table.keys).map(async ([id, path]) => [id, await readFile(join("packaging/keys", path))])));
const names = await readdir(root);
const manifestFile = names.find(name => /^remote-environment-[\w-]+\.json$/u.test(name));
if (!manifestFile) throw new Error("Remote environment manifest missing");
const value = JSON.parse(await readFile(join(root, manifestFile), "utf8"));
const { manifest } = verifyRemoteEnvironment(value, keys, process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio", value.manifest.platform, JSON.parse(await readFile("package.json", "utf8")).version);
if (names.length !== 2 || !names.includes(manifest.archive.asset)) throw new Error("Remote environment archive missing or unexpected output files");
const bytes = await readFile(join(root, manifest.archive.asset));
if (bytes.length !== manifest.archive.size || createHash("sha256").update(bytes).digest("hex") !== manifest.archive.sha256) throw new Error("Remote environment archive checksum mismatch");
console.log(`Verified remote environment: ${manifest.platform}`);
