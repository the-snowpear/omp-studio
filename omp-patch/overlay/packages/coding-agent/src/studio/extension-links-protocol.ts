export type ExtensionLinkOperation = {
	kind: "extensions.links.activate";
	sessionId: string;
	sourceSessionId?: string;
	agentId?: string;
	url: string;
};
export interface ExtensionLinkResultMap {
	"extensions.links.activate": { handled: boolean };
}
export const EXTENSION_LINK_KINDS = ["extensions.links.activate"] as const;
