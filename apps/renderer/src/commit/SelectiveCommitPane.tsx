import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SelectiveCommitDraft,
  SelectiveCommitHunk,
  SelectiveCommitOutcome,
  SelectiveCommitOwnership,
  SelectiveCommitPath,
  SelectiveCommitPreview,
  SelectiveCommitReason,
  SelectiveCommitSelection,
  SelectiveCommitSelectionState,
  SelectiveCommitUnit,
} from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage } from "../hostError";
import { useWideLayout } from "../layout/useWideLayout";
import { GitPatch } from "../git/GitPatch";
import { useOptionalGitWorkspace } from "../git/GitWorkspaceContext";
import { previewCommitSource, realCommitSource, type SelectiveCommitSource } from "./selectiveCommitSource";
import { AgentAvatar } from "../agents/AgentAvatar";
import "./selectiveCommit.css";

/**
 * The change journal names agents by their Runtime agent id (the same id the Hub
 * and the deck use) and the session's own agent by OMP's MAIN_AGENT_ID.
 */
const MAIN_AGENT_ID = "Main";

/** An agent's face in the draft: the deck's sigil, eyes open while it is still editing. */
function DraftAgentAvatar({ id, running }: { id: string; running: boolean }) {
  return <AgentAvatar agentId={id} main={id === MAIN_AGENT_ID} tone={running ? "running" : "idle"} size={14} />;
}

/** Opened from Git, Changes or `/commit`. `draft` is the native builtin.commit handle. */
export interface SelectiveCommitIntent {
  readonly key: number;
  readonly draft?: { readonly draftId: string; readonly revision: number; readonly runtimeEpoch?: number; readonly expiresAt?: number };
  readonly instructions?: string;
}

/** Reads the builtin.commit receipt; other command results never open the panel. */
export function selectiveCommitHandoff(result: unknown): Omit<SelectiveCommitIntent, "key"> | undefined {
  const value = result as { requiresConfirmation?: boolean; selectiveCommit?: NonNullable<SelectiveCommitIntent["draft"]>; instructions?: string } | undefined;
  if (value?.requiresConfirmation !== true || !value.selectiveCommit) return undefined;
  return {
    draft: value.selectiveCommit,
    ...(value.instructions?.trim() ? { instructions: value.instructions } : {}),
  };
}

type Step = "select" | "confirm" | "done";
type Filter = "all" | SelectiveCommitOwnership;
type Body = { text: string | null; totalChars: number; nextOffset?: number | undefined; loading: boolean; error?: string; revision?: number | undefined };

const OWNERSHIP: readonly SelectiveCommitOwnership[] = ["own", "other", "review"];

function expiryMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}
function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf("/");
  return at < 0 ? ["", path] : [path.slice(0, at + 1), path.slice(at + 1)];
}
function pathUnits(path: SelectiveCommitPath): SelectiveCommitUnit[] {
  return path.hunks.flatMap(hunk => hunk.units);
}
function lineCounts(path: SelectiveCommitPath, selectedOnly = false): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const entry of pathUnits(path)) {
    if (selectedOnly && entry.selected === "none") continue;
    added += entry.added; removed += entry.removed;
  }
  return { added, removed };
}
function parseFixes(text: string): Array<string | number> {
  return text.split(/[\s,，]+/u).map(item => item.trim().replace(/^#/u, "")).filter(Boolean).map(item => /^\d+$/u.test(item) ? Number(item) : item);
}

/** Tri-state box drawn from the native selection value; it never infers state from children. */
function TriBox({ state, label, disabled, onToggle }: { state: SelectiveCommitSelectionState; label: string; disabled?: boolean; onToggle(): void }) {
  return <button type="button" role="checkbox" className="scm-box" aria-checked={state === "all" ? "true" : state === "partial" ? "mixed" : "false"} aria-label={label} disabled={disabled}
    onClick={event => { event.stopPropagation(); onToggle(); }}
    onKeyDown={event => { if (event.key === " " || event.key === "Enter") event.stopPropagation(); }}>
    {state === "all" ? <Icon name="check" extra="sm" /> : state === "partial" ? <i aria-hidden="true" /> : null}
  </button>;
}

export function SelectiveCommitPane({ client, sessionId, runtimeEpoch, available, supported, visible, intent, onOpenSettings }: {
  client: StudioClient | null;
  sessionId?: string | undefined;
  runtimeEpoch?: number | undefined;
  available: boolean;
  supported: boolean;
  visible: boolean;
  intent?: SelectiveCommitIntent | undefined;
  onOpenSettings?: (() => void) | undefined;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const tr = (zhText: string, enText: string) => zh ? zhText : enText;
  const { preview, marks } = usePreviewMode();
  const [wideRef, wide] = useWideLayout<HTMLElement>(760);
  const gitWorkspace = useOptionalGitWorkspace();

  const source = useMemo<SelectiveCommitSource | undefined>(() => {
    if (preview) return previewCommitSource();
    return client && sessionId ? realCommitSource(client, sessionId) : undefined;
  }, [preview, client, sessionId]);
  const ready = preview || (available && supported && source !== undefined);

  const [draft, setDraft] = useState<SelectiveCommitDraft>();
  const [frozen, setFrozen] = useState<SelectiveCommitPreview>();
  const [outcome, setOutcome] = useState<SelectiveCommitOutcome>();
  const [step, setStep] = useState<Step>("select");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [repoChanged, setRepoChanged] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [onlyText, setOnlyText] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string>();
  const [bodies, setBodies] = useState<Readonly<Record<string, Body>>>({});
  const [patch, setPatch] = useState<Body>();
  const [subject, setSubject] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [fixes, setFixes] = useState("");
  const [amend, setAmend] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0);
  const patchEpoch = useRef(0);
  const bodyEpoch = useRef(0);
  const held = useRef<{ source: SelectiveCommitSource; draftId: string } | undefined>(undefined);
  const draftRef = useRef<SelectiveCommitDraft | undefined>(undefined);
  draftRef.current = draft;
  const busyRef = useRef<string | undefined>(undefined);
  busyRef.current = busy;
  const intentRef = useRef(intent);
  intentRef.current = intent;
  const sessionRef = useRef(sessionId);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const releaseHeld = useCallback((preserveDraftId?: string) => {
    const current = held.current;
    held.current = undefined;
    if (current && current.draftId !== preserveDraftId) current.source.release(current.draftId);
  }, []);
  const invalidatePatch = useCallback(() => { patchEpoch.current++; setPatch(undefined); }, []);
  const invalidateBodies = useCallback(() => { bodyEpoch.current++; setBodies({}); }, []);
  const adopt = useCallback((next: SelectiveCommitDraft) => {
    if (source && (held.current?.source !== source || held.current?.draftId !== next.view.id)) { releaseHeld(next.view.id); held.current = { source, draftId: next.view.id }; }
    setRepoChanged(false);
    setDraft(next);
  }, [source, releaseHeld]);
  const resetState = useCallback((preserveDraftId?: string) => {
    epoch.current += 1;
    releaseHeld(preserveDraftId);
    setDraft(undefined); setFrozen(undefined); setOutcome(undefined); setStep("select"); setBusy(undefined); setError(""); setRepoChanged(false);
    setExpanded(new Set()); setFocused(undefined); invalidateBodies(); invalidatePatch(); setOnlyText("");
    setSubject(""); setMessageBody(""); setFixes(""); setAmend(false); setNoVerify(false); setInstructions("");
  }, [releaseHeld, invalidateBodies, invalidatePatch]);
  const reset = useCallback(() => { resetState(); }, [resetState]);

  /* A draft belongs to one session, Runtime epoch and data source. */
  useEffect(() => {
    const boundSession = sessionId;
    sessionRef.current = boundSession;
    return () => {
      const keepDraftId = mountedRef.current && sessionRef.current === boundSession ? intentRef.current?.draft?.draftId : undefined;
      resetState(keepDraftId);
    };
  }, [resetState, sessionId, runtimeEpoch, source]);

  /* Watch external repository mutations while a draft or frozen preview is open. */
  useEffect(() => {
    if (preview || !client?.subscribe || !draft || step === "done") return;
    const expectedWorkspaceId = gitWorkspace?.repository?.workspaceId;
    return client.subscribe({ scope: "all" }, event => {
      if (event.kind !== "git.repository.changed") return;
      if (expectedWorkspaceId && event.repository.workspaceId !== expectedWorkspaceId) return;
      if (busyRef.current === "execute") return;
      setRepoChanged(true);
    });
  }, [preview, client, draft?.view.id, step, gitWorkspace?.repository?.workspaceId]);

  const run = useCallback(async <T,>(label: string, work: (current: SelectiveCommitSource) => Promise<T>, apply: (value: T) => void, discard?: (value: T, owner: SelectiveCommitSource) => void) => {
    if (!source) return;
    const generation = epoch.current;
    setBusy(label); setError("");
    try {
      const value = await work(source);
      if (generation === epoch.current) apply(value);
      else discard?.(value, source);
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, tr("选择性提交失败", "Selective commit failed")));
    } finally {
      if (generation === epoch.current) setBusy(undefined);
    }
  }, [source, zh]);
  const acquire = useCallback((work: (current: SelectiveCommitSource) => Promise<SelectiveCommitDraft>, preserveOnEpochShift = false) => {
    void run("prepare", work, adopt, (value, owner) => {
      if (preserveOnEpochShift && mountedRef.current && intentRef.current?.draft?.draftId === value.view.id) return;
      owner.release(value.view.id);
    });
  }, [run, adopt]);

  const prepare = useCallback((scope?: string | readonly string[]) => {
    reset();
    acquire(current => current.prepare(scope));
  }, [reset, acquire]);

  /* Intents: `/commit` hands over a native draft; Git/Changes ask for a fresh one. */
  const lastIntent = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!intent || !ready || !visible) return;
    const handle = intent.draft;
    if (handle?.runtimeEpoch !== undefined && runtimeEpoch !== undefined && handle.runtimeEpoch !== runtimeEpoch) return;
    const intentSignature = `${intent.key}:${sessionId ?? ""}:${runtimeEpoch ?? ""}:${preview ? "preview" : "real"}`;
    if (lastIntent.current === intentSignature) return;
    lastIntent.current = intentSignature;
    resetState(handle?.draftId);
    if (intent.instructions?.trim()) setInstructions(intent.instructions.trim());
    if (handle) acquire(current => current.open(handle.draftId, handle.revision), true);
    else acquire(current => current.prepare());
  }, [intent, ready, visible, sessionId, runtimeEpoch, preview, resetState, acquire]);

  const expiresAt = draft ? expiryMs(frozen && step === "confirm" ? frozen.expiresAt : draft.expiresAt) : undefined;
  useEffect(() => {
    if (expiresAt === undefined || step === "done" || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, step, visible]);
  const remaining = expiresAt === undefined ? undefined : expiresAt - now;
  const expired = remaining !== undefined && remaining <= 0 && step !== "done";

  const select = (selection: SelectiveCommitSelection) => {
    if (!draft || busy || expired) return;
    void run("select", current => current.select(draft, selection), next => {
      adopt(next);
      /* A new revision invalidates any frozen preview, its patch and per-file body chunks. */
      setFrozen(undefined); invalidatePatch(); invalidateBodies();
    });
  };
  const togglePath = (path: SelectiveCommitPath) => select(path.selected === "all" ? { action: "drop", path: path.path } : { action: "take", path: path.path });
  const toggleUnit = (path: SelectiveCommitPath, entry: SelectiveCommitUnit) => select({ action: entry.selected === "all" ? "drop" : "take", path: path.path, units: [entry.id] });

  const loadBody = (path: string, append = false) => {
    if (!draft || !source) return;
    const targetDraftId = draft.view.id;
    const targetRevision = draft.view.revision;
    const existing = bodies[path]?.revision === targetRevision ? bodies[path] : undefined;
    const offset = append ? existing?.nextOffset : undefined;
    if (append && offset === undefined) return;
    const generation = epoch.current;
    const readGeneration = bodyEpoch.current;
    setBodies(map => ({ ...map, [path]: { text: append ? existing?.text ?? "" : null, totalChars: existing?.totalChars ?? 0, nextOffset: existing?.nextOffset, loading: true, revision: targetRevision } }));
    void source.read(draft, { kind: "file", path, ...(offset === undefined ? {} : { offset }) }).then(result => {
      const latestDraft = draftRef.current;
      if (generation !== epoch.current || readGeneration !== bodyEpoch.current || latestDraft?.view.id !== targetDraftId || latestDraft.view.revision !== targetRevision || !result.body) return;
      const body = result.body;
      setBodies(map => {
        const current = map[path]?.revision === targetRevision ? map[path] : undefined;
        return { ...map, [path]: {
          text: body.text === null ? null : `${append ? current?.text ?? "" : ""}${body.text}`,
          totalChars: body.totalChars, nextOffset: body.nextOffset, loading: false, revision: targetRevision,
        } };
      });
    }, cause => {
      const latestDraft = draftRef.current;
      if (generation === epoch.current && readGeneration === bodyEpoch.current && latestDraft?.view.id === targetDraftId && latestDraft.view.revision === targetRevision) {
        setBodies(map => ({ ...map, [path]: { text: null, totalChars: 0, loading: false, revision: targetRevision, error: hostErrorMessage(cause, tr("差异读取失败", "Diff unavailable")) } }));
      }
    });
  };
  const loadPatch = (append = false) => {
    if (!draft || !frozen || !source) return;
    const offset = append ? patch?.nextOffset : undefined;
    if (append && offset === undefined) return;
    const generation = epoch.current;
    const readGeneration = ++patchEpoch.current;
    setPatch(current => ({ text: append ? current?.text ?? "" : null, totalChars: current?.totalChars ?? 0, nextOffset: current?.nextOffset, loading: true }));
    void source.read(draft, { kind: "preview", previewId: frozen.previewId, ...(offset === undefined ? {} : { offset }) }).then(result => {
      if (generation !== epoch.current || readGeneration !== patchEpoch.current || !result.body) return;
      const body = result.body;
      setPatch(current => ({ text: body.text === null ? null : `${append ? current?.text ?? "" : ""}${body.text}`, totalChars: body.totalChars, nextOffset: body.nextOffset, loading: false }));
    }, cause => {
      if (generation === epoch.current && readGeneration === patchEpoch.current) setPatch({ text: null, totalChars: 0, loading: false, error: hostErrorMessage(cause, tr("补丁读取失败", "Patch unavailable")) });
    });
  };

  const openPath = (path: SelectiveCommitPath) => {
    setFocused(path.path);
    if (path.kind !== "text") return;
    setExpanded(set => { const next = new Set(set); if (next.has(path.path)) next.delete(path.path); else next.add(path.path); return next; });
    const cached = bodies[path.path];
    if (!cached || cached.revision !== draft?.view.revision || cached.error) loadBody(path.path);
  };

  const freeze = () => {
    if (!draft || busy || expired) return;
    void run("preview", current => current.preview(draft), next => { setFrozen(next); setRepoChanged(false); invalidatePatch(); setStep("confirm"); });
  };
  const liveHead = !preview ? gitWorkspace?.repository?.headOid : undefined;
  const headDrifted = Boolean(draft && liveHead && draft.view.head && liveHead !== draft.view.head);
  const frozenHeadDrifted = Boolean(frozen && liveHead && frozen.head && liveHead !== frozen.head);
  const externalRepoDrift = step !== "done" && (repoChanged || headDrifted || frozenHeadDrifted);
  const frozenValid = !!frozen && !!draft && frozen.revision === draft.view.revision && frozen.draftId === draft.view.id && !frozenHeadDrifted;
  const execute = () => {
    if (!draft || !frozen || !frozenValid || busy || expired || !subject.trim()) return;
    const body = messageBody.trim();
    const fixList = parseFixes(fixes);
    const message = { subject: subject.trim(), ...(body ? { body } : {}), ...(fixList.length ? { fixes: fixList } : {}) };
    void run("execute", current => current.execute(draft, frozen, message, { ...(amend ? { amend: true } : {}), ...(noVerify ? { noVerify: true } : {}) }), result => {
      setOutcome(result); setStep("done");
      /* The native draft is consumed; release frees its store slot without another commit. */
      releaseHeld();
      void gitWorkspace?.refresh();
    });
  };

  const counts = useMemo(() => {
    const paths = draft?.view.paths ?? [];
    const by: Record<Filter, number> = { all: paths.length, own: 0, other: 0, review: 0 };
    for (const path of paths) for (const owner of OWNERSHIP) if (path.ownership.includes(owner)) by[owner] += 1;
    const chosen = paths.filter(path => path.selected !== "none");
    const lines = chosen.reduce((sum, path) => { const next = lineCounts(path, true); return { added: sum.added + next.added, removed: sum.removed + next.removed }; }, { added: 0, removed: 0 });
    return { by, chosen: chosen.length, ...lines };
  }, [draft]);
  const shown = useMemo(() => (draft?.view.paths ?? []).filter(path => filter === "all" || path.ownership.includes(filter)), [draft, filter]);

  const ownerLabel = (owner: SelectiveCommitOwnership) => owner === "own" ? tr("本会话", "This session") : owner === "other" ? tr("其他来源", "Other") : tr("需审核", "Review");
  const kindLabel = (kind: SelectiveCommitPath["kind"]) => ({
    text: tr("文本", "Text"), binary: tr("二进制", "Binary"), "non-utf8": tr("非 UTF-8", "Non-UTF-8"),
    large: tr("大文件", "Large"), symlink: tr("符号链接", "Symlink"), mode: tr("权限位", "Mode"), gitlink: tr("子模块", "Submodule"),
  })[kind];
  const changeMark = (change: SelectiveCommitPath["change"]) => change === "added" ? "A" : change === "deleted" ? "D" : "M";
  const changeLabel = (change: SelectiveCommitPath["change"]) => change === "added" ? tr("新增", "Added") : change === "deleted" ? tr("删除", "Deleted") : tr("修改", "Modified");
  const reasonText = (reason: SelectiveCommitReason): string => {
    switch (reason.kind) {
      case "entangled": return tr(`与 ${reason.with.join("、")} 交织`, `Entangled with ${reason.with.join(", ")}`);
      case "rewritten": return tr(`已被 ${reason.by} 改写`, `Rewritten by ${reason.by}`);
      case "hunk": return tr("按块归属", "Hunk attribution");
      case "whole": return `${tr("整项", "Whole file")} · ${kindLabel(reason.reason)}${reason.editors.length ? ` · ${reason.editors.join(", ")}` : ""}${reason.hint ? ` · ${reason.hint.label}` : ""}`;
    }
  };
  const actorLabel = (actor: string | null) => actor ?? tr("人工或未知", "Manual or unknown");
  const running = (actor: string) => draft?.view.agents.some(agent => agent.id === actor && agent.running) ?? false;
  const owners = (list: readonly SelectiveCommitOwnership[]) => <span className="scm-owners">{list.map(owner => <span key={owner} className={`scm-owner is-${owner}`}>{ownerLabel(owner)}</span>)}</span>;
  const demo = preview && marks ? <span className="chip gray xs">{tr("演示", "Demo")}</span> : null;

  const stepIndex = step === "select" ? 0 : step === "confirm" ? 1 : 2;
  const steps = [tr("挑选", "Pick"), tr("冻结预览", "Freeze"), tr("提交", "Commit")];

  const header = (
    <header className="scm-head">
      <div className="scm-title">
        <span className="scm-title-icon"><Icon name="commit" extra="sm" /></span>
        <span className="scm-title-text">
          <b>{tr("选择性提交", "Selective commit")}</b>
          {draft ? <span className="scm-ref mono">{draft.view.branch ? <><Icon name="branch" extra="sm" />{draft.view.branch}</> : null}<span>@ {short(draft.view.head)}</span></span> : null}
        </span>
        {demo}
        <span className="spacer" />
        {draft && step !== "done" ? <span className={`scm-rev chip xs ${expired ? "red" : remaining !== undefined && remaining < 60_000 ? "amber" : "gray"}`} data-tip={tr("原生草稿版本与剩余有效期", "Native draft revision and time left")}>
          rev {draft.view.revision}<Icon name="clock" extra="sm" />{expired ? tr("已过期", "Expired") : clock(remaining ?? 0)}
        </span> : null}
        {draft ? <button type="button" className="icon-btn small" aria-label={tr("放弃草稿", "Discard draft")} data-tip={tr("放弃草稿", "Discard draft")} disabled={busy === "execute"} onClick={reset}><Icon name="x" extra="sm" /></button> : null}
      </div>
      {draft ? <ol className="scm-steps" aria-label={tr("提交步骤", "Commit steps")}>
        {steps.map((label, index) => <li key={label} className={index < stepIndex ? "is-done" : index === stepIndex ? "is-current" : undefined} aria-current={index === stepIndex ? "step" : undefined}>
          <span className="scm-step-dot">{index < stepIndex ? <Icon name="check" extra="sm" /> : index + 1}</span><span>{label}</span>
        </li>)}
      </ol> : null}
    </header>
  );

  let body: ReactNode;
  if (!ready) {
    body = <div className="scm-empty is-disabled">
      <span className="scm-empty-mark"><Icon name="commit" /></span>
      <b>{tr("选择性提交暂不可用", "Selective commit unavailable")}</b>
      <p>{!client || !sessionId || !available
        ? tr("连接 Runtime 并打开一个会话后，可按改动归属挑选本次提交的文件与片段。", "Connect a Runtime and open a session to pick files and hunks by ownership.")
        : tr("当前 Runtime 未提供原生选择性提交（需要 OMP 18.20.2 或更高）。普通 Git 提交不受影响。", "This Runtime does not offer native selective commit (OMP 18.20.2 or newer). Regular Git commits are unaffected.")}</p>
    </div>;
  } else if (!draft) {
    body = <div className="scm-empty">
      <span className="scm-empty-mark"><Icon name="commit" /></span>
      <b>{tr("按归属挑选要提交的改动", "Pick what to commit, by who changed it")}</b>
      <p>{tr("Runtime 会根据本会话的编辑记录预选你的改动；其他来源与待审内容保持未选，由你决定。确认前会先冻结一份预览。",
        "The Runtime preselects edits this session made. Changes from elsewhere and items under review stay unpicked until you choose. A frozen preview comes before the commit.")}</p>
      <form className="scm-prepare" onSubmit={event => { event.preventDefault(); const agents = scopeText.split(/[\s,，]+/u).filter(Boolean); prepare(agents.length === 1 ? agents[0] : agents.length ? agents : undefined); }}>
        <input className="input mono" value={scopeText} onChange={event => setScopeText(event.target.value)} placeholder={tr("Agent 范围（可选）：self、* 或 Agent ID", "Agent scope (optional): self, * or agent IDs")} aria-label={tr("草稿 Agent 范围", "Draft agent scope")} />
        <button type="submit" className="btn primary" disabled={!!busy}>{busy === "prepare" ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkles" extra="sm" />}{tr("准备草稿", "Prepare draft")}</button>
      </form>
      {error ? <SelectiveCommitError message={error} zh={zh} onOpenSettings={onOpenSettings} /> : null}
    </div>;
  } else if (step === "done" && outcome) {
    body = <div className="scm-done">
      <span className="scm-done-mark"><Icon name="check" /></span>
      <b>{tr("已提交", "Committed")} <code>{short(outcome.sha)}</code></b>
      <p className="scm-done-subject">{outcome.subject}</p>
      <p className="scm-done-meta">{tr(`${outcome.paths.length} 个文件 · 父提交 ${short(outcome.parent)}`, `${outcome.paths.length} files · parent ${short(outcome.parent)}`)}</p>
      <ul className="scm-done-files">{outcome.paths.map(path => <li key={path} className="mono">{path}</li>)}</ul>
      {outcome.indexNotes.length ? <div className="scm-notes" role="note"><Icon name="info" extra="sm" /><div><b>{tr("暂存区提示", "Index notes")}</b>{outcome.indexNotes.map(note => <p key={note}>{note}</p>)}</div></div> : null}
      <div className="scm-done-actions">
        <button type="button" className="btn outline" onClick={() => { void navigator.clipboard?.writeText(outcome.sha); }}><Icon name="copy" extra="sm" />{tr("复制 SHA", "Copy SHA")}</button>
        <button type="button" className="btn outline" onClick={() => prepare()}><Icon name="refresh" extra="sm" />{tr("再挑一次", "Pick again")}</button>
        <button type="button" className="btn primary" onClick={reset}>{tr("完成", "Done")}</button>
      </div>
    </div>;
  } else if (step === "confirm" && frozen) {
    const patchView = <PatchPanel body={patch} zh={zh} title={tr("冻结补丁", "Frozen patch")} onLoad={() => loadPatch()} onMore={() => loadPatch(true)} />;
    body = <div className={`scm-confirm${wide ? " is-wide" : ""}`}>
      <div className="scm-confirm-main">
        <section className={`scm-frozen${frozenValid ? "" : " is-stale"}`} aria-label={tr("冻结预览", "Frozen preview")}>
          <div className="scm-frozen-head"><Icon name="lock" extra="sm" /><b>{frozenValid ? tr("预览已冻结", "Preview frozen") : tr("预览已失效", "Preview is stale")}</b><span className="spacer" /><span className="mono small">{tr("树", "tree")} {short(frozen.tree)}</span></div>
          <div className="scm-frozen-facts">
            <span><b>{frozen.paths.length}</b>{tr("个文件", " files")}</span>
            <span><b>{bytes(frozen.bytes)}</b>{tr("补丁", " patch")}</span>
            <span><b className="mono">{short(frozen.head)}</b>HEAD</span>
          </div>
          <ul className="scm-frozen-files">{frozen.paths.map(path => <li key={path} className="mono">{path}</li>)}</ul>
          {!frozenValid ? <p className="scm-warn">{frozenHeadDrifted ? tr("HEAD 已变化，请重新准备草稿后再提交。", "HEAD changed. Prepare a new draft before committing.") : tr("选择已变化，请重新冻结预览后再提交。", "The selection changed. Freeze a new preview before committing.")}</p> : null}
        </section>
        {externalRepoDrift ? <div className="scm-expired" role="alert"><Icon name="alert" extra="sm" /><span>{tr("仓库或工作区已在外部发生变化，当前冻结预览可能过期。", "The repository or worktree changed externally. This frozen preview may be stale.")}</span><button type="button" className="btn small outline" disabled={!!busy} onClick={() => prepare(draft.view.scope)}>{tr("重新准备", "Prepare again")}</button></div> : null}
        {!wide ? patchView : null}
        {instructions ? <div className="scm-instructions" role="note"><Icon name="message" extra="sm" /><div><b>{tr("/commit 附带的说明", "Notes passed to /commit")}</b><p>{instructions}</p>
          <button type="button" className="btn small outline" onClick={() => setMessageBody(current => current ? `${current}\n\n${instructions}` : instructions)}>{tr("加入正文", "Add to body")}</button></div></div> : null}
        <form className="scm-message" onSubmit={event => { event.preventDefault(); execute(); }}>
          <label className="scm-field"><span>{tr("标题", "Subject")}<em>*</em></span>
            <input className="input" value={subject} autoFocus onChange={event => setSubject(event.target.value)} placeholder={tr("例如：fix(changes): 保留聚焦的文件", "e.g. fix(changes): keep the focused file open")} />
          </label>
          <label className="scm-field"><span>{tr("正文", "Body")}</span>
            <textarea className="input" rows={3} value={messageBody} onChange={event => setMessageBody(event.target.value)} />
          </label>
          <label className="scm-field"><span>{tr("关联 Issue", "Fixes")}</span>
            <input className="input mono" value={fixes} onChange={event => setFixes(event.target.value)} placeholder="#42, ENG-118" />
          </label>
          <details className={`scm-danger${amend || noVerify ? " is-armed" : ""}`}>
            <summary><Icon name="chevron-r" extra="sm" />{tr("高级选项（谨慎）", "Advanced (use with care)")}{amend || noVerify ? <span className="chip red xs">{tr("已启用", "On")}</span> : null}</summary>
            <label className="scm-check"><input type="checkbox" checked={amend} onChange={event => setAmend(event.target.checked)} />
              <span><b>{tr("修订上一个提交（amend）", "Amend the previous commit")}</b><small>{tr(`会改写 ${short(frozen.head)}，已推送的提交请勿使用。`, `Rewrites ${short(frozen.head)}. Avoid on commits that were already pushed.`)}</small></span></label>
            <label className="scm-check"><input type="checkbox" checked={noVerify} onChange={event => setNoVerify(event.target.checked)} />
              <span><b>{tr("跳过 Git hooks（--no-verify）", "Skip Git hooks (--no-verify)")}</b><small>{tr("pre-commit 与 commit-msg 检查都不会运行。", "pre-commit and commit-msg checks will not run.")}</small></span></label>
          </details>
          {error ? <SelectiveCommitError message={error} zh={zh} onOpenSettings={onOpenSettings} /> : null}
          <div className="scm-foot">
            <button type="button" className="btn outline" disabled={busy === "execute"} onClick={() => { setStep("select"); setError(""); }}><Icon name="arrow-l" extra="sm" />{tr("返回修改", "Back")}</button>
            <span className="spacer" />
            <button type="submit" className={`btn ${amend ? "danger solid" : "primary"}`} disabled={!frozenValid || expired || !!busy || !subject.trim()}>
              {busy === "execute" ? <span className="spinner" aria-hidden="true" /> : <Icon name="commit" extra="sm" />}
              {amend ? tr("改写并提交", "Amend commit") : tr(`提交 ${frozen.paths.length} 个文件`, `Commit ${frozen.paths.length} files`)}
            </button>
          </div>
        </form>
      </div>
      {wide ? <div className="scm-side">{patchView}</div> : null}
    </div>;
  } else {
    const focusedPath = draft.view.paths.find(path => path.path === focused);
    body = <div className={`scm-pick${wide ? " is-wide" : ""}`}>
      <div className="scm-pick-main">
        {draft.view.agents.length ? <div className="scm-agents" aria-label={tr("参与的 Agent", "Agents involved")}>
          {draft.view.agents.map(agent => <span key={agent.id} className={`scm-agent${agent.id === draft.view.caller ? " is-caller" : ""}${agent.inScope ? "" : " is-out"}${agent.running ? " is-running" : ""}`}
            data-tip={[agent.id === draft.view.caller ? tr("发起者", "Caller") : "", agent.inScope ? tr("在范围内", "In scope") : tr("不在范围", "Out of scope"), agent.running ? tr("仍在运行，结果可能变化", "Still running; results may change") : ""].filter(Boolean).join(" · ")}>
            <DraftAgentAvatar id={agent.id} running={agent.running} />{agent.id}{agent.running ? <i className="scm-pulse" aria-hidden="true" /> : null}
          </span>)}
          {draft.view.scope.length ? <span className="scm-scope mono" data-tip={tr("草稿范围", "Draft scope")}><Icon name="filter" extra="sm" />{draft.view.scope.join(" ")}</span> : null}
        </div> : null}
        <div className="scm-toolbar">
          <span className="seg" role="tablist" aria-label={tr("按归属筛选", "Filter by ownership")}>
            {(["all", ...OWNERSHIP] as Filter[]).map(id => <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "active" : undefined} onClick={() => setFilter(id)}>
              {id === "all" ? tr("全部", "All") : ownerLabel(id)}<span className="scm-count">{counts.by[id]}</span>
            </button>)}
          </span>
          <form className="scm-only" onSubmit={event => { event.preventDefault(); const globs = onlyText.split(/[\s,，]+/u).filter(Boolean); if (globs.length) select({ action: "only", paths: globs }); }}>
            <input className="input mono" value={onlyText} onChange={event => setOnlyText(event.target.value)} placeholder="src/**" aria-label={tr("只保留匹配路径", "Keep only matching paths")} />
            <button type="submit" className="btn small outline" disabled={!onlyText.trim() || !!busy || expired} data-tip={tr("只缩小已有选择，不会新增选中项", "Narrows the current selection; never adds")}><Icon name="filter" extra="sm" />{tr("缩小", "Narrow")}</button>
          </form>
        </div>
        <ul className={`scm-paths${busy === "select" ? " is-busy" : ""}`} aria-label={tr("改动文件", "Changed files")}>
          {shown.length === 0 ? <li className="scm-paths-empty">{draft.view.paths.length ? tr("没有符合筛选的文件", "No files match this filter") : tr("没有可提交的改动", "Nothing to commit")}</li> : null}
          {shown.map(path => {
            const [dir, name] = splitPath(path.path);
            const lines = lineCounts(path);
            const open = expanded.has(path.path) && path.kind === "text";
            const whole = path.kind !== "text";
            return <li key={path.path} className={`scm-path${focused === path.path ? " is-focused" : ""}${path.selected === "none" ? " is-unpicked" : ""}`}>
              <div className="scm-path-row" onClick={() => openPath(path)}>
                <TriBox state={path.selected} disabled={!!busy || expired} label={tr(`选择 ${path.path}`, `Select ${path.path}`)} onToggle={() => togglePath(path)} />
                <button type="button" className="scm-path-toggle" aria-expanded={whole ? undefined : open} onClick={event => { event.stopPropagation(); openPath(path); }}>
                  <span className={`scm-change is-${path.change}`} data-tip={changeLabel(path.change)}>{changeMark(path.change)}</span>
                  <span className="scm-path-name"><span className="scm-dir">{dir}</span>{name}</span>
                  {whole ? <span className="chip gray xs" data-tip={tr("只能整项选择", "Selected as a whole")}>{kindLabel(path.kind)}</span> : null}
                  {path.kind === "mode" ? <span className="mono small muted">{path.beforeMode}→{path.afterMode}</span> : null}
                  {!whole ? <span className="scm-lines"><span className="add">+{lines.added}</span><span className="del">−{lines.removed}</span></span> : null}
                  {owners(path.ownership)}
                  {!whole ? <span className={`scm-chev${open ? " open" : ""}`} aria-hidden="true"><Icon name="chevron-r" extra="sm" /></span> : null}
                </button>
              </div>
              {open ? <div className="scm-hunks">
                {path.hunks.map(hunk => <HunkView key={hunk.id} hunk={hunk} path={path} busy={!!busy || expired} zh={zh} owners={owners} actorLabel={actorLabel} running={running} reasonText={reasonText} onToggle={toggleUnit} />)}
                {!wide ? <PatchPanel body={bodies[path.path]} zh={zh} title={tr("文件差异", "File diff")} onLoad={() => loadBody(path.path)} onMore={() => loadBody(path.path, true)} /> : null}
              </div> : null}
              {whole && focused === path.path && !wide ? <p className="scm-whole-note">{tr("该文件没有逐行差异，只能整项纳入或排除。", "This file has no line diff; include or exclude it as a whole.")}{path.hunks[0]?.units[0]?.reasons.map(reason => <span key={reasonText(reason)}> {reasonText(reason)}</span>)}</p> : null}
            </li>;
          })}
        </ul>
        {draft.view.staged.length || draft.view.skipped.length ? <div className="scm-extra">
          {draft.view.staged.length ? <p><Icon name="layers" extra="sm" /><span><b>{tr("暂存区已有内容", "Already staged")}</b>{tr("不属于本草稿，提交后保持原状：", "Not part of this draft; left as is: ")}<span className="mono">{draft.view.staged.join(", ")}</span></span></p> : null}
          {draft.view.skipped.length ? <p><Icon name="eye-off" extra="sm" /><span><b>{tr("已跳过", "Skipped")}</b><span className="mono">{draft.view.skipped.join(", ")}</span></span></p> : null}
        </div> : null}
        {draft.view.state !== "open" ? <p className="scm-warn">{draft.view.state === "busy" ? tr("草稿正被另一操作使用，稍后再试。", "The draft is busy with another operation.") : tr("草稿已被消费，请重新准备。", "This draft was consumed. Prepare a new one.")}</p> : null}
        {externalRepoDrift && !expired ? <div className="scm-expired" role="alert"><Icon name="alert" extra="sm" /><span>{tr("仓库或工作区已在外部发生变化，建议按最新工作区重新准备草稿。", "The repository or worktree changed externally. Prepare again from the latest worktree.")}</span><button type="button" className="btn small outline" disabled={!!busy} onClick={() => prepare(draft.view.scope)}>{tr("重新准备", "Prepare again")}</button></div> : null}
        {expired ? <div className="scm-expired" role="alert"><Icon name="clock" extra="sm" /><span>{tr("草稿已过期，选择需要按最新工作区重新准备。", "The draft expired. Prepare it again from the current worktree.")}</span><button type="button" className="btn small primary" onClick={() => prepare(draft.view.scope)}>{tr("重新准备", "Prepare again")}</button></div> : null}
        {error ? <SelectiveCommitError message={error} zh={zh} onOpenSettings={onOpenSettings} /> : null}
        <div className="scm-foot">
          <span className="scm-summary">{counts.chosen
            ? <>{tr(`已选 ${counts.chosen} 个文件`, `${counts.chosen} files picked`)}<span className="add">+{counts.added}</span><span className="del">−{counts.removed}</span></>
            : tr("尚未选择任何内容", "Nothing picked yet")}</span>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!counts.chosen || !!busy || expired || draft.view.state !== "open"} onClick={freeze}>
            {busy === "preview" ? <span className="spinner" aria-hidden="true" /> : <Icon name="lock" extra="sm" />}{tr("冻结预览", "Freeze preview")}<Icon name="arrow-r" extra="sm" />
          </button>
        </div>
      </div>
      {wide ? <div className="scm-side">{focusedPath
        ? focusedPath.kind === "text"
          ? <PatchPanel key={focusedPath.path} body={bodies[focusedPath.path]} zh={zh} title={focusedPath.path} onLoad={() => loadBody(focusedPath.path)} onMore={() => loadBody(focusedPath.path, true)} />
          : <div className="scm-side-empty"><Icon name="file" /><b>{kindLabel(focusedPath.kind)}</b><span>{tr("该文件没有逐行差异，只能整项纳入或排除。", "This file has no line diff; include or exclude it as a whole.")}</span></div>
        : <div className="scm-side-empty"><Icon name="diff" /><span>{tr("选择左侧文件查看差异", "Pick a file to read its diff")}</span></div>}</div> : null}
    </div>;
  }

  return <section ref={wideRef} className={`scm${wide ? " is-wide" : ""}`} aria-label={tr("选择性提交", "Selective commit")} aria-busy={busy !== undefined}>
    {header}
    <div className="scm-body" key={`${step}:${draft ? "draft" : "none"}`}>{body}</div>
  </section>;
}

