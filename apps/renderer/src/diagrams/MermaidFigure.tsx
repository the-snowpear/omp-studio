import { useOptionalDock } from "../dock/DockContext";
import { useConversationView } from "../conversationWorkspace/Context";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { openDiagram } from "./diagramWindows";
import "./diagrams.css";

export function MermaidFigure({ code, svg }: { code: string; svg: string }) {
  const dock = useOptionalDock(), view = useConversationView(), { t } = useI18n();
  return <figure className="mermaid-figure">
    <div className="mermaid-figure-head">
      <span>Mermaid</span>
      {dock ? <button type="button" className="icon-btn" aria-label={t("diagrams.open")} data-tip={t("diagrams.open")}
        onClick={() => openDiagram(dock.store, code, svg, view?.store.nextWindowRect({ width: 900, height: 680 }))}>
        <Icon name="expand" />
      </button> : null}
    </div>
    <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />
  </figure>;
}
