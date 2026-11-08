import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  StudioClient,
  TimeTravelSettings,
} from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { timeTravelPreview } from "../preview/timeTravelPreview";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";

/** The switch belongs to the desktop profile, even while viewing a remote session. */
export function useTimeTravelSettings(
  activeClient: StudioClient | undefined,
  visible = true,
) {
  const { preview } = usePreviewMode();
  const { localClient } = useExecutionTarget();
  const client = localClient ?? activeClient;
  const demo = useSyncExternalStore(
    timeTravelPreview.subscribe,
    timeTravelPreview.getSettings,
  );
  const [real, setReal] = useState<TimeTravelSettings>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    setReal(undefined);
    const refresh = () => {
      const generation = ++sequence.current;
      if (preview || !client || !visible) return;
      void client.query("timeTravel.settings.get", {}).then(
        (value) => {
          if (generation !== sequence.current) return;
          setReal(value);
          setError(undefined);
        },
        (cause) => {
          if (generation === sequence.current)
            setError(hostErrorMessage(cause, "Time Travel unavailable"));
        },
      );
    };
    refresh();
    window.addEventListener("omp-time-travel-settings", refresh);
    return () => {
      sequence.current++;
      window.removeEventListener("omp-time-travel-settings", refresh);
    };
  }, [client, preview, visible]);
  const update = useCallback(
    async (patch: Partial<TimeTravelSettings>): Promise<boolean> => {
      if (preview) {
        timeTravelPreview.update(patch);
        return true;
      }
      if (!client) return false;
      const generation = ++sequence.current;
      setBusy(true);
      setError(undefined);
      try {
        const accepted = await client.command("timeTravel.settings.set", patch);
        const result = await waitReceipt<TimeTravelSettings>(
          client,
          accepted.requestId,
          null,
        );
        if (generation === sequence.current) setReal(result);
        window.dispatchEvent(new Event("omp-time-travel-settings"));
        return true;
      } catch (cause) {
        if (generation === sequence.current)
          setError(hostErrorMessage(cause, "Unable to update Time Travel"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, preview],
  );
  return { settings: preview ? demo : real, error, busy, update };
}
