import {
  cp,
  mkdir,
  readFile,
  readdir,
  chmod,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExecutableTarget } from "./target-platform.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function stageWebEnvironment(payload, nodePath, platform) {
  payload = resolve(payload);
  const web = join(payload, "web");
  await cp(join(root, "apps/desktop/dist/web-host"), web, { recursive: true });
  await cp(join(root, "apps/renderer/dist"), join(web, "renderer"), {
    recursive: true,
  });
  await readFile(join(web, "renderer/web.html"));
  const keyDirectory = join(payload, "keys");
  await mkdir(keyDirectory, { recursive: true });
  const table = JSON.parse(
    await readFile(join(root, "packaging/keys/trusted-keys.json"), "utf8"),
  );
  for (const name of new Set([
    "trusted-keys.json",
    ...Object.values(table.keys),
  ]))
    await cp(join(root, "packaging/keys", name), join(keyDirectory, name));
  const pty = join(web, "node_modules/node-pty");
  await mkdir(pty, { recursive: true });
  for (const entry of [
    "package.json",
    "lib",
    "build/Release",
    `prebuilds/${platform}`,
  ]) {
    await cp(join(root, "node_modules/node-pty", entry), join(pty, entry), {
      recursive: true,
    }).catch((error) => {
      if (
        error.code !== "ENOENT" ||
        entry === "lib" ||
        entry === "package.json"
      )
        throw error;
    });
  }
  const inspect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(node|exe|dll)$/u.test(entry.name))
        assertExecutableTarget(path, platform);
      else if (entry.name === "spawn-helper" && !platform.startsWith("win32")) {
        assertExecutableTarget(path, platform);
        await chmod(path, 0o755);
      }
    }
  };
  await inspect(pty);
  // N-API modules must load in the actual bundled Node, including their helper process.
  execFileSync(
    nodePath,
    [
      "-e",
      "const p=require(process.argv[1]);const c=p.spawn(process.platform==='win32'?process.env.COMSPEC:'/bin/sh',[],{cols:80,rows:24,env:process.env});c.onData(()=>{});c.onExit(()=>process.exit(0));c.write('exit\\r');setTimeout(()=>process.exit(1),10000);",
      pty,
    ],
    { timeout: 15_000, windowsHide: true },
  );
  const windows =
    '@echo off\r\n"%~dp0node\\node.exe" "%~dp0web\\host.mjs" %*\r\n';
  const posix =
    '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/node/bin/node" "$base/web/host.mjs" "$@"\n';
  await writeFile(
    join(
      payload,
      platform.startsWith("win32") ? "omp-studio-web.cmd" : "omp-studio-web",
    ),
    platform.startsWith("win32") ? windows : posix,
  );
  if (!platform.startsWith("win32"))
    await chmod(join(payload, "omp-studio-web"), 0o755);
}
