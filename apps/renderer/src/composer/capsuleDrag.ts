import type { PointerEvent } from "react";
import { beginPointerDrag } from "../dock/pointerDrag";
import { isZh } from "../i18n";
import { capsuleCaptions, dragConversation, type CapsuleOrigin } from "../conversationWorkspace/drag";
import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import type { DockRect } from "../dock/types";
import { composerDropAt, type ComposerDropTarget, type DroppedChip } from "./composerDrop";
import { hideCapsuleGhost, landCapsuleGhost, showCapsuleGhost } from "./capsuleGhost";
import { dragFile } from "../files/fileDrag";

/**
 * A capsule that has nowhere to open (a folder, an image, a skill…): it only
 * travels between input boxes. Outside them it says "release to cancel" and
 * flies back to where it came from.
 */
export function dragCapsuleOnly(event: PointerEvent<HTMLElement>, chip: DroppedChip, origin?: CapsuleOrigin) {
  const surface = event.currentTarget.ownerDocument;
  const captions = capsuleCaptions(isZh());
  let hovered: ComposerDropTarget | null = null;
  const finish = () => { hovered?.hideCaret(); origin?.element.classList.remove("is-drag-origin"); };
  const back = () => origin ? landCapsuleGhost(surface, origin.element) : hideCapsuleGhost(surface);
  return beginPointerDrag(event, {
    onStart: () => origin?.element.classList.add("is-drag-origin"),
    onMove: point => {
      if (origin && !origin.element.isConnected) return;
      const next = composerDropAt(surface, point);
      if (next !== hovered) hovered?.hideCaret();
      hovered = next;
      hovered?.showCaret(point);
      const caption = !hovered ? captions.cancel : origin && hovered === origin.target ? captions.move : captions.insert;
      showCapsuleGhost(surface, { kind: chip.kind, label: chip.label, caption, muted: !hovered }, point);
    },
    onDrop: point => {
      const into = hovered;
      finish();
      if (!into) { back(); return; }
      const landed = origin && into === origin.target ? into.moveTo(origin.element, point) : into.insertAt(chip, point);
      if (origin && into !== origin.target) origin.target.remove(origin.chipId);
      landCapsuleGhost(surface, landed);
    },
    onCancel: () => { finish(); back(); },
  });
}

/**
 * A capsule grabbed inside the input box. Inside a box it reorders or moves;
 * outside, a conversation becomes its window again and a file opens floating
 * where it is dropped. Either way it then leaves the input box.
 */
export function dragComposerCapsule(event: PointerEvent<HTMLElement>, element: HTMLElement, target: ComposerDropTarget, context: {
  store: ConversationWorkspaceStore | null | undefined;
  openFile?: ((path: string, rect: DockRect) => void) | undefined;
}) {
  const chip = target.chipOf(element);
  if (!chip) return;
  const origin: CapsuleOrigin = { element, chipId: chip.id, target };
  const { store, openFile } = context;
  if (chip.kind === "session" && chip.sessionReference && store) {
    dragConversation(event, store, { reference: chip.sessionReference, title: chip.label, capsule: origin });
    return;
  }
  if (chip.kind === "file" && chip.path && store && openFile) {
    const path = chip.path;
    dragFile(event, store, { chip, open: rect => openFile(path, rect), capsule: origin });
    return;
  }
  dragCapsuleOnly(event, chip, origin);
}
