/** Filters for WebMCP tool discovery. */
export interface WebMcpListOptions {
	/** Return full metadata only for tools with this exact name. */
	name?: string;
	/** Restrict discovery to one frame id. */
	frame?: string;
}

/** Options for invoking a WebMCP tool. */
export interface WebMcpInvokeOptions {
	/** Restrict invocation to one frame id. */
	frame?: string;
	/** Invocation timeout in milliseconds. */
	timeout?: number;
}

/** Options for reading the WebMCP catalog change log. */
export interface WebMcpEventsOptions {
	/** Return events whose sequence is greater than this cursor. */
	since?: number;
	/** Clear retained events after reading them. */
	clear?: boolean;
}

/** One untrusted page-provided WebMCP tool description. */
export interface WebMcpToolRecord {
	/** Page-defined tool name. */
	name: string;
	/** Page-defined tool description. */
	description: string;
	/** CDP identifier of the frame that owns the tool. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Page-defined JSON Schema, included only for exact-name discovery. */
	inputSchema?: unknown;
	/** Page-defined tool annotations, included only for exact-name discovery. */
	annotations?: unknown;
	/** Marks every page-provided field as untrusted content. */
	untrusted: true;
}

/** WebMCP discovery result. */
export interface WebMcpListResult {
	/** Whether Chrome exposes native WebMCP to the page. */
	status: "ready" | "unavailable";
	/** Matching page-provided tools. */
	tools: WebMcpToolRecord[];
	/** Whether the bounded summary omitted or shortened metadata. */
	truncated: boolean;
	/** Why Chrome offers the page no WebMCP, and what turns it on. */
	reason?: string;
	/** Marks every page-provided field as untrusted content. */
	untrusted: true;
}

/** Successful WebMCP invocation result. */
export interface WebMcpInvokeSuccess {
	/** Indicates successful page-tool execution. */
	ok: true;
	/** JSON-cloneable page-provided result. */
	result: unknown;
	/** Whether an oversized page result was represented by a preview. */
	truncated?: boolean;
	/** Original encoded result size when truncated. */
	originalBytes?: number;
	/** Marks the page-provided result as untrusted content. */
	untrusted: true;
}

/** Failed WebMCP invocation result. */
export interface WebMcpInvokeFailure {
	/** Indicates failed page-tool execution. */
	ok: false;
	/** Delimited page-provided or invocation error text. */
	error: string;
	/** Marks the error text as untrusted content. */
	untrusted: true;
}

/** Result of invoking one page-provided WebMCP tool. */
export type WebMcpInvokeResult = WebMcpInvokeSuccess | WebMcpInvokeFailure;

/** One catalog transition observed while polling WebMCP state. */
export interface WebMcpCatalogEvent {
	/** Monotonic per-tab event sequence. */
	sequence: number;
	/** Catalog transition kind. */
	type: "registered" | "updated" | "unregistered";
	/** Page-defined tool name. */
	name: string;
	/** CDP identifier of the owning frame. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Host timestamp when polling observed the transition. */
	timestamp: number;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

/** WebMCP catalog events newer than the requested cursor. */
export interface WebMcpEventsResult {
	/** Matching catalog transitions. */
	events: WebMcpCatalogEvent[];
	/** Latest per-tab event sequence. */
	cursor: number;
	/** Whether older retained events were omitted. */
	truncated: boolean;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

export interface StudioWebMcpCatalog extends WebMcpListResult {
	pageId: string;
	documentId?: string;
	invocationAvailable: boolean;
}
export type WebMcpOperation = {
	kind: "browser.webmcp.invoke";
	sessionId: string;
	pageId: string;
	documentId: string;
	name: string;
	params: Record<string, unknown>;
	options?: WebMcpInvokeOptions;
};
export interface WebMcpResultMap {
	"browser.webmcp.invoke": WebMcpInvokeResult;
}
export const WEBMCP_KINDS = ["browser.webmcp.invoke"] as const;
