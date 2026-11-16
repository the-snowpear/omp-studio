import type { SessionTierState } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewServiceTier(zh = isZh()): SessionTierState {
 return {
  selector:"anthropic/claude-sonnet-4.5",configured:"none",effective:"standard",
  choices:[{id:"standard",available:true},{id:"slow",available:true},{id:"priority",available:true},{id:"ultrafast",available:false,reason:zh?"该模型不提供 Ultrafast":"This model does not offer Ultrafast"}],
 };
}

export const PREVIEW_SERVICE_TIER: SessionTierState = getPreviewServiceTier();