function HunkView({ hunk, path, busy, zh, owners, actorLabel, running, reasonText, onToggle }: {
  hunk: SelectiveCommitHunk; path: SelectiveCommitPath; busy: boolean; zh: boolean;
  owners(list: readonly SelectiveCommitOwnership[]): ReactNode; actorLabel(actor: string | null): string; running(actor: string): boolean; reasonText(reason: SelectiveCommitReason): string;
  onToggle(path: SelectiveCommitPath, unit: SelectiveCommitUnit): void;
}) {
  return <div className="scm-hunk">
    <div className="scm-hunk-head mono">@@ −{hunk.headStart},{hunk.headCount} +{hunk.workStart},{hunk.workCount} @@</div>
    {hunk.units.map(entry => <div key={entry.id} className={`scm-unit${entry.selected === "none" ? " is-unpicked" : ""}`}>
      <TriBox state={entry.selected} disabled={busy} label={zh ? `选择片段 ${entry.id}` : `Select unit ${entry.id}`} onToggle={() => onToggle(path, entry)} />
      <span className="scm-unit-id mono">{entry.id}</span>
      <span className="scm-unit-actor">{entry.actor ? <DraftAgentAvatar id={entry.actor} running={running(entry.actor)} /> : <Icon name="user" extra="sm" />}{actorLabel(entry.actor)}</span>
      <span className="scm-lines"><span className="add">+{entry.added}</span><span className="del">−{entry.removed}</span></span>
      {owners(entry.ownership)}
      {entry.likely ? <span className="chip blue xs" data-tip={zh ? "Runtime 推测属于本会话" : "Runtime thinks this belongs to the session"}>{zh ? "推测" : "Likely"}</span> : null}
      {entry.reasons.filter(reason => reason.kind !== "hunk").map(reason => <span key={reasonText(reason)} className="scm-reason">{reasonText(reason)}</span>)}
    </div>)}
  </div>;
}

