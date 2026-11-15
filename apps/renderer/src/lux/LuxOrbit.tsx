import { useEffect, useRef } from "react";
import { clearLuxActivity, reportLuxActivity, type LuxActivity } from "./activity";

/**
 * State light for a working surface (the composer): an outer halo and a light
 * travelling round the border. Place it as the first child of a positioned,
 * rounded element; both nodes inherit its radius. Styles in styles/light.css.
 */
export function LuxOrbit({ state }: { state: LuxActivity }) {
  const source = useRef<symbol>(Symbol("lux-orbit"));
  useEffect(() => {
    reportLuxActivity(source.current, state);
  }, [state]);
  useEffect(() => {
    const key = source.current;
    return () => clearLuxActivity(key);
  }, []);
  if (state === "idle") return null;
  return (
    <>
      <span className="lux-halo" data-state={state} aria-hidden="true" />
      <span className="lux-orbit" data-state={state} aria-hidden="true" />
    </>
  );
}
