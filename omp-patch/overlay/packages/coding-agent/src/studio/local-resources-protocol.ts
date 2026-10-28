export interface LocalResourceRow {
	name: string;
	uri: string;
	bytes: number;
	modifiedAt: number;
}
export type LocalResourceOperation =
	| { kind: "resource.local.list"; sessionId: string }
	| { kind: "resource.local.open"; sessionId: string; uri: string }
	| { kind: "resource.local.save"; sessionId: string; uri: string; version: string; text: string };
export interface LocalResourceResultMap {
	"resource.local.list": { files: LocalResourceRow[]; truncated: boolean };
	"resource.local.open": { uri: string; version: string; text: string };
	"resource.local.save": { uri: string; version: string; saved: true };
}
export const LOCAL_RESOURCE_KINDS = ["resource.local.list", "resource.local.open", "resource.local.save"] as const;
export function isLocalResourceKind(kind: string): kind is LocalResourceOperation["kind"] {
	return (LOCAL_RESOURCE_KINDS as readonly string[]).includes(kind);
}
