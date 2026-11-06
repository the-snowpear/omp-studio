import type { ReactNode } from "react";
import type { CommandStatus } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { LedgerCommandRow } from "./types";
import "./panels.css";

const clockCache = new Map<string, string>();
const pad = (value: number) => String(value).padStart(2, "0");

/** `MM-DD HH:MM:SS` in local time; the raw stamp stays in the cell tooltip. */
function ledgerClock(iso: string): string {
  const cached = clockCache.get(iso);
  if (cached !== undefined) return cached;
  let text = iso;
  const parsed = Date.parse(iso);
  if (Number.isFinite(parsed)) {
    const at = new Date(parsed);
    text = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  }
  if (clockCache.size > 512) clockCache.clear();
  clockCache.set(iso, text);
  return text;
}

/**
 * Status is the scan target of this ledger, so it leads the row: tone dot for
 * the eye, contract word for the reader. `completed` is the only quiet success;
 * `outcome_unknown` is amber because it needs a second look, not a retry.
 */
function statusTone(status: CommandStatus): "ok" | "alert" | "warn" | "live" {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "rejected") return "alert";
  if (status === "outcome_unknown" || status === "interaction_required") return "warn";
  return "live";
}

function CommandRow({ row }: { row: LedgerCommandRow }) {
  return (
    <div className="dock-row" role="row">
      <span className="dock-cell dock-cell-time" role="cell" {...(row.at ? { "data-tip": row.at } : {})}>
        {row.at ? ledgerClock(row.at) : "—"}
      </span>
      <span className="dock-cell dock-cell-status" role="cell">
        <span className="dock-tone" data-tone={statusTone(row.status)} aria-hidden="true" />
        <span className="dock-status">{row.status.replaceAll("_", " ")}</span>
      </span>
      {/* The detail is clipped in narrow panels, so it rides the tip instead. */}
      <span className="dock-cell dock-cell-name" role="cell" {...(row.detail ? { "data-tip": row.detail } : {})}>
        <span className="dock-command">{row.commandName}</span>
        {row.detail ? <span className="dock-detail">· {row.detail}</span> : null}
      </span>
    </div>
  );
}

/**
 * Output: the semantic command ledger for this surface.
 *
 * The ledger owns the panel body; capability-gated operator controls are a
 * disclosure underneath it rather than a second dashboard crammed into the
 * same scroll area (they used to be squeezed to a few dozen pixels here).
 */
export function OutputPanel({ commands, preview = false, operator }: {
  readonly commands: readonly LedgerCommandRow[];
  readonly preview?: boolean;
  /** Operator controls, passed in by the shell that owns the capability wiring. */
  readonly operator?: ReactNode;
}) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const title = t("shell.outputTitle");
  return (
    <div className="dock-doc">
      <header className="dock-doc-mast">
        <h2 className="dock-doc-title">{title}</h2>
        <span className="dock-doc-rule" aria-hidden="true" />
        <p className="dock-doc-sub">{t("shell.outputDesc")}</p>
        {preview && marks ? <span className="dock-badge-demo">{t("common.demo")}</span> : null}
        <span className="dock-metric"><b>{commands.length}</b>{t("shell.commandsUnit")}</span>
      </header>
      <div className="dock-doc-scroll">
        {commands.length ? (
          <div className="dock-ledger dock-ledger--commands" role="table" aria-label={title}>
            <div className="dock-ledger-head" role="row">
              <span className="dock-cell dock-cell-time" role="columnheader">{t("shell.ledgerTime")}</span>
              <span className="dock-cell" role="columnheader">{t("shell.ledgerStatus")}</span>
              <span className="dock-cell" role="columnheader">{t("shell.ledgerCommand")}</span>
            </div>
            <div role="rowgroup">
              {commands.map(row => <CommandRow key={row.requestId} row={row} />)}
            </div>
          </div>
        ) : (
          <div className="dock-doc-fill">
            <div className="dock-empty">
              <Icon name="console" />
              <strong>{t("shell.outputEmptyTitle")}</strong>
              <span>{t("shell.outputEmptyDetail")}</span>
            </div>
          </div>
        )}
        {operator ? (
          <details className="dock-console">
            <summary>
              <Icon name="chevron-r" extra="sm" />
              {t("shell.operatorConsole")}
              {preview && marks ? <span className="dock-badge-demo">{t("common.demo")}</span> : null}
              <span className="dock-console-hint">{t("shell.operatorConsoleHint")}</span>
            </summary>
            <div className="dock-console-body">{operator}</div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
