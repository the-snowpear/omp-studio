import { useRef } from "react";
import { useOptionalDock } from "../dock/DockContext";
import { ComputerPane } from "../browser/ComputerPane";
import type { ComputerPaneProps } from "./types";

/** A pinned panel retains its original scope. A changed client context never controls another session. */
export function ComputerDockPane(props: ComputerPaneProps) {
  const dock = useOptionalDock();
  const pinned = dock?.store.isPinned("computer") === true;
  const binding = useRef(props);
  const sameTarget = binding.current.executionTarget?.kind === props.executionTarget?.kind && binding.current.executionTarget?.id === props.executionTarget?.id;
  if (!pinned || binding.current.sessionId === props.sessionId && sameTarget) binding.current = props;
  const bound = binding.current;
  const matching = bound.sessionId === props.sessionId && bound.scopeKey === props.scopeKey;
  return <ComputerPane {...bound} visible={props.visible} width={props.width} height={props.height}
    available={props.available && matching} frameIntent={matching ? props.frameIntent : undefined}
    onRevealConversation={matching ? props.onRevealConversation : undefined}
    onRevealApproval={matching ? props.onRevealApproval : undefined} onOpenSettings={matching ? props.onOpenSettings : undefined} />;
}
