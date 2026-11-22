import type { PointerEvent } from "react";
import { beginWindowDrag } from "../dock/windowDrag";
import { workbenchBounds } from "../dock/workbenchGeometry";
import type { DockRect } from "../dock/types";
import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import { acceptsFileScope, composerDropAt, type CapsuleOrigin, type ComposerDropTarget, type ComposerFileScope, type DroppedChip } from "../composer/composerDrop";
import { capsuleCaptions, dragCapsuleOnly, hideCapsuleGhost, landCapsuleGhost, showCapsuleGhost } from "../composer/capsuleGhost";
import { fileLabel } from "../composer/types";

const IMAGE = /\.(png|jpe?g|gif|webp)$/iu;
const FILE_WINDOW = { width: 900, height: 680 };

/** The capsule an Explorer row becomes in an input box (same kinds as its「添加上下文」). */
export function explorerChip(path: string, kind: "file" | "dir"): DroppedChip {
  return { kind: kind === "dir" ? "dir" : IMAGE.test(path) ? "image" : "file", label: fileLabel(path), path };
}

/**
 * Drags a file towards an input box (it becomes a capsule there) or anywhere
 * else in the workbench (it opens as a floating window at that spot). Folders
 * have no window, so they only travel as capsules.
 */
export function dragFile(event: PointerEvent<HTMLElement>, store: ConversationWorkspaceStore | null | undefined, input: {
  chip: DroppedChip;
  open: (rect: DockRect, onOpened?: () => void) => void;
  fileScope?: ComposerFileScope | undefined;
  zh: boolean;
  capsule?: CapsuleOrigin;
}) {
  if (event.button !== 0) return;
  const { chip, open, capsule, fileScope, zh } = input;
  const surface = event.currentTarget.ownerDocument;
  const active = store?.getSnapshot().activeDocumentId;
  const tools = store && active ? store.hosts.get(active).tools : undefined;
  const bounds = workbenchBounds(surface);
  if (chip.kind === "dir" || !tools || !bounds?.width || !bounds.height || tools.store.getSnapshot().preferences.locked) {
    return dragCapsuleOnly(event, chip, zh, capsule, fileScope);
  }
  const captions = capsuleCaptions(zh);
  const width = Math.min(bounds.width, FILE_WINDOW.width), height = Math.min(bounds.height, FILE_WINDOW.height);
  const grabX = Math.min(120, width / 2), grabY = 14;
  const rect = { x: event.clientX - bounds.x - grabX, y: event.clientY - bounds.y - grabY, width, height };
  const sourceRect = event.currentTarget.getBoundingClientRect();
  const home = capsule ? undefined : event.currentTarget.closest("[role=tree]")?.getBoundingClientRect();
  let composer: ComposerDropTarget | null = null;
  let wrongWorkspace = false;
  const finish = () => { composer?.hideCaret(); capsule?.element.classList.remove("is-drag-origin"); };
  return beginWindowDrag(event, {
    rect, bounds, sourceRect, hosts: tools.hosts, layout: tools.store.getSnapshot().layout,
    file: { title: chip.label, path: chip.path ?? chip.label, loadingLabel: zh ? "正在打开文件…" : "Opening file…" },
    fromCapsule: !!capsule,
    valid: () => !tools.store.getSnapshot().preferences.locked && (!capsule || capsule.element.isConnected),
    subscribe: () => () => {},
    onStart: () => capsule?.element.classList.add("is-drag-origin"),
    onCancel: () => { finish(); if (capsule) landCapsuleGhost(surface, capsule.element); else hideCapsuleGhost(surface); },
    project: point => {
      const hovered = composerDropAt(surface, point);
      wrongWorkspace = hovered !== null && !acceptsFileScope(hovered, fileScope);
      const accepting = wrongWorkspace ? null : hovered;
      if (accepting !== composer) composer?.hideCaret();
      composer = accepting;
      if (wrongWorkspace) {
        const caption = zh ? "松手取消：工作区不同" : "Release to cancel: different workspace";
        const pill = showCapsuleGhost(surface, { kind: chip.kind, label: chip.label, caption, muted: true }, point);
        return { rect: pill, label: caption, key: "capsule-stuck", capsule: { rect: pill } };
      }
      if (!composer) { hideCapsuleGhost(surface); return null; }
      composer.showCaret(point);
      const caption = capsule && composer === capsule.target ? captions.move : captions.insert;
      const pill = showCapsuleGhost(surface, { kind: chip.kind, label: chip.label, caption }, point);
      return { rect: pill, label: caption, key: "composer", capsule: { rect: pill } };
    },
    onDrop: (dropped, point) => {
      const into = composer;
      finish();
      if (into) {
        const landed = capsule && into === capsule.target ? into.moveTo(capsule.element, point) : into.insertAt(chip, point);
        if (landed && capsule && into !== capsule.target) capsule.target.remove(capsule.chipId);
        landCapsuleGhost(surface, landed);
        return;
      }
      if (wrongWorkspace) {
        if (capsule) landCapsuleGhost(surface, capsule.element); else hideCapsuleGhost(surface);
        return;
      }
      hideCapsuleGhost(surface);
      // Let go over the tree it came from: nothing to open.
      if (home && point.x >= home.left && point.x <= home.right && point.y >= home.top && point.y <= home.bottom) return;
      open(dropped, capsule ? () => {
        if (capsule.element.isConnected) capsule.target.remove(capsule.chipId);
      } : undefined);
    },
  });
}
