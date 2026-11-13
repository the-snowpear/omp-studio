import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { GIT_STATUS_META, type TreeGitStatus } from "../git/treeStatus";
import { Icon } from "../icons";
import { fileTypeOf, iconNameFor, isSensitive } from "../explorer-types";
import { splitDisplayPath } from "./toolMeta";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useWideLayout } from "../layout/useWideLayout";

/** From this body width the panel reads like a review page: file list beside one file's diff. */
const CHANGES_WIDE_MIN = 820;

export type ChangesDiffLine =
  | { readonly kind: "row"; readonly mark: "+" | "-" | " "; readonly oldLn: string; readonly newLn: string; readonly text: string }
  | { readonly kind: "collapse"; readonly label: string };

export type ChangesDiffHunk = {
  readonly hunkLabel: string;
  readonly lines: readonly ChangesDiffLine[];
};

export type ChangesDiffFile = {
  readonly file: string;
  readonly add: number;
  readonly del: number;
  readonly truncated?: boolean;
  /** Only this confirmed-applied file is listed; its tool call also had unapplied work. */
  readonly partial?: boolean;
  readonly hunks: readonly ChangesDiffHunk[];
};

export type ChangesTurnOption = {
  readonly id: string;
  readonly label: string;
  readonly add: number;
  readonly del: number;
};

function PartialEditBadge() {
  const { resolvedLanguage } = useI18n();
  return <span className="ch-partial-tag"><Icon name="alert-c" extra="sm" />{resolvedLanguage === "zh" ? "部分编辑" : "Partial edit"}</span>;
}

export function FileStat({ status }: { status: TreeGitStatus | undefined }) {
  if (!status) return null;
  const meta = GIT_STATUS_META[status];
  return (
    <span className={`fstat ${meta.className}`}>
      <span aria-hidden="true">{meta.letter}</span>
      <span className="sr-only"> {meta.label}</span>
    </span>
  );
}

export function ChangeDelta({ add, del }: { add: number; del: number }) {
  const { t } = useI18n();
  if (add === 0 && del === 0) return null;
  return (
    <span className="ch-delta">
      {add > 0 ? <span className="ch-add">+{add}<span className="sr-only">{t("changes.linesAdded")}</span></span> : null}
      {del > 0 ? <span className="ch-del">−{del}<span className="sr-only">{t("changes.linesDeleted")}</span></span> : null}
    </span>
  );
}

export function DiffLine({ line, split }: { line: ChangesDiffLine; split: boolean }) {
  if (line.kind === "collapse") {
    return <div className="dl collapse"><Icon name="chevron-ud" extra="sm" /> {line.label}</div>;
  }
  const cls = line.mark === "+" ? "add" : line.mark === "-" ? "del" : "";
  const mark = line.mark === "+" ? "+" : line.mark === "-" ? "−" : " ";
  if (split) {
    const left = line.mark !== "+"
      ? <div className="half"><span className="ln">{line.oldLn}</span><span className="lc">{line.text}</span></div>
      : <div className="half"><span className="ln" /><span className="lc" /></div>;
    const right = line.mark !== "-"
      ? <div className="half"><span className="ln">{line.newLn}</span><span className="lc">{line.text}</span></div>
      : <div className="half"><span className="ln" /><span className="lc" /></div>;
    return <div className={`dl ${cls}`}>{left}{right}</div>;
  }
  return (
    <div className={`dl ${cls}`}>
      <span className="ln">{line.oldLn}</span>
      <span className="ln">{line.newLn}</span>
      <span className="dm" aria-hidden="true">{mark}</span>
      <span className="lc">{line.text}</span>
    </div>
  );
}

export function DiffDisplayMode({ split, onSplit }: { split: boolean; onSplit: (next: boolean) => void }) {
  const { t } = useI18n();
  return <span className="seg" role="radiogroup" aria-label={t("changes.diffDisplayMode")}>
    <button type="button" role="radio" aria-checked={!split} aria-label={t("changes.unifiedDiff")} data-tip={t("changes.unified")} className={split ? "" : "active"} onClick={() => onSplit(false)}>
      <Icon name="rows" extra="sm" />
    </button>
    <button type="button" role="radio" aria-checked={split} aria-label={t("changes.splitDiff")} data-tip={t("changes.split")} className={split ? "active" : ""} onClick={() => onSplit(true)}>
      <Icon name="columns" extra="sm" />
    </button>
  </span>;
}

