export interface StudioBrowserTab {
	id: string;
	name: string;
	title: string;
	url: string;
	kind: string;
	ownerSessionId: string;
	busy: boolean;
	frozen: boolean;
	observable: boolean;
	reason?: string;
}
export type BrowserObservationOperation =
	| { kind: "browser.tabs.get"; sessionId: string }
	| { kind: "browser.observe.prepare"; sessionId: string; tabId: string };
export interface BrowserObservationResultMap {
	"browser.tabs.get": { tabs: StudioBrowserTab[] };
	"browser.observe.prepare": { observationId: string; sessionId: string; tabId: string; expiresAt: number };
}
export const BROWSER_OBSERVATION_KINDS = ["browser.tabs.get", "browser.observe.prepare"] as const;
export function isBrowserObservationKind(kind: string): kind is BrowserObservationOperation["kind"] {
	return (BROWSER_OBSERVATION_KINDS as readonly string[]).includes(kind);
}
/** Private window-owned channel. These events never enter the conversation or public snapshot. */
export type BrowserObservationEvent =
	| {
			kind: "state";
			observationId: string;
			tabId: string;
			title: string;
			url: string;
			frozen: boolean;
			busy: boolean;
			control: "agent" | "waiting" | "human" | "other-window";
	  }
	| {
			kind: "frame";
			observationId: string;
			tabId: string;
			sequence: number;
			data: string;
			width: number;
			height: number;
			timestamp: number;
	  }
	| { kind: "error"; observationId: string; message: string }
	| { kind: "closed"; observationId: string };
export type BrowserObservationInput =
	| { kind: "ping" }
	| { kind: "take" }
	| { kind: "release" }
	| { kind: "ack"; sequence: number }
	| { kind: "navigate"; url: string }
	| { kind: "click"; sequence: number; x: number; y: number; button: "left" | "right" }
	| { kind: "wheel"; sequence: number; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: "key"; sequence: number; key: string; code: string; modifiers: number }
	| { kind: "text"; sequence: number; text: string };
