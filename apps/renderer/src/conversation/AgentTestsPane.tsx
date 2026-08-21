import { Icon } from "../icons";
import { useI18n } from "../i18n";
import {
  formatTestDuration,
  type AgentTestRun,
  type AgentTestRunStatus,
} from "./agentTestRuns";

const STATUS_UI: Record<AgentTestRunStatus, { icon: "check" | "x" | "refresh" | "stop"; tone: string; labelKey: string }> = {
  pass: { icon: "check", tone: "green", labelKey: "tests.statusPass" },
  fail: { icon: "x", tone: "red", labelKey: "tests.statusFail" },
  running: { icon: "refresh", tone: "amber", labelKey: "tests.statusRunning" },
  aborted: { icon: "stop", tone: "gray", labelKey: "tests.statusAborted" },
};

export function AgentTestsPane({
  runs,
  rerunDisabled,
  rerunTitle,
  onRerun,
  onReveal,
}: {
  runs: readonly AgentTestRun[];
  rerunDisabled: boolean;
  rerunTitle: string;
  onRerun: (command: string) => void;
  onReveal?: (run: AgentTestRun) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="tests-notice" role="note">
        {t("tests.notice")}
      </div>
      {runs.length === 0 ? (
        <div className="empty">
          <Icon name="info" extra="lg" />
          <p>{t("tests.emptyTitle")}</p>
          <p className="muted small">{t("tests.emptyDetail")}</p>
        </div>
      ) : (
        runs.map((run) => {
          const ui = STATUS_UI[run.status];
          const label = t(ui.labelKey);
          const showLog = Boolean(run.output) && (run.status === "fail" || run.status === "aborted");
          return (
            <div key={run.toolCallId} className="test-block">
              <div className="test-row">
                <button
                  type="button"
                  className="test-open"
                  onClick={() => onReveal?.(run)}
                  data-tip={t("tests.locate")}
                  aria-label={t("tests.locateAria", { command: run.command })}
                >
                  <span className={`prob-sev sev-${ui.tone}`} role="img" aria-label={label}>
                    <Icon name={ui.icon} extra="sm" />
                  </span>
                  <span className="test-open-body">
                    <b className="mono test-suite ellipsis" data-tip={run.command}>{run.command}</b>
                    {run.cwd ? <span className="tiny muted mono ellipsis" data-tip={run.cwd}>{run.cwd}</span> : null}
                  </span>
                  <span className={`chip ${ui.tone} sm`}>{label}{run.exitCode === undefined ? "" : ` · exit ${run.exitCode}`}</span>
                  {run.durationMs !== undefined ? <span className="tiny muted mono">{formatTestDuration(run.durationMs)}</span> : null}
                  {run.truncated === true ? <span className="chip gray xs">{t("tests.truncated")}</span> : null}
                </button>
                <button
                  type="button"
                  className="btn small outline"
                  disabled={rerunDisabled}
                  data-tip={rerunTitle}
                  onClick={() => onRerun(run.command)}
                >
                  {t("tests.rerunWithAgent")}
                </button>
              </div>
              {showLog && run.output ? <pre className="test-fail">{run.output}</pre> : null}
            </div>
          );
        })
      )}
    </>
  );
}
