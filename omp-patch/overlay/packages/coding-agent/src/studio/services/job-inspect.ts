import type { AgentSession } from "../../session/agent-session";
import type { JobInspection } from "../runtime-features-protocol";
import { shortenHomePath, utf8ByteLength } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";

/** Output kept for the inspector: the tail, where a running job's latest lines are. */
export const JOB_INSPECT_OUTPUT_TAIL_BYTES = 16 * 1024;
const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_PIDS = 64;

/** Terminal escapes and control characters (tabs and newlines stay) dropped from inspected text. */
function cleanText(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return Bun.stripANSI(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Last `maxBytes` UTF-8 bytes of `text`, cut at a line start when one is near. */
export function outputTail(text: string, maxBytes = JOB_INSPECT_OUTPUT_TAIL_BYTES): string {
	if (utf8ByteLength(text) <= maxBytes) return text;
	const bytes = new TextEncoder().encode(text);
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start += 1;
	const tail = new TextDecoder().decode(bytes.subarray(start));
	const newline = tail.indexOf("\n");
	return newline >= 0 && newline < 512 ? tail.slice(newline + 1) : tail;
}

/** `jobs.inspect`: upstream `AgentSession.inspectAsyncJob`, projected to the Studio contract. */
export async function inspectStudioJob(session: AgentSession, jobId: string): Promise<JobInspection> {
	const inspection = session.inspectAsyncJob(jobId);
	if (inspection === undefined) {
		throw new SessionControlError("INVALID_ARGUMENT", `Job "${jobId}" is not in this session's job tree`);
	}
	const output = inspection.output === undefined ? "" : outputTail(cleanText(shortenHomePath(inspection.output)));
	const command = inspection.command === undefined ? "" : cleanText(inspection.command).slice(0, MAX_COMMAND_CHARS);
	return {
		jobId,
		...(command ? { command } : {}),
		...(inspection.cwd ? { cwd: shortenHomePath(inspection.cwd) } : {}),
		pids: inspection.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, MAX_PIDS),
		...(typeof inspection.exitCode === "number" && Number.isFinite(inspection.exitCode)
			? { exitCode: inspection.exitCode }
			: {}),
		...(output ? { output } : {}),
		...(inspection.artifactId ? { artifactId: inspection.artifactId } : {}),
		...(inspection.widget ? { widget: inspection.widget } : {}),
	};
}
