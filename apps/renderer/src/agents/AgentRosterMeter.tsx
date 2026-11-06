import { useMemo } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { DockPanelMeter, type PanelStatusMeter } from "../dock/panelMeters";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { agentPresentation } from "./agentPresentation";

export type AgentRosterSource = "live" | "offline" | "history";
type MeterInput = { agents: readonly StudioAgentSnapshot[]; ready: boolean; source: AgentRosterSource; preview: boolean; marks: boolean; zh: boolean };

export function buildAgentRosterMeter({ agents, ready, source, preview, marks, zh }: MeterInput): PanelStatusMeter {
  const children = ready ? agents.filter(agent => agent.kind !== "main") : [];
  const groups = [
    { id: "failed", count: 0, color: "var(--red)", label: zh ? "失败" : "Failed" },
    { id: "waiting", count: 0, color: "var(--amber)", label: zh ? "待处理" : "Waiting" },
    { id: "running", count: 0, color: "var(--green)", label: zh ? "运行" : "Running" },
    { id: "inactive", count: 0, color: "var(--text-faint)", label: zh ? "未运行" : "Inactive" },
  ];
  const rows = children.map(agent => {
    const { tone, status, modelLabel } = agentPresentation(agent, preview, zh);
    const group = tone === "failed" ? 0 : tone === "waiting" ? 1 : ["running", "starting", "reviving"].includes(tone) ? 2 : 3;
    groups[group]!.count++;
    return `${agent.displayName} · ${status} · ${modelLabel}`;
  });
  const counts = groups.filter(group => group.count > 0);
  const note = !preview && source !== "live" ? source === "offline" ? zh ? "已断连" : "Offline" : zh ? "历史" : "History" : undefined;
  const emptyLabel = ready ? zh ? "无子代理" : "No child agents" : zh ? "读取中" : "Loading";
  const summary = counts.map(item => `${item.count} ${item.label}`).join(" · ") || emptyLabel;
  const label = [note, children.length ? `${children.length} ${zh ? "个子代理" : "child agents"}` : undefined, summary,
    preview && marks ? zh ? "演示" : "Demo" : undefined].filter(Boolean).join(" · ");
  return { kind: "status", total: children.length, counts, emptyLabel, ...(note ? { note } : {}), stale: !preview && source !== "live",
    tone: groups[0]!.count ? "danger" : groups[1]!.count ? "warning" : "normal", label,
    detail: [label, source === "offline" && !preview ? zh ? "以下为上次收到的状态" : "Last received states" : undefined, ...rows].filter(Boolean).join("\n"),
  };
}

/** Lives outside the panel body so folded cards and icons update without mounting conversations. */
export function AgentRosterMeter(props: Pick<MeterInput, "agents" | "ready" | "source">) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const { agents, ready, source } = props;
  const meter = useMemo(() => buildAgentRosterMeter({ agents, ready, source, preview, marks, zh: resolvedLanguage === "zh" }),
    [agents, ready, source, preview, marks, resolvedLanguage]);
  return <DockPanelMeter id="agents" value={meter} />;
}