export const BROWSER_FRAME_MAX_BASE64 = 2_796_204;
export const BROWSER_PRIVATE_MAX_BYTES = 4 * 1024 * 1024;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid browser observation payload");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): asserts value is string {
	if (typeof value !== "string" || value.length > max || value.includes("\0"))
		throw new Error("Invalid browser observation text");
}
function number(value: unknown, min: number, max: number): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
		throw new Error("Invalid browser observation number");
}
function sequence(value: unknown): void {
	number(value, 1, Number.MAX_SAFE_INTEGER);
	if (!Number.isSafeInteger(value)) throw new Error("Invalid browser frame sequence");
}
function id(value: unknown): void {
	text(value, 36);
	if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid observation identity");
}
export function validateBrowserObservationOperation(value: unknown): void {
	const row = object(value, ["kind", "sessionId", "tabId"]);
	if (typeof row.kind !== "string" || !isBrowserObservationKind(row.kind))
		throw new Error("Unknown browser observation operation");
	text(row.sessionId, 512);
	if (!row.sessionId) throw new Error("Session identity required");
	if (row.kind === "browser.observe.prepare") id(row.tabId);
	else object(row, ["kind", "sessionId"]);
}
export function validateBrowserObservationResult(kind: BrowserObservationOperation["kind"], value: unknown): void {
	if (kind === "browser.observe.prepare") {
		const row = object(value, ["observationId", "sessionId", "tabId", "expiresAt"]);
		id(row.observationId);
		id(row.tabId);
		text(row.sessionId, 512);
		number(row.expiresAt, 0, Number.MAX_SAFE_INTEGER);
		return;
	}
	const row = object(value, ["tabs"]);
	if (!Array.isArray(row.tabs) || row.tabs.length > 128) throw new Error("Invalid browser tab list");
	for (const item of row.tabs) {
		const tab = object(item, [
			"id",
			"name",
			"title",
			"url",
			"kind",
			"ownerSessionId",
			"busy",
			"frozen",
			"observable",
			"reason",
		]);
		id(tab.id);
		for (const key of ["name", "title", "url", "kind", "ownerSessionId"]) text(tab[key]);
		for (const key of ["busy", "frozen", "observable"])
			if (typeof tab[key] !== "boolean") throw new Error("Invalid browser tab state");
		if (tab.reason !== undefined) text(tab.reason);
	}
}
export function validateBrowserObservationInput(value: unknown): asserts value is BrowserObservationInput {
	const row = object(value, [
		"kind",
		"sequence",
		"url",
		"x",
		"y",
		"button",
		"deltaX",
		"deltaY",
		"key",
		"code",
		"modifiers",
		"text",
	]);
	const keys: Record<string, string[]> = {
		ping: [],
		take: [],
		release: [],
		ack: ["sequence"],
		navigate: ["url"],
		click: ["sequence", "x", "y", "button"],
		wheel: ["sequence", "x", "y", "deltaX", "deltaY"],
		key: ["sequence", "key", "code", "modifiers"],
		text: ["sequence", "text"],
	};
	if (typeof row.kind !== "string" || !Object.hasOwn(keys, row.kind)) throw new Error("Unknown browser action");
	object(row, ["kind", ...keys[row.kind]!]);
	if (keys[row.kind]!.includes("sequence")) sequence(row.sequence);
	if (row.kind === "navigate") {
		text(row.url);
		const url = new URL(row.url);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials");
	}
	if (row.kind === "click" || row.kind === "wheel") {
		number(row.x, 0, 1);
		number(row.y, 0, 1);
	}
	if (row.kind === "click" && row.button !== "left" && row.button !== "right") throw new Error("Invalid mouse button");
	if (row.kind === "wheel") {
		number(row.deltaX, -2048, 2048);
		number(row.deltaY, -2048, 2048);
	}
	if (row.kind === "key") {
		text(row.key, 64);
		text(row.code, 64);
		number(row.modifiers, 0, 15);
		if (!Number.isInteger(row.modifiers)) throw new Error("Invalid keyboard modifiers");
	}
	if (row.kind === "text") text(row.text, 16384);
}
export function validateBrowserObservationEvent(value: unknown): asserts value is BrowserObservationEvent {
	const row = object(value, [
		"kind",
		"observationId",
		"tabId",
		"title",
		"url",
		"frozen",
		"busy",
		"control",
		"sequence",
		"data",
		"width",
		"height",
		"timestamp",
		"message",
	]);
	id(row.observationId);
	if (row.kind === "closed") {
		object(row, ["kind", "observationId"]);
		return;
	}
	if (row.kind === "error") {
		object(row, ["kind", "observationId", "message"]);
		text(row.message);
		return;
	}
	id(row.tabId);
	if (row.kind === "state") {
		object(row, ["kind", "observationId", "tabId", "title", "url", "frozen", "busy", "control"]);
		text(row.title);
		text(row.url);
		if (
			typeof row.frozen !== "boolean" ||
			typeof row.busy !== "boolean" ||
			!["agent", "waiting", "human", "other-window"].includes(row.control as string)
		)
			throw new Error("Invalid browser state");
		return;
	}
	if (row.kind !== "frame") throw new Error("Unknown browser observation event");
	object(row, ["kind", "observationId", "tabId", "sequence", "data", "width", "height", "timestamp"]);
	sequence(row.sequence);
	text(row.data, BROWSER_FRAME_MAX_BASE64);
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(row.data as string)) throw new Error("Invalid frame encoding");
	number(row.width, 1, 4096);
	number(row.height, 1, 4096);
	if (Number(row.width) * Number(row.height) > 4_000_000)
		throw new Error("Browser viewport exceeds the observation budget");
	number(row.timestamp, 0, Number.MAX_SAFE_INTEGER);
}
