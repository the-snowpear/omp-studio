import type { SessionTierState } from "@omp-studio/studio-protocol";

export const PREVIEW_SERVICE_TIER: SessionTierState = {
 selector:"anthropic/claude-sonnet-4.5",configured:"none",effective:"standard",
 choices:[{id:"standard",available:true},{id:"slow",available:true},{id:"priority",available:true},{id:"ultrafast",available:false,reason:"This model does not offer Ultrafast / 该模型不提供 Ultrafast"}],
};
