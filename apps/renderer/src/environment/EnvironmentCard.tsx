import { useCallback, useMemo } from "react";
import { useDockEngine } from "../dock/DockContext";
import type { PanelId } from "../dock/types";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { buildEnvironmentCard, type EnvironmentCardInput, type EnvironmentCardView } from "./environmentCardModel";
import "./environmentCard.css";

export type EnvironmentCardProps = EnvironmentCardInput & {
  readonly onOpenProject?: (() => void) | undefined;
  readonly onOpenGit?: (() => void) | undefined;
};

function Sync({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  return <span className="env-sync">
    {ahead > 0 ? <span data-tone="ahead">{`↑${ahead}`}</span> : null}
    {behind > 0 ? <span data-tone="behind">{`↓${behind}`}</span> : null}
  </span>;
}

/**
 * Environment / project / branch / changes as one nameplate.
 *
 * Project identity above a quiet runtime line and two Git shortcuts.
 * The diff meter follows the bottom edge of the content-sized card.
 *
 * The card owns no query — the workbench already holds the runtime connection,
 * the active workspace and the shared `git.repository.get` snapshot, so this is
 * a pure projection that the preview fixtures feed the same way.
 */
export function EnvironmentCard(props: EnvironmentCardProps) {
  const { target, runtimeStatus, version, project, repository, onOpenGit, onOpenProject } = props;
  const { t } = useI18n();
  const view: EnvironmentCardView = useMemo(
    () => buildEnvironmentCard({
      target,
      runtimeStatus,
      repository,
      ...(version === undefined ? {} : { version }),
      ...(project === undefined ? {} : { project }),
    }, t),
    [target, runtimeStatus, repository, version, project, t],
  );

  const openProject = view.project.empty ? undefined : onOpenProject;
  const openBranch = view.branch.pending || view.branch.empty ? undefined : onOpenGit;
  const openChanges = view.changes.actionable ? onOpenGit : undefined;
  const projectName = view.project.name;
  const branchName = view.branch.name;
  const changesLabel = view.changes.label;
  const dirty = view.changes.insertions > 0 || view.changes.deletions > 0;
  const projectBody = <>
    <span className="env-project-icon" aria-hidden="true"><Icon name="folder-open" /></span>
    <span className="env-project-copy">
      <span className="env-name">{projectName}</span>
      {view.project.address === undefined ? null : <span className="env-address">{view.project.address}</span>}
    </span>
  </>;

  const branchBody = <>
    <span className="env-glyph" aria-hidden="true"><Icon name="branch" /></span>
    <span className="env-value">
      {view.branch.pending
        ? <span className="env-skeleton" role="status" aria-label={t("environment.loading")} />
        : <span className={`env-text${view.branch.machine ? " is-machine" : ""}`}>{branchName}</span>}
    </span>
    <span className="env-meta">
      {view.branch.operation === undefined
        ? <Sync {...view.branch.sync} />
        : <span className="env-op">{view.branch.operation}</span>}
    </span>
  </>;

  const changesBody = <>
    <span className="env-glyph" aria-hidden="true"><Icon name="changes" /></span>
    <span className="env-value">
      {view.changes.pending
        ? <span className="env-skeleton" role="status" aria-label={t("environment.loading")} />
        : <span className="env-text">{changesLabel}</span>}
    </span>
    <span className="env-meta">
      {view.changes.insertions > 0 ? <span className="env-add">{`+${view.changes.insertions}`}</span> : null}
      {view.changes.deletions > 0 ? <span className="env-del">{`−${view.changes.deletions}`}</span> : null}
    </span>
  </>;

  return <div className="env-card">
    {openProject === undefined
      ? <div className={`env-hero${view.project.empty ? " is-empty" : ""}`}>
          {projectBody}
        </div>
      : <button type="button" className="env-hero is-action" onClick={openProject}
          {...(view.project.tip === undefined ? {} : { "data-tip": view.project.tip })}
          aria-label={`${projectName}${view.project.address === undefined ? "" : ` · ${view.project.address}`}`}>
          {projectBody}
        </button>}

    <div className="env-list">
      <div className="env-row is-env" {...(view.machine.tip === undefined ? {} : { "data-tip": view.machine.tip })}>
        <span className="env-glyph" data-state={view.machine.dot} aria-hidden="true"><Icon name="monitor" /></span>
        <span className="env-value"><span className="env-text">{view.machine.label}</span></span>
        <span className="env-meta">{view.version === undefined ? null : view.version}</span>
        {view.machine.tip === undefined ? null : <span className="sr-only">{view.machine.tip}</span>}
      </div>

      <div className="env-rule" aria-hidden="true" />

      {openBranch === undefined
        ? <div className={`env-row is-branch${view.branch.empty ? " is-empty" : ""}`}>{branchBody}</div>
        : <button type="button" className={`env-row is-branch is-action${view.branch.empty ? " is-empty" : ""}`} onClick={openBranch}
            {...(view.branch.tip === undefined ? {} : { "data-tip": view.branch.tip })}
            aria-label={`${t("environment.branch")} · ${branchName}${view.branch.tip === undefined ? "" : ` · ${view.branch.tip}`}`}>{branchBody}</button>}

      {openChanges === undefined
        ? <div className={`env-row is-changes${view.changes.empty ? " is-empty" : ""}`}>{changesBody}</div>
        : <button type="button" className={`env-row is-changes is-action${view.changes.empty ? " is-empty" : ""}`} onClick={openChanges}
            {...(view.changes.tip === undefined ? {} : { "data-tip": view.changes.tip })}
            aria-label={`${changesLabel}${view.changes.tip === undefined ? "" : ` · ${view.changes.tip}`}`}>{changesBody}</button>}
    </div>

    {dirty ? <div className="env-meter" aria-hidden="true">
      <i className="is-add" style={{ flexGrow: view.changes.insertions }} />
      <i className="is-del" style={{ flexGrow: view.changes.deletions }} />
    </div> : null}
  </div>;
}

/**
 * Dock wiring: both drill-downs are panel opens, so the card can do them
 * through the dock store instead of asking the workbench for callbacks.
 * Branch and changes share the Git panel — both describe the working tree, and
 * that panel is the surface that lists it.
 */
export function EnvironmentDockCard(props: EnvironmentCardProps) {
  const { store } = useDockEngine();
  const open = useCallback((panel: PanelId) => store.dispatch({ type: "open", panel }), [store]);
  return <EnvironmentCard {...props} onOpenProject={() => open("files")} onOpenGit={() => open("git")} />;
}
