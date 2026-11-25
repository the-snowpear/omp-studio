import {
  TerminalSessionManager,
  createNodePtySpawner,
  type PtySpawner,
} from "../terminal-pty.js";
import {
  parseCreateInput,
  parseWriteInput,
  parseResizeInput,
  parseDisposeInput,
} from "../terminal-shared.js";
import type { TerminalSessionInfo } from "../terminal-shared.js";
import { TerminalRecordingManager } from "../terminal-recording.js";
import { activeArtifactLibrary } from "../artifact-library.js";
import { parseRecordingInput } from "../terminal-shared.js";
import { desktopText } from "../desktop-language-shared.js";

export interface SharedTerminal extends TerminalSessionInfo {
  sessionId?: string;
  workspaceId?: string;
  status: "running" | "ended";
  output: string;
  sequence: number;
  truncated: boolean;
}
export type SharedTerminalEvent =
  | { kind: "terminal.data"; id: string; data: string; sequence: number }
  | { kind: "terminal.exit"; id: string }
  | { kind: "terminal.changed" };

/** The Host owns PTYs. A client disconnect only releases its subscription. */
export class SharedTerminals {
  readonly #recordings = new TerminalRecordingManager(activeArtifactLibrary);
  readonly #manager: TerminalSessionManager;
  readonly #terminals = new Map<string, SharedTerminal>();
  readonly #listeners = new Set<(event: SharedTerminalEvent) => void>();
  constructor(
    readonly workspacePath: (id: string) => Promise<string>,
    spawner: PtySpawner = createNodePtySpawner(true),
  ) {
    this.#manager = new TerminalSessionManager({
      spawner,
      recording: this.#recordings,
    });
  }
  list(): SharedTerminal[] {
    return [...this.#terminals.values()].map((row) => ({ ...row }));
  }
  subscribe(listener: (event: SharedTerminalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  private publish(event: SharedTerminalEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async create(
    raw: unknown,
    assertControl?: () => void,
  ): Promise<TerminalSessionInfo> {
    const input = parseCreateInput(raw);
    if (input.targetId)
      throw new Error(desktopText("请在此主机上选择项目后打开终端", "Choose a project on this Host to open a terminal"));
    const cwd = input.workspaceId
      ? await this.workspacePath(input.workspaceId)
      : undefined;
    assertControl?.();
    const info = this.#manager.create(
      0,
      { ...input, flowControl: false },
      {
        onData: (event) => {
          const row = this.#terminals.get(event.id);
          if (!row) return;
          row.output += event.data;
          if (row.output.length > 3 * 1024 * 1024) {
            row.output = row.output.slice(-3 * 1024 * 1024);
            row.truncated = true;
          }
          row.sequence++;
          this.publish({
            kind: "terminal.data",
            id: event.id,
            data: event.data,
            sequence: row.sequence,
          });
        },
        onExit: ({ id }) => {
          const row = this.#terminals.get(id);
          if (row) row.status = "ended";
          this.publish({ kind: "terminal.exit", id });
        },
      },
      cwd,
    );
    this.#terminals.set(info.id, {
      ...info,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "running",
      output: "",
      sequence: 0,
      truncated: false,
    });
    this.publish({ kind: "terminal.changed" });
    return info;
  }
  write(raw: unknown): void {
    const { id, data } = parseWriteInput(raw);
    this.#manager.write(0, id, data);
  }
  resize(raw: unknown): void {
    const { id, cols, rows } = parseResizeInput(raw);
    this.#manager.resize(0, id, cols, rows);
  }
  remove(raw: unknown): void {
    const { id } = parseDisposeInput(raw);
    this.#manager.dispose(0, id);
    this.#terminals.delete(id);
    this.publish({ kind: "terminal.changed" });
  }
  get busy(): boolean {
    return [...this.#terminals.values()].some(
      (row) => row.status === "running",
    );
  }
  record(action: "start" | "stop" | "status", raw: unknown) {
    const input =
      action === "start" ? parseRecordingInput(raw) : parseDisposeInput(raw);
    this.#manager.flushOutput(0, input.id);
    if (action === "start")
      return this.#recordings.start(
        0,
        input,
        this.#manager.recordingTarget(0, input.id),
      );
    if (action === "stop") return this.#recordings.stop(0, input.id);
    return this.#recordings.status(0, input.id);
  }
  async close(): Promise<void> {
    this.#manager.disposeAll();
    this.#listeners.clear();
    await this.#recordings.dispose();
  }
}
