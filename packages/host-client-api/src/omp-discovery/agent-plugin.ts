/**
 * Minimal Agent Plugins (https://agent-plugins.org) root classification.
 * Not a full port of the vendor implementation: no closed-schema validation,
 * no containRoot / ${PLUGIN_DATA} handling, no Bun.
 */

import * as fs from "node:fs/promises";

export type AgentPluginRootStatus =
  | { readonly kind: "none" }
  | { readonly kind: "standard" };

/**
 * Classify a plugin root by its root `plugin.json` $schema.
 * Missing / unreadable / malformed / non-matching roots are "none".
 */
export async function classifyAgentPluginRoot(rootPath: string): Promise<AgentPluginRootStatus> {
  let content: string;
  try {
    content = await fs.readFile(`${rootPath}/plugin.json`, "utf8");
  } catch {
    return { kind: "none" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "none" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "none" };
  }

  const schema = (parsed as Record<string, unknown>).$schema;
  if (typeof schema !== "string" || !schema.startsWith("https://agent-plugins.org/schemas/")) {
    return { kind: "none" };
  }
  return { kind: "standard" };
}

/**
 * Whether a legacy plugin provider (claude-plugins, omp-plugins) may process
 * a root for the given surface. Agent Plugins roots keep `skills` exclusive
 * to the standard loader.
 */
export async function legacyProviderAllowed(
  rootPath: string,
  surface: "skills" | "mcp" | "other"
): Promise<boolean> {
  const status = await classifyAgentPluginRoot(rootPath);
  if (status.kind === "none") return true;
  return surface !== "skills";
}
