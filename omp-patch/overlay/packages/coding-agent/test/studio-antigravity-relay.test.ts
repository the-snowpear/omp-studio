import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { McpBridge } from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd } from "../src/subprocess/worker-client";
import { ANTIGRAVITY_MCP_WORKER_ARG, runAntigravityMcpRelay } from "../src/studio/antigravity-mcp-worker";
import { smokeTestAntigravityMcpWorker } from "../src/studio/antigravity-mcp-smoke";

interface Reply {
	id: number;
	result?: { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }> };
	error?: unknown;
}

test("same-source CLI relay performs a real local MCP tool round trip without nc and exits on EOF", async () => {
	using temp = TempDir.createSync("@studio-mcp-relay-");
	const fixture = temp.join("fixture.txt");
	const text = "本地内容✓".repeat(20_000);
	await Bun.write(fixture, text);
	let called = 0;
	const bridge = new McpBridge(
		[
			{
				name: "fixture_read",
				description: "Read the test fixture",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			},
		],
		async () => {
			called++;
			return { content: [{ type: "text", text: await Bun.file(fixture).text() }] };
		},
	);
	const minimalPath =
		process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32") : temp.path();
	const child = Bun.spawn([...resolveCliEntryCmd(), ANTIGRAVITY_MCP_WORKER_ARG, String(bridge.port)], {
		cwd: temp.path(),
		env: { ...Bun.env, PATH: minimalPath, Path: minimalPath },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const done = Promise.withResolvers<void>();
	const replies: Reply[] = [];
	const decoder = new TextDecoder();
	const reading = (async () => {
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let end; (end = buffer.indexOf("\n")) >= 0;) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				const reply = JSON.parse(line) as Reply;
				replies.push(reply);
				if (reply.id === 3) done.resolve();
			}
		}
	})();
	reading.catch(done.reject);
	const timeout = setTimeout(() => {
		done.reject(new Error("MCP relay did not complete"));
		child.kill("SIGKILL");
	}, 20_000);
	try {
		for (const [index, [method, params]] of [
			[
				"initialize",
				{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
			],
			["tools/list", {}],
			["tools/call", { name: "fixture_read", arguments: {} }],
		].entries())
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params })}\n`);
		await child.stdin.flush();
		await done.promise;
		await child.stdin.end();
		expect(await child.exited).toBe(0);
		await reading;
		expect(await stderr).toBe("");
		expect(replies.find(reply => reply.id === 2)?.result?.tools?.map(tool => tool.name)).toEqual(["fixture_read"]);
		expect(replies.find(reply => reply.id === 3)?.result?.content).toEqual([{ type: "text", text }]);
		expect(called).toBe(1);
	} finally {
		clearTimeout(timeout);
		bridge.close();
		child.kill("SIGKILL");
		await child.exited;
	}
});

for (const ending of ["cancel", "disconnect"] as const) {
	test(`relay releases its socket and input after ${ending}`, async () => {
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test endpoint");
		const input = new PassThrough();
		const output = new PassThrough();
		const controller = new AbortController();
		const connected = once(server, "connection");
		const relaying = runAntigravityMcpRelay(address.port, { input, output, signal: controller.signal });
		const [socket] = await connected;
		socket.on("error", () => {});
		const closed = once(socket, "close");
		try {
			if (ending === "cancel") {
				controller.abort(new Error("operator cancelled relay"));
				await expect(relaying).rejects.toThrow("operator cancelled relay");
			} else {
				socket.end();
				await relaying;
			}
			await closed;
			expect(input.isPaused()).toBe(true);
			expect(output.writableEnded).toBe(false);
		} finally {
			controller.abort();
			socket.destroy();
			input.destroy();
			output.destroy();
			server.close();
		}
	});
}

test("distribution smoke checks the actual relay worker stdio graph", async () => {
	await smokeTestAntigravityMcpWorker();
});
