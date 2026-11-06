import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  ClientInteraction,
  CommandInput,
  CommandResult,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  EvaluationKind,
  EvaluationSpec,
  EvaluationRecord,
  EvaluationPlan,
  EvaluationContext,
  EvaluationResultPage,
  EvaluationControlInput,
  EvaluationExportInput,
} from "@omp-studio/studio-protocol";
import {
  WorkspaceTabs,
  WorkspaceDialog,
  WorkspaceEmpty,
  WorkspaceStatus,
} from "../workspaces/Workspace";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { InteractionDeck } from "../InteractionDeck";
import { Icon } from "../icons";
import { EvaluationConfig } from "./EvaluationConfig";
import { EvaluationResults, EvaluationComparison } from "./EvaluationResults";
import {
  evaluationNames,
  evaluationDescriptions,
  EVALUATION_KINDS,
  emptyEvaluation,
  asObject,
} from "./model";
import {
  EVALUATION_PREVIEW_CONTEXT,
  previewEvaluationRecords,
  previewEvaluation,
  previewEvaluationPlan,
  previewEvaluationRows,
} from "../preview/evaluationPreview";
import "./evaluation.css";

type EvaluationCommand =
  | "evaluations.prepare"
  | "evaluations.start"
  | "evaluations.control"
  | "evaluations.export"
  | "evaluations.respond"
  | "evaluations.openWorkspace";
