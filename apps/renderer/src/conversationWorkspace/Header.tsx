import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { SessionTitleRow } from "@omp-studio/studio-protocol";
import { AnnotationButton } from "../annotations/Annotations";
import { DockPopupButton } from "../dock/DockMenus";
import { DockRailToggle } from "../dock/DockRegions";
import { revealMainWindow } from "../dock/SurfaceContext";
import { SessionTitleMark } from "../history/SessionTitleMark";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { ConversationChromeSurface, useConversationView } from "./Context";
import type { ConversationTabInfo } from "./hosts";

type HeaderSource = { project: string; branch: string; path?: string | undefined; connection?: string | undefined };
export type ConversationHeaderStatus = NonNullable<ConversationTabInfo["status"]>;
type HeaderProps = {
  title: string;
  titleRow: SessionTitleRow | undefined;
  source: HeaderSource;
  status: ConversationHeaderStatus | undefined;
  /** Window mode: the top bar's breadcrumb and Fork/Handoff move into this title row. */
  windowed: boolean;
  projectMenu: (close: () => void) => ReactNode;
  branchMenu: (close: () => void) => ReactNode;
  threadActions: { disabled: boolean; reason: string; onFork: () => void; onHandoff: () => void };
  sessionMenu: (close: () => void) => ReactNode;
  tokenPanel: (close: () => void) => ReactNode;
  contextPanel: ReactNode;
  timeTravel?: ReactNode;
  onOpenTokenCounter: () => void;
  onDetailsChange: (details: "tokens" | "context" | null) => void;
};

function ConversationWindowTitle({ title, titleRow, source, status, windowed, projectMenu, branchMenu, threadActions, sessionMenu }: HeaderProps) {
  const { t, resolvedLanguage } = useI18n();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const sourceLabel = [source.project, source.connection, source.branch, source.path].filter(Boolean).join(" · ");
  const titleMenu = <DockPopupButton className="cw-window-title-menu" label={title} icon="message" draggable triggerContent={<>
    {titleRow?.state === "available" && titleRow.card ? <SessionTitleMark row={titleRow} title={title} /> : <Icon name="message" extra="sm" />}
    <span className="cw-window-title-text">{title}</span><Icon name="chevron-d" extra="sm" />
  </>}>{sessionMenu}</DockPopupButton>;
  const statusDot = status ? <span className={`cw-window-status ${status.tone}`} role="status" aria-label={status.label} data-tip={status.label}><span className="dot" /></span> : null;
  if (windowed) return <>
    <nav className="cw-window-crumb" aria-label={text("对话位置", "Conversation location")}>
      <DockPopupButton className="cw-crumb-button cw-crumb-project" label={text("项目", "Project")} icon="folder-open" triggerContent={<>
        <Icon name={source.connection ? "server" : "folder-open"} extra="sm" />
        <span className="cw-crumb-label" data-tip={sourceLabel}>{source.project}{source.connection ? ` · ${source.connection}` : ""}</span>
        <Icon name="chevron-d" extra="sm cw-crumb-chevron" />
      </>}>{projectMenu}</DockPopupButton>
      <span className="cw-crumb-sep" aria-hidden="true">›</span>
      <DockPopupButton className="cw-crumb-button cw-crumb-branch" label={text("分支", "Branch")} icon="branch" triggerContent={<>
        <Icon name="branch" extra="sm" /><span className="cw-crumb-label" data-tip={source.branch}>{source.branch}</span>
      </>}>{branchMenu}</DockPopupButton>
      <span className="cw-crumb-sep" aria-hidden="true">›</span>
      {titleMenu}
    </nav>
    <button type="button" className="dock-icon-button cw-window-thread-action" aria-label={t("shell.forkThread")} data-tip={threadActions.disabled ? threadActions.reason : t("shell.tipForkThread")}
      disabled={threadActions.disabled} onClick={threadActions.onFork}><Icon name="fork" extra="sm" /></button>
    <button type="button" className="dock-icon-button cw-window-thread-action" aria-label={t("shell.handoffThread")} data-tip={threadActions.disabled ? threadActions.reason : t("shell.tipHandoffThread")}
      disabled={threadActions.disabled} onClick={threadActions.onHandoff}><Icon name="handoff" extra="sm" /></button>
    {statusDot}
  </>;
  return <>
    {titleMenu}
    <span className="cw-window-source" data-tip={sourceLabel}>
      <DockPopupButton className="cw-window-source-menu" label={text("对话来源", "Conversation source")} icon="folder" popupRole="dialog" triggerContent={<><Icon name={source.connection ? "server" : "folder"} extra="sm" /><span>{source.project}{source.connection ? ` · ${source.connection}` : ""}</span></>}>
        {() => <dl className="cw-source-details"><dt>{text("项目", "Project")}</dt><dd>{source.project}</dd><dt>{text("连接", "Connection")}</dt><dd>{source.connection ?? text("此计算机", "This computer")}</dd><dt>{text("分支", "Branch")}</dt><dd>{source.branch}</dd>{source.path ? <><dt>{text("路径", "Path")}</dt><dd>{source.path}</dd></> : null}</dl>}
      </DockPopupButton>
    </span>
    {statusDot}
  </>;
}

function ConversationWindowActions({ tokenPanel, contextPanel, onOpenTokenCounter, onDetailsChange, timeTravel }: HeaderProps) {
  const conversation = useConversationView()!;
  const { t, resolvedLanguage } = useI18n();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const [details, setDetails] = useState<"tokens" | "context" | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { onDetailsChange(open ? details : null); }, [open, details, onDetailsChange]);
  const closeLabel = text("对话窗口选项", "Conversation window options");
  return <>{timeTravel}<DockRailToggle />
    <DockPopupButton className="cw-window-more" label={details === "tokens" ? t("shell.tokenUsageDetails") : details === "context" ? t("shell.contextCompositionDetails") : closeLabel} icon="more" popupRole={details ? "dialog" : "menu"} popupClassName={details === "tokens" ? "cw-window-details tok-pop" : details === "context" ? "cw-window-details telemetry-pop ctx-pop" : ""} onOpen={() => setDetails(null)} onOpenChange={setOpen}>
      {close => details === "tokens" ? tokenPanel(close) : details === "context" ? contextPanel : <>
        <AnnotationButton menu onActivate={close} />
        <MenuItem icon="chart" onClick={() => setDetails("tokens")}>{t("shell.tokenUsageDetails")}</MenuItem>
        <MenuItem icon="layers" onClick={() => setDetails("context")}>{t("shell.contextCompositionDetails")}</MenuItem>
        <MenuItem icon="code" onClick={() => { close(); onOpenTokenCounter(); }}>{text("离线 Token 计数", "Offline token counter")}</MenuItem>
        <div className="menu-sep" />
        <MenuItem icon="restore" onClick={() => { close(); if (conversation.view?.placement === "native" && !revealMainWindow(true)) return; if (conversation.view) conversation.store.dock(conversation.view.id); }}>{text("收回对话区", "Return to conversation area")}</MenuItem>
      </>}
    </DockPopupButton>
  </>;
}

export function ConversationFloatingHeader(props: HeaderProps) {
  const view = useConversationView();
  const { title, titleRow, status } = props;
  // The window-mode tab bar lives outside this conversation's tree; hand it what the tab shows.
  useLayoutEffect(() => { view?.store.hosts.setTab(view.document.id, { title, titleRow, status }); }, [view?.store, view?.document.id, title, titleRow, status?.tone, status?.label]);
  if (!view) return null;
  return <ConversationChromeSurface title={<ConversationWindowTitle {...props} />} actions={<ConversationWindowActions {...props} />} />;
}
