import type { PointerEvent } from "react";
import { dragConversation } from "../conversationWorkspace/drag";
import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import type { DockRect } from "../dock/types";
import type { CapsuleOrigin, ComposerDropTarget } from "./composerDrop";
import { dragCapsuleOnly } from "./capsuleGhost";
import { dragFile } from "../files/fileDrag";

/**
 * A capsule grabbed inside the input box. Inside a box it reorders or moves;
 * outside, a conversation becomes its window again and a file opens floating
 * where it is dropped. Either way it then leaves the input box.
 */
export function dragComposerCapsule(event: PointerEvent<HTMLElement>, element: HTMLElement, target: ComposerDropTarget, context: {
  store: ConversationWorkspaceStore | null | undefined;
  zh: boolean;
  openFile?: ((path: string, rect: DockRect, onOpened?: () => void) => void) | undefined;
}) {
  const chip = target.chipOf(element);
  if (!chip) return;
  const origin: CapsuleOrigin = { element, chipId: chip.id, target };
  const { store, openFile, zh } = context;
  const fileScope = chip.path ? target.fileScope : undefined;
  if (chip.kind === "session" && chip.sessionReference && store) {
    dragConversation(event, store, { reference: chip.sessionReference, title: chip.label, capsule: origin }, zh);
    return;
  }
  if (chip.kind === "file" && chip.path && store && openFile) {
    const path = chip.path;
    dragFile(event, store, { chip, open: (rect, onOpened) => openFile(path, rect, onOpened), capsule: origin, fileScope, zh });
    return;
  }
  dragCapsuleOnly(event, chip, zh, origin, fileScope);
}