function PatchPanel({ body, zh, title, onLoad, onMore }: { body: Body | undefined; zh: boolean; title: string; onLoad(): void; onMore(): void }) {
  return <section className="scm-patch" aria-label={title}>
    <div className="diff-toolbar"><Icon name="file-code" extra="sm" /><span className="mono small ellipsis">{title}</span>
      {body && !body.loading && body.text !== null ? <span className="chip gray xs">{body.nextOffset === undefined ? `${body.totalChars.toLocaleString()} ${zh ? "字符" : "chars"}` : `${(body.text ?? "").length.toLocaleString()} / ${body.totalChars.toLocaleString()}`}</span> : null}
    </div>
    {!body ? <button type="button" className="scm-patch-load" onClick={onLoad}><Icon name="eye" extra="sm" />{zh ? "读取差异" : "Read diff"}</button>
      : body.error ? <p className="scm-warn" role="alert">{body.error}<button type="button" className="btn small outline" onClick={onLoad}>{zh ? "重试" : "Retry"}</button></p>
      : body.text === null && body.loading ? <div className="scm-patch-loading"><span className="spinner" aria-hidden="true" />{zh ? "读取中…" : "Reading…"}</div>
      : body.text === null ? <p className="scm-whole-note">{zh ? "该文件没有逐行差异，只能整项纳入或排除。" : "This file has no line diff; include or exclude it as a whole."}</p>
      : <>
        <div className="diff-scroll scm-patch-scroll">{body.text ? <GitPatch patch={body.text} split={false} /> : <div className="empty">{zh ? "空差异" : "Empty diff"}</div>}</div>
        {body.nextOffset !== undefined ? <button type="button" className="scm-patch-more" disabled={body.loading} onClick={onMore}>{body.loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevron-d" extra="sm" />}{zh ? "继续读取" : "Read more"}</button> : null}
      </>}
  </section>;
}

function SelectiveCommitError({ message, zh, onOpenSettings }: { message: string; zh: boolean; onOpenSettings?: (() => void) | undefined }) {
  const disabled = /commit\.enabled/u.test(message);
  return <div className="scm-error" role="alert"><Icon name="alert" extra="sm" /><span>{disabled ? (zh ? "原生提交功能已被设置 commit.enabled 关闭。" : "Native commit is turned off by the commit.enabled setting.") : message}</span>
    {disabled && onOpenSettings ? <button type="button" className="btn small outline" onClick={onOpenSettings}>{zh ? "打开设置" : "Open settings"}</button> : null}
  </div>;
}
