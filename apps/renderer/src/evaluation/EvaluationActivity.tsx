import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { EvaluationKind, EvaluationRecord } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import "./evaluation.css";

/** Only the status entry is global. Evaluation jobs remain owned by the Host. */
export function EvaluationActivity({
  client,
  visible,
  onOpen,
}: {
  client: StudioClient;
  visible: boolean;
  onOpen(id: string, kind: EvaluationKind): void;
}) {
  const { preview } = usePreviewMode(),
    { resolvedLanguage } = useI18n();
  const [runs, setRuns] = useState<EvaluationRecord[]>([]);
  useEffect(() => {
    if (preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await client.query("evaluations.list", { limit: 200 });
        if (active)
          setRuns(
            result.records.filter(
              (r) => r.interaction || ["preparing", "running", "cancelling"].includes(r.state),
            ),
          );
      } catch {
        /* Older Hosts expose no evaluation status entry. */
      } finally {
        if (active) timer = setTimeout(() => void read(), 5000);
      }
    };
    const unsubscribe = client.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "evaluations.changed") {
        clearTimeout(timer);
        void read();
      }
    });
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, preview]);
  if (!visible || !runs.length || preview) return null;
  const waiting = runs.find((r) => r.interaction),
    target = waiting ?? runs[0]!;
  return (
    <button
      className={`eval-background-entry${waiting ? " waiting" : ""}`}
      onClick={() => onOpen(target.id, target.spec.kind)}
    >
      <Icon name={waiting ? "alert" : "pulse"} />
      {resolvedLanguage === "zh"
        ? waiting
          ? "评测等待你的审查"
          : `${runs.length} 个评测正在运行`
        : waiting
          ? "Evaluation needs your review"
          : `${runs.length} evaluations running`}
    </button>
  );
}
