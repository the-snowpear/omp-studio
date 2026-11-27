import { useMemo, useRef, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { FeatureSettingRow, TodoBackendState } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { FeatureSettingsPane } from "../settings/FeatureSettingsPane";
import { TodoBackendSettings } from "../settings/TodoBackendSettings";
import { ComputerSettings } from "../computer/ComputerSettings";
import { McpRuntimePane } from "../capabilities/McpRuntimePane";
import { DisassemblerPane } from "../capabilities/DisassemblerPane";
import { PREVIEW_FEATURE_SETTINGS } from "../preview/featureSettingsPreview";
import { PREVIEW_COMPUTER_SETTINGS } from "../preview/computerPreview";
import { PREVIEW_DISASSEMBLER } from "../preview/disassemblerPreview";
import { getPreviewMcpRuntime } from "../preview/runtimeCatalogPreview";
import { getPreviewTodoBackends } from "../preview/todoBackendPreview";

const kinds = ["preferences.features.get", "preferences.features.set", "preferences.features.clearOverride", "computer.control.stop", "todo.backends.get", "todo.backend.set", "todo.backend.sync", "mcp.runtime.status", "mcp.auth.reauth", "mcp.auth.stepUp", "mcp.auth.unauth", "mcp.auth.reconnect", "disassembler.status", "disassembler.configure"];
const capabilities = { capabilities: kinds.map(id => ({ id, grade: "stable", version: 1, evidence: "controlled acceptance" })) } as ClientBootstrap["capabilityManifest"];

/** Isolated acceptance data; this client cannot reach a Runtime or user configuration. */
export function SettingsBackendsHarness({ visible = true }: { visible?: boolean }) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const locale = useRef(zh); locale.current = zh;
  const [tab, setTab] = useState("settings");
  const client = useMemo(() => {
    const commands: Record<string, unknown> = {};
    let id = 0;
    let rows: FeatureSettingRow[] = [...PREVIEW_FEATURE_SETTINGS, ...PREVIEW_COMPUTER_SETTINGS.filter(row => row.key !== "computer.takeover")].map(row => ({ ...row }));
    let todo: TodoBackendState = getPreviewTodoBackends(false);
    let disasm = structuredClone(PREVIEW_DISASSEMBLER);
    let authorized = false;
    const command = async (kind: string, input: Record<string, unknown>) => {
      let result: unknown;
      if (kind === "preferences.features.get") result = { settings: rows };
      else if (kind === "preferences.features.set") { rows = rows.map(row => row.key === input.key ? { ...row, value: input.value as FeatureSettingRow["value"], source: input.scope === "global" ? "global" : "runtime" } : row); result = rows.find(row => row.key === input.key); }
      else if (kind.startsWith("todo.")) { if (input.backend) todo = { ...todo, selected: String(input.backend), sync: { state: "synced" } }; result = todo; }
      else if (kind === "mcp.runtime.status") { const state = getPreviewMcpRuntime(locale.current); if (authorized) state.servers = state.servers.map(row => row.name === "docs" ? { ...row, authChallenge: { ...row.authChallenge!, status: "authorized" } } : row); result = state; }
      else if (kind.startsWith("mcp.auth.")) { authorized = true; result = { name: input.name, status: "authorized", scope: "project" }; }
      else if (kind === "disassembler.configure") { disasm = { ...disasm, ...input } as typeof disasm; result = disasm; }
      else if (kind === "disassembler.status") result = disasm;
      else result = { status: "stopped" };
      const requestId = `settings-acceptance-${++id}`;
      commands[requestId] = { status: "completed", result: { result } };
      return { requestId };
    };
    return { command, query: async (kind: string) => { if (kind === "capabilities.get") return capabilities; throw new Error(`Unsupported acceptance query: ${kind}`); }, getState: () => ({ commands }) } as unknown as StudioClient;
  }, []);
  const context = { sessionId: "settings-acceptance", available: true, capabilities };
  return <div style={{ maxWidth: 1100 }}>
    <nav style={{ display: "flex", gap: 8, marginBottom: 20 }}>{[["settings", "运行设置", "Runtime settings"], ["computer", "电脑接管", "Computer takeover"], ["todo", "Todo 后端", "Todo backends"], ["mcp", "MCP 状态", "MCP status"], ["binja", "Binary Ninja", "Binary Ninja"]].map(([id, cn, en]) => <button className={`btn small ${tab === id ? "primary" : "outline"}`} key={id} onClick={() => setTab(id!)}>{zh ? cn : en}</button>)}</nav>
    <div hidden={tab !== "settings"}><FeatureSettingsPane client={client} context={context} visible={visible && tab === "settings"} group="permissions" keys={["tools.commands", "tools.commandDocs", "tools.commandInline", "eval.tools.enabled", "mcp.shared", "mcp.idleStopMinutes"]} /><FeatureSettingsPane client={client} context={context} visible={visible && tab === "settings"} group="tasks" keys={["prewalk.auto", "prewalk.autoTarget"]} /><FeatureSettingsPane client={client} context={context} visible={visible && tab === "settings"} group="shell" keys={["bash.reapBackground", "pty.notify"]} /></div>
    <div hidden={tab !== "computer"}><ComputerSettings client={client} context={context} visible={visible && tab === "computer"} /></div>
    <div hidden={tab !== "todo"}><TodoBackendSettings client={client} context={context} visible={visible && tab === "todo"} /></div>
    <div hidden={tab !== "mcp"}><McpRuntimePane client={client} sessionId={context.sessionId} available authAvailable visible={visible && tab === "mcp"} /></div>
    <div hidden={tab !== "binja"}><DisassemblerPane client={client} sessionId={context.sessionId} available capabilities={capabilities} visible={visible && tab === "binja"} /></div>
  </div>;
}
