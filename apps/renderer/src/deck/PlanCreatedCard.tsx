import { useRef, type RefObject } from "react";
import { Icon } from "../icons";

export type PlanCreatedLink = {
  readonly title?: string;
  readonly demo?: boolean;
  /** Review / preview gallery: pin the card on the last assistant row even without `xd://propose`. */
  readonly attachEvenWithoutPropose?: boolean;
  readonly onOpen: (origin: HTMLElement) => void;
};

export function PlanCreatedCard({
  title,
  demo,
  cardRef,
  onOpen,
}: {
  title: string;
  demo?: boolean;
  cardRef?: RefObject<HTMLButtonElement | null>;
  onOpen: (origin: HTMLElement) => void;
}) {
  const localRef = useRef<HTMLButtonElement>(null);
  const originRef = cardRef ?? localRef;
  return (
    <button
      ref={originRef}
      type="button"
      className="plan-created"
      aria-label={`打开计划：${title}`}
      onClick={() => {
        const origin = originRef.current;
        if (origin) onOpen(origin);
      }}
    >
      <span className="plan-created-copy">
        <span className="plan-created-label">已创建计划</span>
        <span className="plan-created-title">{title}</span>
      </span>
      {demo === true ? <span className="chip gray xs">演示</span> : null}
      <Icon name="chevron-r" extra="sm plan-created-chev" />
    </button>
  );
}
