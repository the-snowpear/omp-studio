import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface StepRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Thin JSONL client for `step --mode rpc`. The spike only needs prompt and
 * abort; the full adapter will add the remaining commands from rpc-types.ts.
 */
export class StepRpc {
  readonly #child: ChildProcessWithoutNullStreams;

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
      try {
        onEvent(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // Non-JSON stdout is diagnostic noise, not protocol data.
      }
    });
  }

  prompt(message: string): void {
    this.#write({ type: "prompt", message });
  }

  abort(): void {
    this.#write({ type: "abort" });
  }

  kill(): void {
    this.#child.kill();
  }

  #write(value: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}
