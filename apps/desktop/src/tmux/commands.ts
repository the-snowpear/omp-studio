import type { TmuxAction } from "./tmux-shared.js";

export const quoteTmux = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function sendKeysLines(paneId: string, data: string): string[] {
  const bytes = Buffer.from(data), lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 512) lines.push(`send-keys -t ${paneId} -H ${[...bytes.subarray(at, at + 512)].map(byte => byte.toString(16).padStart(2, "0")).join(" ")}`);
  return lines;
}
export function actionLines(action: Exclude<TmuxAction, { kind: "setWindowVisible" }>): string[] {
  switch (action.kind) {
    case "newWindow": return [`new-window${action.afterWindowId ? ` -t ${action.afterWindowId} -a` : ""}`];
    case "splitPane": return [`split-window -${action.direction === "right" ? "h" : "v"} -t ${action.paneId}`];
    case "killPane": return [`kill-pane -t ${action.paneId}`];
    case "killWindow": return [`kill-window -t ${action.windowId}`];
    case "killSession": return ["kill-session"];
    case "selectPane": return [`select-pane -t ${action.paneId}`];
    case "selectWindow": return [`select-window -t ${action.windowId}`];
    // rename-window expands formats after command parsing, even inside single quotes.
    case "renameWindow": return [`rename-window -t ${action.windowId} ${quoteTmux(action.name.replaceAll("#", "##"))}`];
    // Per-window -C sizes were added after 3.2. All Studio tabs share one viewport.
    case "resizeWindow": return [`refresh-client -C ${action.cols}x${action.rows}`];
    case "resizePane": return [`resize-pane -t ${action.paneId} -${action.axis} ${action.cells}`];
    case "zoomPane": return [`resize-pane -t ${action.paneId} -Z`];
  }
}
const pathPrefix = 'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:$HOME/bin"; export PATH; command -v tmux >/dev/null 2>&1 || { echo "studio-tmux: not-installed" >&2; exit 127; }; ';
const remote = (script: string) => `exec /bin/sh -c ${quoteTmux(pathPrefix + script)}`;
export const remoteTmuxCommand = (session: string, directory: string) => remote(`exec tmux -u -C new-session -A -s ${quoteTmux(session)} -c ${quoteTmux(directory)}`);
export const remoteListCommand = () => remote("tmux -V; tmux -u list-sessions -F '#{session_id}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_name}' 2>&1");
export function supportedTmuxVersion(version: string): boolean {
  if (version === "master" || version.startsWith("next-")) return true;
  const match = /^(\d+)\.(\d+)/.exec(version);
  return !!match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 2);
}
/** Free text occupies the final column, so embedded tabs survive. */
export function splitTmuxFields(line: string, count: number): string[] {
  const fields: string[] = []; let start = 0;
  while (fields.length < count - 1) { const end = line.indexOf("\t", start); if (end < 0) break; fields.push(line.slice(start, end)); start = end + 1; }
  fields.push(line.slice(start)); return fields;
}
