import { useConversationDom } from "../conversationWorkspace/Context";
import { modelConfigHasUnsavedChanges } from "../models/modelConfigState";
import type { ReactNode } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { StartupNotice } from "../StartupNotice";
import { PreviewSwitch } from "../preview/surfaces";

export function Titlebar({
  canBack,
  canForward,
  onBack,
  onForward,
  onToggleSidebar,
  sidebarCollapsed,
  menus,
}: {
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  menus?: ReactNode;
}) {
  const { window } = useConversationDom();
  const { t } = useI18n();
  const previewMode = usePreviewMode();
  return (
    <header className="app-titlebar">
      <button
        className="icon-btn"
        data-tip={sidebarCollapsed ? t("common.expand") : t("common.collapse")}
        aria-label={sidebarCollapsed ? t("menu.expandSidebar") : t("menu.collapseSidebar")}
        aria-controls="sidebar"
        data-dock-entry="left"
        aria-expanded={sidebarCollapsed === false}
        disabled={!onToggleSidebar}
        onClick={onToggleSidebar}
      >
        <Icon name="layout" />
      </button>
      <button className="icon-btn" data-tip={t("common.back")} aria-label={t("common.back")} disabled={!canBack} onClick={onBack}>
        <Icon name="arrow-l" />
      </button>
      <button className="icon-btn" data-tip={t("common.forward")} aria-label={t("common.forward")} disabled={!canForward} onClick={onForward}>
        <Icon name="arrow-r" />
      </button>
      <nav className="title-menus" aria-label={t("nav.menu")}>{menus}</nav>
      <div className="titlebar-end">
        <PreviewSwitch
          enabled={previewMode.enabled}
          preview={previewMode.preview}
          onToggle={() => {
            if (modelConfigHasUnsavedChanges() && !window.confirm(t("shell.unsavedModelConfigConfirm"))) return;
            previewMode.setPreview(!previewMode.preview);
          }}
        />
      </div>
    </header>
  );
}

export function Unavailable() {
  return (
    <PreviewModeProvider>
      <div className="app">
        <Titlebar />
        <div className="main-col">
          <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
            <Icon name="alert" extra="lg" />
            <h1>Studio client unavailable</h1>
            <p className="muted">Inject a StudioClient through the desktop shell or WebUI bridge.</p>
          </div>
        </div>
      </div>
      <StartupNotice />
    </PreviewModeProvider>
  );
}
