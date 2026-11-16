import type { TmuxLayoutNode } from "./tmux-shared.js";
export function tmuxLayoutChecksum(body: string): string {
  let sum = 0;
  for (const char of body) sum = (((sum >> 1) + ((sum & 1) << 15)) + char.charCodeAt(0)) & 0xffff;
  return sum.toString(16).padStart(4, "0");
}
export function parseTmuxLayout(value: string): { root: TmuxLayoutNode; panes: Array<Extract<TmuxLayoutNode, { type: "pane" }>> } | undefined {
  const body = value.slice(5);
  if (value[4] !== "," || tmuxLayoutChecksum(body) !== value.slice(0, 4)) return undefined;
  let at = 0;
  const panes: Array<Extract<TmuxLayoutNode, { type: "pane" }>> = [];
  function cell(): TmuxLayoutNode | undefined {
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(body.slice(at));
    if (!match) return;
    at += match[0].length;
    const rect = { cols: Number(match[1]), rows: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
    const type = body[at++];
    if (type === ",") {
      const id = /^\d+/.exec(body.slice(at)); if (!id) return;
      at += id[0].length;
      const pane = { type: "pane" as const, paneId: `%${id[0]}`, ...rect }; panes.push(pane); return pane;
    }
    if (type !== "{" && type !== "[") return;
    const children: TmuxLayoutNode[] = [];
    do { const child = cell(); if (!child) return; children.push(child); } while (body[at++] === ",");
    if (body[at - 1] !== (type === "{" ? "}" : "]")) return;
    return { type: type === "{" ? "row" : "column", ...rect, children };
  }
  const root = cell();
  return root && at === body.length ? { root, panes } : undefined;
}
