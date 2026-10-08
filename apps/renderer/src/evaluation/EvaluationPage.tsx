import { RatchetPane } from "./RatchetPane";
import { useEffect, useState } from "react";
import type { AvailableModelRecord, ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { BenchmarkPane } from "../models/BenchmarkPane";
import { JudgmentsPane } from "../judgments/JudgmentsPane";
import { loadRuntimeModels } from "../models/runtimeModels";
import { WorkspacePanel, WorkspaceTabs } from "../workspaces/Workspace";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";

export function EvaluationPage({ client, sessionId, workspaceId, available, capabilities }: {
  client: StudioClient; sessionId?: string | undefined; workspaceId?: string | undefined;
  available: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [tab, setTab] = useState<"benchmarks" | "judgments" | "ratchet">("benchmarks");
  const [models, setModels] = useState<AvailableModelRecord[]>([]);
  const [error, setError] = useState("");
  const supports = (id: string) => capabilities?.capabilities.some(item => item.id === id && item.grade !== "unavailable") === true;
  const canBenchmark = available && supports("benchmarks.list") && supports("benchmarks.start");
  useEffect(() => {
    let active = true; setModels([]); setError("");
    if (!preview && canBenchmark && sessionId) {
      void loadRuntimeModels(client, () => active).then(rows => { if (active) setModels(rows); })
        .catch(cause => { if (active) setError(hostErrorMessage(cause, "Model catalog unavailable")); });
    }
    return () => { active = false; };
  }, [client, preview, canBenchmark, sessionId]);
  return <div className="evaluation-page workspace-page">
    <WorkspaceTabs<"benchmarks" | "judgments" | "ratchet"> id="evaluation" label={zh ? "评测工作区" : "Evaluation workspace"} value={tab} onChange={setTab} items={[
      { id: "benchmarks", label: zh ? "模型基准" : "Model benchmarks", icon: "pulse" },
      { id: "ratchet", label: "Ratchet", icon: "pulse" },
      { id: "judgments", label: zh ? "判断批次" : "Judgment batches", icon: "check" },
    ]} />
    <WorkspacePanel id="evaluation" name="ratchet" active={tab === "ratchet"}><RatchetPane client={client} sessionId={sessionId} available={available} capabilities={capabilities} visible={tab === "ratchet"} /></WorkspacePanel>
    {error ? <div className="banner amber" role="alert">{error}</div> : null}
    <WorkspacePanel id="evaluation" name="benchmarks" active={tab === "benchmarks"}>
      <BenchmarkPane client={client} sessionId={sessionId} workspaceId={workspaceId} available={canBenchmark} models={models} visible={tab === "benchmarks"} />
    </WorkspacePanel>
    <WorkspacePanel id="evaluation" name="judgments" active={tab === "judgments"}>
      <JudgmentsPane standalone client={client} sessionId={sessionId} workspaceId={workspaceId} available={available} capabilities={capabilities} visible={tab === "judgments"} />
    </WorkspacePanel>
  </div>;
}
