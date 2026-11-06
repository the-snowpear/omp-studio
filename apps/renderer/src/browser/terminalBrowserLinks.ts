import type { Terminal, ILink, IDisposable } from "@xterm/xterm";
import { openBrowserLink } from "./browserLinks";

export function registerTerminalBrowserLinks(terminal: Terminal, hover: (url: string | null) => void): IDisposable {
  return terminal.registerLinkProvider({ provideLinks(lineNumber, callback) {
    const buffer = terminal.buffer.active;
    let first = lineNumber - 1;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    let text = "";
    const positions: { x: number; y: number; end: number }[] = [];
    for (let row = first; row < buffer.length && (row === first || buffer.getLine(row)?.isWrapped); row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      for (let column = 0; column < line.length; column++) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const characters = cell.getChars() || " ";
        for (let index = 0; index < characters.length; index++) positions.push({ x: column + 1, y: row + 1, end: column + cell.getWidth() });
        text += characters;
      }
    }
    const links: ILink[] = [];
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
      const url = match[0].replace(/[),.;\]}]+$/u, ""), start = positions[match.index], end = positions[match.index + url.length - 1];
      if (!start || !end || lineNumber < start.y || lineNumber > end.y) continue;
      links.push({ text: url, range: { start: { x: start.x, y: start.y }, end: { x: end.end, y: end.y } }, activate: () => openBrowserLink(url), hover: () => hover(url), leave: () => hover(null) });
    }
    callback(links);
  } });
}
