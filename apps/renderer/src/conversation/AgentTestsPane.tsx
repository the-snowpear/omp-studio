import { Icon } from "../icons";
import {
  formatTestDuration,
  type AgentTestRun,
  type AgentTestRunStatus,
} from "./agentTestRuns";

const STATUS_UI: Record<AgentTestRunStatus, { icon: "check" | "x" | "refresh" | "stop"; tone: string; label: string }> = {
  pass: { icon: "check", tone: "green", label: "通过" },
  fail: { icon: "x", tone: "red", label: "失败" },
  running: { icon: "refresh", tone: "amber", label: "运行中" },
  aborted: { icon: "stop", tone: "gray", label: "已中止" },
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
  return (
    <>
      <div className="tests-notice" role="note">
        当前会话里 Agent 跑过的测试命令。点一行可对上对话里的 Bash 卡片。失败时直接展示 runner 原文，不解析成套件树。
      </div>
      {runs.length === 0 ? (
        <div className="empty">
          <Icon name="info" extra="lg" />
          <p>当前会话还没有 Agent 跑过的测试命令</p>
          <p className="muted small">Agent 用 bash 执行 npm test / bun test / pytest 等命令后，会出现在这里。</p>
        </div>
      ) : (
        runs.map((run) => {
          const ui = STATUS_UI[run.status];
          const showLog = Boolean(run.output) && (run.status === "fail" || run.status === "aborted");
          return (
            <div key={run.toolCallId} className="test-block">
              <div className="test-row">
                <button
                  type="button"
                  className="test-open"
                  onClick={() => onReveal?.(run)}
                  title="在对话中定位这次测试"
                  aria-label={`在对话中定位这次测试：${run.command}`}
                >
                  <span className={`prob-sev sev-${ui.tone}`} role="img" aria-label={ui.label}>
                    <Icon name={ui.icon} extra="sm" />
                  </span>
                  <span className="test-open-body">
                    <b className="mono test-suite ellipsis" title={run.command}>{run.command}</b>
                    {run.cwd ? <span className="tiny muted mono ellipsis" title={run.cwd}>{run.cwd}</span> : null}
                  </span>
                  <span className={`chip ${ui.tone} sm`}>{ui.label}{run.exitCode === undefined ? "" : ` · exit ${run.exitCode}`}</span>
                  {run.durationMs !== undefined ? <span className="tiny muted mono">{formatTestDuration(run.durationMs)}</span> : null}
                  {run.truncated === true ? <span className="chip gray xs">已截断</span> : null}
                </button>
                <button
                  type="button"
                  className="btn small outline"
                  disabled={rerunDisabled}
                  title={rerunTitle}
                  onClick={() => onRerun(run.command)}
                >
                  请 Agent 再跑
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
