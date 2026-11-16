import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { purgeDeletedSessionRows, type SessionPurgeDiagnostic } from "../session/session-db-purge";
import type {
	StudioSessionPurgeRequest,
	StudioSessionPurgeResponse,
	StudioSessionPurgeResult,
} from "./session-lifecycle-protocol";

export const SESSION_PURGE_WORKER_SELECTOR = "__omp_worker_session_purge";
const MAX_INPUT_BYTES = 64 * 1024;

const pathKey = (value: string): string => {
	const normalized = path.resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

function parseRequest(raw: string): StudioSessionPurgeRequest {
	if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error("Maintenance input exceeds its limit");
	const value = JSON.parse(raw) as StudioSessionPurgeRequest;
	if (!value || value.schemaVersion !== 1) throw new Error("Unsupported maintenance input");
	for (const key of ["requestId", "sessionId", "sessionFile", "agentDir"] as const) {
		if (
			typeof value[key] !== "string" ||
			!value[key] ||
			value[key].length > 32768 ||
			/[\u0000-\u001f]/u.test(value[key])
		)
			throw new Error("Invalid maintenance identity or path");
	}
	if (!path.isAbsolute(value.sessionFile) || !path.isAbsolute(value.agentDir))
		throw new Error("Maintenance requires absolute paths");
	return value;
}

/** Runs no session, settings, credentials, extensions, or model discovery. The Host already located the identity. */
export async function purgeStudioSessionRows(input: StudioSessionPurgeRequest): Promise<StudioSessionPurgeResult> {
	try {
		// The CLI has bootstrapped the same profile as its normal Runtime. Never redirect a
		// resident/native global resolver to a client-supplied database or another profile.
		if (pathKey(getAgentDir()) !== pathKey(input.agentDir))
			return { status: "partial", reason: "session-unavailable" };
		const metadata = await fs.lstat(input.sessionFile);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: "partial", reason: "session-unavailable" };
		const [root, file] = await Promise.all([fs.realpath(input.agentDir), fs.realpath(input.sessionFile)]);
		const inside = (directory: string): boolean => {
			const relative = path.relative(pathKey(directory), pathKey(file));
			return (
				relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
			);
		};
		if (
			!(inside(path.join(root, "sessions")) || inside(path.join(root, "archive", "sessions"))) ||
			!(file.endsWith(".jsonl") || file.endsWith(".jsonl.gz"))
		)
			return { status: "partial", reason: "session-unavailable" };
	} catch {
		return { status: "partial", reason: "session-unavailable" };
	}
	let diagnostic: SessionPurgeDiagnostic | undefined;
	purgeDeletedSessionRows(input.sessionFile, {
		sessionId: input.sessionId,
		onDiagnostic: result => {
			diagnostic = result;
		},
	});
	if (!diagnostic) return { status: "partial", reason: "native-purge-unreported" };
	const complete = [diagnostic.history, diagnostic.stats].every(
		row => row.status === "purged" || row.status === "absent",
	);
	return complete
		? { status: "complete", diagnostic }
		: { status: "partial", reason: "native-purge-partial", diagnostic };
}

export interface SessionPurgeWorkerIO {
	readInput?: () => Promise<string>;
	writeOutput?: (line: string) => void;
}

async function readInput(): Promise<string> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of Bun.stdin.stream()) {
		bytes += chunk.byteLength;
		if (bytes > MAX_INPUT_BYTES) throw new Error("Maintenance input exceeds its limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Hidden CLI entrypoint: one private request, one bounded response, then exit. */
export async function runStudioSessionPurgeWorker(io: SessionPurgeWorkerIO = {}): Promise<number> {
	let request: StudioSessionPurgeRequest;
	try {
		request = parseRequest(await (io.readInput ?? readInput)());
	} catch {
		return 2;
	}
	const response: StudioSessionPurgeResponse = {
		schemaVersion: 1,
		requestId: request.requestId,
		result: await purgeStudioSessionRows(request),
	};
	(
		io.writeOutput ??
		(line => {
			process.stdout.write(line);
		})
	)(`${JSON.stringify(response)}\n`);
	return 0;
}
