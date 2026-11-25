import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { Console } from "node:console";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startSharedHost } from "./daemon.js";
import { desktopPaths } from "../platform/desktop-paths.js";
import { connectLocalChannel } from "./local-channel.js";
import {
  ensureSharedHost,
  SharedHostConnection,
  type SharedHostLaunch,
} from "./client.js";

export async function runWebHost(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      options: { type: "string" },
      "options-file": { type: "string" },
      renderer: { type: "string" },
      port: { type: "string" },
      ip: { type: "string" },
      force: { type: "boolean" },
      name: { type: "string" },
      artifact: { type: "string" },
      keys: { type: "string" },
    },
  });
  const mode = positionals[0] ?? "help";
  const directory = dirname(fileURLToPath(import.meta.url));
  const bundledRuntime = join(directory, "..", "runtime");
  const artifact = values.artifact
    ? resolve(values.artifact)
    : existsSync(join(bundledRuntime, "runtime-manifest.json"))
      ? bundledRuntime
      : undefined;
  const launchOptions = values["options-file"] ? await readFile(resolve(values["options-file"]), "utf8") : values.options;
  const launch: SharedHostLaunch = launchOptions
    ? JSON.parse(launchOptions)
    : {
        executable: process.execPath,
        entry: fileURLToPath(import.meta.url),
        rendererDirectory: values.renderer
          ? resolve(values.renderer)
          : join(directory, "renderer"),
        ...(values.port ? { port: Number(values.port) } : {}),
        ...(artifact
          ? {
              packaged: true,
              installLayout: {
                installDirectory: desktopPaths().runtimesRoot,
                artifactRoot: artifact,
                keysDirectory: resolve(
                  values.keys ?? join(directory, "..", "keys"),
                ),
              },
            }
          : {}),
      };
  if (mode === "help") {
    console.log(
      "OMP Studio Web\nstart [--renderer <dist>] [--ip <LAN address>]\nstatus | pair | devices | revoke <id> | rename <id> --name <name>\nlisten --ip <LAN address> | certificate <file> | project <absolute path>\nstop [--force]\n局域网访问需要信任导出的 CA 证书。Trust the exported CA certificate for LAN access.",
    );
    return;
  }
  if (mode === "serve") {
    if (values["options-file"])
      globalThis.console = new Console(createWriteStream(join(desktopPaths().logsRoot, "shared-host.log"), { flags: "a", mode: 0o600 }));
    const bundleVersion = createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex");
    const host = await startSharedHost({
      ...launch,
      bundleVersion,
      ...(values.port ? { port: Number(values.port) } : {}),
    });
    console.log(JSON.stringify(host.status()));
    const close = () => {
      void host.close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  const client = new SharedHostConnection(
    mode === "start"
      ? await ensureSharedHost(launch)
      : await connectLocalChannel(desktopPaths().stateRoot),
  );
  try {
    await client.initialize();
    let result: unknown;
    switch (mode) {
      case "start":
        if (values.ip) await client.call("web.listen", { ip: values.ip });
        result = await client.call("status");
        break;
      case "status":
        result = await client.call("status");
        break;
      case "pair": {
        const value = await client.call<{ url: string; expiresAt: number }>(
          "web.pair",
        );
        result = { url: value.url, expiresAt: value.expiresAt };
        break;
      }
      case "devices":
        result = (await client.call<{ devices: unknown }>("status")).devices;
        break;
      case "revoke":
        result = await client.call("web.revoke", { id: positionals[1] });
        break;
      case "rename":
        result = await client.call("web.rename", {
          id: positionals[1],
          name: values.name,
        });
        break;
      case "listen":
        result = await client.call("web.listen", { ip: values.ip });
        break;
      case "certificate": {
        const certificate = await client.call<string | undefined>(
          "web.certificate",
        );
        if (!certificate || !positionals[1])
          throw new Error(
            "Enable LAN access and supply a certificate output path",
          );
        await writeFile(
          resolve(positionals[1]),
          Buffer.from(certificate, "base64"),
        );
        result = { saved: resolve(positionals[1]) };
        break;
      }
      case "project": {
        await client.takeControl();
        const { StudioClientImpl } = await import("@omp-studio/client");
        const studio = new StudioClientImpl(client.transport());
        let cleanup = () => {};
        try {
          await studio.bootstrap();
          const completed = new Promise<unknown>((done, reject) => {
            const timer = setTimeout(() => {
              off();
              reject(new Error("Project registration timed out"));
            }, 30_000);
            const off = studio.subscribe({ scope: "all" }, (event) => {
              if (
                event.kind !== "command.receipt" ||
                event.receipt.commandName !== "workspace.openPath"
              )
                return;
              if (
                ![
                  "completed",
                  "failed",
                  "rejected",
                  "outcome_unknown",
                ].includes(event.receipt.status)
              )
                return;
              clearTimeout(timer);
              off();
              if (event.receipt.status === "completed")
                done(event.receipt.result);
              else reject(new Error(JSON.stringify(event.receipt)));
            });
            cleanup = () => { clearTimeout(timer); off(); };
          });
          await studio.command("workspace.openPath", { path: positionals[1]! });
          result = await completed;
        } finally {
          cleanup();
          await studio.close();
        }
        break;
      }
      case "stop":
        result = await client.call("shutdown", { force: values.force });
        break;
      default:
        throw new Error("Unknown command. Run omp-studio-web help.");
    }
    console.log(JSON.stringify(result ?? { ok: true }, null, 2));
  } finally {
    client.peer.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void runWebHost(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
