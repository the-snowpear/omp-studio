import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function bundleWebHost(
  output = join(root, "apps/desktop/dist/web-host"),
) {
  await mkdir(output, { recursive: true });
  const worker = await build({
    absWorkingDir: root,
    entryPoints: ["packages/studio-host/src/session-archive-worker.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
  });
  const bytes = worker.outputFiles[0].contents;
  const name = `archive-worker-${createHash("sha256").update(bytes).digest("hex")}.mjs`;
  await writeFile(join(output, name), bytes);
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["apps/desktop/src/web/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["node-pty"],
    outfile: join(output, "host.mjs"),
    metafile: true,
    define: { __OMP_ARCHIVE_WORKER_FILE__: JSON.stringify(`./${name}`) },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /node_modules[/\\]electron[/\\]/u.test(path),
    )
  )
    throw new Error("The shared Host must run without Electron");
  const host = await readFile(join(output, "host.mjs"));
  await writeFile(
    join(output, "host.json"),
    JSON.stringify({
      version: 1,
      sha256: createHash("sha256").update(host).digest("hex"),
      files: [name],
    }),
  );
  return output;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(await bundleWebHost(process.argv[2]));