type ViewRecord = EvaluationRecord & { clientInteraction?: ClientInteraction };
export function EvaluationPage({
  client,
  workspaceId,
  sessionId,
  onOpenModels,
  onOpenDiagnostics,
  intent,
}: {
  client: StudioClient;
  workspaceId?: string | undefined;
  sessionId?: string | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  intent?: { id: string; kind: EvaluationKind } | undefined;
  onOpenModels?(): void;
  onOpenDiagnostics?(): void;
}) {
  const executionTarget = useExecutionTarget();
  const { preview, marks } = usePreviewMode(),
    { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh",
    t = (cn: string, en: string) => (zh ? cn : en);
  const names = evaluationNames(zh),
    descriptions = evaluationDescriptions(zh);
  const [tab, setTab] = useState<EvaluationKind>("benchmark"),
    [context, setContext] = useState<EvaluationContext>();
  const [records, setRecords] = useState<EvaluationRecord[]>([]),
    [selected, setSelected] = useState<string>();
  const [record, setRecord] = useState<ViewRecord>(),
    [page, setPage] = useState<EvaluationResultPage>();
  const [offset, setOffset] = useState(0),
    [history, setHistory] = useState(false),
    [search, setSearch] = useState("");
  const [historyRows, setHistoryRows] = useState<EvaluationRecord[]>([]),
    [historyTotal, setHistoryTotal] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0);
  const [compare, setCompare] = useState<EvaluationRecord>(),
    [compareOpen, setCompareOpen] = useState(false);
  const [draft, setDraft] = useState<EvaluationSpec>(),
    [title, setTitle] = useState(""),
    [sourceId, setSourceId] = useState<string>();
  const [patchText, setPatchText] = useState<string>();
  const [pendingAction, setPendingAction] = useState<"start" | "pilot">();
  const [revising, setRevising] = useState(false),
    [plan, setPlan] = useState<EvaluationPlan>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0),
    [filter, setFilter] = useState("");
  const epoch = useRef(0),
    actionLock = useRef(false),
    previewRecords = useRef<EvaluationRecord[]>([]);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const invoke = useCallback(
    async <K extends EvaluationCommand>(
      name: K,
      input: CommandInput<K>,
    ): Promise<CommandResult<K>> => {
      const handle = await client.command(name, input);
      return waitReceipt<CommandResult<K>>(client, handle.requestId);
    },
    [client],
  );
  useEffect(() => {
    const current = ++epoch.current;
    setContext(undefined);
    setRecords([]);
    setRecord(undefined);
    setSelected(undefined);
    setDraft(undefined);
    setPlan(undefined);
    setError("");
    setNotice("");
    setOffset(0);
    setCompare(undefined);
    if (preview) {
      previewRecords.current = previewEvaluationRecords();
      setRecords(previewRecords.current);
      setContext(EVALUATION_PREVIEW_CONTEXT);
    } else if (workspaceId)
      void client
        .query("evaluations.context", { workspaceId })
        .then((value) => {
          if (current === epoch.current) setContext(value);
        })
        .catch((cause) => {
          if (current === epoch.current)
            setError(hostErrorMessage(cause, "Evaluation workspace unavailable"));
        });
    return () => {
      epoch.current++;
    };
  }, [client, workspaceId, preview]);
  useEffect(() => {
    if (intent) {
      setTab(intent.kind);
      setSelected(intent.id);
      setOffset(0);
      setDraft(undefined);
    }
  }, [intent]);
  useEffect(() => {
    if (preview) return;
    return client.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "evaluations.changed") setRefresh((value) => value + 1);
    });
  }, [client, preview]);
  useEffect(() => {
    if (plan) confirmButton.current?.focus();
  }, [plan]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const list = preview
          ? previewRecords.current
          : (
              await client.query("evaluations.list", {
                ...(workspaceId ? { workspaceId } : {}),
                limit: 200,
              })
            ).records;
        if (!active) return;
        setRecords(list);
        const id = selected ?? list.find((r) => r.spec.kind === tab)?.id;
        if (!id) {
          setRecord(undefined);
          setPage(undefined);
          return;
        }
        const value = preview
          ? list.find((r) => r.id === id)!
          : await client.query("evaluations.read", { id });
        if (!active) return;
        setRecord(value);
        if (id !== selected) {
          setSelected(id);
          setOffset(0);
        }
        const rows = preview ? previewEvaluationRows(value) : undefined;
        const result = rows
          ? {
              rows: rows.slice(offset, offset + 30),
              offset,
              nextOffset: Math.min(rows.length, offset + 30),
              total: rows.length,
            }
          : await client.query("evaluations.rows", { id, offset, limit: 30 });
        if (active) setPage(result);
      } catch (cause) {
        if (active) setError(hostErrorMessage(cause, "Cannot read evaluation"));
      } finally {
        if (active && !preview) timer = setTimeout(() => void load(), 1500);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, preview, tab, selected, offset, refresh]);
  useEffect(() => {
    if (!history) return;
    let active = true;
    if (preview) {
      const rows = previewRecords.current.filter(
        (r) => r.spec.kind === tab && r.title.toLowerCase().includes(search.toLowerCase()),
      );
      setHistoryRows(rows.slice(historyOffset, historyOffset + 50));
      setHistoryTotal(rows.length);
      return;
    }
    void client
      .query("evaluations.list", {
        ...(workspaceId ? { workspaceId } : {}),
        kind: tab,
        search,
        offset: historyOffset,
        limit: 50,
      })
      .then((result) => {
        if (active) {
          setHistoryRows(result.records);
          setHistoryTotal(result.total);
        }
      })
      .catch((cause) => {
        if (active) setError(hostErrorMessage(cause, "Cannot read history"));
      });
    return () => {
      active = false;
    };
  }, [history, search, historyOffset, tab, preview, client, workspaceId, refresh]);
  const action = async (run: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    const current = epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (cause) {
      if (epoch.current === current)
        setError(hostErrorMessage(cause, t("操作未完成", "Action did not complete")));
    } finally {
      actionLock.current = false;
      if (epoch.current === current) {
        setBusy(false);
        setRefresh((n) => n + 1);
      }
    }
  };
  const draftKey = `omp.evaluation.draft.${preview ? "preview" : (workspaceId ?? "none")}.${tab}`;
  const editDraft = (spec: EvaluationSpec) => {
    setDraft(spec);
    setPlan(undefined);
    sessionStorage.setItem(draftKey, JSON.stringify(spec));
  };
  const create = () => {
    let spec = emptyEvaluation(tab);
    const saved = sessionStorage.getItem(draftKey);
    if (saved) {
      try {
        spec = JSON.parse(saved) as EvaluationSpec;
      } catch {
        /* Obsolete local draft. */
      }
    }
    setDraft(spec);
    setTitle(names[tab]);
    setSourceId(undefined);
    setRevising(false);
    setPlan(undefined);
    setError("");
  };
  const retryFailed = () =>
    void action(async () => {
      if (!record || record.spec.kind !== "judgment") return;
      const spec = preview
        ? record.spec
        : await client.query("evaluations.retrySpec", { id: record.id });
      setDraft(spec);
      setTitle(record.title + t(" · 失败项重试", " · Retry failures"));
      setSourceId(record.id);
      setRevising(false);
      setPlan(undefined);
    });
  const rerun = () => {
    if (!record) return;
    setDraft(structuredClone(record.spec));
    setTitle(record.title);
    setSourceId(record.id);
    setRevising(false);
    setPlan(undefined);
  };
  const review = () =>
    void action(async () => {
      if (!draft) return;
      if ((draft.kind === "benchmark" || draft.kind === "instruction") && !draft.models.length)
        throw new Error(t("请选择至少一个模型。", "Select at least one model."));
      if (revising && draft.kind === "ratchet" && record) {
        if (preview)
          previewRecords.current = previewRecords.current.map((r) =>
            r.id === record.id
              ? {
                  ...r,
                  spec: draft,
                  detail: {
                    ...r.detail,
                    approvals: { inputs: "stale", grader: "stale", plan: "stale" },
                  },
                }
              : r,
          );
        else
          await invoke("evaluations.control", { id: record.id, action: "configure", spec: draft });
        setDraft(undefined);
        setRevising(false);
        return;
      }
      setPlan(
        preview
          ? previewEvaluationPlan(draft)
          : await invoke("evaluations.prepare", { workspaceId: workspaceId!, spec: draft }),
      );
    });
  const start = () =>
    void action(async () => {
      if (!plan) return;
      const value = preview
        ? previewEvaluation(plan.spec, title)
        : await invoke("evaluations.start", {
            workspaceId: workspaceId!,
            title,
            spec: plan.spec,
            ...(sourceId ? { sourceId } : {}),
          });
      if (preview) previewRecords.current = [value, ...previewRecords.current];
      setSelected(value.id);
      setRecord(value);
      setDraft(undefined);
      setPlan(undefined);
      setOffset(0);
      sessionStorage.removeItem(draftKey);
    });
  const control = (input: Omit<EvaluationControlInput, "id">) =>
    void action(async () => {
      if (!record) return;
      if (preview) {
        const next: EvaluationRecord = {
          ...record,
          state:
            input.action === "cancel"
              ? "cancelled"
              : input.action === "start"
                ? "running"
                : "ready",
          detail:
            input.action === "approve"
              ? {
                  ...record.detail,
                  approvals: { ...asObject(record.detail.approvals), [input.stage!]: "current" },
                }
              : record.detail,
        };
        previewRecords.current = previewRecords.current.map((r) => (r.id === next.id ? next : r));
        setRecord(next);
        return;
      }
      setRecord(await invoke("evaluations.control", { id: record.id, ...input }));
    });
  const exportReport = (format: EvaluationExportInput["format"]) =>
    void action(async () => {
      if (!record) return;
      if (preview) {
        if (marks)
          setNotice(
            t(
              "演示报告已准备好；没有写入真实产物库。",
              "Demo report ready; no real files were written.",
            ),
          );
        return;
      }
      const result = await invoke("evaluations.export", { id: record.id, format });
      if (!executionTarget.id && globalThis.ompStudioChrome?.exportArtifact) {
        const saved = await globalThis.ompStudioChrome.exportArtifact({
          artifactId: result.artifactId,
        });
        if (!saved.ok) throw new Error(saved.message);
        if (!saved.cancelled) setNotice(t("报告已导出。", "Report exported."));
      } else {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        let mimeType = "application/octet-stream";
        for (;;) {
          const part = await client.query("evaluations.exportChunk", {
            artifactId: result.artifactId,
            offset,
          });
          chunks.push(Uint8Array.from(atob(part.data), (char) => char.charCodeAt(0)));
          mimeType = part.mimeType;
          if (part.nextOffset >= part.total) break;
          offset = part.nextOffset;
        }
        const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
        const link = document.createElement("a");
        link.href = url;
        link.download = result.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(t("报告已导出。", "Report exported."));
      }
    });
  const working = !!record && ["preparing", "running", "cancelling"].includes(record.state);
  const approvals = asObject(record?.detail.approvals);
  const canStartRatchet =
    record?.spec.kind === "ratchet" &&
    ["inputs", "grader", "plan"].every((stage) => approvals[stage] === "current");
  const shownPage =
    page && filter
      ? {
          ...page,
          rows: page.rows.filter((row) =>
            `${row.key} ${row.model ?? ""} ${JSON.stringify(row.data)}`
              .toLowerCase()
              .includes(filter.toLowerCase()),
          ),
        }
      : page;
  return (
    <div className="page-wide evaluation-workspace">
      <WorkspaceTabs
        id="evaluation"
        label={t("评测工作区", "Evaluation workspace")}
        value={tab}
        onChange={(value) => {
          setTab(value);
          setSelected(undefined);
          setOffset(0);
          setDraft(undefined);
          setPlan(undefined);
          setCompare(undefined);
          setFilter("");
        }}
        items={EVALUATION_KINDS.map((kind) => ({
          id: kind,
          label: names[kind],
          icon: kind === "judgment" ? "check" : "pulse",
        }))}
      />
      <section role="tabpanel" id={`evaluation-${tab}-panel`} aria-labelledby={`evaluation-${tab}`}>
        <header className="eval-header">
          <div>
            <div className="eval-eyebrow">
              OMP {context?.runtimeVersion ?? record?.runtimeVersion ?? ""}
              {preview && marks ? <span className="eval-tag">{t("演示", "Demo")}</span> : null}
            </div>
            <h2>{names[tab]}</h2>
            <p>{descriptions[tab]}</p>
          </div>
          <div className="eval-header-actions">
            <button
              className="btn outline"
              onClick={() => {
                setHistoryOffset(0);
                setHistory(true);
              }}
            >
              <Icon name="clock" />
              {t("历史记录", "History")}
              <span>{records.filter((r) => r.spec.kind === tab).length}</span>
            </button>
            <button
              className="btn primary"
              disabled={busy || (!preview && !context?.available)}
              onClick={create}
            >
              <Icon name="plus" />
              {t("新建评测", "New evaluation")}
            </button>
          </div>
        </header>
        {error ? (
          <div className="eval-message error" role="alert">
            {error}
            <button
              className="btn small"
              onClick={() => {
                setError("");
                setRefresh((n) => n + 1);
                if (!preview && workspaceId && !context?.available)
                  void client
                    .query("evaluations.context", { workspaceId })
                    .then(setContext)
                    .catch((cause) => setError(hostErrorMessage(cause, "Cannot reconnect")));
              }}
            >
              {t("重新读取", "Refresh")}
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="eval-message" role="status">
            {notice}
          </p>
        ) : null}
        {!preview && !context?.available ? (
          <div className="eval-message">
            <span>
              {context?.reason ??
                (!workspaceId
                  ? t("选择工作区后即可配置评测。", "Choose a workspace to configure evaluations.")
                  : t("正在连接评测运行环境…", "Connecting the evaluation runtime…"))}
            </span>
            <button className="btn small" onClick={onOpenDiagnostics}>
              {t("诊断中心", "Diagnostics")}
            </button>
            <button className="btn small" onClick={onOpenModels}>
              {t("模型与凭据", "Models and credentials")}
            </button>
          </div>
        ) : null}
        {draft ? (
          <div className="eval-create">
            <div className="eval-toolbar">
              <button
                className="btn small"
                onClick={() => {
                  setDraft(undefined);
                  setPlan(undefined);
                }}
              >
                {t("返回结果", "Back to results")}
              </button>
              <span className="eval-hint">
                {sourceId
                  ? t("按历史配置创建或修订", "Based on saved configuration")
                  : t("草稿会在当前窗口保留", "Draft retained in this window")}
              </span>
            </div>
            <label className="eval-field eval-name">
              <span>{t("评测名称", "Evaluation name")}</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <EvaluationConfig
              key={`${tab}:${sourceId ?? "new"}`}
              spec={draft}
              onChange={editDraft}
              context={context}
              client={client}
              workspaceId={workspaceId}
              currentSessionId={sessionId}
              preview={preview}
              t={t}
            />
            <div className="eval-config-footer">
              <span>
                {t(
                  "只有主动填写的参数会覆盖原生默认。",
                  "Only explicit values override native defaults.",
                )}
              </span>
              <button
                className="btn primary"
                disabled={busy || (!preview && !context?.available)}
                onClick={review}
              >
                {busy
                  ? t("正在准备…", "Preparing…")
                  : revising
                    ? t("保存修订并重新审查", "Save and review changes")
                    : t("检查并准备开始", "Review evaluation")}
              </button>
            </div>
          </div>
        ) : record ? (
          <>
            <div className="eval-run-heading">
              <div>
                <h3>{record.title}</h3>
                <span className="eval-hint">
                  {new Date(record.createdAt).toLocaleString()} ·{" "}
                  {record.saveError ? t("保存待重试", "Save pending") : t("自动保存", "Autosaved")}
                </span>
              </div>
              <WorkspaceStatus state={record.state} />
            </div>
            {record.error ? (
              <p className="eval-message error" role="alert">
                {record.error}
              </p>
            ) : null}
            {record.saveError ? (
              <p className="eval-message error" role="alert">
                {record.saveError}
              </p>
            ) : null}
            <dl className="eval-overview">
              <div>
                <dt>
                  {record.spec.kind === "ratchet"
                    ? t("评测轮次", "Rounds")
                    : t("已完成", "Completed")}
                </dt>
                <dd>
                  {record.completed}
                  <small> / {record.total || "—"}</small>
                </dd>
              </div>
              <div>
                <dt>{t("失败", "Failed")}</dt>
                <dd className={record.failed ? "eval-error" : ""}>{record.failed}</dd>
              </div>
              <div>
                <dt>{t("已记录费用", "Recorded cost")}</dt>
                <dd>{record.cost === null ? "—" : `$${record.cost.toFixed(4)}`}</dd>
              </div>
              <div>
                <dt>{t("运行状态", "Run status")}</dt>
                <dd className="eval-status-text">
                  {record.clientInteraction
                    ? t("等待你的审查", "Awaiting review")
                    : working
                      ? t("后台运行中", "Running in background")
                      : t("结果已保留", "Results retained")}
                </dd>
              </div>
            </dl>
            {working ? (
              <progress
                className="eval-progress"
                aria-label={t("评测进度", "Evaluation progress")}
                max={record.total || 1}
                {...(record.total ? { value: record.completed } : {})}
              />
            ) : null}
            {record.clientInteraction ? (
              <div className="eval-approval">
                <InteractionDeck
                  interaction={record.clientInteraction}
                  disabled={busy}
                  onRespond={async (decision, value) => {
                    try {
                      await invoke("evaluations.respond", {
                        id: record.id,
                        interactionId: record.clientInteraction!.interactionId,
                        leaseGeneration: record.clientInteraction!.leaseGeneration,
                        decision,
                        ...(value === undefined ? {} : { value }),
                      });
                      setRefresh((n) => n + 1);
                      return true;
                    } catch (cause) {
                      setError(hostErrorMessage(cause, "Cannot submit review"));
                      return false;
                    }
                  }}
                />
              </div>
            ) : null}
            {record.spec.kind === "ratchet" ? (
              <div className="eval-approval-stages">
                {(["inputs", "grader", "plan"] as const).map((stage, index) => (
                  <div key={stage}>
                    <span
                      className={`eval-stage-index${approvals[stage] === "current" ? " complete" : ""}`}
                    >
                      {approvals[stage] === "current" ? "✓" : index + 1}
                    </span>
                    <span>
                      <strong>
                        {stage === "inputs"
                          ? t("输入与划分", "Inputs and split")
                          : stage === "grader"
                            ? t("评分器", "Grader")
                            : t("计划与边界", "Plan and limits")}
                      </strong>
                      <small>
                        {approvals[stage] === "current"
                          ? t("已确认", "Approved")
                          : approvals[stage] === "stale"
                            ? t("材料已变化", "Material changed")
                            : t("待审查", "Needs review")}
                      </small>
                    </span>
                    <button
                      className="btn small"
                      disabled={
                        busy || working || !!record.clientInteraction || !record.detail.nativeState
                      }
                      onClick={() => control({ action: "approve", stage })}
                    >
                      {t("审查", "Review")}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="eval-toolbar eval-run-actions">
              {working ? (
                <button
                  className="btn outline danger"
                  disabled={busy || record.state === "cancelling"}
                  onClick={() => control({ action: "cancel" })}
                >
                  {t("停止评测", "Stop evaluation")}
                </button>
              ) : (
                <button
                  className="btn outline"
                  disabled={record.replayable === false}
                  onClick={rerun}
                >
                  {t("按此配置复跑", "Run again")}
                </button>
              )}
              {record.spec.kind === "judgment" && record.failed > 0 ? (
                <button
                  className="btn outline"
                  disabled={busy || working || record.replayable === false}
                  onClick={retryFailed}
                >
                  {t("重试失败项", "Retry failed items")}
                </button>
              ) : null}
              {record.replayable === false ? (
                <span className="eval-hint">
                  {t(
                    "旧报告缺少原始输入，可查看和导出。",
                    "Legacy report has no original inputs; viewing and export remain available.",
                  )}
                </span>
              ) : null}
              {record.spec.kind === "ratchet" ? (
                <>
                  <button
                    className="btn primary"
                    disabled={busy || working || !canStartRatchet}
                    onClick={() => setPendingAction("start")}
                  >
                    {t("启动／继续迭代", "Start / continue")}
                  </button>
                  <button
                    className="btn"
                    disabled={busy || working || !canStartRatchet}
                    onClick={() => setPendingAction("pilot")}
                  >
                    {t("运行一次基线／试评", "Run baseline / pilot")}
                  </button>
                  <button
                    className="btn"
                    disabled={busy || working}
                    onClick={() => {
                      setDraft(structuredClone(record.spec));
                      setTitle(record.title);
                      setSourceId(record.id);
                      setRevising(true);
                    }}
                  >
                    {t("修改材料与计划", "Revise setup")}
                  </button>
                </>
              ) : null}
              <details className="eval-export">
                <summary className="btn outline">{t("导出报告", "Export")}</summary>
                <div>
                  {(["json", "csv", "html"] as const).map((format) => (
                    <button
                      className="btn small"
                      key={format}
                      disabled={busy}
                      onClick={() => exportReport(format)}
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                  {record.spec.kind === "ratchet" ? (
                    <button
                      className="btn small"
                      disabled={busy || !record.detail.patchAvailable}
                      onClick={() => exportReport("patch")}
                    >
                      {t("最佳版本补丁", "Best-version patch")}
                    </button>
                  ) : null}
                </div>
              </details>
              <button
                className="btn"
                disabled={!compare || compare.id === record.id}
                onClick={() => setCompareOpen(true)}
              >
                {t("对比报告", "Compare")}
              </button>
              <span className="eval-hint">
                {working ? t("离开页面不会停止当前任务", "Navigation does not stop this run") : ""}
              </span>
            </div>
            {record.spec.kind === "ratchet" ? (
              <details className="eval-advanced">
                <summary>{t("隔离工作区与恢复信息", "Isolation and recovery")}</summary>
                <p className="mono">{String(record.detail.workspace ?? "—")}</p>
                <div className="eval-toolbar">
                  <button
                    className="btn small"
                    onClick={() =>
                      void action(async () => {
                        if (!preview) await invoke("evaluations.openWorkspace", { id: record.id });
                      })
                    }
                  >
                    {t("打开隔离工作区", "Open isolated workspace")}
                  </button>
                  <button
                    className="btn small"
                    disabled={!record.detail.patchAvailable}
                    onClick={() =>
                      void action(async () => {
                        if (preview) {
                          setPatchText(
                            [
                              "--- a/prompts/router.md",
                              "+++ b/prompts/router.md",
                              "@@ -1 +1 @@",
                              "-Classify requests.",
                              "+Classify billing and technical requests using the approved examples.",
                            ].join(String.fromCharCode(10)),
                          );
                          return;
                        }
                        let offset = 0,
                          text = "";
                        for (;;) {
                          const part = await client.query("evaluations.patch", {
                            id: record.id,
                            offset,
                          });
                          text += part.text;
                          if (part.nextOffset >= part.total) break;
                          offset = part.nextOffset;
                        }
                        setPatchText(text);
                      })
                    }
                  >
                    {t("查看最佳版本差异", "View best-version diff")}
                  </button>
                </div>
                <p>
                  {t(
                    "导出差异对应已验证的最佳版本，由你决定如何合入原项目。",
                    "The exported patch belongs to the verified best version. Applying it remains your decision.",
                  )}
                </p>
              </details>
            ) : null}
            <div className="eval-filter">
              <input
                className="input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("筛选当前页结果", "Filter results on this page")}
                aria-label={t("筛选结果", "Filter results")}
              />
              <span className="eval-hint">
                {page
                  ? `${page.offset + (page.rows.length ? 1 : 0)}–${page.nextOffset} / ${page.total}`
                  : ""}
              </span>
            </div>
            <EvaluationResults record={record} page={shownPage} t={t} />
            <div className="eval-pagination">
              <button
                className="btn small"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                {t("上一页", "Previous")}
              </button>
              <span>
                {page
                  ? `${page.offset + (page.rows.length ? 1 : 0)}–${page.nextOffset} / ${page.total}`
                  : ""}
              </span>
              <button
                className="btn small"
                disabled={!page || page.nextOffset >= page.total}
                onClick={() => setOffset(page!.nextOffset)}
              >
                {t("下一页", "Next")}
              </button>
            </div>
            <details className="eval-advanced">
              <summary>{t("配置与原生详情", "Configuration and native details")}</summary>
              <p className="mono">
                {record.id} · OMP {record.runtimeVersion ?? "—"}
              </p>
              <pre>
                {JSON.stringify(
                  { configuration: record.spec, plan: record.plan, details: record.detail },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        ) : (
          <WorkspaceEmpty title={t("还没有评测记录", "No evaluations yet")} icon="pulse">
            {t(
              "从原生工作负载开始，结果会自动保存在此工作区。",
              "Start with a native workload. Results are saved automatically for this workspace.",
            )}
          </WorkspaceEmpty>
        )}
      </section>
      {patchText !== undefined ? (
        <WorkspaceDialog
          title={t("最佳版本差异", "Best-version diff")}
          onClose={() => setPatchText(undefined)}
        >
          <pre className="eval-diff">
            {patchText || t("最佳版本没有代码差异。", "The best version has no code changes.")}
          </pre>
        </WorkspaceDialog>
      ) : null}
      {pendingAction ? (
        <WorkspaceDialog
          title={
            pendingAction === "pilot"
              ? t("运行一次试评", "Run a pilot")
              : t("启动迭代", "Start iteration")
          }
          onClose={() => setPendingAction(undefined)}
        >
          <p>
            {t(
              "将调用原生代理和已审批的运行器，可能产生费用。",
              "Runs the native agent and approved runner; usage may incur charges.",
            )}
          </p>
          <p>
            {record?.spec.kind === "ratchet"
              ? `${t("目标", "Target")}: ${record.spec.metric} · ${t("轮次上限", "Round limit")}: ${record.spec.roundsLimit ?? "—"} · USD ${record.spec.costLimit ?? "—"}`
              : ""}
          </p>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              control({ action: pendingAction });
              setPendingAction(undefined);
            }}
          >
            {t("确认并运行", "Confirm and run")}
          </button>
        </WorkspaceDialog>
      ) : null}
      {plan ? (
        <WorkspaceDialog
          title={t("确认评测配置", "Review evaluation")}
          onClose={() => setPlan(undefined)}
        >
          <p className="eval-review-title">{title}</p>
          <div className="eval-review-count">
            <strong>
              {plan.requests === null
                ? t("按实际执行计费", "Usage-based")
                : `${plan.upperBound ? "≤ " : ""}${plan.requests}`}
            </strong>
            <span>
              {plan.requests === null
                ? t(
                    "问题分组、重试与代理流程影响请求数量",
                    "Grouping, retries and agent work determine request count",
                  )
                : t("次模型请求（不含额外重试）", "model requests, excluding additional retries")}
            </span>
          </div>
          {plan.resolvedModels?.length ? (
            <p className="mono">{plan.resolvedModels.join(" · ")}</p>
          ) : null}
          <div className="eval-plan-phases">
            {plan.phases.map((phase) => (
              <div key={phase.name}>
                <strong>{phase.name}</strong>
                <span>
                  {phase.requests} {t("次／模型", "requests / model")} · {phase.concurrency}{" "}
                  {t("并发", "concurrent")}
                  {phase.maxTokens ? ` · ${phase.maxTokens} max tokens` : ""}
                </span>
              </div>
            ))}
          </div>
          <p>
            {t(
              "开始后会产生模型或运行器费用，失败及重试也可能计费。价格缺失时显示未知。",
              "Model or runner usage is billable, including possible failures and retries. Missing prices remain unknown.",
            )}
          </p>
          {plan.spec.kind === "ratchet" && plan.spec.assist ? (
            <p>
              {t(
                "本次先由代理准备评测材料。优化仍需完成三个原生审批后主动启动。",
                "The agent first prepares material. Optimization requires three native approvals and an explicit start.",
              )}
            </p>
          ) : null}
          <details className="eval-advanced">
            <summary>{t("完整冻结配置", "Frozen configuration")}</summary>
            <pre>{JSON.stringify(plan.spec, null, 2)}</pre>
          </details>
          <div className="eval-dialog-actions">
            <button className="btn" onClick={() => setPlan(undefined)}>
              {t("返回修改", "Back")}
            </button>
            <button ref={confirmButton} className="btn primary" disabled={busy} onClick={start}>
              {busy ? t("启动中…", "Starting…") : t("确认并开始", "Confirm and start")}
            </button>
          </div>
        </WorkspaceDialog>
      ) : null}
      {history ? (
        <WorkspaceDialog
          title={t("评测历史", "Evaluation history")}
          onClose={() => setHistory(false)}
        >
          <input
            className="input"
            aria-label={t("搜索历史", "Search history")}
            placeholder={t("搜索名称或 ID", "Search name or ID")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setHistoryOffset(0);
            }}
          />
          <div className="eval-history-list">
            {historyRows.map((r) => (
              <div key={r.id}>
                <button
                  onClick={() => {
                    setSelected(r.id);
                    setOffset(0);
                    setDraft(undefined);
                    setHistory(false);
                  }}
                >
                  <strong>{r.title}</strong>
                  <small>
                    {new Date(r.createdAt).toLocaleString()} · {r.completed}/{r.total}
                  </small>
                </button>
                <WorkspaceStatus state={r.state} />
                <button
                  className="btn small"
                  disabled={r.id === record?.id}
                  onClick={() => {
                    setCompare(r);
                    setHistory(false);
                    setCompareOpen(true);
                  }}
                >
                  {t("与当前对比", "Compare with current")}
                </button>
              </div>
            ))}
          </div>
          <div className="eval-pagination">
            <button
              className="btn small"
              disabled={!historyOffset}
              onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}
            >
              {t("上一页", "Previous")}
            </button>
            <span>
              {historyOffset + historyRows.length} / {historyTotal}
            </span>
            <button
              className="btn small"
              disabled={historyOffset + historyRows.length >= historyTotal}
              onClick={() => setHistoryOffset(historyOffset + 50)}
            >
              {t("下一页", "Next")}
            </button>
          </div>
        </WorkspaceDialog>
      ) : null}
      {compareOpen && compare && record ? (
        <WorkspaceDialog
          title={t("报告对比", "Compare reports")}
          onClose={() => setCompareOpen(false)}
        >
          <EvaluationComparison before={compare} after={record} t={t} />
        </WorkspaceDialog>
      ) : null}
    </div>
  );
}
