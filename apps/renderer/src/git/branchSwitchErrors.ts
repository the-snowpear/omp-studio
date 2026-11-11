import { hostErrorMessage } from "../hostError";

/** Host marker for a blocked `git switch`; message lines after it are `path[ TAB +N TAB -N ]`. */
const SWITCH_BLOCKED_HEADER = "Local changes would be overwritten by checkout";

export interface SwitchBlockedFile {
  readonly path: string;
  readonly insertions?: number;
  readonly deletions?: number;
}

export function switchBlockedFilesOf(error: unknown): SwitchBlockedFile[] | undefined {
  const message = hostErrorMessage(error, "");
  if (!message.startsWith(SWITCH_BLOCKED_HEADER)) return undefined;
  const files: SwitchBlockedFile[] = [];
  for (const line of message.split("\n").slice(1)) {
    const parts = line.trim().split("\t");
    const path = parts[0] ?? "";
    if (!path) continue;
    const insertions = parts.length === 3 ? Number(parts[1]) : Number.NaN;
    const deletions = parts.length === 3 ? Number(parts[2]) : Number.NaN;
    files.push({
      path,
      ...(Number.isFinite(insertions) && Number.isFinite(deletions) ? { insertions, deletions } : {}),
    });
  }
  return files.length > 0 ? files : undefined;
}
