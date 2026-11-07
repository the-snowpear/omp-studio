import { useState } from "react";
import type { JsonValue } from "@omp-studio/client-contract";

/** Only expanded branches mount their children; large eval values stay readable. */
export function JsonTree({ value, label, initialOpen = true }: { value: JsonValue; label?: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  if (value === null || typeof value !== "object") return <div className="json-tree-leaf">{label !== undefined ? <span className="json-tree-key">{label}: </span> : null}<span>{JSON.stringify(value)}</span></div>;
  const entries = Object.entries(value), array = Array.isArray(value);
  return <details className="json-tree" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{label !== undefined ? `${label}: ` : ""}{array ? `[${entries.length}]` : `{${entries.length}}`}</summary>{open ? <div className="json-tree-children">{entries.map(([key, child]) => <JsonTree key={key} label={key} value={child} initialOpen={false} />)}</div> : null}</details>;
}
