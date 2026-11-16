import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";

export const ANTIGRAVITY_MCP_WORKER_ARG = "__omp_worker_antigravity_mcp";

export interface AntigravityRelayStreams {
	input: Readable;
	output: Writable;
	signal?: AbortSignal;
}

/** Byte-only, backpressured stdio relay. All MCP semantics remain in the native McpBridge. */
export async function runAntigravityMcpRelay(
	port: number,
	{ input, output, signal }: AntigravityRelayStreams,
): Promise<void> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Antigravity MCP loopback port");
	signal?.throwIfAborted();
	const socket = createConnection({ host: "127.0.0.1", port });
	const done = Promise.withResolvers<void>();
	const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error("MCP relay aborted"));
	const fail = (error: Error) => socket.destroy(error);
	const timeout = () => socket.destroy(new Error("Antigravity MCP bridge connection timed out"));
	socket.setTimeout(10_000, timeout);
	socket.once("connect", () => {
		socket.setTimeout(0);
		input.pipe(socket);
		socket.pipe(output, { end: false });
	});
	socket.once("error", done.reject);
	socket.once("close", () => done.resolve());
	input.once("error", fail);
	output.once("error", fail);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		await done.promise;
	} finally {
		signal?.removeEventListener("abort", abort);
		input.removeListener("error", fail);
		output.removeListener("error", fail);
		input.unpipe(socket);
		input.pause();
		socket.unpipe(output);
		socket.destroy();
	}
}

export async function startAntigravityMcpWorker(args: readonly string[]): Promise<void> {
	if (args.length !== 1 || !/^\d+$/.test(args[0]!)) throw new Error("Expected one Antigravity MCP loopback port");
	await runAntigravityMcpRelay(Number(args[0]), { input: process.stdin, output: process.stdout });
}
