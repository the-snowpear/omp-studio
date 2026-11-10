/**
 * What Step has installed: extensions and the MCP servers they declare.
 *
 * Both are facts on disk, not runtime state — `step.plugin.json` lists an
 * extension's MCP servers in a standard shape, and the CLI exposes its command
 * catalog over RPC. Neither needs a bespoke adapter; they need a reader.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StepRpc } from "./step-rpc.js";

/** Where Step keeps its config: the parent of the agent directory, which is the
 * same resolution the CLI itself uses. */
export function configRoot(): string | undefined {
  if (process.env["STEP_CONFIG_DIR"]) return process.env["STEP_CONFIG_DIR"];
  const agent = process.env["STEP_CODING_AGENT_DIR"];
  if (!agent) return undefined;
  const parent = agent.split(/[/\\]/).slice(0, -1).join("/");
  return parent || undefined;
}

/**
 * The two trees nest differently: `marketplaces/<marketplace>/<extension>/` is
 * two deep, `plugins/<extension>/` is one. Scanning each at its own depth is the
 * whole difference between finding playwright and silently missing it.
 */
function manifests(root: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const [relative, installed] of [
    ["marketplaces", false],
    ["plugins", true],
  ] as const) {
    let top: string[];
    try {
      top = readdirSync(join(root, relative));
    } catch {
      continue;
    }
    const candidates: string[] = [];
    for (const entry of top) {
      const path = join(root, relative, entry);
      if (relative === "plugins") {
        candidates.push(path);
        continue;
      }
      // A marketplace is a directory of extension directories.
      let inner: string[];
      try {
        inner = readdirSync(path);
      } catch {
        continue;
      }
      candidates.push(...inner.map(name => join(path, name)));
    }
    for (const dir of candidates) {
      let text: string;
      try {
        text = readFileSync(join(dir, "step.plugin.json"), "utf8");
      } catch {
        continue;
      }
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof value["id"] === "string" ? value["id"] : "";
      if (!id) continue;
      value["installed"] = installed;
      const existing = found.find(known => known["id"] === id);
      // An installed copy wins over its catalog entry.
      if (existing && installed) Object.assign(existing, value);
      else if (!existing) found.push(value);
    }
  }
  return found;
}

/** The installed extensions, each with the MCP servers it declares. */
export function listExtensions(root: string | undefined): Array<Record<string, unknown>> {
  if (!root) return [];
  return manifests(root).map(manifest => {
    const servers = manifest["mcpServers"];
    const mcpServers =
      servers && typeof servers === "object"
        ? Object.entries(servers as Record<string, Record<string, unknown>>).map(
            ([name, spec]) => ({
              name,
              command: typeof spec["command"] === "string" ? spec["command"] : "",
              args: Array.isArray(spec["args"]) ? spec["args"] : [],
            }),
          )
        : [];
    return {
      id: typeof manifest["id"] === "string" ? manifest["id"] : "",
      name: typeof manifest["name"] === "string" ? manifest["name"] : "",
      description: typeof manifest["description"] === "string" ? manifest["description"] : "",
      version: typeof manifest["version"] === "string" ? manifest["version"] : "",
      installed: manifest["installed"] === true,
      mcpServers,
    };
  });
}

/**
 * The CLI's command catalog: slash commands from every source, which is the
 * skills surface — there is no separate skills registry to read.
 */
export async function listCommands(
  rpc: StepRpc,
): Promise<Array<Record<string, unknown>>> {
  const catalog = await rpc.request("get_commands", {});
  const commands = catalog["commands"];
  return Array.isArray(commands) ? (commands as Array<Record<string, unknown>>) : [];
}
