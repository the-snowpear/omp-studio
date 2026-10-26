import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildSshAskpass } from "./build-ssh-askpass.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function bundleRemoteHost(output = join(root, "apps/desktop/dist/remote-host")) {
  const { build } = createRequire(join(root, "package.json"))("esbuild");
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ["apps/desktop/src/remote/main.ts"], bundle: true, platform: "node", target: "node22", format: "esm", external: ["electron", "node-pty"], outfile: join(output, "host.mjs"), logLevel: "warning", banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
  await buildSshAskpass();
  const bytes = await readFile(join(output, "host.mjs"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(output, "host.json"), JSON.stringify({ version: 1, sha256, bytes: bytes.length }));
  return { directory: output, sha256, bytes: bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await bundleRemoteHost(process.argv[2]));
