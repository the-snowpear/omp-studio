import { useEffect, useState, useSyncExternalStore } from "react";
import { getLuxActivity, subscribeLuxActivity } from "./activity";

/**
 * The ambient light field (vivid only; styles/light.css decides when it
 * shows). Always mounted so turning the level up needs no re-render; at other
 * levels it is `display: none`.
 */
export function LuxAmbient() {
  const activity = useSyncExternalStore(subscribeLuxActivity, getLuxActivity, getLuxActivity);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const sync = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return (
    <div className="lux-ambient" data-activity={activity} data-hidden={hidden || undefined} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
