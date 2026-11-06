import { useMemo } from "react";
import { DiffLine, type ChangesDiffLine } from "../conversation/ChangesPanel";

type PatchRow = ChangesDiffLine | { kind: "header"; text: string };

function patchRows(patch: string): PatchRow[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines = patch.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line): PatchRow => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: "header", text: line };
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    const mark = line[0];
    if (inHunk && (mark === "+" || mark === "-" || mark === " ")) {
      return {
        kind: "row", mark,
        oldLn: mark === "+" ? "" : String(oldLine++),
        newLn: mark === "-" ? "" : String(newLine++),
        text: line.slice(1),
      };
    }
    return { kind: "header", text: line };
  });
}

export function GitPatch({ patch, split }: { patch: string; split: boolean }) {
  const rows = useMemo(() => patchRows(patch), [patch]);
  return rows.map((row, index) => row.kind === "header"
    ? <div key={index} className="diff-head-row">{row.text}</div>
    : <DiffLine key={index} line={row} split={split} />);
}
