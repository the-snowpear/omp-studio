import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface StepRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSONL client for `step --mode rpc`. Events go to the callback; request()
 * correlates a response by id. The spike needs get_state, prompt and abort;
 * the full adapter will add the remaining commands from rpc-types.ts.
 */
export class StepRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  #seq = 0;

  constructor(
    options: StepRpcOptions,
    onEvent: (event: Record<string, unknown>) => void,
  ) {
    this.#child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "pipe",
    });
    createInterface({ input: this.#child.stdout }).on("line", line => {
      const text = line.trim();
      if (text === "") return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return; // Non-JSON stdout is diagnostic noise.
      }
      if (message["type"] === "response" && typeof message["id"] === "string") {
        const pending = this.#pending.get(message["id"]);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.#pending.delete(message["id"]);
          if (message["success"] === false) {
            pending.reject(new Error(JSON.stringify(message["error"] ?? "rpc error")));
          } else {
            pending.resolve((message["data"] ?? {}) as Record<string, unknown>);
          }
        }
        return;
      }
      onEvent(message);
    });
  }

  request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const id = `req-${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`step rpc timeout: ${type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ ...payload, type, id });
    });
  }

  prompt(message: string): void {
    this.#write({ type: "prompt", message });
  }

  abort(): void {
    this.#write({ type: "abort" });
  }

  kill(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("step rpc closed"));
    }
    this.#pending.clear();
    this.#child.kill();
  }

  #write(value: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}
