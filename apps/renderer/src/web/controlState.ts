import { useSyncExternalStore } from "react";
import type { ControlState } from "../../../desktop/src/web/control";

let writable = true;
const listeners = new Set<() => void>();
export function updateControlState(
  control: ControlState,
  deviceId?: string,
): void {
  writable = control.owner?.id === deviceId;
  for (const listener of listeners) listener();
}
export function useHostControl(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => writable,
  );
}
