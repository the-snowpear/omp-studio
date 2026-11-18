import { useRef, type RefObject } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";

export type PlanCreatedLink = {
  readonly title?: string;
  readonly body?: string;
  readonly demo?: boolean;
  /** Review / preview gallery: pin the card on the last assistant row even without `xd://propose`. */
  readonly attachEvenWithoutPropose?: boolean;
  readonly onOpen: (origin: HTMLElement, doc?: { readonly title: string; readonly body: string }) => void;
};

export function PlanCreatedCard({
  title,
  demo,
  toolCallId,
  cardRef,
  onOpen,
}: {
  title: string;
  demo?: boolean;
  toolCallId?: string;
  cardRef?: RefObject<HTMLButtonElement | null>;
  onOpen: (origin: HTMLElement) => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const localRef = useRef<HTMLButtonElement>(null);
  const { marks } = usePreviewMode();
  const originRef = cardRef ?? localRef;
  return (
    <button
      ref={originRef}
      type="button"
      className="plan-created"
      {...(toolCallId === undefined ? {} : { "data-tool-call-id": toolCallId })}
      aria-label={zh ? `打开计划：${title}` : `Open plan: ${title}`}
      onClick={() => {
        const origin = originRef.current;
        if (origin) onOpen(origin);
      }}
    >
      <span className="plan-created-copy">
        <span className="plan-created-label">{zh ? "已创建计划" : "Plan created"}</span>
        <span className="plan-created-title">{title}</span>
      </span>
      {demo === true && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      <Icon name="chevron-r" extra="sm plan-created-chev" />
    </button>
  );
}
