export interface ResourceOperation {
	kind: "resource.read";
	sessionId: string;
	uri: string;
	offset?: number;
	version?: string;
}
export interface ResourcePage {
	uri: string;
	version: string;
	offset: number;
	total: number;
	nextOffset?: number;
	text: string;
	truncated: boolean;
	image?: { mimeType: string; data: string };
}
export function validateResourceOperation(v: unknown): asserts v is ResourceOperation {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid resource request");
	const r = v as Record<string, unknown>;
	if (
		Object.keys(r).some(k => !["kind", "sessionId", "uri", "offset", "version"].includes(k)) ||
		r.kind !== "resource.read" ||
		typeof r.sessionId !== "string" ||
		!r.sessionId ||
		typeof r.uri !== "string" ||
		r.uri.length > 4096 ||
		r.uri.includes("\0") ||
		!/^(local|omp|attachment|conflict):\/\//.test(r.uri)
	)
		throw Error("Invalid resource target");
	if (
		r.offset !== undefined &&
		(!Number.isSafeInteger(r.offset) || (r.offset as number) < 0 || (r.offset as number) > 1000000)
	)
		throw Error("Invalid resource page");
	if (r.version !== undefined && (typeof r.version !== "string" || !/^[a-f0-9]{64}$/.test(r.version)))
		throw Error("Invalid resource version");
	if ((r.offset as number) > 0 && r.version === undefined) throw Error("Further pages require a resource version");
}
