import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { previewAgentDisplay } from "../preview/agentDockPreview";

export function agentStatusText(status: string, zh: boolean): string {
  const labels: Record<string, string> = { starting: "启动中", running: "运行中", idle: "空闲", parked: "已停靠", reviving: "恢复中", aborted: "已停止", failed: "失败", released: "已释放" };
  return zh ? labels[status] ?? status : status;
}

export function agentPresentation(agent: StudioAgentSnapshot, preview: boolean, zh: boolean) {
  const demo = preview ? previewAgentDisplay(agent.agentId) : undefined;
  const tone = demo?.tone ?? agent.status;
  const status = demo?.status ?? agentStatusText(agent.status, zh);
  // Waiting comes from the explicit demo adapter only. Runtime lifecycle alone
  // cannot associate a pending interaction with an individual child Agent.
  const compactStatus = tone === "waiting" ? zh ? "待处理" : "Waiting" : agentStatusText(agent.status, zh);
  const model = agent.resolvedModel;
  return { demo, tone, status, compactStatus, model,
    modelLabel: model?.includes("/") ? model.slice(model.indexOf("/") + 1) : model ?? (zh ? "模型未知" : "Unknown model"),
  };
}
