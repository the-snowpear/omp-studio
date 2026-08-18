/** CSI, OSC, and single-char ESC sequences from tool stdout. */
const ANSI_RE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Apply in-line `\r` the way a terminal does: each segment overwrites from
 * column 0. Used so npm / Vite progress lines do not pile up as garbage.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    let current = "";
    for (const part of line.split("\r")) {
      current = part + current.slice(part.length);
    }
    return current;
  }).join("\n");
}

export function displayBashOutput(text: string): string {
  return applyCarriageReturns(stripAnsi(text));
}

export type BashDisplayRow = {
  readonly text: string;
  readonly cls: string;
};

export function bashDisplayRows(raw: unknown): BashDisplayRow[] {
  const rows: BashDisplayRow[] = [];
  if (Array.isArray(raw)) {
    for (const line of raw) {
      if (Array.isArray(line)) {
        rows.push({
          text: displayBashOutput(String(line[0] ?? "")),
          cls: typeof line[1] === "string" && line[1] ? `c-${line[1]}` : "",
        });
      } else {
        rows.push({ text: displayBashOutput(String(line)), cls: "" });
      }
    }
    return rows;
  }
  if (typeof raw !== "string" || raw.length === 0) return rows;
  for (const line of displayBashOutput(raw).split("\n")) {
    rows.push({ text: line, cls: "" });
  }
  return rows;
}
