import type { AgentModelInspection } from "@omp-studio/studio-protocol";
export function previewAgentModel(agentId: string, selectedModel = "demo/reason", saved = false): AgentModelInspection {
 const selector=selectedModel.includes("/")?selectedModel:"demo/"+selectedModel;
 return { agentId, source: saved ? "saved" : "live", selectedModel:selector, ...(saved?{}:{servingModel:selector,usingFallback:false,effectiveThinking:"high"}), configuredThinking: saved ? "high" : "auto", candidates: [selector, "demo/backup"], candidatesTruncated: false };
}
