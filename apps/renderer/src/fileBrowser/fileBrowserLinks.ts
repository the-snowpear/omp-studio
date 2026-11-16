import { useSyncExternalStore } from "react";
import { useConversationView } from "../conversationWorkspace/Context";

export interface FileBrowserOpenIntent { path: string; workspaceId?: string; targetId?: string | null }
const openers = new Map<string, (intent: FileBrowserOpenIntent) => void>();
export function registerFileBrowser(owner: string, open: (intent: FileBrowserOpenIntent) => void) {
  openers.set(owner, open);
  return () => { if (openers.get(owner) === open) openers.delete(owner); };
}
export function useOpenFileBrowser() {
  const view = useConversationView();
  return (intent: FileBrowserOpenIntent) => { const open = openers.get(view?.document.id ?? "standalone"); open?.(intent); return !!open; };
}

const reveals = new Map<string, { path: string; revision: number }>();
const listeners = new Set<() => void>();
const revealKey = (owner: string, target: string | null, workspace: string) => JSON.stringify([owner, target, workspace]);
export function revealWorkspaceFile(owner: string, target: string | null, workspace: string, path: string) {
  const key = revealKey(owner, target, workspace);
  reveals.set(key, { path, revision: (reveals.get(key)?.revision ?? 0) + 1 });
  for (const listener of listeners) listener();
}
export function useExplorerReveal(target: string | null, workspace: string) {
  const view = useConversationView(), key = revealKey(view?.document.id ?? "standalone", target, workspace);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => reveals.get(key));
}
