import { STUDIO_HOST_SESSION_ORIGIN } from "../session/session-entries";

export type StudioConversationOrigin = "cli" | "studio";

export function classifyStudioSessionOrigin(header: { studioOrigin?: string }): StudioConversationOrigin {
	return header.studioOrigin === STUDIO_HOST_SESSION_ORIGIN ? "studio" : "cli";
}
