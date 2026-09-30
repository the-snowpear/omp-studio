import type { SessionTierState } from "@omp-studio/studio-protocol";

export const PREVIEW_SERVICE_TIER: SessionTierState = {
 selector:"demo/model",configured:"none",effective:"standard",
 choices:[{id:"standard",available:true},{id:"slow",available:true},{id:"priority",available:true},{id:"ultrafast",available:false,reason:"Demo model does not offer Ultrafast / 演示模型不提供 Ultrafast"}],
};
