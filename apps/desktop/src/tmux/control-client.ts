import type { Writable } from "node:stream";
import { TmuxControlParser, type TmuxParserEvents, type TmuxBlock } from "./control-parser.js";
import { desktopText } from "../desktop-language-shared.js";

interface Command { line: string; resolve(lines: Buffer[]): void; reject(error: Error): void }
export class TmuxControlClient {
  readonly parser: TmuxControlParser;
  readonly ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #started = false;
  #closed = false;
  #queue: Command[] = [];
  #waiting: Command[] = [];
  #timer: ReturnType<typeof setTimeout>;
  #reported = new Set<string>();
  constructor(readonly stdin: Writable, readonly events: Omit<TmuxParserEvents, "onBlock"> & { onCommandError?(error: Error): void }, timeoutMs = 15_000) {
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    // A connection may fail before its owner starts awaiting ready.
    void this.ready.catch(() => {});
    this.parser = new TmuxControlParser({ ...events, onBlock: block => this.#block(block) });
    this.#timer = setTimeout(() => this.close(new Error("attach-timeout")), timeoutMs);
    this.#timer.unref();
    stdin.on("error", error => this.close(error));
  }
  run(line: string): Promise<Buffer[]> {
    if (this.#closed) return Promise.reject(new Error(desktopText("tmux 连接已关闭", "tmux connection closed")));
    return new Promise((resolve, reject) => {
      const command = { line, resolve, reject };
      if (this.#started) this.#send(command); else this.#queue.push(command);
    });
  }
  fire(line: string): void {
    void this.run(line).catch(error => {
      const kind = line.split(" ", 1)[0]!;
      if (!this.#reported.has(kind)) { this.#reported.add(kind); this.events.onCommandError?.(error as Error); }
    });
  }
  #send(command: Command): void { this.#waiting.push(command); this.stdin.write(command.line + "\n"); }
  #block(block: TmuxBlock): void {
    if (this.#closed) return;
    const error = () => new Error(block.lines.map(line => line.toString()).join("\n") || desktopText("tmux 命令执行失败", "tmux command failed"));
    if (!this.#started) {
      clearTimeout(this.#timer);
      if (!block.ok) { this.close(error()); return; }
      this.#started = true; this.#resolveReady();
      for (const command of this.#queue.splice(0)) this.#send(command);
      return;
    }
    // Hooks also produce blocks, but only flag 1 identifies a command from stdin.
    if (!(block.flags & 1)) return;
    const command = this.#waiting.shift();
    if (block.ok) command?.resolve(block.lines); else command?.reject(error());
  }
  detach(): void {
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end("\n");
    this.close(new Error(desktopText("tmux 连接已分离", "tmux detached")));
  }
  close(error = new Error(desktopText("tmux 连接已关闭", "tmux connection closed"))): void {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#timer); this.#rejectReady(error);
    for (const command of [...this.#waiting.splice(0), ...this.#queue.splice(0)]) command.reject(error);
  }
}
