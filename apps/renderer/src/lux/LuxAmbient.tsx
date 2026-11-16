import { useSyncExternalStore } from "react";
import { getLuxActivity, subscribeLuxActivity } from "./activity";

/**
 * The ambient light field (vivid only; styles/light.css decides when it
 * shows). Always mounted so turning the level up needs no re-render; at other
 * levels it is `display: none`.
 */
export function LuxAmbient() {
  const activity = useSyncExternalStore(subscribeLuxActivity, getLuxActivity, getLuxActivity);
  return (
    <div className="lux-ambient" data-activity={activity} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
