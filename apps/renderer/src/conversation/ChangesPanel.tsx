import { useId, useState, type ReactNode } from "react";
import { GIT_STATUS_META, type TreeGitStatus } from "../git/treeStatus";
import { Icon } from "../icons";
import { splitDisplayPath } from "./toolMeta";
import { useI18n } from "../i18n";

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
  readonly hunks: readonly ChangesDiffHunk[];
};

export type ChangesTurnOption = {
  readonly id: string;
  readonly label: string;
  readonly add: number;
  readonly del: number;
};

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|css|scss|html?|json|md|py|rs|go|vue|svelte)$/i;

function fileIcon(path: string): "file-code" | "file" {
  return CODE_FILE.test(path) ? "file-code" : "file";
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

function DiffLine({ line, split }: { line: ChangesDiffLine; split: boolean }) {
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

function FileDiff({ file, split }: { file: ChangesDiffFile; split: boolean }) {
  const { t } = useI18n();
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  return (
    <div className={`ch-file-diff diff-scroll${split ? " diff-split" : ""}`}>
      <div className="ch-file-diff-inner">
        {file.truncated ? <span className="chip gray xs">{t("changes.truncated")}</span> : null}
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
  const { t } = useI18n();
  return (
    <>
      <div className="ch-toolbar">
        <TurnPicker turns={turns} turnId={turnId} onTurnChange={onTurnChange} />
        {demo === true ? <span className="chip gray xs">{t("common.demo")}</span> : null}
        <span className="spacer" />
        <span className="seg" role="radiogroup" aria-label={t("changes.diffDisplayMode")}>
          <button
            type="button"
            role="radio"
            aria-checked={!split}
            aria-label={t("changes.unifiedDiff")}
            data-tip={t("changes.unified")}
            className={split ? "" : "active"}
            onClick={() => onSplit(false)}
          >
            <Icon name="rows" extra="sm" />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={split}
            aria-label={t("changes.splitDiff")}
            data-tip={t("changes.split")}
            className={split ? "active" : ""}
            onClick={() => onSplit(true)}
          >
            <Icon name="columns" extra="sm" />
          </button>
        </span>
      </div>
      <div className="ch-list">
        {files.length === 0 ? empty : files.map((file) => {
          const open = expanded.has(file.file);
          const display = splitDisplayPath(file.file);
          return (
            <div key={file.file} className={`ch-item${open ? " open" : ""}`}>
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
                  <Icon name={fileIcon(file.file)} extra="sm" />
                </span>
                <span className="ch-file-meta">
                  <span className="ch-file-name">{display.name}</span>
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
      </div>
    </>
  );
}