/** `bare`: the wide detail pane shows the truncation chip in its own header. */
function FileDiff({ file, split, bare = false }: { file: ChangesDiffFile; split: boolean; bare?: boolean }) {
  const { t } = useI18n();
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  return (
    <div className={`ch-file-diff diff-scroll${split ? " diff-split" : ""}`}>
      <div className="ch-file-diff-inner">
        {file.truncated && !bare ? <span className="chip gray xs">{t("changes.truncated")}</span> : null}
        {lines.length === 0 ? (
          <div className="ch-file-diff-empty">{t("changes.noDiffToShow")}</div>
        ) : (
          file.hunks.map((hunk, hunkIndex) => (
            <div className="ch-file-hunk" key={`${file.file}-${hunkIndex}`}>
              <div className="diff-head-row">{hunk.hunkLabel}</div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLine
                  key={`${file.file}-${hunkIndex}-${lineIndex}`}
                  line={line}
                  split={split}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TurnPicker({
  turns,
  turnId,
  onTurnChange,
}: {
  turns: readonly ChangesTurnOption[];
  turnId: string;
  onTurnChange: (id: string) => void;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const active = turns.find((turn) => turn.id === turnId) ?? turns[0];
  const formatLabel = (turn?: ChangesTurnOption) => {
    if (!turn) return t("changes.latestTurn");
    if (turn.id === "last") return t("changes.latestTurn");
    if (turn.id === "session") return t("changes.entireSession");
    return turn.label;
  };
  return (
    <div className={`ch-turn${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="ch-turn-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("changes.selectTurn")}
        disabled={turns.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="branch" extra="sm" />
        <span className="ch-turn-label ellipsis">{formatLabel(active)}</span>
        {active ? <ChangeDelta add={active.add} del={active.del} /> : null}
        <Icon name="chevron-d" extra="sm" />
      </button>
      {open ? (
        <>
          <button type="button" className="ch-turn-backdrop" aria-label={t("changes.closeTurnsMenu")} onClick={() => setOpen(false)} />
          <div className="menu ch-turn-menu" id={menuId} role="menu" aria-label={t("changes.turnsMenu")}>
            {turns.map((turn) => (
              <button
                key={turn.id}
                type="button"
                className="menu-item"
                role="menuitem"
                aria-current={turn.id === (active?.id ?? turnId) ? "true" : undefined}
                onClick={() => {
                  onTurnChange(turn.id);
                  setOpen(false);
                }}
              >
                <span>{formatLabel(turn)}</span>
                <ChangeDelta add={turn.add} del={turn.del} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ChangesPanel({
  turns,
  turnId,
  onTurnChange,
  demo,
  files,
  expanded,
  onToggle,
  split,
  onSplit,
  empty,
}: {
  turns: readonly ChangesTurnOption[];
  turnId: string;
  onTurnChange: (id: string) => void;
  demo?: boolean;
  files: readonly ChangesDiffFile[];
  expanded: ReadonlySet<string>;
  onToggle: (file: string) => void;
  split: boolean;
  onSplit: (next: boolean) => void;
  empty?: ReactNode;
}) {
  const { t, resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const [rootRef, wide] = useWideLayout<HTMLDivElement>(CHANGES_WIDE_MIN);
  return (
    <div className={`changes-panel${wide ? " is-wide" : ""}`} ref={rootRef}>
      <div className="ch-toolbar">
        <TurnPicker turns={turns} turnId={turnId} onTurnChange={onTurnChange} />
        {demo === true && marks ? <span className="chip gray xs">{t("common.demo")}</span> : null}
        <span className="spacer" />
        {wide && files.length > 0 ? <span className="ch-toolbar-summary">{t("changes.fileCount", { count: files.length })}</span> : null}
        <DiffDisplayMode split={split} onSplit={onSplit} />
      </div>
      {files.some(file => file.partial) ? <div className="ch-partial-notice" role="alert">
        <Icon name="alert-c" extra="sm" />
        <span>{resolvedLanguage === "zh"
          ? "部分编辑未完整应用。这里只审核原生结果确认已落盘的文件与差异，未应用的部分不计入统计。"
          : "An edit did not apply completely. Only files and diffs confirmed applied by the native result are reviewed here; unapplied work is excluded from the totals."}</span>
      </div> : null}
      {wide && files.length > 0 ? <ChangesBrowser files={files} expanded={expanded} split={split} /> : <div className="ch-list">
        {files.length === 0 ? empty : files.map((file) => {
          const open = expanded.has(file.file);
          const display = splitDisplayPath(file.file);
          // 类型判定必须吃 basename：`config/.env` 走完整路径会落空，
          // `docs/README.md` 也拿不到「书」这个旗舰形。
          const ftype = fileTypeOf(display.name);
          return (
            <div
              key={file.file}
              className={`ch-item${open ? " open" : ""}`}
              data-ftype={ftype ?? undefined}
              data-secret={isSensitive(display.name) || undefined}
            >
              <button
                type="button"
                className="ch-row"
                aria-expanded={open}
                aria-label={open ? t("changes.collapseChanges", { file: file.file }) : t("changes.expandChanges", { file: file.file })}
                data-tip={file.file}
                onClick={() => onToggle(file.file)}
              >
                <Icon name="chevron-r" extra="sm ch-row-chev" />
                <span className="ch-row-icon" aria-hidden="true">
                  <Icon name={iconNameFor(ftype, display.name)} extra="sm" />
                </span>
                <span className="ch-file-meta">
                  <span className="ch-file-name">{display.name}</span>
                  {file.partial ? <PartialEditBadge /> : null}
                  {display.dir ? <span className="ch-file-dir">{display.dir}</span> : null}
                </span>
                <ChangeDelta add={file.add} del={file.del} />
              </button>
              {open ? (
                <div className="ch-file-diff-wrap">
                  <FileDiff file={file} split={split} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>}
    </div>
  );
}

/**
 * Wide layout: every changed file in a list, the selected one's whole diff beside it.
 * Selection is local to this view; a focus request from the conversation ("审核")
 * arrives as a one-file `expanded` set and moves the selection to that file.
 */
function ChangesBrowser({ files, expanded, split }: { files: readonly ChangesDiffFile[]; expanded: ReadonlySet<string>; split: boolean }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const focused = files.find((file) => expanded.has(file.file))?.file;
  useEffect(() => { if (focused !== undefined) setPicked(focused); }, [expanded, focused]);
  const found = files.findIndex((file) => file.file === picked);
  const index = found < 0 ? 0 : found;
  const selected = files[index]!;
  const select = (next: number, focus: boolean) => {
    const file = files[Math.max(0, Math.min(files.length - 1, next))];
    if (!file) return;
    setPicked(file.file);
    if (focus) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(file.file)}"]`)?.focus({ preventScroll: false }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (step) { event.preventDefault(); select(index + step, true); return; }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); select(event.key === "Home" ? 0 : files.length - 1, true); }
  };
  const display = splitDisplayPath(selected.file);
  const ftype = fileTypeOf(display.name);
  return (
    <div className="ch-browser">
      <div className="ch-browser-list" role="listbox" aria-label={t("changes.fileList")} ref={listRef} onKeyDown={onKeyDown}>
        {files.map((file, position) => {
          const row = splitDisplayPath(file.file);
          const rowType = fileTypeOf(row.name);
          const active = position === index;
          return (
            <button
              key={file.file}
              type="button"
              role="option"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-file={file.file}
              data-tip={file.file}
              className={`ch-browser-row${active ? " is-active" : ""}`}
              data-ftype={rowType ?? undefined}
              data-secret={isSensitive(row.name) || undefined}
              onClick={() => select(position, false)}
            >
              <span className="ch-row-icon" aria-hidden="true"><Icon name={iconNameFor(rowType, row.name)} extra="sm" /></span>
              <span className="ch-browser-copy">
                <span className="ch-browser-name">{row.name}</span>
                {file.partial ? <PartialEditBadge /> : null}
                {row.dir ? <span className="ch-browser-dir">{row.dir}</span> : null}
              </span>
              <ChangeDelta add={file.add} del={file.del} />
            </button>
          );
        })}
      </div>
      <section className="ch-browser-detail" aria-label={selected.file} data-ftype={ftype ?? undefined} data-secret={isSensitive(display.name) || undefined}>
        <header className="ch-detail-head">
          <span className="ch-row-icon" aria-hidden="true"><Icon name={iconNameFor(ftype, display.name)} /></span>
          <span className="ch-detail-title">
            <span className="ch-detail-name">{display.name}</span>
            {display.dir ? <span className="ch-detail-dir">{display.dir}</span> : null}
          </span>
          <ChangeDelta add={selected.add} del={selected.del} />
          {selected.partial ? <PartialEditBadge /> : null}
          {selected.truncated ? <span className="chip gray xs">{t("changes.truncated")}</span> : null}
          <span className="spacer" />
          {files.length > 1 ? <span className="ch-detail-nav">
            <span className="ch-detail-position">{index + 1} / {files.length}</span>
            <button type="button" className="icon-btn small" aria-label={t("changes.previousFile")} data-tip={t("changes.previousFile")} disabled={index === 0} onClick={() => select(index - 1, false)}><Icon name="chevron-u" extra="sm" /></button>
            <button type="button" className="icon-btn small" aria-label={t("changes.nextFile")} data-tip={t("changes.nextFile")} disabled={index === files.length - 1} onClick={() => select(index + 1, false)}><Icon name="chevron-d" extra="sm" /></button>
          </span> : null}
        </header>
        <FileDiff key={selected.file} file={selected} split={split} bare />
      </section>
    </div>
  );
}
