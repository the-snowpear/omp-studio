export const DISASSEMBLER_VIEWS = ["overview", "pseudocode", "asm", "functions", "strings", "imports", "exports", "xrefs"] as const;
export type DisassemblerView = (typeof DISASSEMBLER_VIEWS)[number];
export type DisassemblerEngine = "ida" | "ghidra";
export type DisassemblerBackend = DisassemblerEngine | "auto" | "none";

export interface DisassemblerBackendStatus {
  state: "ready" | "installing" | "unavailable" | "unknown";
  detail?: string;
}

export interface DisassemblerDatabase {
  id: string;
  label: string;
  name: string;
  ref: string;
  path: string;
  backend: DisassemblerEngine;
  state: "opening" | "open";
  module: string;
  format: string;
  arch: string;
  bitness: number;
  busy: boolean;
  dirty: boolean;
  current?: { method: string; startedAt: number };
  identity?: string;
  version?: number;
}

export interface DisassemblerStatus {
  backend: DisassemblerBackend;
  maxOpen: number;
  idleCloseSec: number;
  activeBackend?: DisassemblerEngine;
  backends: Record<DisassemblerEngine, DisassemblerBackendStatus>;
  available: boolean;
  reason?: string;
  databases: DisassemblerDatabase[];
}

export interface DisassemblerSlice { arch: string; cpuType: number; offset: number; size: number }
export interface DisassemblerMetadata {
  text: string;
  fat?: { slice: DisassemblerSlice; slices: DisassemblerSlice[] };
}

export type DisassemblerEdit =
  | { action: "open"; path: string; arch?: string }
  | { action: "save"; dbId: string }
  | { action: "close"; dbId: string; save: boolean }
  | { action: "rename"; dbId: string; target: string; name: string }
  | { action: "comment"; dbId: string; target: string; text: string; repeatable: boolean }
  | { action: "set_type"; dbId: string; target: string; decl: string }
  | { action: "make_function"; dbId: string; target: string }
  | { action: "exec"; dbId: string; code: string };

export type DisassemblerOperation = { sessionId: string } & (
  | { kind: "disassembler.status" }
  | { kind: "disassembler.configure"; backend: DisassemblerBackend; maxOpen: number; idleCloseSec: number }
  | { kind: "disassembler.metadata.read"; path: string; arch?: string }
  | { kind: "disassembler.open"; path: string; arch?: string }
  | { kind: "disassembler.close"; id: string; save?: boolean }
  | { kind: "disassembler.save"; id: string }
  | { kind: "disassembler.run"; id: string; code: string; timeoutMs: number }
  | { kind: "disassembler.cancel"; id?: string }
  | { kind: "disassembler.query"; dbId: string; identity: string; version: number; view: DisassemblerView; target?: string; offset?: number }
  | { kind: "disassembler.edit.prepare"; edit: DisassemblerEdit }
  | { kind: "disassembler.edit.apply"; token: string }
);

export interface DisassemblerResultMap {
  "disassembler.status": DisassemblerStatus;
  "disassembler.configure": DisassemblerStatus;
  "disassembler.metadata.read": DisassemblerMetadata;
  "disassembler.open": { database: DisassemblerDatabase };
  "disassembler.close": { closed: true; backup: string };
  "disassembler.save": { saved: true; backup: string };
  "disassembler.run": { output: string; value: string | null; error: string | null; truncated: boolean; backup: string; resultFile: string };
  "disassembler.cancel": { cancelled: boolean };
  "disassembler.query": { text: string; total: number; offset: number; nextOffset?: number; truncated: boolean };
  "disassembler.edit.prepare": { token: string; edit: DisassemblerEdit; identity?: string; version?: number; expiresAt: number };
  "disassembler.edit.apply": { text: string };
}

export const DISASSEMBLER_KINDS = [
  "disassembler.status", "disassembler.configure", "disassembler.metadata.read", "disassembler.open",
  "disassembler.close", "disassembler.save", "disassembler.run", "disassembler.cancel",
  "disassembler.query", "disassembler.edit.prepare", "disassembler.edit.apply",
] as const;

export function isDisassemblerKind(kind: string): kind is DisassemblerOperation["kind"] {
  return (DISASSEMBLER_KINDS as readonly string[]).includes(kind);
}
