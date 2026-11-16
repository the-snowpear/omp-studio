import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { resolveCliEntryCmd, SMOKE_TEST_TIMEOUT_MS } from "../subprocess/worker-client";
import { ANTIGRAVITY_MCP_WORKER_ARG } from "./antigravity-mcp-worker";

/** Exercises the same bundled CLI entry and stdio graph as agy's managed MCP server. */
export async function smokeTestAntigravityMcpWorker(): Promise<void> {
	const sockets = new Set<Socket>();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.pipe(socket);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Antigravity MCP smoke has no loopback endpoint");
	try {
		const child = Bun.spawn([...resolveCliEntryCmd(), ANTIGRAVITY_MCP_WORKER_ARG, String(address.port)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const timeout = setTimeout(() => child.kill("SIGKILL"), SMOKE_TEST_TIMEOUT_MS);
		try {
			const payload = `${JSON.stringify({ jsonrpc: "2.0", id: "studio-mcp-smoke", method: "ping" })}\n`;
			child.stdin.write(payload);
			await child.stdin.flush();
			await child.stdin.end();
			const [code, output, error] = await Promise.all([child.exited, stdout, stderr]);
			if (code !== 0 || output !== payload || error !== "") {
				throw new Error(
					`Antigravity MCP worker smoke failed (exit ${code}): ${error || "stdio round trip mismatch"}`,
				);
			}
		} finally {
			clearTimeout(timeout);
			child.kill("SIGKILL");
			await child.exited;
		}
	} finally {
		for (const socket of sockets) socket.destroy();
		server.close();
	}
}
