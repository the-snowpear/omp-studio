import { useId, useSyncExternalStore } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { ConversationWorkspaceStore } from "./store";
import "./workspaceEmpty.css";

export function WorkspaceEmpty({ store }: { store: ConversationWorkspaceStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const focus = useSyncExternalStore(store.windows.subscribe, store.windows.getSnapshot);
  const { resolvedLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const titleId = useId();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const views = store.recentViews();
  const current = views.find(view => view.documentId === focus.ownerId) ?? views[0];
  const owner = state.documents.find(document => document.id === (current?.documentId ?? state.activeDocumentId));
  const create = () => { store.openNewWindow(owner); };
  return <section className="cw-idle" aria-labelledby={titleId}>
    <div className="cw-idle-inner">
      <div className="cw-idle-art" aria-hidden="true">
        <div className="cw-idle-window cw-idle-window-back"><span /><i /><i /></div>
        <div className="cw-idle-window cw-idle-window-front">
          <div className="cw-idle-window-bar"><Icon name="message" /><span /><i /></div>
          <div className="cw-idle-window-lines"><span /><span /><span /></div>
          <div className="cw-idle-window-input"><i /><Icon name="arrow-u" /></div>
        </div>
        <div className="cw-idle-art-corner" />
      </div>
      <div className="cw-idle-heading">
        <span className="cw-idle-eyebrow">OMP STUDIO{preview && marks ? <span>{text("演示", "Preview")}</span> : null}</span>
        <h1 id={titleId}>{text("对话工作区", "Conversation workspace")}</h1>
        <p>{text("从左侧选择对话，在独立窗口中继续。", "Choose a conversation in the sidebar to open its own window.")}</p>
      </div>
      <div className="cw-idle-actions">
        <button type="button" className="btn primary cw-idle-create" onClick={create}><Icon name="plus" />{text("新建对话窗口", "New conversation window")}</button>
        {current ? <button type="button" className="btn ghost" onClick={() => store.dock(current.id)}><Icon name="layout" />{text("收回当前对话", "Bring conversation back")}</button> : null}
      </div>
      {views.length ? <div className="cw-idle-recent">
        <div className="cw-idle-recent-heading"><span>{text("已打开的对话", "Open conversations")}</span><span>{String(views.length).padStart(2, "0")}</span></div>
        <ul>{views.slice(0, 3).map(view => {
          const document = state.documents.find(document => document.id === view.documentId)!;
          const status = view.minimized ? text("已最小化", "Minimized") : view.placement === "native" ? text("独立窗口", "Desktop window") : view.placement === "docked" ? text("已停靠", "Docked") : text("浮窗", "Floating");
          return <li key={view.id}><button type="button" className="cw-idle-conversation" onClick={() => store.focus(view.id)}>
            <span className="cw-idle-conversation-icon"><Icon name={view.placement === "native" ? "external" : "message"} /></span>
            <span className="cw-idle-conversation-copy"><strong>{document.title}</strong><small>{[document.projectName, status].filter(Boolean).join(" · ")}</small></span>
            <Icon name="arrow-r" extra="cw-idle-reveal" />
          </button></li>;
        })}</ul>
      </div> : null}
      <p className="cw-idle-hint"><Icon name="columns" />{text("拖到边缘，即可并排。", "Drag windows to an edge to arrange them side by side.")}</p>
    </div>
  </section>;
}
