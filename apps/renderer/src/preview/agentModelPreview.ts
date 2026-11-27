import type { AgentModelInspection } from "@omp-studio/studio-protocol";
export function previewAgentModel(agentId: string, selectedModel = "anthropic/claude-opus-4.1", saved = false): AgentModelInspection {
 const selector=selectedModel.includes("/")?selectedModel:"openai/"+selectedModel;
 return { agentId, source: saved ? "saved" : "live", selectedModel:selector, ...(saved?{}:{servingModel:selector,usingFallback:false,effectiveThinking:"high",controllable:true,models:[{selector,name:selector.split("/").at(-1)!},{selector:"openai/gpt-5",name:"GPT-5"}],thinkingLevels:["off","auto","low","medium","high"]}), configuredThinking: saved ? "high" : "auto", candidates: [selector, "openai/gpt-5"], candidatesTruncated: false };
}
