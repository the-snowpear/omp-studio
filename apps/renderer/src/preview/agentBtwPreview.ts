import type { AgentBtwState } from "@omp-studio/studio-protocol";
export const PREVIEW_CHILD_BTW_TURNS:AgentBtwState["turns"]=[{question:"这个子任务的测试范围是什么？",answer:"先检查当前子任务修改的模块，再运行对应回归测试。",status:"complete",createdAt:1790726400000,updatedAt:1790726400000}];
export function agentBtwPreview(agentId:string):AgentBtwState{
 return {binding:"demo-child-btw",agentId,targetSessionId:"demo-child-session",snapshot:null,topics:[{topicId:"demo-child-topic",question:"这个子任务的测试范围是什么？",status:"complete",updatedAt:1790726400000,turnCount:1}],turns:[]};
}
